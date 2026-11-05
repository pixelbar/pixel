import { type Access, actorRef } from "../../core/access.ts";
import {
	ATTEND_ACTION,
	type AttendanceMessage,
	type ChannelPost,
	type ChannelPosts,
} from "../../core/channel-posts.ts";
import { UserFacingError } from "../../core/errors.ts";
import { escapeMarkdown } from "../../core/format.ts";
import type { Interpolate, TokenValues } from "../../core/interpolate.ts";
import type { Logger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import { toInstant, toLocal } from "../../core/recurrence.ts";
import type { ActionDefinition } from "../../core/ui.ts";
import { describeWhen, parseTimeOfDay } from "../../core/when.ts";
import { type AttendancePoll, type AttendanceStore, POLL_ID } from "../../services/attendance.ts";
import { MAX_MESSAGE_LENGTH, type PostedPoll, type Schedule } from "../../services/schedules.ts";

/**
 * Attendance polls: Pixel's own "who's coming" poll. It's a message with a button per
 * answer; Pixel counts the clicks, keeps the totals on the message up to date, and,
 * if its creator set a results channel, posts who's coming there at a set time on the
 * day it closes and again when it closes. Unlike a platform poll, there's no winner.
 *
 * Anyone in the server may vote (guest), once: picking another answer switches, and
 * picking yours again takes it back. Each click is `ATTEND_ACTION` through the
 * dispatcher, for whoever clicked, by ID.
 */

/** Anyone in the server may answer. */
export const ATTEND_ACCESS: Access = { minTier: "guest" };

/** A results post up to this late (Pixel was down) still goes out. */
const LATE_LIMIT_MS = 60 * 60_000;

export const DEFAULT_STATUS_TEXT = "📊 So far, {{count}} coming: {{names}}";
export const DEFAULT_CLOSED_TEXT = "🗳️ The poll has closed. {{count}} coming: {{names}}";

export const ATTEND_MESSAGES = {
	gone: "That poll isn't running any more.",
	closed: "That poll has closed.",
	chose: (label: string) =>
		`You're down as **${escapeMarkdown(label)}**. Press it again to take that back.`,
	tookBack: "You've taken your answer back.",
} as const;

/** The tokens a results post can use, besides the date ones. */
export const RESULT_TOKENS = ["count", "names", "question", "link"] as const;

type Votes = Pick<AttendancePoll, "answers" | "votes">;

/** The voters for each answer, by name, in the order they voted. */
function votersByAnswer(poll: Votes): string[][] {
	return poll.answers.map((_, i) => poll.votes.filter((v) => v.answer === i).map((v) => v.name));
}

/** "Alice, Bob and Carol", escaped, at most `max` names before "and 12 more". */
export function listNames(names: readonly string[], max = Number.POSITIVE_INFINITY): string {
	if (names.length === 0) return "nobody";
	const escaped = names.map((n) => escapeMarkdown(n) || "someone");
	if (escaped.length > max) {
		const shown = escaped.slice(0, Math.max(0, max));
		const more = `${escaped.length - shown.length} more`;
		return shown.length === 0 ? more : `${shown.join(", ")} and ${more}`;
	}
	if (escaped.length === 1) return escaped[0] as string;
	return `${escaped.slice(0, -1).join(", ")} and ${escaped.at(-1)}`;
}

/** Who picked an answer that counts as coming. */
export function coming(poll: Votes): string[] {
	return poll.votes.filter((v) => poll.answers[v.answer]?.counts).map((v) => v.name);
}

/** What `{{count}}`, `{{names}}`, `{{question}}` and `{{link}}` fill in with. */
export function resultValues(poll: AttendancePoll): TokenValues {
	const names = coming(poll);
	return {
		count: String(names.length),
		names: listNames(names),
		question: escapeMarkdown(poll.question),
		link: poll.url,
	};
}

/** A results post: the creator's template, filled in at post time. Never pings. */
export function resultsPost(
	template: string,
	poll: AttendancePoll,
	interpolator: Interpolate,
): ChannelPost {
	const text = interpolator.interpolate(template, new Date(poll.postedAt), resultValues(poll));
	const chars = [...text];
	return {
		kind: "message",
		text:
			chars.length > MAX_MESSAGE_LENGTH
				? `${chars.slice(0, MAX_MESSAGE_LENGTH - 1).join("")}…`
				: text,
		mentions: false,
	};
}

/** The poll's message: the question, the totals with names, and when it closes. */
export function attendanceMessage(
	poll: Omit<AttendancePoll, "messageId" | "url">,
	timezone: string,
	now: Date,
): AttendanceMessage {
	const open = !poll.closed && now < new Date(poll.closesAt);
	const closes = describeWhen(toLocal(new Date(poll.closesAt), timezone));
	const voters = votersByAnswer(poll);
	const render = (max: number) =>
		[
			`🗳️ **${escapeMarkdown(poll.question)}**`,
			"",
			...poll.answers.map((answer, i) => {
				const names = voters[i] ?? [];
				const label = `**${escapeMarkdown(answer.label)}**: ${names.length}`;
				return names.length === 0 ? label : `${label} · ${listNames(names, max)}`;
			}),
			"",
			open
				? `Open until ${closes}. Press an answer to pick it, and again to take it back.`
				: `Closed ${closes}.`,
		].join("\n");
	// Long lists of names are cut down until the message fits.
	let text = render(Number.POSITIVE_INFINITY);
	for (let max = 40; [...text].length > MAX_MESSAGE_LENGTH && max >= 0; max -= 5) {
		text = render(max);
	}
	return { pollId: poll.id, text, answers: poll.answers.map((a) => a.label), open };
}

/**
 * When the totals so far go out: `at` on the day it closes (a poll closing at
 * midnight closes on the day before), if that's after it was posted and before it
 * closes.
 */
export function statusInstant(
	at: string,
	postedAt: Date,
	closesAt: Date,
	timezone: string,
): Date | undefined {
	const time = parseTimeOfDay(at);
	if (!time) return undefined;
	const day = toLocal(new Date(closesAt.getTime() - 60_000), timezone);
	const instant = toInstant(
		{ year: day.year, month: day.month, day: day.day, hour: time.hour, minute: time.minute },
		timezone,
	);
	return instant > postedAt && instant < closesAt ? instant : undefined;
}

export type AttendanceDeps = {
	store: AttendanceStore;
	posts: Pick<ChannelPosts, "postAttendance" | "editAttendance" | "post" | "ready">;
	timezone: string;
	interpolator: Interpolate;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground" | "breadcrumb">;
	now?: () => Date;
};

export type AttendancePolls = ReturnType<typeof createAttendancePolls>;

export function createAttendancePolls(deps: AttendanceDeps) {
	const now = deps.now ?? (() => new Date());
	const log = deps.logger.child({ component: "attendance" });
	/** Message edits in flight, by poll; a click meanwhile asks for one more. */
	const refreshing = new Map<string, { again: boolean; done: Promise<void> }>();

	/**
	 * Brings the poll's message up to date. Edits for one poll run one at a time, and
	 * clicks while one runs make one more edit from the latest totals, never one each.
	 */
	function refresh(id: string): Promise<void> {
		const running = refreshing.get(id);
		if (running) {
			running.again = true;
			return running.done;
		}
		const state = { again: false, done: Promise.resolve() };
		state.done = (async () => {
			try {
				do {
					state.again = false;
					const poll = deps.store.get(id);
					if (!poll) return;
					await deps.posts.editAttendance(
						poll.channelId,
						poll.messageId,
						attendanceMessage(poll, deps.timezone, now()),
					);
				} while (state.again);
			} catch (error) {
				log.error(
					{ event: "attendance.refresh_failed", poll: id, err: error },
					"couldn't update an attendance poll's message",
				);
				deps.reporter.captureBackground(error, "attendance");
			} finally {
				refreshing.delete(id);
			}
		})();
		refreshing.set(id, state);
		return state.done;
	}

	const action: ActionDefinition = {
		name: ATTEND_ACTION,
		access: ATTEND_ACCESS,
		options: [
			{ name: "poll", description: "Which poll", type: "string", required: true },
			{ name: "answer", description: "Which answer", type: "integer", required: true },
		],
		handler: async (ctx) => {
			const id = String(ctx.args.poll);
			const answer = Number(ctx.args.answer);
			const poll = POLL_ID.test(id) ? deps.store.get(id) : undefined;
			if (!poll || !Number.isInteger(answer) || answer < 0 || answer >= poll.answers.length) {
				throw new UserFacingError(ATTEND_MESSAGES.gone);
			}
			if (poll.closed || now() >= new Date(poll.closesAt)) {
				throw new UserFacingError(ATTEND_MESSAGES.closed);
			}
			const result = deps.store.vote(
				id,
				actorRef(ctx.principal),
				ctx.principal.displayName,
				answer,
			);
			if (!result) throw new UserFacingError(ATTEND_MESSAGES.gone);
			// Not awaited: the click is answered at once, and the totals follow.
			void refresh(id);
			ctx.logger.info(
				{
					event: "attendance.voted",
					poll: id,
					took: result.answer === undefined ? "back" : "answer",
				},
				"answered an attendance poll",
			);
			const chosen = result.answer === undefined ? undefined : poll.answers[result.answer];
			return {
				reply: {
					private: true,
					text: chosen ? ATTEND_MESSAGES.chose(chosen.label) : ATTEND_MESSAGES.tookBack,
				},
			};
		},
	};

	/**
	 * Posts an attendance poll for a schedule's occurrence and starts counting. `post` is
	 * the schedule's post with its tokens filled. Returns what reminders need.
	 */
	async function post(
		schedule: Schedule,
		filled: Extract<ChannelPost, { kind: "attendance" }>,
		occurrence: Date,
	): Promise<PostedPoll> {
		if (deps.store.problem)
			throw new Error(`attendance polls are unavailable: ${deps.store.problem}`);
		const sentAt = now();
		// Counted from when it's sent, like a platform poll.
		const closesAt = new Date(sentAt.getTime() + filled.durationHours * 3_600_000);
		const { results } = schedule;
		const statusAt =
			results?.statusAt === undefined
				? undefined
				: statusInstant(results.statusAt, sentAt, closesAt, deps.timezone);
		const poll: Omit<AttendancePoll, "messageId" | "url"> = {
			id: deps.store.newId(),
			scheduleId: schedule.id,
			createdBy: schedule.createdBy.ref,
			channelId: schedule.channelId,
			question: filled.question,
			answers: filled.answers.map((a) => ({ label: a.label, counts: a.counts })),
			postedAt: occurrence.toISOString(),
			closesAt: closesAt.toISOString(),
			...(results
				? {
						results: {
							channelId: results.channelId,
							...(statusAt ? { statusAt: statusAt.toISOString() } : {}),
							statusText: results.statusText,
							closedText: results.closedText,
						},
					}
				: {}),
			closed: false,
			votes: [],
		};
		const sent = await deps.posts.postAttendance(
			schedule.channelId,
			attendanceMessage(poll, deps.timezone, sentAt),
		);
		deps.store.add({ ...poll, messageId: sent.messageId, url: sent.url }, sentAt);
		return {
			question: filled.question,
			url: sent.url,
			postedAt: occurrence.toISOString(),
			closesAt: closesAt.toISOString(),
		};
	}

	/**
	 * Closes the polls that are due (the buttons go, and the closing totals are posted)
	 * and posts the totals so far that are due. Each is handled once, results posts are
	 * skipped more than an hour late or once their creator may no longer schedule, and
	 * a failure is logged and reported, never thrown.
	 */
	async function runDue(
		at: Date,
		stillAllowed: (ref: string) => Promise<boolean>,
		handled: Set<string>,
	): Promise<void> {
		if (deps.store.problem || !deps.posts.ready) return;
		for (const { id } of deps.store.all()) {
			const poll = deps.store.get(id);
			if (!poll || poll.closed) continue;
			const closesAt = new Date(poll.closesAt);
			if (at >= closesAt) {
				await handle(`${id}~close`, handled, poll, async () => {
					const closed = deps.store.update(id, { closed: true }) as AttendancePoll;
					await refresh(id);
					if (closed.results) {
						await results(closed, "close", closed.results.closedText, closesAt, at, stillAllowed);
					}
				});
				continue;
			}
			const statusAt = poll.results?.statusAt ? new Date(poll.results.statusAt) : undefined;
			if (poll.results && statusAt && !poll.statusHandled && at >= statusAt) {
				const { statusText } = poll.results;
				await handle(`${id}~status`, handled, poll, async () => {
					deps.store.update(id, { statusHandled: true });
					await results(poll, "status", statusText, statusAt, at, stillAllowed);
				});
			}
		}
	}

	async function handle(
		key: string,
		handled: Set<string>,
		poll: AttendancePoll,
		run: () => Promise<void>,
	): Promise<void> {
		if (handled.has(key)) return;
		handled.add(key);
		try {
			await run();
		} catch (error) {
			log.error(
				{ event: "attendance.failed", poll: poll.id, schedule: poll.scheduleId, err: error },
				"couldn't handle an attendance poll",
			);
			deps.reporter.captureBackground(error, "attendance");
		}
	}

	async function results(
		poll: AttendancePoll,
		kind: "status" | "close",
		template: string,
		due: Date,
		at: Date,
		stillAllowed: (ref: string) => Promise<boolean>,
	): Promise<void> {
		const target = poll.results?.channelId as string;
		const fields = { poll: poll.id, schedule: poll.scheduleId, channelId: target, kind };
		if (at.getTime() - due.getTime() > LATE_LIMIT_MS) {
			log.warn(
				{ event: "attendance.results_skipped", ...fields },
				"too late to post results, skipped",
			);
			return;
		}
		if (!(await stillAllowed(poll.createdBy))) {
			log.warn(
				{ event: "attendance.results_no_access", ...fields, createdBy: poll.createdBy },
				"didn't post results: the poll's creator no longer has access",
			);
			return;
		}
		// The latest totals, read again after the wait.
		const current = deps.store.get(poll.id) ?? poll;
		await deps.posts.post(target, resultsPost(template, current, deps.interpolator));
		log.info({ event: "attendance.results_posted", ...fields }, "posted attendance results");
		deps.reporter.breadcrumb("attendance", `posted ${kind} for ${poll.id}`, fields);
	}

	return { action, post, refresh, runDue };
}
