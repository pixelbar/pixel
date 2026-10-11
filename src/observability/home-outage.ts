import type { HomeStatus } from "../core/home.ts";

/**
 * Sentry cron monitor for a long Home Assistant outage. Separate from
 * `pixel-<env>` (Discord / process heartbeat) so a quiet bot and an unreachable
 * HA page different people, and so a short Nabu Casa flap does not open an issue.
 */

/** One monitor per environment, never shared with the Discord heartbeat. */
export const homeMonitorSlug = (env: string): string => `pixel-${env}-home-assistant`;

export function homeIsConnected(status: HomeStatus): boolean {
	return status.kind === "connected";
}

/**
 * Check-ins stay ok until the home has been down for `graceMs`. Short drops
 * therefore never flip the monitor to error. After the grace, every check-in
 * is error until it is connected again.
 */
export function withOutageGrace(
	isUp: () => boolean,
	graceMs: number,
	now: () => number = Date.now,
): () => boolean {
	let downSince: number | undefined;
	return () => {
		if (isUp()) {
			downSince = undefined;
			return true;
		}
		downSince ??= now();
		return now() - downSince < graceMs;
	};
}
