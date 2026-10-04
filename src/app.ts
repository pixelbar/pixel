import { join } from "node:path";
import type { Config } from "./config.ts";
import { Announcer } from "./core/announcer.ts";
import { Calendar } from "./core/calendar.ts";
import {
	type CapabilityDefinition,
	CapabilityRegistry,
	reportUnknownCapabilities,
} from "./core/capabilities.ts";
import { Dispatcher } from "./core/dispatcher.ts";
import type { Feature } from "./core/feature.ts";
import { IdentityService } from "./core/identity.ts";
import type { Logger } from "./core/logger.ts";
import type { AccessStore } from "./core/ports/access-store.ts";
import type { ErrorReporter } from "./core/ports/error-reporter.ts";
import { RateLimiter } from "./core/rate-limit.ts";
import { CommandRegistry } from "./core/registry.ts";
import { RoleMirror } from "./core/role-mirror.ts";
import { CAPABILITIES } from "./features/capabilities.ts";
import { buildFeatures } from "./features/index.ts";
import { ConfigTierSource, StoreCapabilitySource } from "./services/access-config.ts";
import { FileAccessStore } from "./services/access-store.ts";
import { infoVariables, loadInfoTopics } from "./services/info-content.ts";
import { FileSpaceStateStore } from "./services/space-state-store.ts";
import { SpaceApiStatus, type SpaceStatus } from "./services/space-status.ts";

export type Core = {
	access: AccessStore;
	capabilities: CapabilityRegistry;
	/** Mirrors tiers to Discord roles once the Discord adapter has plugged its backend in. */
	roles: RoleMirror;
	registry: CommandRegistry;
	dispatcher: Dispatcher;
	/** Not started here — the bot calls `start()`; scripts never poll. */
	spaceStatus: SpaceStatus;
	/** Platform adapters register their publishers here once they're ready. */
	announcer: Announcer;
	/** A platform adapter plugs its events in here once it's ready. */
	calendar: Calendar;
	/** Not started here — the bot calls `startFeatures()` once the adapters are ready. */
	features: readonly Feature[];
};

export type BuildCoreOptions = {
	startedAt?: Date;
	/** Overrides HTTP for services (tests). */
	fetch?: typeof globalThis.fetch;
	/** Overrides the capabilities declared in `features/capabilities.ts` (tests). */
	capabilities?: readonly CapabilityDefinition[];
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
	// Missing or invalid files throw here, so Pixel never starts with "everyone is a guest".
	const access = FileAccessStore.open({ paths: config.access, logger, reporter });
	for (const warning of access.view.warnings) {
		logger.warn({ event: "access_config.warning" }, warning);
	}
	// Capabilities are declared in code. Names in the file that aren't are ignored, but reported.
	const capabilities = new CapabilityRegistry(options.capabilities ?? CAPABILITIES);
	reportUnknownCapabilities(access.view.records.values(), capabilities, { logger, reporter });

	const roles = new RoleMirror({ logger, reporter });

	const spaceStatus = new SpaceApiStatus({
		url: config.spaceApiUrl,
		logger,
		reportError: (error) => reporter.captureBackground(error, "spaceapi"),
		store: new FileSpaceStateStore(join(config.dataDir, "space.state")),
		...(options.fetch ? { fetch: options.fetch } : {}),
	});

	const announcer = new Announcer({ logger, reporter });
	const calendar = new Calendar({ logger, reporter });

	// Invalid content stops startup, like the access lists. CI loads the real content too.
	const infoTopics = loadInfoTopics(
		join(config.contentDir, "info"),
		infoVariables({ announcementsChannelId: config.discord.announcementsChannelId }),
	);
	logger.info({ event: "info.loaded", topics: infoTopics.length }, "loaded /info topics");

	const registry = new CommandRegistry({ capabilities });
	const features = buildFeatures({
		version: config.version,
		startedAt: options.startedAt ?? new Date(),
		access,
		capabilities,
		roles,
		reporter,
		spaceStatus,
		announcer,
		calendar,
		infoTopics,
		timezone: config.timezone,
		logger,
	});
	for (const feature of features) registry.register(feature);

	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService(
			[new ConfigTierSource(access)],
			[new StoreCapabilitySource(access)],
		),
		rateLimiter: new RateLimiter({ capacity: 5, refillPerSecond: 0.5 }),
		logger,
		reporter,
	});

	return {
		access,
		capabilities,
		roles,
		registry,
		dispatcher,
		spaceStatus,
		announcer,
		calendar,
		features,
	};
}
