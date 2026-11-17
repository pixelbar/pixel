import { type Access, actorLogFields, actorRef, type Principal } from "../../core/access.ts";
import {
	ATTENDANCE_COLOURS,
	type AttendanceAnswer,
	type AttendanceColour,
	type ChannelPost,
	type ChannelPosts,
	MAX_ATTENDANCE_ANSWERS,
} from "../../core/channel-posts.ts";
import type { CommandOption, ResolvedChannel } from "../../core/command.ts";
import { formatMinutes, parseDurationMinutes } from "../../core/duration.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown } from "../../core/format.ts";
import { type Interpolate, interpolateChannelPost } from "../../core/interpolate.ts";
import type { Logger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import {
	formatLocal,
	type LocalDateTime,
	listDays,
	nextOccurrence,
	parseLocal,
	type Recurrence,
	toLocal,
	WEEKDAY_NAMES,
	WEEKDAYS,
	type Weekday,
	weekdayOf,
} from "../../core/recurrence.ts";
import type { Embed, Reply } from "../../core/reply.ts";
import { timeOfDayRefusal, whenRefusal } from "../../core/time-help.ts";
import type {
	ActionContext,
	ActionDefinition,
	ActionResult,
	ChoiceOption,
	Control,
	ControlRow,
	Form,
} from "../../core/ui.ts";
import {
	describeWhen,
	formatTimeOfDay,
	parseDays,
	parseTimeOfDay,
	readWhen,
	type WhenProblem,
} from "../../core/when.ts";
import { AttendanceStore } from "../../services/attendance.ts";
import {
	type AttendanceResults,
	MAX_ATTENDANCE_LABEL,
	MAX_MESSAGE_LENGTH,
	MAX_POLL_ANSWER,
	MAX_POLL_ANSWERS,
	MAX_POLL_QUESTION,
	MAX_RESULTS_TEXT,
	type PollReminder,
	type Schedule,
	type ScheduleStore,
} from "../../services/schedules.ts";
import { createAttendancePolls, DEFAULT_CLOSED_TEXT, DEFAULT_STATUS_TEXT } from "./attendance.ts";
import { type Draft, Drafts, REPEATS, type Repeat } from "./drafts.ts";
import { checkFilledLength } from "./limits.ts";
import { runDue } from "./runner.ts";

/** Lets someone schedule messages and polls. Granted with `/admin` → Capabilities. */
export const SCHEDULE_CAPABILITY = {
	name: "schedule-posts",
	description: "Schedule messages and polls in channels they can post in",
};

/** Members (and admins) holding the capability. The command and every action share it. */
const ACCESS: Access = { minTier: "member", capability: SCHEDULE_CAPABILITY.name };

/** How long a poll can stay open, as offered. Read by `core/duration.ts`. */
const DURATIONS = ["1 hour", "4 hours", "8 hours", "1 day", "3 days", "1 week", "2 weeks"] as const;

/** A poll duration in whole hours, or undefined if it isn't one. */
export function pollHours(typed: string): number | undefined {
	const minutes = parseDurationMinutes(typed);
	return minutes !== undefined && minutes % 60 === 0 ? minutes / 60 : undefined;
}

/** How often the runner looks for due posts. */
export const TICK_MS = 30_000;

/** Schedules on one page of the list (Discord shows 25 options in a select). */
export const PAGE_SIZE = 25;

const REPEAT_LABELS: Record<Repeat, string> = {
	once: "Once",
	weekly: "Weekly",
	fortnightly: "Every 2 weeks",
	monthly: "Monthly",
	"every-2-months": "Every 2 months",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The actions behind `/schedule`'s buttons, select menus and forms. */
export const ACTIONS = {
	home: "schedule.home",
	open: "schedule.open",
	new: "schedule.new",
	edit: "schedule.edit",
	details: "schedule.details",
	draft: "schedule.draft",
	days: "schedule.days",
	duration: "schedule.duration",
	toggle: "schedule.toggle",
	reminders: "schedule.reminders",
	reminded: "schedule.reminded",
	counting: "schedule.counting",
	colours: "schedule.colours",
	coloured: "schedule.coloured",
	results: "schedule.results",
	resulted: "schedule.resulted",
	rename: "schedule.rename",
	renamed: "schedule.renamed",
	save: "schedule.save",
	cancel: "schedule.cancel",
	pause: "schedule.pause",
	resume: "schedule.resume",
	delete: "schedule.delete",
	confirmDelete: "schedule.confirm-delete",
} as const;

export const SCHEDULE_MESSAGES = {
	badTime: (problem: WhenProblem, zone: string) =>
		whenRefusal(problem, { field: "When", zone, hint: "Change it in Edit details." }),
	nothingLeft:
		"That would leave it with nothing to post: a one-off needs a time that's still to come. Change **When** in Edit details.",
	noChannel: "Pick a channel in Edit details.",
	noColours: "Colours are for an attendance poll's answers: add them in Edit details first.",
	cantPost:
		"You can only schedule posts in channels where you can post yourself. Pick another channel.",
	cantPoll: "You can't create polls in that channel yourself, so I won't schedule one there.",
	cantPing: "You can't ping everyone in that channel yourself, so turn pings off.",
	emptyMessage: "The message can't be empty.",
	emptyQuestion: "The question can't be empty.",
	draftGone: "That draft has expired, so nothing was saved. Start again.",
	saving: "That's already being saved.",
	scheduleGone: "That schedule doesn't exist any more.",
	notYours: "Only the person who made a schedule can change it.",
	cantResume: "Its time has passed while it was paused, so it can't be resumed. Delete it instead.",
	badReminderTime: (zone: string) =>
		timeOfDayRefusal({ field: "Remind every day at", zone, hint: "Change it in Reminders." }),
	noReminderChannel: "Pick a channel to remind people in, in Reminders.",
	cantRemind:
		"You can only send reminders to channels where you can post yourself. Pick another one in Reminders.",
	badResultsTime: (zone: string) =>
		timeOfDayRefusal({
			field: "Totals so far at",
			zone,
			hint: "Change it in Results, or leave it empty.",
		}),
	cantPostResults:
		"You can only post results in channels where you can post yourself. Pick another one in Results.",
} as const;

export type SchedulesDeps = {
	store: ScheduleStore;
	posts: ChannelPosts;
	timezone: string;
	stillAllowed: (ref: string) => Promise<boolean>;
	/** Fills `{{tokens}}` in the stored body at post time. */
	interpolator: Interpolate;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground" | "breadcrumb">;
	/** Attendance polls and their votes. Defaults to one kept in memory only, for tests. */
	attendance?: AttendanceStore;
	now?: () => Date;
};

/** A draft that's ready to save. */
type Ready = {
	start: LocalDateTime;
	recurrence: Recurrence;
	post: ChannelPost;
	channel: { id: string; name: string };
	name: string;
	reminder?: PollReminder;
	results?: AttendanceResults;
	/** Whether the time or repeat changed, for an edit. */
	retimed: boolean;
};

/**
 * `/schedule`: messages and polls posted in a channel at set times, once or on a
 * repeat. The command opens a private panel; everything else is buttons, select
 * menus and forms on it (see docs/discord-components.md). A new or changed post is
 * a draft until it's saved, so the person sees exactly what will be posted first.
 * People can only schedule into channels they can post in themselves, pings need
 * their permission to ping everyone, and only whoever made a schedule can change it.
 */
export function createSchedulesFeature(deps: SchedulesDeps): Feature {
	const now = deps.now ?? (() => new Date());
	const zone = deps.timezone;
	const drafts = new Drafts(() => now().getTime());
	const attendance = createAttendancePolls({
		store: deps.attendance ?? new AttendanceStore({ logger: deps.logger }),
		posts: deps.posts,
		timezone: zone,
		interpolator: deps.interpolator,
		logger: deps.logger,
		reporter: deps.reporter,
		now,
	});
	/** Drafts being saved. Checks wait on Discord, so a double click mustn't save twice. */
	const saving = new Set<string>();

	// ── Reading what's typed ─────────────────────────────────────────────

	function recurrenceFor(
		repeat: Repeat,
		start: LocalDateTime,
		days: readonly Weekday[] | undefined,
	): Recurrence {
		switch (repeat) {
			case "weekly":
			case "fortnightly":
				return {
					kind: "weekly",
					everyWeeks: repeat === "weekly" ? 1 : 2,
					days: days && days.length > 0 ? [...days] : [weekdayOf(start)],
				};
			case "monthly":
				return { kind: "monthly", everyMonths: 1 };
			case "every-2-months":
				return { kind: "monthly", everyMonths: 2 };
			default:
				return { kind: "once" };
		}
	}

	/** The timing a draft asks for: new, or on top of the schedule it changes. */
	function timingOf(
		draft: Draft,
		schedule: Schedule | undefined,
	): { start: LocalDateTime; recurrence: Recurrence; retimed: boolean } {
		const whenChanged = !schedule || draft.when.trim() !== (draft.whenAsShown ?? "").trim();
		let start: LocalDateTime;
		if (whenChanged) {
			const read = readWhen(draft.when, now(), zone);
			if (!read.ok) throw new UserFacingError(SCHEDULE_MESSAGES.badTime(read.problem, zone));
			start = read.at;
		} else {
			start = parseLocal(schedule.start) as LocalDateTime;
		}
		const recurrence = recurrenceFor(draft.repeat, start, draft.days);
		if (!schedule) return { start, recurrence, retimed: true };
		const retimed =
			formatLocal(start) !== schedule.start ||
			JSON.stringify(recurrence) !== JSON.stringify(schedule.recurrence);
		if (!nextRun({ ...schedule, start: formatLocal(start), recurrence }, zone, now())) {
			throw new UserFacingError(SCHEDULE_MESSAGES.nothingLeft);
		}
		return { start, recurrence, retimed };
	}

	function postOf(draft: Draft): ChannelPost {
		if (draft.kind === "message") {
			const text = draft.text.trim();
			if (text === "") throw new UserFacingError(SCHEDULE_MESSAGES.emptyMessage);
			return { kind: "message", text, mentions: draft.mentions };
		}
		const question = draft.question.trim();
		if (question === "") throw new UserFacingError(SCHEDULE_MESSAGES.emptyQuestion);
		if (draft.kind === "attendance") {
			return {
				kind: "attendance",
				question,
				answers: attendanceAnswers(draft, parseAttendanceAnswers(draft.answers)),
				durationHours: draft.durationHours,
			};
		}
		return {
			kind: "poll",
			question,
			answers: parseAnswers(draft.answers),
			durationHours: draft.durationHours,
			multiple: draft.multiple,
		};
	}

	/** Checks the person and Pixel may make this post in the picked channel. Returns its name. */
	async function checkChannel(
		channel: ResolvedChannel | undefined,
		post: ChannelPost,
	): Promise<{ id: string; name: string }> {
		if (!channel) throw new UserFacingError(SCHEDULE_MESSAGES.noChannel);
		if (!channel.caller.canPost) throw new UserFacingError(SCHEDULE_MESSAGES.cantPost);
		if (post.kind === "poll" && !channel.caller.canCreatePolls) {
			throw new UserFacingError(SCHEDULE_MESSAGES.cantPoll);
		}
		if (post.kind === "message" && post.mentions && !channel.caller.canMentionEveryone) {
			throw new UserFacingError(SCHEDULE_MESSAGES.cantPing);
		}
		const check = await deps.posts.check(channel.id, post);
		if (!check.ok) throw new UserFacingError(`I can't post there: ${check.problem}.`);
		return { id: channel.id, name: check.name };
	}

	/** Everything a draft needs before it can be saved. Throws what's wrong. */
	async function evaluate(draft: Draft): Promise<Ready> {
		const schedule = draft.editing ? deps.store.get(draft.editing) : undefined;
		if (draft.editing && !schedule) throw new UserFacingError(SCHEDULE_MESSAGES.scheduleGone);
		const timing = timingOf(draft, schedule);
		const post = postOf(draft);
		checkFilledLength(post, timing, zone, now(), deps.interpolator);
		const channel = await checkChannel(draft.channel, post);
		const name = draft.name ?? cleanName(post.kind === "message" ? post.text : post.question);
		const reminder = post.kind !== "message" ? await checkReminder(draft) : undefined;
		const results = post.kind === "attendance" ? await checkResults(draft) : undefined;
		return {
			...timing,
			post,
			channel,
			name,
			...(reminder ? { reminder } : {}),
			...(results ? { results } : {}),
		};
	}

	/**
	 * The poll's reminder, if it has one. A channel picked on the form must be one the
	 * person can post in; Pixel must be able to post the reminder there either way.
	 */
	async function checkReminder(draft: Draft): Promise<PollReminder | undefined> {
		if (!draft.reminder) return undefined;
		const time = parseTimeOfDay(draft.reminder.at);
		if (!time) throw new UserFacingError(SCHEDULE_MESSAGES.badReminderTime(zone));
		const channel = draft.reminder.channel;
		if (!channel) throw new UserFacingError(SCHEDULE_MESSAGES.noReminderChannel);
		if (channel.caller && !channel.caller.canPost) {
			throw new UserFacingError(SCHEDULE_MESSAGES.cantRemind);
		}
		const check = await deps.posts.check(channel.id, {
			kind: "message",
			text: ".",
			mentions: false,
		});
		if (!check.ok) throw new UserFacingError(`I can't send reminders there: ${check.problem}.`);
		return { channelId: channel.id, channelName: check.name, at: formatTimeOfDay(time) };
	}

	/**
	 * An attendance poll's results posts, if it has them. Like a reminder: a channel picked
	 * on the form must be one the person can post in, and Pixel must be able to post there.
	 */
	async function checkResults(draft: Draft): Promise<AttendanceResults | undefined> {
		if (!draft.results) return undefined;
		const typed = draft.results.at.trim();
		const time = typed === "" ? undefined : parseTimeOfDay(typed);
		if (typed !== "" && !time) throw new UserFacingError(SCHEDULE_MESSAGES.badResultsTime(zone));
		const channel = draft.results.channel;
		if (channel.caller && !channel.caller.canPost) {
			throw new UserFacingError(SCHEDULE_MESSAGES.cantPostResults);
		}
		const check = await deps.posts.check(channel.id, {
			kind: "message",
			text: ".",
			mentions: false,
		});
		if (!check.ok) throw new UserFacingError(`I can't post results there: ${check.problem}.`);
		return {
			channelId: channel.id,
			channelName: check.name,
			...(time ? { statusAt: formatTimeOfDay(time) } : {}),
			statusText: draft.results.statusText.trim() || DEFAULT_STATUS_TEXT,
			closedText: draft.results.closedText.trim() || DEFAULT_CLOSED_TEXT,
		};
	}

	// ── Whose is what ────────────────────────────────────────────────────

	const owns = (schedule: Schedule, principal: Principal) =>
		schedule.createdBy.ref === actorRef(principal);

	function ownSchedule(ctx: ActionContext): Schedule {
		const schedule = deps.store.get(String(ctx.args.id ?? ""));
		if (!schedule) throw new UserFacingError(SCHEDULE_MESSAGES.scheduleGone);
		if (!owns(schedule, ctx.principal)) {
			ctx.logger.info(
				{ event: "schedule.edit_refused", id: schedule.id, ...actorLogFields(ctx.principal) },
				"refused a change to someone else's schedule",
			);
			throw new UserFacingError(SCHEDULE_MESSAGES.notYours);
		}
		return schedule;
	}

	function ownDraft(ctx: ActionContext): Draft | undefined {
		return drafts.get(String(ctx.args.draft ?? ""), actorRef(ctx.principal));
	}

	// ── Panels ───────────────────────────────────────────────────────────

	const call = (action: string, args: Record<string, string | number> = {}) => ({ action, args });
	const button = (
		label: string,
		action: string,
		args: Record<string, string | number> = {},
		style: "primary" | "secondary" | "success" | "danger" = "secondary",
		disabled = false,
	): Control => ({
		kind: "button",
		label,
		style,
		call: call(action, args),
		...(disabled ? { disabled } : {}),
	});

	/** Soonest first; paused and finished ones last. */
	function sorted(schedules: readonly Schedule[]): Schedule[] {
		const at = new Date(now());
		const key = (s: Schedule) => (s.paused ? undefined : nextRun(s, zone, at)?.getTime());
		return [...schedules].sort((a, b) => {
			const ka = key(a);
			const kb = key(b);
			if (ka === undefined || kb === undefined) {
				return ka === kb ? 0 : ka === undefined ? 1 : -1;
			}
			return ka - kb;
		});
	}

	function home(principal: Principal, page = 0, notice?: string): Reply {
		const all = sorted(deps.store.all());
		const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
		const current = Math.min(Math.max(0, page), pages - 1);
		const shown = all.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
		const mine = all.filter((s) => owns(s, principal)).length;
		const paused = all.filter((s) => s.paused).length;
		const lines = [
			...(notice ? [notice, ""] : []),
			all.length === 0
				? "Nothing is scheduled yet. Make a message, a poll or an attendance poll with the buttons below."
				: [
						`**${all.length}** scheduled · **${mine}** yours${paused > 0 ? ` · **${paused}** paused` : ""}`,
						"Choose one to see what it will post, change it or delete it.",
					].join("\n"),
			...(pages > 1 ? [`Page ${current + 1} of ${pages}.`] : []),
			`Times are in ${zone}.`,
		];
		const rows: ControlRow[] = [];
		if (shown.length > 0) {
			rows.push([
				{
					kind: "select",
					placeholder: "Choose a schedule…",
					call: call(ACTIONS.open),
					arg: "id",
					options: shown.map((s) => scheduleOption(s, principal)),
				},
			]);
		}
		rows.push([
			button("New message", ACTIONS.new, { kind: "message" }, "primary"),
			button("New poll", ACTIONS.new, { kind: "poll" }),
			button("New attendance poll", ACTIONS.new, { kind: "attendance" }),
		]);
		if (pages > 1) {
			rows.push([
				button("‹ Previous", ACTIONS.home, { page: current - 1 }, "secondary", current === 0),
				button("Next ›", ACTIONS.home, { page: current + 1 }, "secondary", current >= pages - 1),
			]);
		}
		return {
			embeds: [{ title: "Scheduled posts", description: lines.join("\n"), accent: "brand" }],
			private: true,
			controls: rows,
		};
	}

	/** One option in the list. Plain text: select menus don't show markdown. */
	function scheduleOption(schedule: Schedule, principal: Principal): ChoiceOption {
		const next = schedule.paused ? undefined : nextRun(schedule, zone, now());
		const parts = [
			`#${schedule.channelName}`,
			schedule.paused ? "paused" : next ? `next ${describeWhen(toLocal(next, zone))}` : "finished",
			repeatLabel(schedule),
			...(owns(schedule, principal) ? [] : [`by ${schedule.createdBy.name}`]),
		];
		return {
			label: `${icon(schedule.post)} ${schedule.name}`,
			value: schedule.id,
			description: parts.join(" · "),
		};
	}

	function repeatLabel(schedule: Pick<Schedule, "start" | "recurrence">): string {
		const start = parseLocal(schedule.start) as LocalDateTime;
		const r = schedule.recurrence;
		switch (r.kind) {
			case "weekly":
				return `${r.everyWeeks === 2 ? "every 2 weeks" : "weekly"} on ${listDays(r.days)}`;
			case "monthly":
				return `${r.everyMonths === 2 ? "every 2 months" : "monthly"} on the ${ordinal(start.day)}`;
			default:
				return "once";
		}
	}

	function detail(schedule: Schedule, principal: Principal, notice?: string): Reply {
		const mine = owns(schedule, principal);
		const next = nextRun(schedule, zone, now());
		const status = schedule.paused
			? next
				? "⏸ **Paused.** It won't post until it's resumed."
				: `⏸ **Paused.** ${SCHEDULE_MESSAGES.cantResume}`
			: next
				? `Next post: **${describeWhen(toLocal(next, zone))}** (${zone}).`
				: "It has nothing left to post.";
		const post = filledPost(schedule, deps.interpolator, zone, now());
		const description = [
			...(notice ? [notice, ""] : []),
			status,
			mine
				? "Made by you."
				: `Made by ${escapeMarkdown(schedule.createdBy.name)}. Only they can change it.`,
			"",
			post.kind === "message"
				? "Above is what it will post next time, with dates filled in. Pings don't fire here."
				: "Below is the poll it will post next time, with dates filled in.",
		].join("\n");
		const times = schedule.paused ? [] : upcoming(schedule, zone, now(), 3);
		const summary: Embed = {
			title: `${icon(post)} ${escapeMarkdown(schedule.name)}`,
			description,
			fields: [
				{ name: "Channel", value: `#${escapeMarkdown(schedule.channelName)}`, inline: true },
				{ name: "Repeats", value: capitalise(repeatLabel(schedule)), inline: true },
				{ name: "What", value: describeWhat(schedule.post) },
				...(schedule.reminder
					? [{ name: "Reminders", value: describeReminder(schedule.reminder, zone) }]
					: []),
				...(schedule.post.kind === "attendance"
					? [{ name: "Results", value: describeResults(schedule.results, zone) }]
					: []),
				...(times.length > 0
					? [
							{
								name: `Next posts (${zone})`,
								value: times.map((t) => `• ${describeWhen(toLocal(t, zone))}`).join("\n"),
							},
						]
					: []),
			],
			accent: schedule.paused || !next ? "neutral" : "brand",
		};
		const actions: Control[] = [];
		if (mine) {
			if (next) actions.push(button("Edit", ACTIONS.edit, { id: schedule.id }, "primary"));
			if (schedule.paused) {
				if (next) actions.push(button("Resume", ACTIONS.resume, { id: schedule.id }));
			} else if (next) {
				actions.push(button("Pause", ACTIONS.pause, { id: schedule.id }));
			}
			actions.push(button("Delete", ACTIONS.delete, { id: schedule.id }, "danger"));
		}
		const rows: ControlRow[] = [
			...(actions.length > 0 ? [actions] : []),
			[button("← All schedules", ACTIONS.home)],
		];
		if (post.kind === "message") {
			return {
				text: post.text.slice(0, 2000),
				embeds: [summary],
				private: true,
				controls: rows,
			};
		}
		return { embeds: [summary, pollPreviewEmbed(post)], private: true, controls: rows };
	}

	function confirmDelete(schedule: Schedule): Reply {
		return {
			embeds: [
				{
					title: `Delete ${escapeMarkdown(schedule.name)}?`,
					description: "It won't post again. This can't be undone.",
					accent: "warning",
				},
			],
			private: true,
			controls: [
				[
					button("Delete schedule", ACTIONS.confirmDelete, { id: schedule.id }, "danger"),
					button("Cancel", ACTIONS.open, { id: schedule.id }),
				],
			],
		};
	}

	async function draftPanel(draft: Draft): Promise<Reply> {
		let ready: Ready | undefined;
		let problem: string | undefined;
		try {
			ready = await evaluate(draft);
		} catch (error) {
			if (!(error instanceof UserFacingError)) throw error;
			problem = error.message;
		}
		const editing = draft.editing !== undefined;
		const saveLabel = editing ? "Save changes" : "Schedule";
		const what = WHAT[draft.kind];
		const lines: string[] = [];
		let preview: ChannelPost | undefined;
		if (ready) {
			const first = nextOccurrence(ready.start, ready.recurrence, zone, now()) as Date;
			const occurrence = editing && !ready.retimed ? nextRunOf(draft, first) : first;
			preview = interpolateChannelPost(ready.post, (text) =>
				deps.interpolator.interpolate(text, occurrence),
			);
			lines.push(
				`Nothing is saved until you press **${saveLabel}**.`,
				"",
				`**#${escapeMarkdown(ready.channel.name)}** · ${editing ? "next" : "first"} post **${describeWhen(toLocal(occurrence, zone))}** (${zone}) · ${repeatLabel({ start: formatLocal(ready.start), recurrence: ready.recurrence })}`,
			);
		} else {
			lines.push(`⚠️ ${problem}`, "", `Nothing is saved until you press **${saveLabel}**.`);
		}
		const name =
			draft.name ?? cleanName(draft.kind === "message" ? draft.text.trim() : draft.question.trim());
		const summary: Embed = {
			title: editing ? `Changes to ${escapeMarkdown(name)}` : `New ${what}`,
			description: lines.join("\n"),
			fields: [
				{ name: "Name", value: escapeMarkdown(name), inline: true },
				{ name: "What", value: describeWhat(postSettings(draft)), inline: true },
				...(draft.kind !== "message"
					? [
							{
								name: "Reminders",
								value: ready?.reminder
									? describeReminder(ready.reminder, zone)
									: draft.reminder
										? "Not set up yet: see above"
										: "None",
							},
						]
					: []),
				...(draft.kind === "attendance"
					? [
							{
								name: "Results",
								value: ready
									? describeResults(ready.results, zone)
									: draft.results
										? "Not set up yet: see above"
										: describeResults(undefined, zone),
							},
						]
					: []),
			],
			accent: ready ? "brand" : "warning",
		};
		const rows: ControlRow[] = [];
		if (draft.repeat === "weekly" || draft.repeat === "fortnightly") {
			const chosen = new Set(
				ready?.recurrence.kind === "weekly" ? ready.recurrence.days : (draft.days ?? []),
			);
			rows.push([
				{
					kind: "select",
					placeholder: "Which days?",
					call: call(ACTIONS.days, { draft: draft.id }),
					arg: "days",
					min: 1,
					max: WEEKDAYS.length,
					options: WEEKDAYS.map((day) => ({
						label: `Repeat on ${WEEKDAY_NAMES[day]}`,
						value: day,
						...(chosen.has(day) ? { selected: true } : {}),
					})),
				},
			]);
		}
		if (draft.kind !== "message") {
			rows.push([
				{
					kind: "select",
					placeholder: "How long can people vote?",
					call: call(ACTIONS.duration, { draft: draft.id }),
					arg: "duration",
					options: DURATIONS.map((d) => ({
						label: `Open for ${d}`,
						value: d,
						...(pollHours(d) === draft.durationHours ? { selected: true } : {}),
					})),
				},
			]);
		}
		const answers = draft.kind === "attendance" ? tryAttendanceAnswers(draft.answers) : undefined;
		if (answers) {
			const counting = countingOf(draft, answers.length);
			rows.push([
				{
					kind: "select",
					placeholder: "Which answers count as coming?",
					call: call(ACTIONS.counting, { draft: draft.id }),
					arg: "counting",
					min: 1,
					max: answers.length,
					options: answers.map((label, i) => ({
						label: `Counts as coming: ${[...label].slice(0, 70).join("")}`,
						value: String(i),
						...(counting.includes(i) ? { selected: true } : {}),
					})),
				},
			]);
		}
		if (draft.kind !== "message") {
			rows.push([
				...(draft.kind === "poll"
					? [
							button(`Several answers: ${draft.multiple ? "on" : "off"}`, ACTIONS.toggle, {
								draft: draft.id,
								setting: "multiple",
							}),
						]
					: []),
				button(
					draft.reminder
						? `Reminders: daily at ${reminderClock(draft.reminder.at)}`
						: "Reminders: off",
					ACTIONS.reminders,
					{ draft: draft.id },
				),
				...(draft.kind === "attendance"
					? [
							button(
								draft.results
									? `Results: in #${[...draft.results.channel.name].slice(0, 20).join("")}`
									: "Results: off",
								ACTIONS.results,
								{ draft: draft.id },
							),
							...(answers
								? [
										button(
											`Colours: ${colourSummary(coloursOf(draft, answers.length))}`,
											ACTIONS.colours,
											{ draft: draft.id },
										),
									]
								: []),
						]
					: []),
			]);
		} else if (draft.mentions || draft.channel?.caller.canMentionEveryone) {
			// Only offered where the person could ping everyone themselves, or to turn it off.
			rows.push([
				button(`Pings: ${draft.mentions ? "on" : "off"}`, ACTIONS.toggle, {
					draft: draft.id,
					setting: "mentions",
				}),
			]);
		}
		rows.push([
			button(saveLabel, ACTIONS.save, { draft: draft.id }, "success", !ready),
			button("Edit details", ACTIONS.details, { draft: draft.id }, ready ? "secondary" : "primary"),
			button("Rename", ACTIONS.rename, { draft: draft.id }),
			button("Cancel", ACTIONS.cancel, { draft: draft.id }),
		]);
		if (preview?.kind === "message") {
			return {
				text: preview.text.slice(0, 2000),
				embeds: [summary],
				private: true,
				controls: rows,
			};
		}
		return {
			...(draft.kind === "message" && draft.text.trim() !== ""
				? { text: draft.text.trim().slice(0, 2000) }
				: {}),
			embeds: [summary, ...(preview ? [pollPreviewEmbed(preview)] : [])],
			private: true,
			controls: rows,
		};
	}

	/** For an unchanged edit, the occurrence the schedule itself would post next. */
	function nextRunOf(draft: Draft, fallback: Date): Date {
		const schedule = deps.store.get(draft.editing as string);
		return (schedule && nextRun(schedule, zone, now())) ?? fallback;
	}

	function detailsForm(draft: Draft): Form {
		const editing = draft.editing !== undefined;
		const what = WHAT[draft.kind];
		const attending = draft.kind === "attendance";
		const body =
			draft.kind === "message"
				? [
						{
							kind: "text" as const,
							name: "text",
							label: "Message",
							style: "paragraph" as const,
							maxLength: MAX_MESSAGE_LENGTH,
							placeholder:
								"What to post. Markdown works. {{date}} and {{date+2}} fill in when it's posted.",
							...(draft.text ? { value: draft.text } : {}),
						},
					]
				: [
						{
							kind: "text" as const,
							name: "question",
							label: "Question",
							style: "short" as const,
							maxLength: MAX_POLL_QUESTION,
							placeholder: "Who's coming? {{date}} fills in when it's posted.",
							...(draft.question ? { value: draft.question } : {}),
						},
						{
							kind: "text" as const,
							name: "answers",
							label: attending
								? `Answers, one per line (1 to ${MAX_ATTENDANCE_ANSWERS})`
								: `Answers, one per line (2 to ${MAX_POLL_ANSWERS})`,
							...(attending
								? {
										description:
											"A button each. Pick which count as coming after this. Pressing one again takes it back.",
									}
								: {}),
							style: "paragraph" as const,
							maxLength: attending
								? MAX_ATTENDANCE_ANSWERS * (MAX_ATTENDANCE_LABEL + 1)
								: MAX_POLL_ANSWERS * (MAX_POLL_ANSWER + 1),
							placeholder: attending ? "Coming\nNot coming" : "Yes\nNo\nMaybe",
							...(draft.answers ? { value: draft.answers } : {}),
						},
					];
		return {
			title: editing ? `Edit ${what}` : `New ${what}`,
			submit: call(ACTIONS.draft, { draft: draft.id }),
			fields: [
				{
					kind: "channel",
					name: "channel",
					label: "Channel",
					description: "Where to post it. You need to be able to post there yourself.",
					...(draft.channel ? { value: draft.channel.id } : {}),
				},
				{
					kind: "text",
					name: "when",
					label: editing ? "When (leave it to keep the timing)" : "When",
					description: `In ${zone}. A day, a time or both.`,
					style: "short",
					maxLength: 100,
					placeholder: "wed 1900 · tomorrow 9am · 14 oct 19:00 · now+1h",
					...(draft.when ? { value: draft.when } : {}),
				},
				{
					kind: "radio",
					name: "repeat",
					label: "Repeat",
					options: REPEATS.map((r) => ({
						label: REPEAT_LABELS[r],
						value: r,
						...(r === draft.repeat ? { selected: true } : {}),
					})),
				},
				...body,
			],
		};
	}

	function remindersForm(draft: Draft): Form {
		const channel = draft.reminder?.channel;
		return {
			title: "Reminders",
			submit: call(ACTIONS.reminded, { draft: draft.id }),
			fields: [
				{
					kind: "text",
					name: "remind-at",
					label: "Remind every day at",
					description: `A time of day in ${zone}, not in the poll's last 30 minutes. Empty for none.`,
					style: "short",
					maxLength: 20,
					placeholder: "18:00",
					required: false,
					...(draft.reminder ? { value: draft.reminder.at } : {}),
				},
				{
					kind: "channel",
					name: "remind-in",
					label: "Remind people in",
					description: "Where to post the reminder. You need to be able to post there yourself.",
					required: false,
					...(channel ? { value: channel.id } : {}),
				},
			],
		};
	}

	function coloursForm(draft: Draft, answers: readonly string[]): Form {
		const colours = coloursOf(draft, answers.length);
		return {
			title: "Button colours",
			submit: call(ACTIONS.coloured, { draft: draft.id }),
			fields: answers.map((label, i) => ({
				kind: "radio" as const,
				name: `colour-${i}`,
				// Answers are at most 40 characters, which fits a field's label.
				label,
				options: ATTENDANCE_COLOURS.map((colour) => ({
					label: COLOUR_NAMES[colour],
					value: colour,
					...(colours[i] === colour ? { selected: true } : {}),
				})),
			})),
		};
	}

	function resultsForm(draft: Draft): Form {
		const results = draft.results;
		const tokens = "{{count}}, {{names}}, {{question}}, {{link}} and {{date}} fill in.";
		return {
			title: "Results",
			submit: call(ACTIONS.resulted, { draft: draft.id }),
			fields: [
				{
					kind: "channel",
					name: "results-in",
					label: "Post the results in",
					description: "You need to be able to post there yourself. Empty for no results posts.",
					required: false,
					...(results ? { value: results.channel.id } : {}),
				},
				{
					kind: "text",
					name: "status-at",
					label: "Totals so far at",
					description: `A time of day in ${zone}, on the day it closes. Empty for none.`,
					style: "short",
					maxLength: 20,
					placeholder: "17:00",
					required: false,
					...(results?.at ? { value: results.at } : {}),
				},
				{
					kind: "text",
					name: "status-text",
					label: "Totals so far say",
					description: tokens,
					style: "paragraph",
					maxLength: MAX_RESULTS_TEXT,
					placeholder: DEFAULT_STATUS_TEXT,
					required: false,
					...(results?.statusText ? { value: results.statusText } : {}),
				},
				{
					kind: "text",
					name: "closed-text",
					label: "When it closes, say",
					description: tokens,
					style: "paragraph",
					maxLength: MAX_RESULTS_TEXT,
					placeholder: DEFAULT_CLOSED_TEXT,
					required: false,
					...(results?.closedText ? { value: results.closedText } : {}),
				},
			],
		};
	}

	function renameForm(draft: Draft): Form {
		return {
			title: "Rename",
			submit: call(ACTIONS.renamed, { draft: draft.id }),
			fields: [
				{
					kind: "text",
					name: "name",
					label: "Name",
					description: "How it shows in the list. Leave it empty to use the start of the text.",
					style: "short",
					maxLength: 60,
					required: false,
					...(draft.name ? { value: draft.name } : {}),
				},
			],
		};
	}

	/** Back to the home list, saying why, when a draft has gone. */
	const draftGone = (ctx: ActionContext): ActionResult => ({
		reply: home(ctx.principal, 0, `⚠️ ${SCHEDULE_MESSAGES.draftGone}`),
	});

	// ── Saving ───────────────────────────────────────────────────────────

	async function save(ctx: ActionContext, draft: Draft): Promise<Reply> {
		if (saving.has(draft.id)) throw new UserFacingError(SCHEDULE_MESSAGES.saving);
		saving.add(draft.id);
		try {
			return await saveOnce(ctx, draft);
		} finally {
			saving.delete(draft.id);
		}
	}

	async function saveOnce(ctx: ActionContext, draft: Draft): Promise<Reply> {
		let ready: Ready;
		try {
			ready = await evaluate(draft);
		} catch (error) {
			if (error instanceof UserFacingError) return draftPanel(draft);
			throw error;
		}
		const { start, recurrence, post, channel, name, retimed, reminder, results } = ready;
		if (draft.editing === undefined) {
			const schedule = deps.store.add({
				name,
				channelId: channel.id,
				channelName: channel.name,
				post,
				start: formatLocal(start),
				recurrence,
				paused: false,
				createdBy: { ref: actorRef(ctx.principal), name: ctx.principal.displayName },
				createdAt: now().toISOString(),
				lastRunAt: null,
				...(reminder ? { reminder } : {}),
				...(results ? { results } : {}),
			});
			drafts.remove(draft.id);
			ctx.logger.info(
				{
					event: "schedule.created",
					id: schedule.id,
					channelId: channel.id,
					kind: post.kind,
					recurrence: recurrence.kind,
					reminderChannelId: reminder?.channelId,
				},
				"scheduled a post",
			);
			deps.reporter.breadcrumb("schedule", `created ${schedule.id}`, { id: schedule.id });
			return detail(schedule, ctx.principal, "✅ **Scheduled.**");
		}
		const schedule = ownSchedule({ ...ctx, args: { id: draft.editing } });
		const updated = deps.store.update(schedule.id, {
			post,
			name,
			channelId: channel.id,
			channelName: channel.name,
			start: formatLocal(start),
			recurrence,
			reminder,
			results,
			// New timing counts from now, like resume: nothing it "missed" before the edit goes out.
			...(retimed ? { lastRunAt: fromNow(schedule, now()) } : {}),
		});
		drafts.remove(draft.id);
		if (!updated) throw new UserFacingError(SCHEDULE_MESSAGES.scheduleGone);
		ctx.logger.info(
			{
				event: "schedule.edited",
				id: updated.id,
				kind: post.kind,
				...actorLogFields(ctx.principal),
			},
			"edited a schedule",
		);
		deps.reporter.breadcrumb("schedule", `edited ${updated.id}`, { id: updated.id });
		return detail(updated, ctx.principal, "✅ **Saved.**");
	}

	// ── Actions ──────────────────────────────────────────────────────────

	const id: CommandOption = {
		name: "id",
		description: "Which schedule",
		type: "string",
		required: true,
	};
	const draftId: CommandOption = {
		name: "draft",
		description: "Which draft",
		type: "string",
		required: true,
	};
	const action = (
		name: string,
		options: readonly CommandOption[],
		handler: (ctx: ActionContext) => Promise<ActionResult> | ActionResult,
	): ActionDefinition => ({ name, access: ACCESS, options, handler: async (ctx) => handler(ctx) });
	/** An action on one of the caller's drafts; an expired one goes back to the list. */
	const onDraft = (
		name: string,
		options: readonly CommandOption[],
		handler: (ctx: ActionContext, draft: Draft) => Promise<ActionResult> | ActionResult,
	) =>
		action(name, [draftId, ...options], (ctx) => {
			const draft = ownDraft(ctx);
			return draft ? handler(ctx, draft) : draftGone(ctx);
		});
	/** An action on a schedule; one that's gone goes back to the list. */
	const onSchedule = (
		name: string,
		handler: (ctx: ActionContext) => Promise<ActionResult> | ActionResult,
	) =>
		action(name, [id], (ctx) =>
			deps.store.get(String(ctx.args.id))
				? handler(ctx)
				: { reply: home(ctx.principal, 0, `⚠️ ${SCHEDULE_MESSAGES.scheduleGone}`) },
		);

	const actions: ActionDefinition[] = [
		action(ACTIONS.home, [{ name: "page", description: "Which page", type: "integer" }], (ctx) => ({
			reply: home(ctx.principal, Number(ctx.args.page ?? 0)),
		})),
		onSchedule(ACTIONS.open, (ctx) => ({
			reply: detail(deps.store.get(String(ctx.args.id)) as Schedule, ctx.principal),
		})),
		action(
			ACTIONS.new,
			[
				{
					name: "kind",
					description: "Message, poll or attendance poll",
					type: "string",
					required: true,
					choices: ["message", "poll", "attendance"],
				},
			],
			(ctx) => {
				const draft = drafts.create({
					owner: actorRef(ctx.principal),
					kind:
						ctx.args.kind === "poll" || ctx.args.kind === "attendance" ? ctx.args.kind : "message",
					when: "",
					repeat: "once",
					text: "",
					mentions: false,
					question: "",
					answers: "",
					durationHours: 24,
					multiple: false,
				});
				return { form: detailsForm(draft) };
			},
		),
		onSchedule(ACTIONS.edit, (ctx) => {
			const schedule = ownSchedule(ctx);
			const next = nextRun(schedule, zone, now());
			if (!next) throw new UserFacingError(SCHEDULE_MESSAGES.nothingLeft);
			const when = typedWhen(toLocal(next, zone));
			const draft = drafts.create({
				owner: actorRef(ctx.principal),
				editing: schedule.id,
				kind: schedule.post.kind,
				// Picked again on the form, which says what the person may do there now.
				when,
				whenAsShown: when,
				repeat: repeatOf(schedule.recurrence),
				...(schedule.recurrence.kind === "weekly" ? { days: schedule.recurrence.days } : {}),
				text: schedule.post.kind === "message" ? schedule.post.text : "",
				mentions: schedule.post.kind === "message" && schedule.post.mentions,
				question: schedule.post.kind === "message" ? "" : schedule.post.question,
				answers: answersText(schedule.post),
				durationHours: schedule.post.kind === "message" ? 24 : schedule.post.durationHours,
				multiple: schedule.post.kind === "poll" && schedule.post.multiple,
				...(schedule.post.kind === "attendance"
					? {
							counting: schedule.post.answers.flatMap((a, i) => (a.counts ? [i] : [])),
							colours: schedule.post.answers.map((a) => a.colour ?? "grey"),
						}
					: {}),
				...(schedule.results
					? {
							results: {
								at: schedule.results.statusAt ?? "",
								statusText: schedule.results.statusText,
								closedText: schedule.results.closedText,
								channel: { id: schedule.results.channelId, name: schedule.results.channelName },
							},
						}
					: {}),
				name: schedule.name,
				...(schedule.reminder
					? {
							reminder: {
								at: schedule.reminder.at,
								channel: { id: schedule.reminder.channelId, name: schedule.reminder.channelName },
							},
						}
					: {}),
			});
			const form = detailsForm(draft);
			// The channel picker opens on the schedule's channel.
			return {
				form: {
					...form,
					fields: form.fields.map((f) =>
						f.kind === "channel" ? { ...f, value: schedule.channelId } : f,
					),
				},
			};
		}),
		onDraft(ACTIONS.details, [], (_, draft) => ({ form: detailsForm(draft) })),
		onDraft(
			ACTIONS.draft,
			[
				{ name: "channel", description: "Where", type: "channel", required: true },
				{ name: "when", description: "When", type: "string", required: true },
				{ name: "repeat", description: "Repeat", type: "string", required: true, choices: REPEATS },
				{ name: "text", description: "Message", type: "string" },
				{ name: "question", description: "Question", type: "string" },
				{ name: "answers", description: "Answers", type: "string" },
			],
			async (ctx, draft) => {
				const repeat = ctx.args.repeat as Repeat;
				const updated = drafts.update(draft, {
					channel: ctx.channels.channel,
					when: String(ctx.args.when),
					repeat,
					// Days only mean something for a weekly repeat.
					...(repeat === "weekly" || repeat === "fortnightly" ? {} : { days: undefined }),
					...(draft.kind === "message"
						? { text: String(ctx.args.text ?? "") }
						: {
								question: String(ctx.args.question ?? ""),
								answers: String(ctx.args.answers ?? ""),
							}),
				});
				return { reply: await draftPanel(updated) };
			},
		),
		onDraft(
			ACTIONS.days,
			[{ name: "days", description: "Which days", type: "string", required: true }],
			async (ctx, draft) => {
				const days = parseDays(String(ctx.args.days));
				if (!days || days.length === 0) throw new UserFacingError("Choose at least one day.");
				return { reply: await draftPanel(drafts.update(draft, { days })) };
			},
		),
		onDraft(
			ACTIONS.duration,
			[
				{
					name: "duration",
					description: "How long",
					type: "string",
					required: true,
					choices: DURATIONS,
				},
			],
			async (ctx, draft) => {
				const durationHours = pollHours(String(ctx.args.duration)) as number;
				return { reply: await draftPanel(drafts.update(draft, { durationHours })) };
			},
		),
		onDraft(
			ACTIONS.toggle,
			[
				{
					name: "setting",
					description: "Which setting",
					type: "string",
					required: true,
					choices: ["mentions", "multiple"],
				},
			],
			async (ctx, draft) => {
				const change =
					ctx.args.setting === "mentions"
						? { mentions: !draft.mentions }
						: { multiple: !draft.multiple };
				return { reply: await draftPanel(drafts.update(draft, change)) };
			},
		),
		onDraft(ACTIONS.reminders, [], (_, draft) => {
			if (draft.kind === "message") throw new UserFacingError("Reminders only work for polls.");
			return { form: remindersForm(draft) };
		}),
		onDraft(
			ACTIONS.counting,
			[{ name: "counting", description: "Which answers count", type: "string", required: true }],
			async (ctx, draft) => {
				const answers = tryAttendanceAnswers(draft.answers);
				const picked = String(ctx.args.counting)
					.split(",")
					.map((v) => v.trim())
					.filter((v) => /^\d$/.test(v))
					.map(Number)
					.filter((i) => answers !== undefined && i < answers.length);
				if (draft.kind !== "attendance" || picked.length === 0) {
					throw new UserFacingError("Choose at least one answer that counts as coming.");
				}
				return {
					reply: await draftPanel(drafts.update(draft, { counting: [...new Set(picked)] })),
				};
			},
		),
		onDraft(ACTIONS.colours, [], (_, draft) => {
			const answers = draft.kind === "attendance" ? tryAttendanceAnswers(draft.answers) : undefined;
			if (!answers) throw new UserFacingError(SCHEDULE_MESSAGES.noColours);
			return { form: coloursForm(draft, answers) };
		}),
		onDraft(
			ACTIONS.coloured,
			Array.from({ length: MAX_ATTENDANCE_ANSWERS }, (_, i) => ({
				name: `colour-${i}`,
				description: `Answer ${i + 1}'s colour`,
				type: "string" as const,
			})),
			async (ctx, draft) => {
				const answers =
					draft.kind === "attendance" ? tryAttendanceAnswers(draft.answers) : undefined;
				if (!answers) throw new UserFacingError(SCHEDULE_MESSAGES.noColours);
				// Anything that isn't one of the colours keeps what it was.
				const before = coloursOf(draft, answers.length);
				const colours = answers.map((_, i) => {
					const picked = ctx.args[`colour-${i}`];
					return isColour(picked) ? picked : (before[i] ?? "grey");
				});
				return { reply: await draftPanel(drafts.update(draft, { colours })) };
			},
		),
		onDraft(ACTIONS.results, [], (_, draft) => {
			if (draft.kind !== "attendance") {
				throw new UserFacingError("Results only work for attendance polls.");
			}
			return { form: resultsForm(draft) };
		}),
		onDraft(
			ACTIONS.resulted,
			[
				{ name: "results-in", description: "Where", type: "channel" },
				{ name: "status-at", description: "When", type: "string" },
				{ name: "status-text", description: "Totals so far", type: "string" },
				{ name: "closed-text", description: "When it closes", type: "string" },
			],
			async (ctx, draft) => {
				const text = (name: string) =>
					typeof ctx.args[name] === "string" ? (ctx.args[name] as string).trim() : "";
				const picked = ctx.channels["results-in"];
				const updated = drafts.update(draft, {
					// No channel means no results posts.
					results: picked
						? {
								at: text("status-at"),
								statusText: text("status-text"),
								closedText: text("closed-text"),
								channel: { id: picked.id, name: picked.name, caller: picked.caller },
							}
						: undefined,
				});
				return { reply: await draftPanel(updated) };
			},
		),
		onDraft(
			ACTIONS.reminded,
			[
				{ name: "remind-at", description: "When", type: "string" },
				{ name: "remind-in", description: "Where", type: "channel" },
			],
			async (ctx, draft) => {
				const at = typeof ctx.args["remind-at"] === "string" ? ctx.args["remind-at"].trim() : "";
				const picked = ctx.channels["remind-in"];
				const updated = drafts.update(draft, {
					// No time means no reminders.
					reminder:
						at === ""
							? undefined
							: {
									at,
									...(picked
										? { channel: { id: picked.id, name: picked.name, caller: picked.caller } }
										: {}),
								},
				});
				return { reply: await draftPanel(updated) };
			},
		),
		onDraft(ACTIONS.rename, [], (_, draft) => ({ form: renameForm(draft) })),
		onDraft(
			ACTIONS.renamed,
			[{ name: "name", description: "Name", type: "string" }],
			async (ctx, draft) => {
				const typed = typeof ctx.args.name === "string" ? ctx.args.name.trim() : "";
				const updated = drafts.update(draft, { name: typed === "" ? undefined : cleanName(typed) });
				return { reply: await draftPanel(updated) };
			},
		),
		onDraft(ACTIONS.save, [], async (ctx, draft) => ({ reply: await save(ctx, draft) })),
		onDraft(ACTIONS.cancel, [], (ctx, draft) => {
			drafts.remove(draft.id);
			const schedule = draft.editing ? deps.store.get(draft.editing) : undefined;
			return {
				reply: schedule
					? detail(schedule, ctx.principal, "Nothing was changed.")
					: home(ctx.principal, 0, "Nothing was saved."),
			};
		}),
		onSchedule(ACTIONS.pause, (ctx) => {
			const schedule = ownSchedule(ctx);
			const paused = deps.store.update(schedule.id, { paused: true }) as Schedule;
			ctx.logger.info({ event: "schedule.paused", id: schedule.id }, "paused a schedule");
			return {
				reply: detail(paused, ctx.principal, "⏸ **Paused.** It won't post until you resume it."),
			};
		}),
		onSchedule(ACTIONS.resume, (ctx) => {
			const schedule = ownSchedule(ctx);
			// Counts from the same instant as the lastRunAt saved below, so it's the post it will make.
			if (!nextRun(schedule, zone, now())) throw new UserFacingError(SCHEDULE_MESSAGES.cantResume);
			// From now on: nothing missed while it was paused is posted.
			const resumed = deps.store.update(schedule.id, {
				paused: false,
				lastRunAt: fromNow(schedule, now()),
			}) as Schedule;
			ctx.logger.info({ event: "schedule.resumed", id: schedule.id }, "resumed a schedule");
			return { reply: detail(resumed, ctx.principal, "▶️ **Resumed.**") };
		}),
		onSchedule(ACTIONS.delete, (ctx) => ({ reply: confirmDelete(ownSchedule(ctx)) })),
		onSchedule(ACTIONS.confirmDelete, (ctx) => {
			const schedule = ownSchedule(ctx);
			deps.store.remove(schedule.id);
			ctx.logger.info({ event: "schedule.deleted", id: schedule.id }, "deleted a schedule");
			deps.reporter.breadcrumb("schedule", `deleted ${schedule.id}`, { id: schedule.id });
			return {
				reply: home(ctx.principal, 0, `🗑 Deleted **${escapeMarkdown(schedule.name)}**.`),
			};
		}),
	];

	return {
		name: "schedules",
		commands: [
			{
				name: "schedule",
				description: "Schedule messages and polls, and manage them",
				access: ACCESS,
				private: true,
				handler: async (ctx) => home(ctx.principal),
			},
		],
		actions: [...actions, attendance.action],
		start: () => {
			const handled = new Set<string>();
			let running = false;
			const tick = async () => {
				if (running) return;
				running = true;
				try {
					await runDue({ ...deps, attendance, handled }, now());
				} catch (error) {
					// runDue doesn't throw, but nothing from a timer may escape.
					deps.logger.error({ event: "schedule.tick_failed", err: error }, "schedule check failed");
				} finally {
					running = false;
				}
			};
			const timer = setInterval(() => void tick(), TICK_MS);
			timer.unref();
			void tick();
			return () => clearInterval(timer);
		},
	};
}

/** The settings part of a draft, as a post, for describing it. */
function postSettings(draft: Draft): ChannelPost {
	if (draft.kind === "attendance") {
		return {
			kind: "attendance",
			question: draft.question,
			answers: attendanceAnswers(draft, tryAttendanceAnswers(draft.answers) ?? []),
			durationHours: draft.durationHours,
		};
	}
	return draft.kind === "message"
		? { kind: "message", text: draft.text, mentions: draft.mentions }
		: {
				kind: "poll",
				question: draft.question,
				answers: [],
				durationHours: draft.durationHours,
				multiple: draft.multiple,
			};
}

function describeWhat(post: ChannelPost): string {
	if (post.kind === "attendance") {
		const counted = post.answers.filter((a) => a.counts).map((a) => `“${escapeMarkdown(a.label)}”`);
		return `An attendance poll open for ${durationLabel(post.durationHours)}${counted.length > 0 ? `, counting ${counted.join(" and ")} as coming` : ""}`;
	}
	return post.kind === "message"
		? `A message, pings ${post.mentions ? "on" : "off"}`
		: `A poll open for ${durationLabel(post.durationHours)}, ${post.multiple ? "several answers allowed" : "one answer each"}`;
}

/** A time as someone would type it, and `parseWhen` reads back: "6 nov 2026 19:00". */
function typedWhen(t: LocalDateTime): string {
	return `${t.day} ${MONTHS[t.month - 1]} ${t.year} ${formatTimeOfDay(t)}`;
}

function repeatOf(recurrence: Recurrence): Repeat {
	switch (recurrence.kind) {
		case "weekly":
			return recurrence.everyWeeks === 2 ? "fortnightly" : "weekly";
		case "monthly":
			return recurrence.everyMonths === 2 ? "every-2-months" : "monthly";
		default:
			return "once";
	}
}

function ordinal(n: number): string {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Answers from the form: one per line, trimmed, no blanks or repeats. */
export function parseAnswers(text: string): string[] {
	const answers = [
		...new Set(
			text
				.split("\n")
				.map((a) => a.trim())
				.filter((a) => a !== ""),
		),
	];
	if (answers.length < 2 || answers.length > MAX_POLL_ANSWERS) {
		throw new UserFacingError(
			`A poll needs 2 to ${MAX_POLL_ANSWERS} different answers, one per line.`,
		);
	}
	const long = answers.find((a) => [...a].length > MAX_POLL_ANSWER);
	if (long) throw new UserFacingError(`Each answer can be at most ${MAX_POLL_ANSWER} characters.`);
	return answers;
}

/** A name from free text: its first line, at most 60 characters. */
function cleanName(text: string): string {
	const line = text.split("\n")[0]?.trim() ?? "";
	const name = [...line].length > 60 ? `${[...line].slice(0, 59).join("")}…` : line;
	return name === "" ? "Scheduled post" : name;
}

/** `lastRunAt` for a schedule that should only post from `now` on (the stored one if later). */
function fromNow(schedule: Schedule, now: Date): string {
	return schedule.lastRunAt && new Date(schedule.lastRunAt) > now
		? schedule.lastRunAt
		: now.toISOString();
}

/** When a schedule posts next from `now` on, if ever. */
export function nextRun(schedule: Schedule, zone: string, now: Date): Date | undefined {
	const start = parseLocal(schedule.start);
	if (!start) return undefined;
	const after =
		schedule.lastRunAt && new Date(schedule.lastRunAt) > now ? new Date(schedule.lastRunAt) : now;
	return nextOccurrence(start, schedule.recurrence, zone, after);
}

/** The next few times, for the summary. */
function upcoming(schedule: Schedule, zone: string, now: Date, count: number): Date[] {
	const start = parseLocal(schedule.start) as LocalDateTime;
	const out: Date[] = [];
	let after = now;
	for (let i = 0; i < count; i++) {
		const next = nextOccurrence(start, schedule.recurrence, zone, after);
		if (!next) break;
		out.push(next);
		after = next;
	}
	return out;
}

/** A reminder time as Pixel reads it ("18:00"), or as typed if it can't. */
function reminderClock(typed: string): string {
	const time = parseTimeOfDay(typed);
	return time ? formatTimeOfDay(time) : typed;
}

/** "Every day at 18:00 (Europe/Amsterdam) in #general, while the poll is open" */
function describeReminder(reminder: PollReminder, zone: string): string {
	return `Every day at ${reminder.at} (${zone}) in #${escapeMarkdown(reminder.channelName)}, while the poll is open`;
}

function durationLabel(hours: number): string {
	return DURATIONS.find((d) => pollHours(d) === hours) ?? formatMinutes(hours * 60);
}

/** The stored post with tokens filled as of the next occurrence (or `now`). */
function filledPost(
	schedule: Schedule,
	interpolator: Interpolate,
	zone: string,
	now: Date,
): ChannelPost {
	const at = nextRun(schedule, zone, now) ?? now;
	return interpolateChannelPost(schedule.post, (text) => interpolator.interpolate(text, at));
}

function pollPreviewEmbed(post: Exclude<ChannelPost, { kind: "message" }>): Embed {
	if (post.kind === "attendance") {
		return {
			title: `🙋 ${escapeMarkdown(post.question)}`,
			description: post.answers
				.map((a) => {
					const notes = [
						...(a.colour ? [COLOUR_NAMES[a.colour].toLowerCase()] : []),
						...(a.counts ? ["counts as coming"] : []),
					];
					return `• ${escapeMarkdown(a.label)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
				})
				.join("\n"),
			fields: [
				{ name: "Open for", value: durationLabel(post.durationHours), inline: true },
				{ name: "Answers", value: "One each, by button", inline: true },
			],
			accent: "brand",
		};
	}
	return {
		title: `🗳 ${escapeMarkdown(post.question)}`,
		description: post.answers.map((a) => `• ${escapeMarkdown(a)}`).join("\n"),
		fields: [
			{ name: "Open for", value: durationLabel(post.durationHours), inline: true },
			{ name: "Answers", value: post.multiple ? "Several allowed" : "One", inline: true },
		],
		accent: "brand",
	};
}

const WHAT = { message: "message", poll: "poll", attendance: "attendance poll" } as const;

function icon(post: ChannelPost): string {
	return post.kind === "message" ? "💬" : post.kind === "poll" ? "🗳" : "🙋";
}

/** A schedule's answers as typed on the form: one per line. */
function answersText(post: ChannelPost): string {
	if (post.kind === "message") return "";
	return post.kind === "poll"
		? post.answers.join("\n")
		: post.answers.map((a) => a.label).join("\n");
}

/** An attendance poll's answers from the form: one per line, trimmed, no blanks or repeats. */
export function parseAttendanceAnswers(text: string): string[] {
	const answers = [
		...new Set(
			text
				.split("\n")
				.map((a) => a.trim())
				.filter((a) => a !== ""),
		),
	];
	if (answers.length < 1 || answers.length > MAX_ATTENDANCE_ANSWERS) {
		throw new UserFacingError(
			`An attendance poll needs 1 to ${MAX_ATTENDANCE_ANSWERS} different answers, one per line.`,
		);
	}
	const long = answers.find((a) => [...a].length > MAX_ATTENDANCE_LABEL);
	if (long) {
		throw new UserFacingError(`Each answer can be at most ${MAX_ATTENDANCE_LABEL} characters.`);
	}
	return answers;
}

function tryAttendanceAnswers(text: string): string[] | undefined {
	try {
		return parseAttendanceAnswers(text);
	} catch {
		return undefined;
	}
}

const COLOUR_NAMES: Record<AttendanceColour, string> = {
	grey: "Grey",
	blue: "Blue",
	green: "Green",
	red: "Red",
};

function isColour(value: unknown): value is AttendanceColour {
	return typeof value === "string" && (ATTENDANCE_COLOURS as readonly string[]).includes(value);
}

/** Each answer's colour, by position: the ones picked, and grey for the rest. */
function coloursOf(draft: Pick<Draft, "colours">, answers: number): AttendanceColour[] {
	return Array.from({ length: answers }, (_, i) => draft.colours?.[i] ?? "grey");
}

/** "all grey", or each answer's colour in order, for the draft's button. */
function colourSummary(colours: readonly AttendanceColour[]): string {
	return colours.every((c) => c === "grey")
		? "all grey"
		: colours.map((c) => COLOUR_NAMES[c].toLowerCase()).join(", ");
}

/** A draft's attendance answers as posted: which count, and colours other than grey. */
function attendanceAnswers(
	draft: Pick<Draft, "counting" | "colours">,
	labels: readonly string[],
): AttendanceAnswer[] {
	const counting = countingOf(draft, labels.length);
	const colours = coloursOf(draft, labels.length);
	return labels.map((label, i) => {
		const colour = colours[i] ?? "grey";
		return { label, counts: counting.includes(i), ...(colour === "grey" ? {} : { colour }) };
	});
}

/** Which answers count as coming: the ones picked that still exist, or else the first. */
function countingOf(draft: Pick<Draft, "counting">, answers: number): number[] {
	const picked = (draft.counting ?? []).filter((i) => i < answers);
	return picked.length > 0 ? [...picked] : [0];
}

/** "In #general: the totals so far at 17:00 on the day it closes, and again when it closes" */
function describeResults(results: AttendanceResults | undefined, zone: string): string {
	if (!results) return "None: the totals show on the poll only";
	const channel = `#${escapeMarkdown(results.channelName)}`;
	return results.statusAt
		? `In ${channel}: the totals so far at ${results.statusAt} (${zone}) on the day it closes, and when it closes`
		: `In ${channel}, when it closes`;
}
