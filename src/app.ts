import { join } from "node:path";
import type { Config } from "./config.ts";
import { checkAccess, splitRef } from "./core/access.ts";
import { Announcer } from "./core/announcer.ts";
import { Calendar } from "./core/calendar.ts";
import {
	type CapabilityDefinition,
	CapabilityRegistry,
	reportUnknownCapabilities,
} from "./core/capabilities.ts";
import { CapabilityNotifier } from "./core/capability-notify.ts";
import { ChannelPosts } from "./core/channel-posts.ts";
import { Dispatcher } from "./core/dispatcher.ts";
import type { Feature } from "./core/feature.ts";
import { Home } from "./core/home.ts";
import { HOME_KINDS } from "./core/home-kinds/index.ts";
import { IdentityService } from "./core/identity.ts";
import type { Logger } from "./core/logger.ts";
import type { AccessStore } from "./core/ports/access-store.ts";
import type { ErrorReporter } from "./core/ports/error-reporter.ts";
import { type FeedbackSink, nullFeedbackSink } from "./core/ports/feedback.ts";
import { RateLimiter } from "./core/rate-limit.ts";
import { CommandRegistry } from "./core/registry.ts";
import { RoleMirror } from "./core/role-mirror.ts";
import { CAPABILITIES } from "./features/capabilities.ts";
import { buildFeatures } from "./features/index.ts";
import { SCHEDULE_CAPABILITY } from "./features/schedules/index.ts";
import { ConfigTierSource, StoreCapabilitySource } from "./services/access-config.ts";
import { FileAccessStore } from "./services/access-store.ts";
import { HomeDeviceStore } from "./services/home-devices.ts";
import { HomeInventory, INVENTORY_FILE } from "./services/home-inventory.ts";
import { infoVariables, loadInfoTopics } from "./services/info-content.ts";
import { KindSwitch } from "./services/kind-switch.ts";
import { ScheduleStore } from "./services/schedules.ts";
import { FileSpaceStateStore } from "./services/space-state-store.ts";
import { SpaceApiStatus, type SpaceStatus } from "./services/space-status.ts";

export type Core = {
	access: AccessStore;
	capabilities: CapabilityRegistry;
	/** DMs someone when a capability is granted or revoked, once Discord has plugged in. */
	capabilityNotify: CapabilityNotifier;
	/** Mirrors tiers to Discord roles once the Discord adapter has plugged its backend in. */
	roles: RoleMirror;
	/** Reads and controls Home Assistant once its adapter has plugged a backend in. */
	home: Home;
	/** The devices Pixel may touch in Home Assistant. Empty when Home Assistant isn't set up. */
	homeDevices: HomeDeviceStore;
	/** Everything Home Assistant has, written to a file for people to read. Never an allow-list. */
	homeInventory: HomeInventory;
	/** Emergency switches for kinds of device, such as doors (`/admin doors`). */
	switches: KindSwitch;
	registry: CommandRegistry;
	dispatcher: Dispatcher;
	/** Not started here — the bot calls `start()`; scripts never poll. */
	spaceStatus: SpaceStatus;
	/** Where scheduled posts go; the Discord adapter plugs in its poster once it's ready. */
	channelPosts: ChannelPosts;
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
	/** Where `/feedback` messages go. Without one, the command says feedback isn't set up. */
	feedback?: FeedbackSink;
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
	// Capabilities are declared in code. Names in the file that aren't are ignored, but reported.
	const capabilities = new CapabilityRegistry(options.capabilities ?? CAPABILITIES);
	const capabilityNotify = new CapabilityNotifier({ logger, capabilities });
	// Missing or invalid files throw here, so Pixel never starts with "everyone is a guest".
	const access = FileAccessStore.open({
		paths: config.access,
		logger,
		reporter,
		notify: capabilityNotify,
	});
	for (const warning of access.view.warnings) {
		logger.warn({ event: "access_config.warning" }, warning);
	}
	reportUnknownCapabilities(access.view.records.values(), capabilities, { logger, reporter });

	const roles = new RoleMirror({ logger, reporter });
	const home = new Home({ logger, reporter });
	// With Home Assistant set up, the devices file must exist and be valid, or startup stops.
	const homeDevices = config.homeAssistant
		? HomeDeviceStore.open({ dir: config.homeAssistantDir, kinds: HOME_KINDS })
		: HomeDeviceStore.empty();
	const homeInventory = config.homeAssistant
		? new HomeInventory({
				home,
				kinds: HOME_KINDS,
				devices: homeDevices,
				file: join(config.homeAssistantDir, INVENTORY_FILE),
				logger,
				intervalMs: config.homeSyncMinutes * 60_000,
			})
		: HomeInventory.off();
	// Everything starts on; what an admin switches off is remembered across restarts.
	const switches = new KindSwitch({
		file: join(config.dataDir, "home-switches.state"),
		logger,
		switchable: ["door"],
	});

	const spaceStatus = new SpaceApiStatus({
		url: config.spaceApiUrl,
		logger,
		reportError: (error) => reporter.captureBackground(error, "spaceapi"),
		store: new FileSpaceStateStore(join(config.dataDir, "space.state")),
		...(options.fetch ? { fetch: options.fetch } : {}),
	});

	const announcer = new Announcer({ logger, reporter });
	const calendar = new Calendar({ logger, reporter });
	const channelPosts = new ChannelPosts();
	// An invalid schedules file doesn't stop Pixel: nothing is posted or changed until it's fixed.
	const schedules = new ScheduleStore({ file: join(config.dataDir, "schedules.yaml"), logger });
	if (schedules.problem) reporter.captureBackground(new Error(schedules.problem), "schedules");
	const identity = new IdentityService(
		[new ConfigTierSource(access)],
		[new StoreCapabilitySource(access)],
	);
	// A schedule keeps posting only while whoever made it may still schedule posts.
	const canSchedule = async (ref: string) => {
		const { platform, userId } = splitRef(ref);
		if (platform !== "discord") return false;
		const principal = await identity.resolve({ platform, userId, displayName: "", chat: "group" });
		return checkAccess({ minTier: "member", capability: SCHEDULE_CAPABILITY.name }, principal)
			.allowed;
	};

	// Invalid content stops startup, like the access lists. CI loads the real content too.
	const infoTopics = loadInfoTopics(
		join(config.contentDir, "info"),
		infoVariables({ announcementsChannelId: config.discord.announcementsChannelId }),
	);
	logger.info({ event: "info.loaded", topics: infoTopics.length }, "loaded /info topics");

	const registry = new CommandRegistry({ capabilities });
	const features = buildFeatures({
		version: config.version,
		runtime: config.runtime,
		startedAt: options.startedAt ?? new Date(),
		access,
		capabilities,
		feedback: options.feedback ?? nullFeedbackSink,
		roles,
		home,
		homeDevices,
		homeInventory,
		switches,
		reporter,
		spaceStatus,
		announcer,
		calendar,
		channelPosts,
		schedules,
		canSchedule,
		infoTopics,
		timezone: config.timezone,
		logger,
	});
	for (const feature of features) registry.register(feature);

	const dispatcher = new Dispatcher({
		registry,
		identity,
		rateLimiter: new RateLimiter({ capacity: 5, refillPerSecond: 0.5 }),
		logger,
		reporter,
	});

	return {
		access,
		capabilities,
		capabilityNotify,
		roles,
		home,
		homeDevices,
		homeInventory,
		switches,
		registry,
		dispatcher,
		spaceStatus,
		announcer,
		calendar,
		channelPosts,
		features,
	};
}
