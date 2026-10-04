import { join } from "node:path";
import * as Sentry from "@sentry/node";
import { createDiscordAdapter } from "./adapters/discord/index.ts";
import { buildCore } from "./app.ts";
import { loadConfig } from "./config.ts";
import { type Stop, startFeatures } from "./core/feature.ts";
import { startHealthServer } from "./observability/health.ts";
import { createLogger } from "./observability/logger.ts";
import { createSentryReporter } from "./observability/sentry-reporter.ts";

async function main(): Promise<void> {
	const config = loadConfig();
	const logger = createLogger(config);
	const reporter = createSentryReporter();
	const { access, dispatcher, registry, spaceStatus, announcer, calendar, roles, features } =
		buildCore(config, logger, reporter);

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
		reportError: (error) => reporter.captureBackground(error, "discord"),
		onReady: () => {
			stopFeatures = startFeatures(features);
		},
	});
	const health = startHealthServer(config.healthPort, () => discord.isReady());
	spaceStatus.start();

	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		logger.info({ event: "shutdown", signal }, "shutting down");
		stopFeatures();
		spaceStatus.stop();
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
