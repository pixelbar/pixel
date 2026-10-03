import { join } from "node:path";
import type { Config } from "./config.ts";
import { Announcer } from "./core/announcer.ts";
import { Dispatcher } from "./core/dispatcher.ts";
import type { Feature } from "./core/feature.ts";
import { IdentityService } from "./core/identity.ts";
import type { Logger } from "./core/logger.ts";
import type { ErrorReporter } from "./core/ports/error-reporter.ts";
import { RateLimiter } from "./core/rate-limit.ts";
import { CommandRegistry } from "./core/registry.ts";
import { buildFeatures } from "./features/index.ts";
import { type AccessConfig, ConfigTierSource, loadAccessConfig } from "./services/access-config.ts";
import { FileSpaceStateStore } from "./services/space-state-store.ts";
import { SpaceApiStatus, type SpaceStatus } from "./services/space-status.ts";

export type Core = {
	access: AccessConfig;
	registry: CommandRegistry;
	dispatcher: Dispatcher;
	/** Not started here — the bot calls `start()`; scripts never poll. */
	spaceStatus: SpaceStatus;
	/** Platform adapters register their publishers here once they're ready. */
	announcer: Announcer;
	/** Not started here — the bot calls `startFeatures()` once the adapters are ready. */
	features: readonly Feature[];
};

export type BuildCoreOptions = {
	startedAt?: Date;
	/** Overrides HTTP for services (tests). */
	fetch?: typeof globalThis.fetch;
};

/**
 * Wires up everything platform-independent. Shared by the bot and by scripts
 * (e.g. command registration) so they see exactly the same commands.
 */
export function buildCore(
	config: Config,
	logger: Logger,
	reporter: ErrorReporter,
	options: BuildCoreOptions = {},
): Core {
	const access = loadAccessConfig(config.access);
	for (const warning of access.warnings) logger.warn({ event: "access_config.warning" }, warning);

	const spaceStatus = new SpaceApiStatus({
		url: config.spaceApiUrl,
		logger,
		reportError: (error) => reporter.captureBackground(error, "spaceapi"),
		store: new FileSpaceStateStore(join(config.dataDir, "space.state")),
		...(options.fetch ? { fetch: options.fetch } : {}),
	});

	const announcer = new Announcer({ logger, reporter });

	const registry = new CommandRegistry();
	const features = buildFeatures({
		version: config.version,
		startedAt: options.startedAt ?? new Date(),
		access,
		spaceStatus,
		announcer,
		logger,
	});
	for (const feature of features) registry.register(feature);

	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService([new ConfigTierSource(access)]),
		rateLimiter: new RateLimiter({ capacity: 5, refillPerSecond: 0.5 }),
		logger,
		reporter,
	});

	return { access, registry, dispatcher, spaceStatus, announcer, features };
}
