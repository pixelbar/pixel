import { join } from "node:path";
import * as Sentry from "@sentry/node";
import { createDiscordAdapter } from "./adapters/discord/index.ts";
import { HomeAssistantBackend } from "./adapters/home-assistant/backend.ts";
import { buildCore } from "./app.ts";
import { loadConfig } from "./config.ts";
import { type Stop, startFeatures } from "./core/feature.ts";
import { startHealthServer } from "./observability/health.ts";
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
		roles,
		home,
		homeDevices,
		homeInventory,
		features,
	} = buildCore(config, logger, reporter, { feedback: createSentryFeedback() });

	logger.info(
		{ event: "startup", commands: registry.all().length, access: access.view.counts },
		"starting Pixel",
	);

	// Background work (e.g. announcing space changes) starts once Discord is ready,
	// so the announcement publishers exist before the first change is announced.
	let stopFeatures: Stop = () => {};
	const discord = createDiscordAdapter({
		token: config.discord.token,
		guildId: config.discord.guildId,
		dispatcher,
		logger,
		announce: config.discord.announce,
		announceStateFile: join(config.dataDir, "announcements.state"),
		announcer,
		calendar,
		roles,
		roleMapping: config.discord.roles,
		reportError: (error, actor) => reporter.captureBackground(error, "discord", actor),
		onReady: () => {
			stopFeatures = startFeatures(features);
		},
	});
	// Home Assistant connects in the background and reconnects forever, so it never holds up the
	// bot. It doesn't count towards health either: Home Assistant being down shouldn't restart Pixel.
	let homeAssistant: HomeAssistantBackend | undefined;
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
	spaceStatus.start();

	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		logger.info({ event: "shutdown", signal }, "shutting down");
		stopFeatures();
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
