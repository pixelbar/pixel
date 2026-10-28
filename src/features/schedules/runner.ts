import type { ChannelPost, ChannelPosts } from "../../core/channel-posts.ts";
import { escapeMarkdown } from "../../core/format.ts";
import { type Interpolate, interpolateChannelPost } from "../../core/interpolate.ts";
import type { Logger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import {
	formatLocal,
	nextOccurrence,
	parseLocal,
	type Recurrence,
	toInstant,
	toLocal,
	WEEKDAYS,
} from "../../core/recurrence.ts";
import { describeWhen } from "../../core/when.ts";
import type { PostedPoll, Schedule, ScheduleStore } from "../../services/schedules.ts";
import { clipToLimits } from "./limits.ts";

/** A post up to this late (Pixel was down) still goes out; later than that it's skipped. */
export const LATE_LIMIT_MS = 60 * 60_000;

export type RunnerDeps = {
	store: Pick<ScheduleStore, "all" | "get" | "update" | "remove" | "problem">;
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

const EVERY_DAY: Recurrence = { kind: "weekly", everyWeeks: 1, days: WEEKDAYS };

/**
 * The reminder a poll schedule should post at `now`, if one is due: the latest of its
 * daily times after the poll went out and after the last reminder, while the poll is
 * still open.
 */
export function dueReminder(
	schedule: Pick<Schedule, "reminder" | "lastPoll" | "lastReminderAt">,
	timezone: string,
	now: Date,
): { at: Date; skipped: number } | undefined {
	const { reminder, lastPoll } = schedule;
	if (!reminder || !lastPoll) return undefined;
	const [hour, minute] = reminder.at.split(":").map(Number) as [number, number];
	const postedAt = new Date(lastPoll.postedAt);
	const start = { ...toLocal(postedAt, timezone), hour, minute };
	const after =
		schedule.lastReminderAt && new Date(schedule.lastReminderAt) > postedAt
			? schedule.lastReminderAt
			: lastPoll.postedAt;
	const due = dueOccurrence(
		{ start: formatLocal(start), recurrence: EVERY_DAY, lastRunAt: after },
		timezone,
		now,
	);
	return due && due.at < new Date(lastPoll.closesAt) ? due : undefined;
}

/**
 * Whether a schedule still has an occurrence to post after the last one handled. A
 * one-off edited from a repeat keeps the old repeat's `lastPoll`, so that alone
 * doesn't mean it's done.
 */
function postsAgain(
	schedule: Pick<Schedule, "start" | "recurrence" | "lastRunAt">,
	timezone: string,
): boolean {
	const start = parseLocal(schedule.start);
	if (!start) return false;
	const after = schedule.lastRunAt
		? new Date(schedule.lastRunAt)
		: new Date(toInstant(start, timezone).getTime() - 1);
	return nextOccurrence(start, schedule.recurrence, timezone, after) !== undefined;
}

/** The reminder message for a poll. Never pings anyone. */
export function reminderPost(poll: PostedPoll, timezone: string): ChannelPost {
	const closes = describeWhen(toLocal(new Date(poll.closesAt), timezone));
	return {
		kind: "message",
		text: `🗳️ Reminder: vote on **${escapeMarkdown(poll.question)}** before ${closes}: ${poll.url}`,
		mentions: false,
	};
}

/**
 * Handles every schedule that's due: posts it (once), skips it if it's more than an
 * hour late, and remembers the occurrence either way so nothing is posted twice. A
 * one-off is removed once handled. Each schedule is read again just before it's
 * handled and after every wait, so one deleted, paused or edited meanwhile (say while
 * an earlier one was posting) is never posted as it was. Then posts the polls'
 * reminders that are due. Never throws.
 */
export async function runDue(deps: RunnerDeps, now: Date): Promise<void> {
	if (deps.store.problem || !deps.posts.ready) return;
	const log = deps.logger.child({ component: "schedules" });
	for (const { id } of deps.store.all()) {
		const schedule = deps.store.get(id);
		if (!schedule || schedule.paused) continue;
		const due = dueOccurrence(schedule, deps.timezone, now);
		if (!due) continue;
		const key = `${schedule.id}@${due.at.toISOString()}`;
		if (deps.handled.has(key)) continue;
		deps.handled.add(key);
		const fields = { id: schedule.id, channelId: schedule.channelId, kind: schedule.post.kind };
		let polled: PostedPoll | undefined;
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
				// Deleted, paused or edited while we waited: post what's there now, or nothing.
				const current = deps.store.get(schedule.id);
				if (!current || current.paused) continue;
				if (dueOccurrence(current, deps.timezone, now)?.at.getTime() !== due.at.getTime()) continue;
				const filled = clipToLimits(
					interpolateChannelPost(current.post, (text) =>
						deps.interpolator.interpolate(text, due.at),
					),
				);
				if (filled.clipped) {
					// Tokens made it longer than the platform allows. Never log the text itself.
					log.warn({ event: "schedule.clipped", ...fields }, "filled post too long, clipped it");
				}
				const sent = await deps.posts.post(current.channelId, filled.post);
				if (filled.post.kind === "poll") {
					polled = {
						question: filled.post.question,
						url: sent.url,
						postedAt: due.at.toISOString(),
						// Discord counts from when it's sent, not from the occurrence.
						closesAt: new Date(now.getTime() + filled.post.durationHours * 3_600_000).toISOString(),
					};
				}
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
			// A one-off poll with reminders stays until its poll closes, so they can go out.
			const keep =
				schedule.recurrence.kind !== "once" ||
				(polled !== undefined && deps.store.get(schedule.id)?.reminder !== undefined);
			if (!keep) deps.store.remove(schedule.id);
			else
				deps.store.update(schedule.id, {
					lastRunAt: due.at.toISOString(),
					...(polled ? { lastPoll: polled } : {}),
				});
		} catch (error) {
			log.error(
				{ event: "schedule.save_failed", ...fields, err: error },
				"couldn't record a scheduled post",
			);
			deps.reporter.captureBackground(error, "schedules");
		}
	}
	await remindDue(deps, now, log);
}

/**
 * Posts each poll's daily reminder that's due, by the same rules as the posts: once,
 * not more than an hour late, only while its creator may still schedule, and read
 * again just before posting. A one-off kept for its reminders goes once its poll has
 * closed. Never throws.
 */
async function remindDue(deps: RunnerDeps, now: Date, log: Logger): Promise<void> {
	for (const { id } of deps.store.all()) {
		const schedule = deps.store.get(id);
		if (!schedule?.lastPoll) continue;
		if (
			schedule.recurrence.kind === "once" &&
			now >= new Date(schedule.lastPoll.closesAt) &&
			!postsAgain(schedule, deps.timezone)
		) {
			try {
				deps.store.remove(schedule.id);
			} catch (error) {
				log.error(
					{ event: "schedule.save_failed", id: schedule.id, err: error },
					"couldn't remove a finished one-off poll",
				);
				deps.reporter.captureBackground(error, "schedules");
			}
			continue;
		}
		if (schedule.paused || !schedule.reminder) continue;
		const due = dueReminder(schedule, deps.timezone, now);
		if (!due) continue;
		const fields = {
			id: schedule.id,
			channelId: schedule.reminder.channelId,
			kind: "poll-reminder",
		};
		const key = `${schedule.id}~reminder@${due.at.toISOString()}`;
		if (deps.handled.has(key)) continue;
		deps.handled.add(key);
		try {
			if (now.getTime() - due.at.getTime() > LATE_LIMIT_MS) {
				log.warn(
					{ event: "schedule.reminder_skipped", ...fields, due: due.at.toISOString() },
					"too late to remind, skipped",
				);
			} else if (!(await deps.stillAllowed(schedule.createdBy.ref))) {
				deps.store.update(schedule.id, { paused: true });
				log.warn(
					{ event: "schedule.paused_no_access", ...fields, createdBy: schedule.createdBy.ref },
					"paused: its creator no longer has access",
				);
				continue;
			} else {
				const current = deps.store.get(schedule.id);
				if (!current?.reminder || !current.lastPoll || current.paused) continue;
				if (dueReminder(current, deps.timezone, now)?.at.getTime() !== due.at.getTime()) continue;
				await deps.posts.post(
					current.reminder.channelId,
					reminderPost(current.lastPoll, deps.timezone),
				);
				log.info(
					{ event: "schedule.reminded", ...fields, due: due.at.toISOString() },
					"posted a poll reminder",
				);
				deps.reporter.breadcrumb("schedule", `reminded ${schedule.id}`, fields);
			}
		} catch (error) {
			log.error(
				{ event: "schedule.reminder_failed", ...fields, err: error },
				"couldn't post a poll reminder",
			);
			deps.reporter.captureBackground(error, "schedules");
		}
		try {
			deps.store.update(schedule.id, { lastReminderAt: due.at.toISOString() });
		} catch (error) {
			log.error(
				{ event: "schedule.save_failed", ...fields, err: error },
				"couldn't record a poll reminder",
			);
			deps.reporter.captureBackground(error, "schedules");
		}
	}
}
