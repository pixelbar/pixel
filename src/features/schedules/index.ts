import { type Access, actorLogFields, actorRef, type Principal } from "../../core/access.ts";
import type { ChannelPost, ChannelPosts } from "../../core/channel-posts.ts";
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
import type {
	ActionContext,
	ActionDefinition,
	ActionResult,
	ChoiceOption,
	Control,
	ControlRow,
	Form,
} from "../../core/ui.ts";
import { describeWhen, formatTimeOfDay, parseDays, parseWhen } from "../../core/when.ts";
import {
	MAX_MESSAGE_LENGTH,
	MAX_POLL_ANSWER,
	MAX_POLL_ANSWERS,
	MAX_POLL_QUESTION,
	type Schedule,
	type ScheduleStore,
} from "../../services/schedules.ts";
import { type Draft, Drafts, REPEATS, type Repeat } from "./drafts.ts";
import { checkFilledLength } from "./limits.ts";
import { runDue } from "./runner.ts";

/** Lets someone schedule messages and polls. Granted with `/admin capabilities`. */
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
	badTime: (zone: string) =>
		`I couldn't understand that time, or it's in the past. Type a time in ${zone}, for example \`wed 1900\`, \`14 oct 19:00\` or \`tomorrow 9am\`.`,
	nothingLeft:
		"That would leave it with nothing to post: a one-off needs a time that's still to come. Change **When** in Edit details.",
	noChannel: "Pick a channel in Edit details.",
	cantPost:
		"You can only schedule posts in channels where you can post yourself. Pick another channel.",
	cantPoll: "You can't create polls in that channel yourself, so I won't schedule one there.",
	cantPing: "You can't ping everyone in that channel yourself, so turn pings off.",
	emptyMessage: "The message can't be empty.",
	emptyQuestion: "The question can't be empty.",
	draftGone: "That draft has expired, so nothing was saved. Start again.",
	scheduleGone: "That schedule doesn't exist any more.",
	notYours: "Only the person who made a schedule can change it.",
	cantResume: "Its time has passed while it was paused, so it can't be resumed. Delete it instead.",
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
	now?: () => Date;
};

/** A draft that's ready to save. */
type Ready = {
	start: LocalDateTime;
	recurrence: Recurrence;
	post: ChannelPost;
	channel: { id: string; name: string };
	name: string;
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
		const start = whenChanged
			? parseWhen(draft.when, now(), zone)
			: (parseLocal(schedule.start) as LocalDateTime);
		if (!start) throw new UserFacingError(SCHEDULE_MESSAGES.badTime(zone));
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
		return { ...timing, post, channel, name };
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
				? "Nothing is scheduled yet. Make a message or a poll with the buttons below."
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
			label: `${schedule.post.kind === "poll" ? "🗳" : "💬"} ${schedule.name}`,
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
			title: `${post.kind === "poll" ? "🗳" : "💬"} ${escapeMarkdown(schedule.name)}`,
			description,
			fields: [
				{ name: "Channel", value: `#${escapeMarkdown(schedule.channelName)}`, inline: true },
				{ name: "Repeats", value: capitalise(repeatLabel(schedule)), inline: true },
				{ name: "What", value: describeWhat(schedule.post) },
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
		const what = draft.kind === "message" ? "message" : "poll";
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
		if (draft.kind === "poll") {
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
			rows.push([
				button(`Several answers: ${draft.multiple ? "on" : "off"}`, ACTIONS.toggle, {
					draft: draft.id,
					setting: "multiple",
				}),
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
			embeds: [summary, ...(preview?.kind === "poll" ? [pollPreviewEmbed(preview)] : [])],
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
		const what = draft.kind === "message" ? "message" : "poll";
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
							label: `Answers, one per line (2 to ${MAX_POLL_ANSWERS})`,
							style: "paragraph" as const,
							maxLength: MAX_POLL_ANSWERS * (MAX_POLL_ANSWER + 1),
							placeholder: "Yes\nNo\nMaybe",
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
		let ready: Ready;
		try {
			ready = await evaluate(draft);
		} catch (error) {
			if (error instanceof UserFacingError) return draftPanel(draft);
			throw error;
		}
		const { start, recurrence, post, channel, name, retimed } = ready;
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
			});
			drafts.remove(draft.id);
			ctx.logger.info(
				{
					event: "schedule.created",
					id: schedule.id,
					channelId: channel.id,
					kind: post.kind,
					recurrence: recurrence.kind,
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
					description: "Message or poll",
					type: "string",
					required: true,
					choices: ["message", "poll"],
				},
			],
			(ctx) => {
				const draft = drafts.create({
					owner: actorRef(ctx.principal),
					kind: ctx.args.kind === "poll" ? "poll" : "message",
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
				question: schedule.post.kind === "poll" ? schedule.post.question : "",
				answers: schedule.post.kind === "poll" ? schedule.post.answers.join("\n") : "",
				durationHours: schedule.post.kind === "poll" ? schedule.post.durationHours : 24,
				multiple: schedule.post.kind === "poll" && schedule.post.multiple,
				name: schedule.name,
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
		actions,
		start: () => {
			const handled = new Set<string>();
			let running = false;
			const tick = async () => {
				if (running) return;
				running = true;
				try {
					await runDue({ ...deps, handled }, now());
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

function pollPreviewEmbed(post: Extract<ChannelPost, { kind: "poll" }>): Embed {
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
