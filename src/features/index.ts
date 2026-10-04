import type { Announcer } from "../core/announcer.ts";
import type { Calendar } from "../core/calendar.ts";
import type { CapabilityRegistry } from "../core/capabilities.ts";
import type { Feature } from "../core/feature.ts";
import type { Home } from "../core/home.ts";
import type { Logger } from "../core/logger.ts";
import type { AccessStore } from "../core/ports/access-store.ts";
import type { ErrorReporter } from "../core/ports/error-reporter.ts";
import type { FeedbackSink } from "../core/ports/feedback.ts";
import type { RoleMirror } from "../core/role-mirror.ts";
import type { HomeDeviceStore } from "../services/home-devices.ts";
import type { InfoTopic } from "../services/info-content.ts";
import type { SpaceStatus } from "../services/space-status.ts";
import { createAdminFeature } from "./admin/index.ts";
import { createEventsFeature } from "./events/index.ts";
import { createFeedbackFeature } from "./feedback/index.ts";
import { createHelpFeature } from "./help/index.ts";
import { createInfoFeature } from "./info/index.ts";
import { createPingFeature } from "./ping/index.ts";
import { createStatusFeature } from "./status/index.ts";
import { createWhoamiFeature } from "./whoami/index.ts";

export type FeatureDeps = {
	version: string;
	startedAt: Date;
	access: AccessStore;
	capabilities: CapabilityRegistry;
	roles: RoleMirror;
	home: Home;
	homeDevices: HomeDeviceStore;
	feedback: FeedbackSink;
	reporter: ErrorReporter;
	spaceStatus: SpaceStatus;
	announcer: Announcer;
	calendar: Calendar;
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
		createAdminFeature({
			version: deps.version,
			startedAt: deps.startedAt,
			access: deps.access,
			capabilities: deps.capabilities,
			roles: deps.roles,
			home: deps.home,
			homeDevices: deps.homeDevices,
			reporter: deps.reporter,
		}),
	];
}
