import type { Announcer } from "../core/announcer.ts";
import type { Calendar } from "../core/calendar.ts";
import type { CapabilityRegistry } from "../core/capabilities.ts";
import type { ChannelPosts } from "../core/channel-posts.ts";
import type { Feature } from "../core/feature.ts";
import type { Home } from "../core/home.ts";
import type { Logger } from "../core/logger.ts";
import type { AccessStore } from "../core/ports/access-store.ts";
import type { ErrorReporter } from "../core/ports/error-reporter.ts";
import type { FeedbackSink } from "../core/ports/feedback.ts";
import type { RoleMirror } from "../core/role-mirror.ts";
import type { HomeDeviceStore } from "../services/home-devices.ts";
import type { HomeInventory } from "../services/home-inventory.ts";
import type { InfoTopic } from "../services/info-content.ts";
import type { KindSwitch } from "../services/kind-switch.ts";
import type { ScheduleStore } from "../services/schedules.ts";
import type { SpaceStatus } from "../services/space-status.ts";
import { createAdminFeature } from "./admin/index.ts";
import { createEventsFeature } from "./events/index.ts";
import { createFeedbackFeature } from "./feedback/index.ts";
import { createHelpFeature } from "./help/index.ts";
import { createHomeFeature } from "./home/index.ts";
import { createHomeInventoryFeature } from "./home-inventory/index.ts";
import { createInfoFeature } from "./info/index.ts";
import { createPingFeature } from "./ping/index.ts";
import { createSchedulesFeature } from "./schedules/index.ts";
import { createStatusFeature } from "./status/index.ts";
import { createWhoamiFeature } from "./whoami/index.ts";

export type FeatureDeps = {
	version: string;
	runtime: "local" | "cloud";
	startedAt: Date;
	access: AccessStore;
	capabilities: CapabilityRegistry;
	roles: RoleMirror;
	home: Home;
	homeDevices: HomeDeviceStore;
	homeInventory: HomeInventory;
	/** Emergency switches for kinds of device (`/admin doors`). */
	switches: KindSwitch;
	feedback: FeedbackSink;
	reporter: ErrorReporter;
	spaceStatus: SpaceStatus;
	announcer: Announcer;
	calendar: Calendar;
	/** Where scheduled posts go, once the platform adapter is ready. */
	channelPosts: ChannelPosts;
	schedules: ScheduleStore;
	/** Whether someone (by platform ID) may still schedule posts, for posts they set up earlier. */
	canSchedule: (ref: string) => Promise<boolean>;
	infoTopics: readonly InfoTopic[];
	/** The time zone times are shown in, e.g. "Europe/Amsterdam". */
	timezone: string;
	logger: Logger;
};

/** Every feature Pixel runs. Add new features here. */
export function buildFeatures(deps: FeatureDeps): Feature[] {
	return [
		createHelpFeature(),
		createPingFeature({ version: deps.version }),
		createStatusFeature({
			spaceStatus: deps.spaceStatus,
			announcer: deps.announcer,
			logger: deps.logger,
		}),
		createEventsFeature({ calendar: deps.calendar, timezone: deps.timezone }),
		createInfoFeature({ topics: deps.infoTopics }),
		createWhoamiFeature(),
		createFeedbackFeature({ sink: deps.feedback }),
		createSchedulesFeature({
			store: deps.schedules,
			posts: deps.channelPosts,
			timezone: deps.timezone,
			stillAllowed: deps.canSchedule,
			logger: deps.logger,
			reporter: deps.reporter,
		}),
		createHomeFeature({
			home: deps.home,
			homeDevices: deps.homeDevices,
			reporter: deps.reporter,
			switches: deps.switches,
		}),
		createHomeInventoryFeature({ inventory: deps.homeInventory, logger: deps.logger }),
		createAdminFeature({
			version: deps.version,
			runtime: deps.runtime,
			startedAt: deps.startedAt,
			access: deps.access,
			capabilities: deps.capabilities,
			roles: deps.roles,
			home: deps.home,
			homeDevices: deps.homeDevices,
			homeInventory: deps.homeInventory,
			switches: deps.switches,
			reporter: deps.reporter,
		}),
	];
}
