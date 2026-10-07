import * as Sentry from "@sentry/node";
import type { Logger } from "../core/logger.ts";

/**
 * A heartbeat for an outside monitor: a dead bot can't report its own death, so
 * Pixel checks in on a schedule and the monitor raises the alarm when the check-ins
 * stop. That covers a crash, a hung process and the host going down. While the
 * process is alive but Discord isn't connected, it checks in as failed, so that's
 * caught straight away too.
 */

export type CheckInStatus = "ok" | "error";
export type CheckIn = (status: CheckInStatus) => void;

export type Heartbeat = {
	/** Checks in now, such as the moment Discord connects. */
	beat(): void;
	stop(): void;
};

export function startHeartbeat(options: {
	intervalMs: number;
	isHealthy: () => boolean;
	checkIn: CheckIn;
	logger: Logger;
}): Heartbeat {
	const log = options.logger.child({ component: "heartbeat" });
	let last: CheckInStatus | undefined;
	const beat = () => {
		const status: CheckInStatus = options.isHealthy() ? "ok" : "error";
		try {
			options.checkIn(status);
		} catch (error) {
			// Never let monitoring break the bot, and nothing from a timer may escape.
			log.warn({ event: "heartbeat.failed", err: error }, "couldn't check in");
			return;
		}
		// Log changes, not every beat.
		if (status !== last) {
			log.info({ event: "heartbeat.status", status }, `heartbeat: ${status}`);
			last = status;
		}
	};
	const timer = setInterval(beat, options.intervalMs);
	timer.unref();
	return { beat, stop: () => clearInterval(timer) };
}

/**
 * Checks in to a Sentry cron monitor. The monitor is created or updated from this
 * config on the first check-in, so there's nothing to set up by hand apart from who
 * gets alerted. One missed or failed check-in opens an issue; one good one resolves it.
 */
export function sentryCheckIn(monitorSlug: string, intervalMinutes: number): CheckIn {
	return (status) => {
		Sentry.captureCheckIn(
			{ monitorSlug, status },
			{
				schedule: { type: "interval", value: intervalMinutes, unit: "minute" },
				// Room for a deploy or restart before a missed check-in counts.
				checkinMargin: Math.max(5, intervalMinutes),
				maxRuntime: 1,
				failureIssueThreshold: 1,
				recoveryThreshold: 1,
			},
		);
	};
}

/** The monitor's name in Sentry, one per environment, so dev doesn't page about prod or the other way round. */
export const monitorSlug = (env: string): string => `pixel-${env}`;
