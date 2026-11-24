import { join } from "node:path";
import type { AnnouncementRoutes } from "../core/announcement-routes.ts";
import type { Announcer } from "../core/announcer.ts";
import type { Calendar } from "../core/calendar.ts";
import type { CapabilityRegistry } from "../core/capabilities.ts";
import type { ChannelPosts } from "../core/channel-posts.ts";
import type { DirectMessages } from "../core/direct-messages.ts";
import type { DoorbellEvents } from "../core/doorbell.ts";
import type { Feature } from "../core/feature.ts";
import type { Home } from "../core/home.ts";
import { createInterpolator } from "../core/interpolate.ts";
import type { Logger } from "../core/logger.ts";
import type { AccessStore } from "../core/ports/access-store.ts";
import type { DoorSystem } from "../core/ports/door-system.ts";
import type { DoorbellAccept } from "../core/ports/doorbell-accept.ts";
import type { ErrorReporter } from "../core/ports/error-reporter.ts";
import type { FeedbackSink } from "../core/ports/feedback.ts";
import { type Gate, notConnectedGate } from "../core/ports/gate.ts";
import type { RoleMirror } from "../core/role-mirror.ts";
import type { AttendanceStore } from "../services/attendance.ts";
import type { DoorbellSettings } from "../services/doorbell-settings.ts";
import type { FoodWishlistStore } from "../services/food-wishlist.ts";
import type { HomeDeviceStore } from "../services/home-devices.ts";
import type { InfoTopic } from "../services/info-content.ts";
import type { KindSwitch } from "../services/kind-switch.ts";
import { ParkingActivity } from "../services/parking-activity.ts";
import type { ParkingBookingStore } from "../services/parking-bookings.ts";
import { ParkingNotices } from "../services/parking-notices.ts";
import type { ParkingSpotStore } from "../services/parking-spots.ts";
import type { ParkingWindowStore } from "../services/parking-windows.ts";
import type { ScheduleStore } from "../services/schedules.ts";
import type { SpaceStateApi } from "../services/space-state-api.ts";
import type { SpaceStatus } from "../services/space-status.ts";
import type { Wiki } from "../services/wiki.ts";
import { createAdminFeature } from "./admin/index.ts";
import { createClosingTimeFeature } from "./closing-time/index.ts";
import { createDoorbellFeature } from "./doorbell/index.ts";
import { createEventsFeature } from "./events/index.ts";
import { createFeedbackFeature } from "./feedback/index.ts";
import { createFishbotFeature } from "./fishbot/index.ts";
import { createFoodFeature } from "./food/index.ts";
import { createHelpFeature } from "./help/index.ts";
import { createHomeFeature } from "./home/index.ts";
import { createInfoFeature } from "./info/index.ts";
import { createOpenrFeature, type OpenrDoor, openrGate } from "./openr/index.ts";
import { createParkingFeature } from "./parking/index.ts";
import { createPingFeature } from "./ping/index.ts";
import { createReleaseAnnouncementFeature } from "./release-announcement/index.ts";
import { createSchedulesFeature } from "./schedules/index.ts";
import { createStatusFeature } from "./status/index.ts";
import { createWhoamiFeature } from "./whoami/index.ts";
import { createWikiFeature } from "./wiki/index.ts";

export type FeatureDeps = {
	version: string;
	env: string;
	commit: string | undefined;
	branch: string | undefined;
	/** Where runtime state lives (`PIXEL_DATA_DIR`). */
	dataDir: string;
	runtime: "local" | "cloud";
	startedAt: Date;
	access: AccessStore;
	capabilities: CapabilityRegistry;
	roles: RoleMirror;
	home: Home;
	homeDevices: HomeDeviceStore;
	announcementRoutes: AnnouncementRoutes;
	/** Emergency switches for kinds of device (`/admin` → Doors). */
	switches: KindSwitch;
	feedback: FeedbackSink;
	reporter: ErrorReporter;
	spaceStatus: SpaceStatus;
	/** Sets the space open or closed (`/spacestate`). Undefined when it isn't configured. */
	spaceState: SpaceStateApi | undefined;
	announcer: Announcer;
	calendar: Calendar;
	/** Where scheduled posts go, once the platform adapter is ready. */
	channelPosts: ChannelPosts;
	schedules: ScheduleStore;
	/** Attendance polls Pixel has posted, and their votes. */
	attendance: AttendanceStore;
	/** Parking spots and settings (`data/parking-spots.yaml`). */
	parkingSpots: ParkingSpotStore;
	/** When parking spots are open or closed (`data/parking-windows.yaml`). */
	parkingWindows: ParkingWindowStore;
	/** Who is parked where (`data/parking-bookings.yaml`). */
	parkingBookings: ParkingBookingStore;
	/**
	 * Opens the parking gate. Defaults to the OpenR gate door when there is one, and
	 * otherwise to a gate that never opens.
	 */
	gate?: Gate;
	/** The building's doors (OpenR). Undefined when OpenR isn't configured. */
	doorSystem: DoorSystem | undefined;
	/** The doors `/openr open` offers, and the parking gate's door, from the config. */
	openrDoors: readonly OpenrDoor[];
	openrGateDoor: string | undefined;
	/** DMs for features (parking reminders), once the platform adapter is ready. */
	directMessages: DirectMessages;
	/** Where every parking change is posted for admins. Returns undefined when off (still counted in Sentry). */
	parkingChannelId: () => string | undefined;
	/** Whether someone (by platform ID) may still schedule posts, for posts they set up earlier. */
	canSchedule: (ref: string) => Promise<boolean>;
	infoTopics: readonly InfoTopic[];
	/** Pixelbar's wiki, for `/wiki`. */
	wiki: Wiki;
	/** The time zone times are shown in, e.g. "Europe/Amsterdam". */
	timezone: string;
	logger: Logger;
	/** Closing-time posts: destination on/off, the persist file, and the message body. */
	closingTime: { enabled: () => boolean; file: string; message: () => string };
	/** Food wishlist (`data/food-wishlist.yaml`). */
	foodWishlist: FoodWishlistStore;
	/** Optional channel for out-of-stock alerts to admins. Returns undefined when off. */
	foodAlertChannelId: () => string | undefined;
	/** The doorbell: pixel-phone's call events, where they're posted, and how to answer. */
	doorbell: {
		events: DoorbellEvents;
		settings: DoorbellSettings;
		/** Undefined when pixel-phone isn't configured. */
		accept: DoorbellAccept | undefined;
	};
};

/** Every feature Pixel runs. Add new features here. */
export function buildFeatures(deps: FeatureDeps): Feature[] {
	// One interpolator for every user-set post. Register later tokens here
	// (space state, Home Assistant, …) — do not add an if/else in each feature.
	const interpolator = createInterpolator({ timezone: deps.timezone });
	const parkingNotices = new ParkingNotices({ messages: deps.directMessages, logger: deps.logger });
	const parkingActivity = new ParkingActivity({
		posts: deps.channelPosts,
		channelId: deps.parkingChannelId,
		reporter: deps.reporter,
		logger: deps.logger,
		timezone: deps.timezone,
	});
	const gate =
		deps.gate ??
		(deps.doorSystem && deps.openrGateDoor !== undefined
			? openrGate({ doors: deps.doorSystem, gateDoor: deps.openrGateDoor, switches: deps.switches })
			: notConnectedGate);
	const closingTime = createClosingTimeFeature({
		announcer: deps.announcer,
		enabled: deps.closingTime.enabled,
		message: deps.closingTime.message,
		interpolator,
		logger: deps.logger,
	});
	return [
		createHelpFeature(),
		createFishbotFeature(),
		createPingFeature({ version: deps.version }),
		createStatusFeature({
			spaceStatus: deps.spaceStatus,
			announcer: deps.announcer,
			logger: deps.logger,
			onSpaceClosed: closingTime.onSpaceClosed,
		}),
		createReleaseAnnouncementFeature({
			announcer: deps.announcer,
			build: {
				version: deps.version,
				env: deps.env,
				commit: deps.commit,
				branch: deps.branch,
				runtime: deps.runtime,
			},
			stateFile: join(deps.dataDir, "release-announced.yaml"),
			logger: deps.logger,
		}),
		// Temporarily disabled: /spacestate isn't working. Re-enable once the API is fixed.
		// createSpaceStateFeature({ api: deps.spaceState, reporter: deps.reporter }),
		closingTime,
		createEventsFeature({ calendar: deps.calendar, timezone: deps.timezone }),
		createInfoFeature({ topics: deps.infoTopics }),
		createWikiFeature({ wiki: deps.wiki, logger: deps.logger }),
		createWhoamiFeature(),
		createFeedbackFeature({ sink: deps.feedback }),
		createSchedulesFeature({
			store: deps.schedules,
			attendance: deps.attendance,
			posts: deps.channelPosts,
			timezone: deps.timezone,
			stillAllowed: deps.canSchedule,
			interpolator,
			logger: deps.logger,
			reporter: deps.reporter,
		}),
		createParkingFeature({
			spots: deps.parkingSpots,
			windows: deps.parkingWindows,
			bookings: deps.parkingBookings,
			gate,
			notices: parkingNotices,
			activity: parkingActivity,
			timezone: deps.timezone,
			logger: deps.logger,
			reporter: deps.reporter,
		}),
		createFoodFeature({
			wishlist: deps.foodWishlist,
			poster: deps.channelPosts,
			alertChannelId: deps.foodAlertChannelId,
			logger: deps.logger,
		}),
		createHomeFeature({
			home: deps.home,
			homeDevices: deps.homeDevices,
			reporter: deps.reporter,
			switches: deps.switches,
		}),
		createDoorbellFeature({
			events: deps.doorbell.events,
			posts: deps.channelPosts,
			settings: deps.doorbell.settings,
			accept: deps.doorbell.accept,
			logger: deps.logger,
			reporter: deps.reporter,
		}),
		createOpenrFeature({
			doors: deps.doorSystem,
			list: deps.openrDoors,
			switches: deps.switches,
			reporter: deps.reporter,
		}),
		createAdminFeature({
			version: deps.version,
			runtime: deps.runtime,
			startedAt: deps.startedAt,
			access: deps.access,
			capabilities: deps.capabilities,
			roles: deps.roles,
			home: deps.home,
			homeDevices: deps.homeDevices,
			announcementRoutes: deps.announcementRoutes,
			switches: deps.switches,
			reporter: deps.reporter,
			closingTimeFile: deps.closingTime.file,
			parking: {
				spots: deps.parkingSpots,
				windows: deps.parkingWindows,
				bookings: deps.parkingBookings,
				notices: parkingNotices,
				activity: parkingActivity,
				timezone: deps.timezone,
			},
			openr: {
				system: deps.doorSystem,
				doors: deps.openrDoors,
				gateDoor: deps.openrGateDoor,
			},
			doorbell: {
				settings: deps.doorbell.settings,
				posts: deps.channelPosts,
				configured: deps.doorbell.accept !== undefined,
			},
		}),
	];
}
