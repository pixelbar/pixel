import type { Announcer } from "../core/announcer.ts";
import type { Feature } from "../core/feature.ts";
import type { Logger } from "../core/logger.ts";
import type { AccessConfig } from "../services/access-config.ts";
import type { SpaceStatus } from "../services/space-status.ts";
import { createAdminFeature } from "./admin/index.ts";
import { createHelpFeature } from "./help/index.ts";
import { createPingFeature } from "./ping/index.ts";
import { createStatusFeature } from "./status/index.ts";
import { createWhoamiFeature } from "./whoami/index.ts";

export type FeatureDeps = {
	version: string;
	startedAt: Date;
	access: AccessConfig;
	spaceStatus: SpaceStatus;
	announcer: Announcer;
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
		createWhoamiFeature(),
		createAdminFeature({
			version: deps.version,
			startedAt: deps.startedAt,
			accessCounts: deps.access.counts,
		}),
	];
}
