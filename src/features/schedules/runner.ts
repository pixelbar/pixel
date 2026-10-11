import type { ChannelPosts } from "../../core/channel-posts.ts";
import { type Interpolate, interpolateChannelPost } from "../../core/interpolate.ts";
import type { Logger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import { nextOccurrence, parseLocal, toInstant } from "../../core/recurrence.ts";
import type { Schedule, ScheduleStore } from "../../services/schedules.ts";

/** A post up to this late (Pixel was down) still goes out; later than that it's skipped. */
export const LATE_LIMIT_MS = 60 * 60_000;

export type RunnerDeps = {
	store: Pick<ScheduleStore, "all" | "update" | "remove" | "problem">;
	posts: Pick<ChannelPosts, "post" | "ready">;
	timezone: string;
	/** Fills `{{tokens}}` in the stored body at post time. */
	interpolator: Interpolate;
	/** Whether the person who made a schedule may still schedule posts. */
	stillAllowed: (ref: string) => Promise<boolean>;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground" | "breadcrumb">;
	/**
	 * Occurrences already handled in this process ("id@time"), so that if saving fails a
	 * post still never goes out twice. Keep one set for the life of the runner.
	 */
	handled: Set<string>;
};

/** The occurrence a schedule should handle at `now`, and how many it's skipping, or undefined if none is due. */
export function dueOccurrence(
	schedule: Pick<Schedule, "start" | "recurrence" | "lastRunAt">,
	timezone: string,
	now: Date,
): { at: Date; skipped: number } | undefined {
	const start = parseLocal(schedule.start);
	if (!start) return undefined;
	let after = schedule.lastRunAt
		? new Date(schedule.lastRunAt)
		: new Date(toInstant(start, timezone).getTime() - 1);
	let at: Date | undefined;
	let skipped = -1;
	// Walk past everything that's due; only the latest one can go out.
	for (let i = 0; i < 1000; i++) {
		const next = nextOccurrence(start, schedule.recurrence, timezone, after);
		if (!next || next > now) break;
		at = next;
		after = next;
		skipped++;
	}
	return at ? { at, skipped } : undefined;
}

/**
 * Handles every schedule that's due: posts it (once), skips it if it's more than an
 * hour late, and remembers the occurrence either way so nothing is posted twice. A
 * one-off is removed once handled. Never throws.
 */
export async function runDue(deps: RunnerDeps, now: Date): Promise<void> {
	if (deps.store.problem || !deps.posts.ready) return;
	const log = deps.logger.child({ component: "schedules" });
	for (const schedule of deps.store.all()) {
		if (schedule.paused) continue;
		const due = dueOccurrence(schedule, deps.timezone, now);
		if (!due) continue;
		const key = `${schedule.id}@${due.at.toISOString()}`;
		if (deps.handled.has(key)) continue;
		deps.handled.add(key);
		const fields = { id: schedule.id, channelId: schedule.channelId, kind: schedule.post.kind };
		try {
			if (due.skipped > 0) {
				log.warn(
					{ event: "schedule.missed", ...fields, missed: due.skipped },
					"skipped posts missed while offline",
				);
			}
			if (now.getTime() - due.at.getTime() > LATE_LIMIT_MS) {
				log.warn(
					{ event: "schedule.skipped", ...fields, due: due.at.toISOString() },
					"too late to post, skipped",
				);
			} else if (!(await deps.stillAllowed(schedule.createdBy.ref))) {
				// Whoever made it can't schedule posts any more: stop it rather than post on their behalf.
				deps.store.update(schedule.id, { paused: true });
				log.warn(
					{ event: "schedule.paused_no_access", ...fields, createdBy: schedule.createdBy.ref },
					"paused: its creator no longer has access",
				);
				continue;
			} else {
				await deps.posts.post(
					schedule.channelId,
					interpolateChannelPost(schedule.post, (text) => deps.interpolator.interpolate(text, now)),
				);
				log.info(
					{ event: "schedule.posted", ...fields, due: due.at.toISOString() },
					"posted a scheduled post",
				);
				deps.reporter.breadcrumb("schedule", `posted ${schedule.id}`, fields);
			}
		} catch (error) {
			// Never retried: a late repeat is worse than a missed one. The next occurrence tries again.
			log.error(
				{ event: "schedule.failed", ...fields, err: error },
				"couldn't post a scheduled post",
			);
			deps.reporter.captureBackground(error, "schedules");
		}
		try {
			if (schedule.recurrence.kind === "once") deps.store.remove(schedule.id);
			else deps.store.update(schedule.id, { lastRunAt: due.at.toISOString() });
		} catch (error) {
			log.error(
				{ event: "schedule.save_failed", ...fields, err: error },
				"couldn't record a scheduled post",
			);
			deps.reporter.captureBackground(error, "schedules");
		}
	}
}
