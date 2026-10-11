import { type Access, actorLogFields, actorRef } from "../../core/access.ts";
import type { ChannelPost, ChannelPosts } from "../../core/channel-posts.ts";
import type {
	BeforeFormContext,
	BeforeFormResult,
	CommandContext,
	CommandOption,
	SubcommandDefinition,
	Suggestion,
} from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown, inlineCode } from "../../core/format.ts";
import type { Logger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import {
	describeRecurrence,
	formatLocal,
	type LocalDateTime,
	nextOccurrence,
	parseLocal,
	type Recurrence,
	toLocal,
	weekdayOf,
} from "../../core/recurrence.ts";
import type { Embed, Reply } from "../../core/reply.ts";
import { describeWhen, parseDays, parseWhen, suggestDays } from "../../core/when.ts";
import {
	MAX_MESSAGE_LENGTH,
	MAX_POLL_ANSWER,
	MAX_POLL_ANSWERS,
	MAX_POLL_QUESTION,
	type Schedule,
	type ScheduleStore,
} from "../../services/schedules.ts";
import { runDue } from "./runner.ts";

/** Lets someone schedule messages and polls. Granted with `/admin capabilities`. */
export const SCHEDULE_CAPABILITY = {
	name: "schedule-posts",
	description: "Schedule messages and polls in channels they can post in",
};

/** Members (and admins) holding the capability. */
const ACCESS: Access = { minTier: "member", capability: SCHEDULE_CAPABILITY.name };

const REPEATS = ["once", "weekly", "fortnightly", "monthly", "every-2-months"] as const;
type Repeat = (typeof REPEATS)[number];

const DURATIONS: Record<string, number> = {
	"1 hour": 1,
	"4 hours": 4,
	"8 hours": 8,
	"1 day": 24,
	"3 days": 72,
	"1 week": 168,
	"2 weeks": 336,
};

/** How often the runner looks for due posts. */
export const TICK_MS = 30_000;

export type SchedulesDeps = {
	store: ScheduleStore;
	posts: ChannelPosts;
	timezone: string;
	stillAllowed: (ref: string) => Promise<boolean>;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground" | "breadcrumb">;
	now?: () => Date;
};

/**
 * `/schedule`: messages and polls posted in a channel at set times, once or on a
 * repeat. Long text goes in a form (a modal on Discord). `when` is free-form
 * text (Discord has no date picker); Pixel parses it and confirms the time.
 * People can only schedule into channels they can post in themselves, and pings
 * need their permission to ping everyone.
 */
export function createSchedulesFeature(deps: SchedulesDeps): Feature {
	const now = deps.now ?? (() => new Date());
	const zone = deps.timezone;

	const channelOption: CommandOption = {
		name: "channel",
		description: "Where to post it",
		type: "channel",
		required: true,
	};
	const whenOption: CommandOption = {
		name: "when",
		description: "When to post (Europe/Amsterdam), e.g. wed 1900, 14 oct 19:00, tomorrow 9am",
		type: "string",
		required: true,
	};
	const repeatOption: CommandOption = {
		name: "repeat",
		description: "How often (default: once)",
		type: "string",
		choices: REPEATS,
	};
	const daysOption: CommandOption = {
		name: "days",
		description: "For weekly and fortnightly: which days, e.g. wed sat",
		type: "string",
		suggest: async ({ typed }) => suggestDays(typed),
	};
	const nameOption: CommandOption = {
		name: "name",
		description: "A name to find it by later (default: the start of the text)",
		type: "string",
	};
	const scheduleOption: CommandOption = {
		name: "schedule",
		description: "Which schedule",
		type: "string",
		required: true,
		suggest: async ({ typed }) => suggestSchedules(deps.store.all(), typed),
	};

	/** Turns the typed options into a start and a repeat, or says what's wrong. */
	function timing(args: CommandContext["args"]): { start: LocalDateTime; recurrence: Recurrence } {
		const start = parseWhen(String(args.when ?? ""), now(), zone);
		if (!start) {
			throw new UserFacingError(
				`I couldn't understand that time, or it's in the past. Type a time in ${zone}, for example \`wed 1900\`, \`14 oct 19:00\` or \`tomorrow 9am\`.`,
			);
		}
		const repeat = (args.repeat ?? "once") as Repeat;
		const daysText = typeof args.days === "string" ? args.days : undefined;
		if (daysText !== undefined && repeat !== "weekly" && repeat !== "fortnightly") {
			throw new UserFacingError("`days` only works with a weekly or fortnightly repeat.");
		}
		switch (repeat) {
			case "weekly":
			case "fortnightly": {
				const days = daysText === undefined ? [weekdayOf(start)] : parseDays(daysText);
				if (!days || days.length === 0)
					throw new UserFacingError(
						"I couldn't understand those days. Try something like `wed sat`.",
					);
				return {
					start,
					recurrence: { kind: "weekly", everyWeeks: repeat === "weekly" ? 1 : 2, days },
				};
			}
			case "monthly":
				return { start, recurrence: { kind: "monthly", everyMonths: 1 } };
			case "every-2-months":
				return { start, recurrence: { kind: "monthly", everyMonths: 2 } };
			default:
				return { start, recurrence: { kind: "once" } };
		}
	}

	/** Checks the person and Pixel may make this post in the picked channel. Returns its name. */
	async function checkChannel(
		ctx: Pick<CommandContext, "channels">,
		post: ChannelPost,
	): Promise<{ id: string; name: string }> {
		const channel = ctx.channels.channel;
		if (!channel) throw new UserFacingError("Pick a channel.");
		if (!channel.caller.canPost) {
			throw new UserFacingError(
				"You can only schedule posts in channels where you can post yourself.",
			);
		}
		if (post.kind === "poll" && !channel.caller.canCreatePolls) {
			throw new UserFacingError(
				"You can't create polls in that channel yourself, so I won't schedule one there.",
			);
		}
		if (post.kind === "message" && post.mentions && !channel.caller.canMentionEveryone) {
			throw new UserFacingError(
				"You can't ping everyone in that channel yourself, so `mentions` can't be on there.",
			);
		}
		const check = await deps.posts.check(channel.id, post);
		if (!check.ok) throw new UserFacingError(`I can't post there: ${check.problem}.`);
		return { id: channel.id, name: check.name };
	}

	async function create(
		ctx: CommandContext,
		post: ChannelPost,
		fallbackName: string,
	): Promise<Reply> {
		const { start, recurrence } = timing(ctx.args);
		const channel = await checkChannel(ctx, post);
		const name = cleanName(typeof ctx.args.name === "string" ? ctx.args.name : fallbackName);
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
		return { embeds: [describeSchedule(schedule, zone, now(), "✅ Scheduled")], private: true };
	}

	/** Parse `when` (and days) and the channel before the body form opens. */
	async function prepareBodyForm(
		ctx: Pick<CommandContext, "args" | "channels">,
		post: ChannelPost,
	): Promise<{ title: string }> {
		const { start } = timing(ctx.args);
		await checkChannel(ctx, post);
		return { title: describeWhen(start) };
	}

	const CANT_EDIT = "I can't edit that schedule.";

	function ownEditable(principal: { platform: "discord"; userId: string }): Schedule[] {
		const ref = actorRef(principal);
		return deps.store
			.all()
			.filter((schedule) => schedule.createdBy.ref === ref && nextRun(schedule, zone, now()));
	}

	function findOwnEditable(
		principal: { platform: "discord"; userId: string },
		typed: string,
	): Schedule | undefined {
		return findSchedule(ownEditable(principal), typed);
	}

	function refuseEdit(ctx: {
		logger: CommandContext["logger"];
		principal: CommandContext["principal"];
	}): never {
		ctx.logger.info(
			{ event: "schedule.edit_refused", ...actorLogFields(ctx.principal) },
			"refused a schedule edit",
		);
		throw new UserFacingError(CANT_EDIT);
	}

	/** Apply optional `when` / `repeat` / `days` on top of what's already stored. */
	function editTiming(
		schedule: Schedule,
		args: CommandContext["args"],
	): {
		start: LocalDateTime;
		recurrence: Recurrence;
	} {
		const hasWhen = typeof args.when === "string" && args.when !== "";
		const hasRepeat = typeof args.repeat === "string";
		const hasDays = typeof args.days === "string";
		const start = hasWhen ? parseWhen(String(args.when), now(), zone) : parseLocal(schedule.start);
		if (!start) {
			throw new UserFacingError(
				`I couldn't understand that time, or it's in the past. Type a time in ${zone}, for example \`wed 1900\`, \`14 oct 19:00\` or \`tomorrow 9am\`.`,
			);
		}
		const repeat = (hasRepeat ? args.repeat : repeatOf(schedule.recurrence)) as Repeat;
		const daysText = hasDays ? String(args.days) : undefined;
		if (daysText !== undefined && repeat !== "weekly" && repeat !== "fortnightly") {
			throw new UserFacingError("`days` only works with a weekly or fortnightly repeat.");
		}
		if (!hasWhen && !hasRepeat && !hasDays) {
			return { start, recurrence: schedule.recurrence };
		}
		switch (repeat) {
			case "weekly":
			case "fortnightly": {
				const days =
					daysText === undefined
						? schedule.recurrence.kind === "weekly"
							? schedule.recurrence.days
							: [weekdayOf(start)]
						: parseDays(daysText);
				if (!days || days.length === 0)
					throw new UserFacingError(
						"I couldn't understand those days. Try something like `wed sat`.",
					);
				return {
					start,
					recurrence: { kind: "weekly", everyWeeks: repeat === "weekly" ? 1 : 2, days },
				};
			}
			case "monthly":
				return { start, recurrence: { kind: "monthly", everyMonths: 1 } };
			case "every-2-months":
				return { start, recurrence: { kind: "monthly", everyMonths: 2 } };
			default:
				return { start, recurrence: { kind: "once" } };
		}
	}

	async function prepareEditForm(ctx: BeforeFormContext): Promise<BeforeFormResult> {
		const typed = typeof ctx.args.schedule === "string" ? ctx.args.schedule : "";
		if (typed === "") return { fields: [] };
		const schedule = findOwnEditable(ctx.principal, typed);
		if (!schedule) refuseEdit(ctx);
		if (
			typeof ctx.args.when === "string" ||
			typeof ctx.args.repeat === "string" ||
			typeof ctx.args.days === "string"
		) {
			editTiming(schedule, ctx.args);
		}
		const next = nextRun(schedule, zone, now());
		const title = next ? `Edit · ${describeWhen(toLocal(next, zone))}` : "Edit schedule";
		if (schedule.post.kind === "message") {
			return { title, values: { text: schedule.post.text }, fields: ["text"] };
		}
		return {
			title,
			values: {
				question: schedule.post.question,
				answers: schedule.post.answers.join("\n"),
			},
			fields: ["question", "answers"],
		};
	}

	async function edit(ctx: CommandContext): Promise<Reply> {
		const typed = typeof ctx.args.schedule === "string" ? ctx.args.schedule : "";
		if (typed === "") {
			return { embeds: [describeOwnList(ownEditable(ctx.principal), zone, now())], private: true };
		}
		const schedule = findOwnEditable(ctx.principal, typed);
		if (!schedule) refuseEdit(ctx);
		const timingChange =
			typeof ctx.args.when === "string" ||
			typeof ctx.args.repeat === "string" ||
			typeof ctx.args.days === "string"
				? editTiming(schedule, ctx.args)
				: { start: parseLocal(schedule.start) as LocalDateTime, recurrence: schedule.recurrence };
		const post = editedPost(schedule.post, ctx.args);
		const name = typeof ctx.args.name === "string" ? cleanName(ctx.args.name) : schedule.name;
		const updated = deps.store.update(schedule.id, {
			post,
			start: formatLocal(timingChange.start),
			recurrence: timingChange.recurrence,
			name,
		});
		if (!updated) refuseEdit(ctx);
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
		return { embeds: [describeSchedule(updated, zone, now(), "✅ Updated")], private: true };
	}

	const manage = (
		name: string,
		description: string,
		run: (schedule: Schedule, ctx: CommandContext) => Promise<Reply> | Reply,
	): SubcommandDefinition => ({
		name,
		description,
		access: ACCESS,
		private: true,
		options: [scheduleOption],
		handler: async (ctx) => {
			const schedule = findSchedule(deps.store.all(), String(ctx.args.schedule ?? ""));
			if (!schedule)
				throw new UserFacingError("I can't find that schedule. `/schedule list` shows them all.");
			return run(schedule, ctx);
		},
	});

	return {
		name: "schedules",
		commands: [
			{
				name: "schedule",
				description: "Schedule messages and polls",
				access: ACCESS,
				subcommands: [
					{
						name: "message",
						description: "Schedule a message",
						access: ACCESS,
						private: true,
						options: [
							channelOption,
							whenOption,
							{
								name: "text",
								description: "Message",
								type: "string",
								required: true,
								form: {
									style: "paragraph",
									maxLength: MAX_MESSAGE_LENGTH,
									placeholder: "What to post. Markdown works.",
								},
							},
							repeatOption,
							daysOption,
							{
								name: "mentions",
								description: "Let @everyone, @here and role mentions ping (default: off)",
								type: "boolean",
							},
							nameOption,
						],
						beforeForm: (ctx) =>
							prepareBodyForm(ctx, {
								kind: "message",
								text: ".",
								mentions: ctx.args.mentions === true,
							}),
						handler: async (ctx) => {
							const text = String(ctx.args.text ?? "").trim();
							if (text === "") throw new UserFacingError("The message can't be empty.");
							return create(
								ctx,
								{ kind: "message", text, mentions: ctx.args.mentions === true },
								text,
							);
						},
					},
					{
						name: "poll",
						description: "Schedule a poll",
						access: ACCESS,
						private: true,
						options: [
							channelOption,
							whenOption,
							{
								name: "question",
								description: "Question",
								type: "string",
								required: true,
								form: { style: "short", maxLength: MAX_POLL_QUESTION },
							},
							{
								name: "answers",
								description: "Answers, one per line (2 to 10)",
								type: "string",
								required: true,
								form: {
									style: "paragraph",
									maxLength: MAX_POLL_ANSWERS * (MAX_POLL_ANSWER + 1),
									placeholder: "Yes\nNo\nMaybe",
								},
							},
							repeatOption,
							daysOption,
							{
								name: "duration",
								description: "How long people can vote (default: 1 day)",
								type: "string",
								choices: Object.keys(DURATIONS),
							},
							{
								name: "multiple",
								description: "Let people pick more than one answer",
								type: "boolean",
							},
							nameOption,
						],
						beforeForm: (ctx) =>
							prepareBodyForm(ctx, {
								kind: "poll",
								question: ".",
								answers: ["a", "b"],
								durationHours: 1,
								multiple: ctx.args.multiple === true,
							}),
						handler: async (ctx) => {
							const question = String(ctx.args.question ?? "").trim();
							if (question === "") throw new UserFacingError("The question can't be empty.");
							const answers = parseAnswers(String(ctx.args.answers ?? ""));
							const durationHours = DURATIONS[String(ctx.args.duration ?? "1 day")] ?? 24;
							return create(
								ctx,
								{
									kind: "poll",
									question,
									answers,
									durationHours,
									multiple: ctx.args.multiple === true,
								},
								question,
							);
						},
					},
					{
						name: "list",
						description: "See every scheduled post",
						access: ACCESS,
						private: true,
						handler: async () => ({
							embeds: [describeList(deps.store.all(), zone, now())],
							private: true,
						}),
					},
					{
						name: "edit",
						description: "Edit one of your scheduled posts before it goes out",
						access: ACCESS,
						private: true,
						options: [
							{
								name: "schedule",
								description: "Which of your schedules",
								type: "string",
								suggest: async ({ typed, principal }) =>
									suggestSchedules(ownEditable(principal), typed),
							},
							{ ...whenOption, required: false },
							repeatOption,
							daysOption,
							nameOption,
							{
								name: "text",
								description: "Message",
								type: "string",
								form: {
									style: "paragraph",
									maxLength: MAX_MESSAGE_LENGTH,
									placeholder: "What to post. Markdown works.",
								},
							},
							{
								name: "question",
								description: "Question",
								type: "string",
								form: {
									style: "short",
									maxLength: MAX_POLL_QUESTION,
									placeholder: "Question.",
								},
							},
							{
								name: "answers",
								description: "Answers, one per line (2 to 10)",
								type: "string",
								form: {
									style: "paragraph",
									maxLength: MAX_POLL_ANSWERS * (MAX_POLL_ANSWER + 1),
									placeholder: "Yes\nNo\nMaybe",
								},
							},
						],
						beforeForm: (ctx) => prepareEditForm(ctx),
						handler: (ctx) => edit(ctx),
					},
					manage("preview", "See exactly what a scheduled post will look like", (schedule) =>
						preview(schedule, zone, now()),
					),
					manage("pause", "Stop a schedule from posting until it's resumed", (schedule, ctx) => {
						deps.store.update(schedule.id, { paused: true });
						ctx.logger.info({ event: "schedule.paused", id: schedule.id }, "paused a schedule");
						return {
							text: `Paused ${label(schedule)}. \`/schedule resume\` starts it again.`,
							private: true,
						};
					}),
					manage("resume", "Start a paused schedule again", (schedule, ctx) => {
						// From now on: nothing missed while it was paused is posted.
						const from =
							schedule.lastRunAt && new Date(schedule.lastRunAt) > now()
								? schedule.lastRunAt
								: now().toISOString();
						const updated = deps.store.update(schedule.id, { paused: false, lastRunAt: from });
						ctx.logger.info({ event: "schedule.resumed", id: schedule.id }, "resumed a schedule");
						const next = updated ? nextRun(updated, zone, now()) : undefined;
						return {
							text: next
								? `Resumed ${label(schedule)}. Next post: ${describeWhen(toLocal(next, zone))}.`
								: `Resumed ${label(schedule)}, but it has no more posts to make.`,
							private: true,
						};
					}),
					manage("delete", "Delete a schedule", (schedule, ctx) => {
						deps.store.remove(schedule.id);
						ctx.logger.info({ event: "schedule.deleted", id: schedule.id }, "deleted a schedule");
						deps.reporter.breadcrumb("schedule", `deleted ${schedule.id}`, { id: schedule.id });
						return { text: `Deleted ${label(schedule)}.`, private: true };
					}),
				],
			},
		],
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

/** The stored body after an edit: only the fields that were sent change. */
function editedPost(post: ChannelPost, args: CommandContext["args"]): ChannelPost {
	if (post.kind === "message") {
		const text = typeof args.text === "string" ? args.text.trim() : post.text;
		if (text === "") throw new UserFacingError("The message can't be empty.");
		return { ...post, text };
	}
	const question = typeof args.question === "string" ? args.question.trim() : post.question;
	if (question === "") throw new UserFacingError("The question can't be empty.");
	const answers = typeof args.answers === "string" ? parseAnswers(args.answers) : [...post.answers];
	return { ...post, question, answers };
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

/** "**Weekly poll** (`ab2c3d`)", with the name made inert. */
function label(schedule: Pick<Schedule, "name" | "id">): string {
	return `**${escapeMarkdown(schedule.name)}** (${inlineCode(schedule.id)})`;
}

function findSchedule(schedules: readonly Schedule[], typed: string): Schedule | undefined {
	const key = typed.trim().toLowerCase();
	return schedules.find((s) => s.id === key) ?? schedules.find((s) => s.name.toLowerCase() === key);
}

function suggestSchedules(schedules: readonly Schedule[], typed: string): Suggestion[] {
	const key = typed.trim().toLowerCase();
	return schedules
		.filter((s) => key === "" || s.id.includes(key) || s.name.toLowerCase().includes(key))
		.slice(0, 25)
		.map((s) => ({ name: `${s.name} (${s.id})${s.paused ? " · paused" : ""}`, value: s.id }));
}

/** When a schedule posts next from `now` on, if ever. */
export function nextRun(schedule: Schedule, zone: string, now: Date): Date | undefined {
	const start = parseLocal(schedule.start);
	if (!start) return undefined;
	const after =
		schedule.lastRunAt && new Date(schedule.lastRunAt) > now ? new Date(schedule.lastRunAt) : now;
	return nextOccurrence(start, schedule.recurrence, zone, after);
}

/** The next few times, for the preview. */
function upcoming(schedule: Schedule, zone: string, now: Date, count: number): Date[] {
	const start = parseLocal(schedule.start);
	if (!start) return [];
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

function describeSchedule(schedule: Schedule, zone: string, now: Date, title: string): Embed {
	const start = parseLocal(schedule.start) as LocalDateTime;
	const times = upcoming(schedule, zone, now, 3).map((t) => `• ${describeWhen(toLocal(t, zone))}`);
	const what =
		schedule.post.kind === "message"
			? `A message${schedule.post.mentions ? ", with pings allowed" : ""}`
			: `A poll open for ${durationLabel(schedule.post.durationHours)}${schedule.post.multiple ? ", several answers allowed" : ""}`;
	return {
		title: `${title}: ${escapeMarkdown(schedule.name)}`,
		description: `Understood as **${describeWhen(start)}** (${zone}).`,
		fields: [
			{ name: "Channel", value: `#${escapeMarkdown(schedule.channelName)}`, inline: true },
			{ name: "ID", value: inlineCode(schedule.id), inline: true },
			{ name: "What", value: what },
			{ name: "Repeats", value: describeRecurrence(start, schedule.recurrence) },
			{ name: `Next posts (${zone})`, value: times.length > 0 ? times.join("\n") : "None" },
		],
		accent: "positive",
	};
}

function durationLabel(hours: number): string {
	return Object.entries(DURATIONS).find(([, h]) => h === hours)?.[0] ?? `${hours} hours`;
}

function describeOwnList(schedules: readonly Schedule[], zone: string, now: Date): Embed {
	if (schedules.length === 0) {
		return {
			title: "Your scheduled posts",
			description:
				"You have no scheduled posts left to edit. `/schedule message` and `/schedule poll` create them.",
			accent: "neutral",
		};
	}
	const listed = describeList(schedules, zone, now);
	return { ...listed, title: `Your scheduled posts (${zone})` };
}

function describeList(schedules: readonly Schedule[], zone: string, now: Date): Embed {
	if (schedules.length === 0) {
		return {
			title: "Scheduled posts",
			description: "Nothing is scheduled. Use `/schedule message` or `/schedule poll`.",
			accent: "neutral",
		};
	}
	const lines = schedules.map((s) => {
		const start = parseLocal(s.start) as LocalDateTime;
		const next = s.paused ? undefined : nextRun(s, zone, now);
		const when = s.paused
			? "⏸ paused"
			: next
				? `next ${describeWhen(toLocal(next, zone))}`
				: "no more posts";
		const kind = s.post.kind === "poll" ? "🗳" : "💬";
		return `${kind} ${label(s)} in #${escapeMarkdown(s.channelName)}\n${describeRecurrence(start, s.recurrence)} · ${when}`;
	});
	return {
		title: `Scheduled posts (${zone})`,
		description: lines.join("\n\n").slice(0, 4000),
		accent: "brand",
	};
}

function preview(schedule: Schedule, zone: string, now: Date): Reply {
	const next = schedule.paused ? undefined : nextRun(schedule, zone, now);
	const header = `Preview of ${label(schedule)} in #${escapeMarkdown(schedule.channelName)}${
		next ? `, next on ${describeWhen(toLocal(next, zone))}` : ""
	}. Pings don't fire in a preview.`;
	if (schedule.post.kind === "message") {
		return { text: `${header}\n\n${schedule.post.text}`.slice(0, 2000), private: true };
	}
	const answers = schedule.post.answers.map((a) => `• ${escapeMarkdown(a)}`).join("\n");
	return {
		text: header,
		embeds: [
			{
				title: `🗳 ${escapeMarkdown(schedule.post.question)}`,
				description: answers,
				fields: [
					{ name: "Open for", value: durationLabel(schedule.post.durationHours), inline: true },
					{
						name: "Answers",
						value: schedule.post.multiple ? "Several allowed" : "One",
						inline: true,
					},
				],
				accent: "brand",
			},
		],
		private: true,
	};
}
