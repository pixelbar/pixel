import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor, Tier } from "../../core/access.ts";
import { CapabilityRegistry } from "../../core/capabilities.ts";
import {
	type ChannelCheck,
	type ChannelPost,
	ChannelPosts,
	POSTS_UNAVAILABLE,
} from "../../core/channel-posts.ts";
import { isGroup, isSubgroup, type ResolvedChannel } from "../../core/command.ts";
import { Dispatcher, MESSAGES } from "../../core/dispatcher.ts";
import { IdentityService } from "../../core/identity.ts";
import { createInterpolator } from "../../core/interpolate.ts";
import { silentLogger } from "../../core/logger.ts";
import { nullErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import { ScheduleStore } from "../../services/schedules.ts";
import { actor, IDS } from "../../testing/fixtures.ts";
import { createSchedulesFeature, parseAnswers, SCHEDULE_CAPABILITY, TICK_MS } from "./index.ts";

const AMS = "Europe/Amsterdam";
// Monday 12 October 2026, 10:00 in Amsterdam.
const NOW = new Date("2026-10-12T08:00:00Z");
const CHANNEL = "100000000000000050";
const PEOPLE: Record<string, { tier: Tier; holds: string[] }> = {
	[IDS.member]: { tier: "member", holds: [SCHEDULE_CAPABILITY.name] },
	[IDS.admin]: { tier: "admin", holds: [] },
	[IDS.friend]: { tier: "friend", holds: [SCHEDULE_CAPABILITY.name] },
};

const channel = (caller: Partial<ResolvedChannel["caller"]> = {}): ResolvedChannel => ({
	id: CHANNEL,
	name: "general",
	caller: { canPost: true, canMentionEveryone: false, canCreatePolls: true, ...caller },
});

function setup(options: { check?: ChannelCheck; ready?: boolean } = {}) {
	const store = new ScheduleStore({ logger: silentLogger });
	const posts = new ChannelPosts();
	const posted: ChannelPost[] = [];
	const poster = {
		check: vi.fn(async (): Promise<ChannelCheck> => options.check ?? { ok: true, name: "general" }),
		post: vi.fn(async (_id: string, post: ChannelPost) => {
			posted.push(post);
		}),
	};
	if (options.ready !== false) posts.use(poster);
	const info = vi.fn();
	const logger = { ...silentLogger, info };
	logger.child = () => logger;
	const feature = createSchedulesFeature({
		store,
		posts,
		timezone: AMS,
		stillAllowed: async () => true,
		interpolator: createInterpolator({ timezone: AMS, now: () => NOW }),
		logger,
		reporter: nullErrorReporter,
		now: () => NOW,
	});
	const registry = new CommandRegistry({
		capabilities: new CapabilityRegistry([SCHEDULE_CAPABILITY]),
	});
	registry.register(feature);
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService(
			[{ name: "t", tierFor: async (a: PlatformActor) => PEOPLE[a.userId]?.tier ?? null }],
			[{ name: "t", capabilitiesFor: async (a: PlatformActor) => PEOPLE[a.userId]?.holds ?? [] }],
		),
		rateLimiter: new RateLimiter({ capacity: 1000, refillPerSecond: 0, now: () => 0 }),
		logger,
		reporter: nullErrorReporter,
	});
	const run = (
		subcommand: string,
		args: Record<string, string | boolean>,
		options: { userId?: string; channel?: ResolvedChannel } = {},
	) =>
		dispatcher.dispatch({
			actor: actor({ userId: options.userId ?? IDS.member, displayName: "Ada" }),
			command: "schedule",
			subcommand,
			args,
			channels: options.channel ? { channel: options.channel } : {},
		});
	const message = (args: Record<string, string | boolean> = {}, ch = channel()) =>
		run(
			"message",
			{ channel: CHANNEL, when: "wed 19:00", text: "Pizza night tonight!", ...args },
			{ channel: ch },
		);
	const poll = (args: Record<string, string | boolean> = {}, ch = channel()) =>
		run(
			"poll",
			{
				channel: CHANNEL,
				when: "wed 19:00",
				question: "Who's coming?",
				answers: "Yes\nNo\nMaybe",
				...args,
			},
			{ channel: ch },
		);
	const suggest = (
		subcommand: string,
		option: string,
		typed: string,
		args: Record<string, string> = {},
	) =>
		dispatcher.suggest({
			actor: actor({ userId: IDS.member }),
			command: "schedule",
			subcommand,
			option,
			typed,
			args,
		});
	return { store, posts, poster, posted, feature, run, message, poll, suggest, dispatcher, info };
}

const text = (
	embed:
		| { title: string; description?: string; fields?: { name: string; value: string }[] }
		| undefined,
) =>
	[
		embed?.title,
		embed?.description,
		...(embed?.fields ?? []).map((f) => `${f.name}: ${f.value}`),
	].join("\n");

describe("who may schedule", () => {
	it("is a member holding schedule-posts; an admin without it and a friend with it are refused", async () => {
		const { message } = setup();
		expect((await message()).reply.embeds?.[0]?.title).toMatch(/^✅ Scheduled/);
		const admin = await setup().run("list", {}, { userId: IDS.admin });
		expect(admin.reply.text).toBe(MESSAGES.deniedTier);
		const friend = await setup().run("list", {}, { userId: IDS.friend });
		expect(friend.reply.text).toBe(MESSAGES.deniedTier);
		const guest = await setup().run("list", {}, { userId: IDS.guest });
		expect(guest.reply.text).toBe(MESSAGES.deniedTier);
	});

	it("registers the capability with a description for admins", () => {
		expect(SCHEDULE_CAPABILITY).toEqual({
			name: "schedule-posts",
			description: expect.any(String),
		});
	});
});

describe("before the body form", () => {
	const form = (dispatcher: Dispatcher, args: Record<string, string | boolean>, ch = channel()) =>
		dispatcher.prepareForm({
			actor: actor({ userId: IDS.member, displayName: "Ada" }),
			command: "schedule",
			subcommand: "message",
			args: { channel: CHANNEL, ...args },
			channels: { channel: ch },
		});

	it("parses a good `when` and puts the interpreted time on the form title", async () => {
		const { dispatcher, store } = setup();
		expect(await form(dispatcher, { when: "wed 19:00" })).toEqual({
			ready: true,
			title: "Wed 14 Oct 2026, 19:00",
		});
		expect(await form(dispatcher, { when: "tomorrow 9am" })).toEqual({
			ready: true,
			title: "Tue 13 Oct 2026, 09:00",
		});
		expect(store.all()).toEqual([]);
	});

	it("refuses a bad or past `when` without opening the form, so the body is never typed", async () => {
		const { dispatcher, store } = setup();
		const bad = await form(dispatcher, { when: "someday" });
		expect(bad.ready).toBe(false);
		if (!bad.ready) expect(bad.refuse.reply.text).toMatch(/couldn't understand that time/);
		const past = await form(dispatcher, { when: "today 9" });
		expect(past.ready).toBe(false);
		if (!past.ready) expect(past.refuse.reply.text).toMatch(/past/);
		expect(store.all()).toEqual([]);
	});

	it("refuses a weekly `days` it can't read, still without a form", async () => {
		const { dispatcher } = setup();
		const result = await form(dispatcher, {
			when: "wed 19:00",
			repeat: "weekly",
			days: "blursday",
		});
		expect(result.ready).toBe(false);
		if (!result.ready) expect(result.refuse.reply.text).toMatch(/couldn't understand those days/);
	});

	it("does the same for a poll", async () => {
		const { dispatcher, store } = setup();
		const result = await dispatcher.prepareForm({
			actor: actor({ userId: IDS.member, displayName: "Ada" }),
			command: "schedule",
			subcommand: "poll",
			args: { channel: CHANNEL, when: "someday" },
			channels: { channel: channel() },
		});
		expect(result.ready).toBe(false);
		if (!result.ready) expect(result.refuse.reply.text).toMatch(/couldn't understand that time/);
		expect(store.all()).toEqual([]);
	});
});

describe("/schedule message", () => {
	it("saves the message with its channel, time and repeat, and previews the next posts", async () => {
		const { message, store, info } = setup();
		const result = await message({ repeat: "weekly", days: "wed sat", name: "Pizza" });
		expect(result.private).toBe(true);
		const [schedule] = store.all();
		expect(schedule).toMatchObject({
			name: "Pizza",
			channelId: CHANNEL,
			channelName: "general",
			post: { kind: "message", text: "Pizza night tonight!", mentions: false },
			start: "2026-10-14T19:00",
			recurrence: { kind: "weekly", everyWeeks: 1, days: ["wed", "sat"] },
			paused: false,
			createdBy: { ref: `discord:${IDS.member}`, name: "Ada" },
			lastRunAt: null,
		});
		const shown = text(result.reply.embeds?.[0]);
		expect(shown).toContain("✅ Scheduled: Pizza");
		expect(shown).toContain("Understood as **Wed 14 Oct 2026, 19:00** (Europe/Amsterdam).");
		expect(shown).toContain("every Wednesday and Saturday at 19:00");
		expect(shown).toContain("Wed 14 Oct 2026, 19:00");
		expect(shown).toContain("Sat 17 Oct 2026, 19:00");
		expect(shown).toContain("Wed 21 Oct 2026, 19:00");
		expect(shown).toContain(schedule?.id);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.created", kind: "message" }),
			expect.any(String),
		);
	});

	it("names it after the first line of the text when no name is given", async () => {
		const { message, store } = setup();
		await message({ text: "Line one\nline two" });
		expect(store.all()[0]?.name).toBe("Line one");
		await message({ text: `${"x".repeat(80)}` });
		expect(store.all()[1]?.name).toHaveLength(60);
	});

	it.each([
		[
			"weekly without days, on the start's weekday",
			{ repeat: "weekly" },
			{ kind: "weekly", everyWeeks: 1, days: ["wed"] },
		],
		[
			"fortnightly",
			{ repeat: "fortnightly", days: "wed,sat" },
			{ kind: "weekly", everyWeeks: 2, days: ["wed", "sat"] },
		],
		["monthly", { repeat: "monthly" }, { kind: "monthly", everyMonths: 1 }],
		["every two months", { repeat: "every-2-months" }, { kind: "monthly", everyMonths: 2 }],
		["once by default", {}, { kind: "once" }],
	])("repeats %s", async (_label, args, recurrence) => {
		const { message, store } = setup();
		await message(args as Record<string, string>);
		expect(store.all()[0]?.recurrence).toEqual(recurrence);
	});

	it.each([
		["a time in the past", { when: "today 9" }, /past/],
		["a time it can't read", { when: "someday" }, /couldn't understand that time/],
		["days without a weekly repeat", { days: "wed" }, /only works with a weekly/],
		[
			"days it can't read",
			{ repeat: "weekly", days: "blursday" },
			/couldn't understand those days/,
		],
		["an empty message", { text: "   " }, /can't be empty/],
		["a message that's too long", { text: "x".repeat(2001) }, /at most 2000/],
	])("refuses %s, saving nothing", async (_label, args, message) => {
		const ctx = setup();
		const result = await ctx.message(args as Record<string, string>);
		expect(result.reply.text).toMatch(message);
		expect(ctx.store.all()).toEqual([]);
	});

	it("only posts where the person can post, and only pings when they could ping everyone there", async () => {
		const cantPost = await setup().message({}, channel({ canPost: false }));
		expect(cantPost.reply.text).toMatch(/where you can post yourself/);
		const cantPing = await setup().message(
			{ mentions: true },
			channel({ canMentionEveryone: false }),
		);
		expect(cantPing.reply.text).toMatch(/can't ping everyone/);
		const ctx = setup();
		await ctx.message({ mentions: true }, channel({ canMentionEveryone: true }));
		expect(ctx.store.all()[0]?.post).toMatchObject({ mentions: true });
	});

	it("checks that Pixel itself can post there, and says why not", async () => {
		const ctx = setup({
			check: { ok: false, problem: "I'm missing these permissions there: SendMessages" },
		});
		const result = await ctx.message();
		expect(result.reply.text).toBe(
			"I can't post there: I'm missing these permissions there: SendMessages.",
		);
		expect(ctx.store.all()).toEqual([]);
		const notReady = await setup({ ready: false }).message();
		expect(notReady.reply.text).toBe(POSTS_UNAVAILABLE);
	});

	it("refuses a channel that wasn't picked", async () => {
		const { run } = setup();
		const result = await run("message", { channel: CHANNEL, when: "wed 19", text: "x" });
		expect(result.reply.text).toMatch(/Invalid value for option "channel"/);
	});
});

describe("/schedule poll", () => {
	it("saves a poll with its answers, duration and whether several answers are allowed", async () => {
		const { poll, store } = setup();
		const result = await poll({
			duration: "3 days",
			multiple: true,
			repeat: "weekly",
			days: "wed sat",
		});
		expect(store.all()[0]?.post).toEqual({
			kind: "poll",
			question: "Who's coming?",
			answers: ["Yes", "No", "Maybe"],
			durationHours: 72,
			multiple: true,
		});
		expect(text(result.reply.embeds?.[0])).toContain(
			"A poll open for 3 days, several answers allowed",
		);
	});

	it("is open for a day, single choice, by default", async () => {
		const { poll, store } = setup();
		await poll();
		expect(store.all()[0]?.post).toMatchObject({ durationHours: 24, multiple: false });
	});

	it("needs the person to be able to create polls there", async () => {
		const result = await setup().poll({}, channel({ canCreatePolls: false }));
		expect(result.reply.text).toMatch(/can't create polls in that channel/);
	});

	it.each([
		["one answer", "Yes", /2 to 10 different answers/],
		["eleven answers", Array.from({ length: 11 }, (_, i) => `a${i}`).join("\n"), /2 to 10/],
		["an answer that's too long", `Yes\n${"x".repeat(56)}`, /at most 55/],
	])("refuses %s", async (_label, answers, message) => {
		expect((await setup().poll({ answers })).reply.text).toMatch(message);
	});

	it("needs a question", async () => {
		expect((await setup().poll({ question: " " })).reply.text).toMatch(/question can't be empty/);
	});
});

describe("parseAnswers", () => {
	it("takes one per line, trimmed, without blanks or repeats", () => {
		expect(parseAnswers(" Yes \n\nNo\nYes\n Maybe")).toEqual(["Yes", "No", "Maybe"]);
	});
});

describe("managing schedules", () => {
	async function withOne() {
		const ctx = setup();
		await ctx.message({ repeat: "weekly", name: "Pizza" });
		const id = ctx.store.all()[0]?.id as string;
		return { ...ctx, id };
	}

	it("lists them with their channel, repeat and next post", async () => {
		const { run, id } = await withOne();
		const shown = text((await run("list", {})).reply.embeds?.[0]);
		expect(shown).toContain("Pizza");
		expect(shown).toContain(id);
		expect(shown).toContain("#general");
		expect(shown).toContain("every Wednesday at 19:00");
		expect(shown).toContain("next Wed 14 Oct 2026, 19:00");
	});

	it("says when there are none", async () => {
		expect(text((await setup().run("list", {})).reply.embeds?.[0])).toContain(
			"Nothing is scheduled",
		);
	});

	it("pauses and resumes, and a paused one shows as paused and doesn't post", async () => {
		const { run, store, id } = await withOne();
		expect((await run("pause", { schedule: id })).reply.text).toContain("Paused **Pizza**");
		expect(store.get(id)?.paused).toBe(true);
		expect(text((await run("list", {})).reply.embeds?.[0])).toContain("⏸ paused");
		const resumed = await run("resume", { schedule: id });
		expect(resumed.reply.text).toContain("Next post: Wed 14 Oct 2026, 19:00");
		expect(store.get(id)).toMatchObject({ paused: false, lastRunAt: NOW.toISOString() });
	});

	it("finds a schedule by its ID or its name", async () => {
		const { run, store } = await withOne();
		await run("delete", { schedule: "pizza" });
		expect(store.all()).toEqual([]);
	});

	it("deletes, and says so for one that doesn't exist", async () => {
		const { run, store, id } = await withOne();
		expect((await run("delete", { schedule: id })).reply.text).toContain("Deleted **Pizza**");
		expect(store.all()).toEqual([]);
		expect((await run("delete", { schedule: id })).reply.text).toMatch(/can't find that schedule/);
	});

	it("previews a message exactly, and a poll as its question and answers", async () => {
		const ctx = await withOne();
		const message = await ctx.run("preview", { schedule: ctx.id });
		expect(message.reply.text).toContain("Pizza night tonight!");
		expect(message.reply.text).toContain("Pings don't fire in a preview");
		await ctx.poll({ name: "Vote" });
		const pollId = ctx.store.all()[1]?.id as string;
		const poll = await ctx.run("preview", { schedule: pollId });
		expect(poll.reply.embeds?.[0]?.title).toBe("🗳 Who's coming?");
		expect(poll.reply.embeds?.[0]?.description).toBe("• Yes\n• No\n• Maybe");
	});

	it("says a one-off that's already gone has no more posts when resumed", async () => {
		const ctx = setup();
		await ctx.message({});
		const id = ctx.store.all()[0]?.id as string;
		ctx.store.update(id, { lastRunAt: "2026-10-14T17:00:00.000Z", paused: true });
		expect((await ctx.run("resume", { schedule: id })).reply.text).toContain("no more posts");
	});

	it("shows names people chose as plain text, not formatting", async () => {
		const ctx = setup();
		await ctx.message({ name: "**@everyone** [x](https://e.x)" });
		expect(text((await ctx.run("list", {})).reply.embeds?.[0])).toContain(
			"\\*\\*@everyone\\*\\* \\[x\\](https://e.x)",
		);
	});
});

describe("when is free-form text", () => {
	it("is a string option with no autocomplete, so Discord doesn't force a list of dates", () => {
		const cmd = setup().feature.commands?.[0];
		expect(cmd && isGroup(cmd)).toBe(true);
		if (!cmd || !isGroup(cmd)) return;
		const message = cmd.subcommands.find((s) => s.name === "message");
		expect(message && !isSubgroup(message)).toBe(true);
		if (!message || isSubgroup(message)) return;
		const when = message.options?.find((o) => o.name === "when");
		expect(when).toMatchObject({ type: "string", required: true });
		expect(when && "suggest" in when ? when.suggest : undefined).toBeUndefined();
		expect(when && "choices" in when ? when.choices : undefined).toBeUndefined();
	});

	it("confirms the interpreted time in the space's zone", async () => {
		const shown = text((await setup().message({ when: "tomorrow 9am" })).reply.embeds?.[0]);
		expect(shown).toContain("Understood as **Tue 13 Oct 2026, 09:00** (Europe/Amsterdam).");
	});
});

describe("autocomplete", () => {
	it("offers days, and schedules by name or ID", async () => {
		const ctx = setup();
		expect(await ctx.suggest("message", "days", "wed sat")).toEqual([
			{ name: "Wednesday and Saturday", value: "wed,sat" },
		]);
		await ctx.message({ name: "Pizza" });
		await ctx.message({ name: "Board meeting" });
		const id = ctx.store.all()[0]?.id as string;
		ctx.store.update(id, { paused: true });
		expect(await ctx.suggest("delete", "schedule", "piz")).toEqual([
			{ name: `Pizza (${id}) · paused`, value: id },
		]);
		expect(await ctx.suggest("delete", "schedule", "")).toHaveLength(2);
	});
});

describe("the background runner", () => {
	beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-14T17:00:10Z") }));
	afterEach(() => vi.useRealTimers());

	it("checks straight away and every 30 seconds, and stops when told", async () => {
		const store = new ScheduleStore({ logger: silentLogger });
		const posts = new ChannelPosts();
		const post = vi.fn(async () => {});
		posts.use({ check: async () => ({ ok: true, name: "g" }), post });
		store.add({
			name: "x",
			channelId: CHANNEL,
			channelName: "g",
			post: { kind: "message", text: "hi", mentions: false },
			start: "2026-10-14T19:01",
			recurrence: { kind: "once" },
			paused: false,
			createdBy: { ref: `discord:${IDS.member}`, name: "A" },
			createdAt: NOW.toISOString(),
			lastRunAt: null,
		});
		const feature = createSchedulesFeature({
			store,
			posts,
			timezone: AMS,
			stillAllowed: async () => true,
			interpolator: createInterpolator({ timezone: AMS, now: () => NOW }),
			logger: silentLogger,
			reporter: nullErrorReporter,
		});
		const stop = feature.start?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(post).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(TICK_MS * 2);
		expect(post).toHaveBeenCalledTimes(1);
		stop?.();
		expect(vi.getTimerCount()).toBe(0);
	});
});
