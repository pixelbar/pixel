import { join } from "node:path";
import * as Sentry from "@sentry/node";
import { createDiscordAdapter } from "./adapters/discord/index.ts";
import { HomeAssistantBackend } from "./adapters/home-assistant/backend.ts";
import { buildCore } from "./app.ts";
import { loadConfig } from "./config.ts";
import { type Stop, startFeatures } from "./core/feature.ts";
import { createBotStatus } from "./features/bot-status/index.ts";
import { loadBuildInfo } from "./observability/build-info.ts";
import { startHealthServer } from "./observability/health.ts";
import {
	type Heartbeat,
	monitorSlug,
	sentryCheckIn,
	startHeartbeat,
} from "./observability/heartbeat.ts";
import { createLogger } from "./observability/logger.ts";
import { logProcessFailures } from "./observability/process-logging.ts";
import { createSentryFeedback } from "./observability/sentry-feedback.ts";
import { createSentryReporter } from "./observability/sentry-reporter.ts";
import { findMissingDevices } from "./services/home-devices.ts";

async function main(): Promise<void> {
	const config = loadConfig();
	const logger = createLogger(config);
	logProcessFailures(logger);
	const reporter = createSentryReporter();
	const {
		access,
		dispatcher,
		registry,
		spaceStatus,
		announcer,
		calendar,
		channelPosts,
		roles,
		capabilityNotify,
		home,
		homeDevices,
		homeInventory,
		features,
	} = buildCore(config, logger, reporter, { feedback: createSentryFeedback() });

	logger.info(
		{ event: "startup", commands: registry.all().length, access: access.view.counts },
		"starting Pixel",
	);

	const build = loadBuildInfo(config);
	const botStatus = createBotStatus({
		announcer,
		build,
		startedAt: new Date(),
		home,
		spaceStatus,
		logger,
	});
	logger.info({ event: "build", ...build }, "build info");

	// Background work (e.g. announcing space changes) starts once Discord is ready,
	// so the announcement publishers exist before the first change is announced.
	let stopFeatures: Stop = () => {};
	let heartbeat: Heartbeat | undefined;
	const discord = createDiscordAdapter({
		token: config.discord.token,
		guildId: config.discord.guildId,
		dispatcher,
		logger,
		announce: config.discord.announce,
		announceStateFile: join(config.dataDir, "announcements.state"),
		botStatusStateFile: join(config.dataDir, "bot-status.state"),
		announcer,
		calendar,
		channelPosts,
		roles,
		capabilityNotify,
		roleMapping: config.discord.roles,
		reportError: (error, actor) => reporter.captureBackground(error, "discord", actor),
		onReady: () => {
			stopFeatures = startFeatures(features);
			heartbeat?.beat();
			// Say Pixel is online once Home Assistant has had a moment to connect, so the
			// status it posts is meaningful. Never holds anything up.
			void Promise.race([homeAssistantSettled(), delay(10_000)]).then(() => botStatus.up());
		},
	});
	// Home Assistant connects in the background and reconnects forever, so it never holds up the
	// bot. It doesn't count towards health either: Home Assistant being down shouldn't restart Pixel.
	let homeAssistant: HomeAssistantBackend | undefined;
	const homeAssistantSettled = () => homeAssistant?.settled ?? Promise.resolve();
	if (config.homeAssistant) {
		homeAssistant = new HomeAssistantBackend({ ...config.homeAssistant, logger });
		home.attach(homeAssistant);
		homeAssistant.settled
			.then(async () => {
				await home.check();
				// A typo in the devices file shows up as a warning, never a failure.
				const missing = await findMissingDevices(homeDevices.view, home);
				if (missing && missing.length > 0) {
					logger.warn(
						{ event: "home.devices_missing", devices: missing },
						"some devices' entities weren't found in Home Assistant",
					);
				}
				await homeInventory.sync();
			})
			.catch((error: unknown) => reporter.captureBackground(error, "home-assistant"));
	} else {
		logger.info({ event: "home.unconfigured" }, "Home Assistant isn't configured");
	}
	const health = startHealthServer(config.healthPort, () => discord.isReady());
	// Check in with Sentry while healthy, so it can alert when Pixel goes quiet (a crash, a
	// hang, the host going down). Only with Sentry set up.
	if (config.sentryDsn && config.heartbeatMinutes > 0) {
		heartbeat = startHeartbeat({
			intervalMs: config.heartbeatMinutes * 60_000,
			isHealthy: () => discord.isReady(),
			checkIn: sentryCheckIn(monitorSlug(config.env), config.heartbeatMinutes),
			logger,
		});
	}
	spaceStatus.start();

	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		logger.info({ event: "shutdown", signal }, "shutting down");
		// Say goodbye while still connected, but never let it hold up the shutdown.
		await Promise.race([botStatus.down("restarting or shutting down"), delay(5000)]);
		stopFeatures();
		heartbeat?.stop();
		spaceStatus.stop();
		homeAssistant?.close();
		await discord.stop();
		health.close();
		await Sentry.flush(2000);
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	await discord.start();
}

main().catch(async (error: unknown) => {
	// Config and access errors carry safe, actionable messages; print them plainly.
	process.stderr.write(
		`Pixel failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	Sentry.captureException(error);
	await Sentry.flush(2000);
	process.exit(1);
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
