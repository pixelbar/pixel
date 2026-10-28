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
const OTHER_MEMBER = "100000000000000012";
const PEOPLE: Record<string, { tier: Tier; holds: string[] }> = {
	[IDS.member]: { tier: "member", holds: [SCHEDULE_CAPABILITY.name] },
	[OTHER_MEMBER]: { tier: "member", holds: [SCHEDULE_CAPABILITY.name] },
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
	// The feature's clock; tests move it with `clock.now = ...`.
	const clock = { now: NOW };
	const poster = {
		check: vi.fn(
			async (_id: string): Promise<ChannelCheck> => options.check ?? { ok: true, name: "general" },
		),
		post: vi.fn(async (_id: string, post: ChannelPost) => {
			posted.push(post);
			return { url: `https://example.test/m/${posted.length}` };
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
		interpolator: createInterpolator({ timezone: AMS, now: () => clock.now }),
		logger,
		reporter: nullErrorReporter,
		now: () => clock.now,
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
		options: {
			userId?: string;
			channel?: ResolvedChannel;
			channels?: Record<string, ResolvedChannel>;
		} = {},
	) =>
		dispatcher.dispatch({
			actor: actor({ userId: options.userId ?? IDS.member, displayName: "Ada" }),
			command: "schedule",
			subcommand,
			args,
			channels: {
				...(options.channel ? { channel: options.channel } : {}),
				...options.channels,
			},
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
		userId = IDS.member,
	) =>
		dispatcher.suggest({
			actor: actor({ userId }),
			command: "schedule",
			subcommand,
			option,
			typed,
			args,
		});
	const form = (
		subcommand: string,
		args: Record<string, string | boolean> = {},
		userId = IDS.member,
	) =>
		dispatcher.prepareForm({
			actor: actor({ userId, displayName: "Ada" }),
			command: "schedule",
			subcommand,
			args,
		});
	/** One check by the background runner at the clock's time, as `start()` does. */
	const tick = async () => {
		const stop = feature.start?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		stop?.();
	};
	return {
		store,
		posts,
		poster,
		posted,
		clock,
		tick,
		feature,
		run,
		message,
		poll,
		suggest,
		form,
		dispatcher,
		info,
	};
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
		expect(shown).toContain("occurs once at 19:00, then repeats every Wednesday and Saturday");
		expect(shown).toContain("Wed 14 Oct 2026, 19:00");
		expect(shown).toContain("Sat 17 Oct 2026, 19:00");
		expect(shown).toContain("Wed 21 Oct 2026, 19:00");
		expect(shown).toContain(schedule?.id);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.created", kind: "message" }),
			expect.any(String),
		);
	});

	it("shows the message filled as of the first post, and keeps tokens in the store", async () => {
		const { message, store } = setup();
		const result = await message({
			name: "Pizza",
			text: "Pizza on {{day}} {{date}} ({{unknown}})",
		});
		expect(result.reply.text).toBe("Pizza on Wednesday 14 October 2026 ({{unknown}})");
		expect(store.all()[0]?.post).toMatchObject({
			text: "Pizza on {{day}} {{date}} ({{unknown}})",
		});
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

	it("shows the poll question and answers filled as of the first post", async () => {
		const { poll, store } = setup();
		const result = await poll({
			name: "Vote",
			question: "Who's coming {{day}}?",
			answers: "Yes {{date}}\nNo {{month}}",
		});
		expect(result.reply.embeds?.[1]?.title).toBe("🗳 Who's coming Wednesday?");
		expect(result.reply.embeds?.[1]?.description).toBe("• Yes 14 October 2026\n• No October");
		expect(store.all()[0]?.post).toMatchObject({
			question: "Who's coming {{day}}?",
			answers: ["Yes {{date}}", "No {{month}}"],
		});
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

	describe("reminders", () => {
		const REMIND = "100000000000000051";
		const remindChannel = (caller: Partial<ResolvedChannel["caller"]> = {}): ResolvedChannel => ({
			...channel(caller),
			id: REMIND,
			name: "chat",
		});
		const pollWithReminder = (
			ctx: ReturnType<typeof setup>,
			args: Record<string, string | boolean> = {},
			remindIn: ResolvedChannel | null = remindChannel(),
		) =>
			ctx.run(
				"poll",
				{
					channel: CHANNEL,
					when: "mon 10:30",
					question: "Who's coming?",
					answers: "Yes\nNo",
					repeat: "weekly",
					...(remindIn ? { "remind-in": REMIND } : {}),
					"remind-at": "6pm",
					...args,
				},
				{ channel: channel(), channels: remindIn ? { "remind-in": remindIn } : {} },
			);

		it("saves the channel and time, and shows them in the confirmation and the list", async () => {
			const ctx = setup();
			ctx.poster.check.mockImplementation(
				async (id: string): Promise<ChannelCheck> => ({
					ok: true,
					name: id === REMIND ? "chat" : "general",
				}),
			);
			const result = await pollWithReminder(ctx);
			expect(ctx.store.all()[0]?.reminder).toEqual({
				channelId: REMIND,
				channelName: "chat",
				at: "18:00",
			});
			expect(text(result.reply.embeds?.[0])).toContain(
				"Reminders: Every day at 18:00 (Europe/Amsterdam) in #chat, while the poll is open",
			);
			const list = await ctx.run("list", {});
			expect(list.reply.embeds?.[0]?.description).toContain("reminds daily at 18:00 in #chat");
			expect(ctx.poster.check).toHaveBeenCalledWith(REMIND, {
				kind: "message",
				text: ".",
				mentions: false,
			});
		});

		it("needs both a channel and a time", async () => {
			const ctx = setup();
			expect((await pollWithReminder(ctx, {}, null)).reply.text).toMatch(/Add `remind-in`/);
			const noTime = await ctx.run(
				"poll",
				{ channel: CHANNEL, when: "wed", question: "Q", answers: "a\nb", "remind-in": REMIND },
				{ channel: channel(), channels: { "remind-in": remindChannel() } },
			);
			expect(noTime.reply.text).toMatch(/Add `remind-at`/);
			expect(ctx.store.all()).toEqual([]);
		});

		it("refuses a time it can't read", async () => {
			const result = await pollWithReminder(setup(), { "remind-at": "tomorrow" });
			expect(result.reply.text).toMatch(/couldn't understand that time\. Type a time of day/);
		});

		it("only reminds where the person can post themselves, and where Pixel can", async () => {
			const ctx = setup();
			const refused = await pollWithReminder(ctx, {}, remindChannel({ canPost: false }));
			expect(refused.reply.text).toMatch(/only schedule posts in channels where you can post/);
			ctx.poster.check.mockImplementation(
				async (id: string): Promise<ChannelCheck> =>
					id === REMIND ? { ok: false, problem: "nope" } : { ok: true, name: "general" },
			);
			expect((await pollWithReminder(ctx)).reply.text).toMatch(/can't post there: nope/);
			expect(ctx.store.all()).toEqual([]);
		});

		it("checks the reminder before the form opens", async () => {
			const ctx = setup();
			await expect(
				ctx.dispatcher.prepareForm({
					actor: actor({ userId: IDS.member, displayName: "Ada" }),
					command: "schedule",
					subcommand: "poll",
					args: { channel: CHANNEL, when: "wed", "remind-at": "18:00" },
					channels: { channel: channel() },
				}),
			).resolves.toMatchObject({
				ready: false,
				refuse: { reply: { text: expect.stringMatching(/Add `remind-in`/) } },
			});
		});

		it("is changed, kept or turned off by an edit", async () => {
			const ctx = setup();
			await pollWithReminder(ctx);
			const id = ctx.store.all()[0]?.id as string;
			await ctx.run("edit", { schedule: id, "remind-at": "9:15" });
			expect(ctx.store.get(id)?.reminder).toMatchObject({ channelId: REMIND, at: "09:15" });
			await ctx.run("edit", { schedule: id, name: "Renamed" });
			expect(ctx.store.get(id)?.reminder?.at).toBe("09:15");
			const both = await ctx.run(
				"edit",
				{ schedule: id, "remind-at": "off", "remind-in": REMIND },
				{ channels: { "remind-in": remindChannel() } },
			);
			expect(both.reply.text).toMatch(/Leave out `remind-in`/);
			await ctx.run("edit", { schedule: id, "remind-at": "OFF" });
			expect(ctx.store.get(id)?.reminder).toBeUndefined();
		});

		it("are added to a poll by an edit, and refused for a message", async () => {
			const ctx = setup();
			await ctx.poll({ name: "Vote" });
			await ctx.message({ name: "Msg" });
			const [pollId, messageId] = ctx.store.all().map((s) => s.id) as [string, string];
			await ctx.run(
				"edit",
				{ schedule: pollId, "remind-in": REMIND, "remind-at": "20:00" },
				{ channels: { "remind-in": remindChannel() } },
			);
			expect(ctx.store.get(pollId)?.reminder?.at).toBe("20:00");
			const refused = await ctx.run("edit", { schedule: messageId, "remind-at": "20:00" });
			expect(refused.reply.text).toMatch(/Reminders only work for polls/);
		});

		it("are posted by the runner each day the poll is open, linking to it", async () => {
			const ctx = setup();
			// Mon 12 Oct 10:30, open for 3 days; reminders at 18:00.
			await pollWithReminder(ctx, { duration: "3 days" });
			ctx.clock.now = new Date("2026-10-12T08:30:05Z");
			await ctx.tick();
			ctx.clock.now = new Date("2026-10-12T16:00:05Z");
			await ctx.tick();
			expect(ctx.posted.at(-1)).toEqual({
				kind: "message",
				text: "🗳️ Reminder: vote on **Who's coming?** before Thu 15 Oct 2026, 10:30: https://example.test/m/1",
				mentions: false,
			});
			expect(ctx.poster.post).toHaveBeenLastCalledWith(REMIND, expect.anything());
		});
	});

	it("needs a question", async () => {
		expect((await setup().poll({ question: " " })).reply.text).toMatch(/question can't be empty/);
	});

	it("refuses an answer that only goes over the limit once its tokens are filled", async () => {
		// "{{date}}" (8) becomes "14 October 2026" (15): 49 as typed, 56 when posted.
		const { poll, store } = setup();
		const result = await poll({ answers: `Yes\n${"x".repeat(41)}{{date}}` });
		expect(result.reply.text).toMatch(/answer would be over Discord's 55-character limit/);
		expect(store.all()).toEqual([]);
	});
});

describe("tokens and Discord's length limits", () => {
	const tooLong = `${"x".repeat(1986)}{{date}}`;

	it("refuses a message that tokens would push over 2000 characters, and saves nothing", async () => {
		const { message, store } = setup();
		const result = await message({ text: tooLong });
		expect(result.reply.text).toMatch(
			/tokens filled in, the message would be over Discord's 2000-character limit/,
		);
		expect(result.reply.text).not.toContain("xxxx");
		expect(store.all()).toEqual([]);
		expect((await message({ text: `${"x".repeat(1985)}{{date}}` })).reply.text).toHaveLength(2000);
	});

	it("refuses an edit that tokens would push over the limit, and keeps the old text", async () => {
		const { message, run, store } = setup();
		await message();
		const id = store.all()[0]?.id as string;
		const result = await run("edit", { schedule: id, text: tooLong });
		expect(result.reply.text).toMatch(/2000-character limit/);
		expect(store.get(id)?.post).toMatchObject({ text: "Pizza night tonight!" });
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
		expect(shown).toContain("occurs once at 19:00, then repeats every Wednesday");
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

	it("fills tokens in a preview as of the next post, including a poll's question and answers", async () => {
		const ctx = setup();
		await ctx.message({ name: "Pizza", text: "Pizza on {{day}} {{date}} ({{unknown}})" });
		const messageId = ctx.store.all()[0]?.id as string;
		const message = await ctx.run("preview", { schedule: messageId });
		const body = message.reply.text?.split("\n\n").at(-1);
		expect(body).toBe("Pizza on Wednesday 14 October 2026 ({{unknown}})");
		expect(JSON.stringify(ctx.info.mock.calls)).not.toContain("Pizza on");

		await ctx.poll({
			name: "Vote",
			question: "Who's coming {{day}}?",
			answers: "Yes {{date}}\nNo {{month}}",
		});
		const pollId = ctx.store.all()[1]?.id as string;
		const poll = await ctx.run("preview", { schedule: pollId });
		expect(poll.reply.embeds?.[0]?.title).toBe("🗳 Who's coming Wednesday?");
		expect(poll.reply.embeds?.[0]?.description).toBe("• Yes 14 October 2026\n• No October");
		expect(ctx.store.get(pollId)?.post).toMatchObject({
			question: "Who's coming {{day}}?",
			answers: ["Yes {{date}}", "No {{month}}"],
		});
	});

	it("won't resume a one-off whose time passed while paused, and says how to delete it", async () => {
		const ctx = setup();
		await ctx.message({ name: "Pizza" });
		const id = ctx.store.all()[0]?.id as string;
		await ctx.run("pause", { schedule: id });
		ctx.clock.now = new Date("2026-10-15T08:00:00Z");
		const result = await ctx.run("resume", { schedule: id });
		expect(result.reply.text).toBe(
			`**Pizza** (\`${id}\`) has nothing left to post: its time passed. \`/schedule delete\` removes it.`,
		);
		expect(ctx.store.get(id)).toMatchObject({ paused: true, lastRunAt: null });
	});

	it("resumes a repeat from now on, so nothing missed while paused goes out late", async () => {
		const ctx = setup();
		await ctx.message({ when: "mon 19:00", repeat: "weekly" });
		const id = ctx.store.all()[0]?.id as string;
		await ctx.run("pause", { schedule: id });
		ctx.clock.now = new Date("2026-10-12T17:20:00Z"); // Mon 19:20, 20 minutes after it was due
		const result = await ctx.run("resume", { schedule: id });
		expect(result.reply.text).toContain("Next post: Mon 19 Oct 2026, 19:00");
		await ctx.tick();
		expect(ctx.posted).toEqual([]);
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

	it("names the configured zone in its description, not a fixed one", () => {
		const feature = createSchedulesFeature({
			store: new ScheduleStore({ logger: silentLogger }),
			posts: new ChannelPosts(),
			timezone: "America/New_York",
			stillAllowed: async () => true,
			interpolator: createInterpolator({ timezone: "America/New_York", now: () => NOW }),
			logger: silentLogger,
			reporter: nullErrorReporter,
		});
		const cmd = feature.commands?.[0];
		if (!cmd || !isGroup(cmd)) throw new Error("expected a command group");
		const descriptions = cmd.subcommands.flatMap((s) =>
			isSubgroup(s) ? [] : (s.options ?? []).filter((o) => o.name === "when"),
		);
		expect(descriptions.map((o) => o.description)).toEqual([
			"When to post (America/New_York), e.g. wed 1900, 14 oct 19:00, tomorrow 9am",
			"When to post (America/New_York), e.g. wed 1900, 14 oct 19:00, tomorrow 9am",
			"When to post (America/New_York), e.g. wed 1900, 14 oct 19:00, tomorrow 9am",
		]);
	});

	it("confirms the interpreted time in the space's zone", async () => {
		const shown = text((await setup().message({ when: "tomorrow 9am" })).reply.embeds?.[0]);
		expect(shown).toContain("Understood as **Tue 13 Oct 2026, 09:00** (Europe/Amsterdam).");
	});
});

describe("/schedule edit", () => {
	async function withTwoOwners() {
		const ctx = setup();
		await ctx.message({ name: "Mine", text: "Pizza night tonight!" });
		await ctx.run(
			"message",
			{ channel: CHANNEL, when: "wed 19:00", text: "Someone else's post", name: "Theirs" },
			{ userId: OTHER_MEMBER, channel: channel() },
		);
		const mine = ctx.store.all().find((s) => s.createdBy.ref === `discord:${IDS.member}`);
		const theirs = ctx.store.all().find((s) => s.createdBy.ref === `discord:${OTHER_MEMBER}`);
		return {
			...ctx,
			mine: mine as NonNullable<typeof mine>,
			theirs: theirs as NonNullable<typeof theirs>,
		};
	}

	it("lists only this user's still-upcoming posts, privately", async () => {
		const { run, mine } = await withTwoOwners();
		const result = await run("edit", {});
		expect(result.private).toBe(true);
		const shown = text(result.reply.embeds?.[0]);
		expect(shown).toContain("Your scheduled posts");
		expect(shown).toContain("Mine");
		expect(shown).toContain(mine.id);
		expect(shown).not.toContain("Theirs");
		expect(shown).not.toContain("Someone else's post");
	});

	it("says so privately when this user has nothing left to edit", async () => {
		const result = await setup().run("edit", {});
		expect(result.private).toBe(true);
		expect(text(result.reply.embeds?.[0])).toContain("no scheduled posts left to edit");
	});

	it("edits this user's message text and keeps it in the same store", async () => {
		const { run, store, mine, info } = await withTwoOwners();
		const result = await run("edit", { schedule: mine.id, text: "Updated pizza note" });
		expect(result.private).toBe(true);
		expect(text(result.reply.embeds?.[0])).toContain("✅ Updated: Mine");
		expect(store.get(mine.id)?.post).toEqual({
			kind: "message",
			text: "Updated pizza note",
			mentions: false,
		});
		expect(result.reply.text).toBe("Updated pizza note");
		expect(store.get(mine.id)?.createdBy.ref).toBe(`discord:${IDS.member}`);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "schedule.edited",
				id: mine.id,
				kind: "message",
				user: `discord:${IDS.member}`,
			}),
			expect.any(String),
		);
		expect(JSON.stringify(info.mock.calls)).not.toContain("Updated pizza note");
		expect(JSON.stringify(info.mock.calls)).not.toContain("Pizza night tonight!");
	});

	it("edits a poll's question and answers", async () => {
		const ctx = setup();
		await ctx.poll({ name: "Vote" });
		const id = ctx.store.all()[0]?.id as string;
		const result = await ctx.run("edit", {
			schedule: id,
			question: "Who's coming {{day}}?",
			answers: "Yes {{date}}\nNo",
		});
		expect(result.reply.embeds?.[1]?.title).toBe("🗳 Who's coming Wednesday?");
		expect(result.reply.embeds?.[1]?.description).toBe("• Yes 14 October 2026\n• No");
		expect(ctx.store.get(id)?.post).toEqual({
			kind: "poll",
			question: "Who's coming {{day}}?",
			answers: ["Yes {{date}}", "No"],
			durationHours: 24,
			multiple: false,
		});
	});

	it("edits how long a poll stays open, and shows it in the confirmation and the preview", async () => {
		const ctx = setup();
		await ctx.poll({ name: "Vote", duration: "3 days", multiple: true });
		const id = ctx.store.all()[0]?.id as string;
		const result = await ctx.run("edit", { schedule: id, duration: "1 week" });
		expect(ctx.store.get(id)?.post).toEqual({
			kind: "poll",
			question: "Who's coming?",
			answers: ["Yes", "No", "Maybe"],
			durationHours: 168,
			multiple: true,
		});
		expect(text(result.reply.embeds?.[0])).toContain(
			"A poll open for 1 week, several answers allowed",
		);
		expect(text(result.reply.embeds?.[1])).toContain("Open for: 1 week");
		const preview = await ctx.run("preview", { schedule: id });
		expect(text(preview.reply.embeds?.[0])).toContain("Open for: 1 week");
	});

	it("keeps a poll's duration when it isn't given", async () => {
		const ctx = setup();
		await ctx.poll({ name: "Vote", duration: "3 days" });
		const id = ctx.store.all()[0]?.id as string;
		const result = await ctx.run("edit", { schedule: id, question: "Who's in?" });
		expect(ctx.store.get(id)?.post).toMatchObject({ question: "Who's in?", durationHours: 72 });
		expect(text(result.reply.embeds?.[0])).toContain("A poll open for 3 days");
	});

	it("refuses a duration on a message before the form opens, and does not save", async () => {
		const { form, run, store, mine } = await withTwoOwners();
		const refusal =
			"`duration` only works on a poll: it's how long people can vote. Leave it out to edit a message.";
		expect(await form("edit", { schedule: mine.id, duration: "1 day" })).toMatchObject({
			ready: false,
			refuse: { reply: { text: refusal } },
		});
		const result = await run("edit", { schedule: mine.id, duration: "1 day", text: "New" });
		expect(result.reply.text).toBe(refusal);
		expect(store.get(mine.id)?.post).toEqual({
			kind: "message",
			text: "Pizza night tonight!",
			mentions: false,
		});
	});

	it("refuses a duration that isn't one of the choices, as create does", async () => {
		const ctx = setup();
		await ctx.poll({ name: "Vote" });
		const id = ctx.store.all()[0]?.id as string;
		const refusal = 'Invalid value for option "duration".';
		const bad = await ctx.form("edit", { schedule: id, duration: "5 years" });
		expect(bad.ready).toBe(false);
		if (!bad.ready) expect(bad.refuse.reply.text).toBe(refusal);
		const edited = await ctx.run("edit", { schedule: id, duration: "5 years" });
		expect(edited.reply.text).toBe(refusal);
		expect(ctx.store.get(id)?.post).toMatchObject({ durationHours: 24 });
		expect((await ctx.poll({ duration: "5 years" })).reply.text).toBe(refusal);
	});

	it("edits when and repeat when they are already stored", async () => {
		const { run, store, mine } = await withTwoOwners();
		const result = await run("edit", {
			schedule: mine.id,
			when: "thu 20:00",
			repeat: "weekly",
			days: "thu",
			name: "Thursday pizza",
		});
		expect(store.get(mine.id)).toMatchObject({
			name: "Thursday pizza",
			start: "2026-10-15T20:00",
			recurrence: { kind: "weekly", everyWeeks: 1, days: ["thu"] },
			post: { kind: "message", text: "Pizza night tonight!" },
		});
		expect(text(result.reply.embeds?.[0])).toContain(
			"occurs once at 20:00, then repeats every Thursday",
		);
	});

	// A weekly Monday 19:00 post that last went out on Monday 12 October.
	async function ranMonday() {
		const ctx = setup();
		await ctx.message({ name: "Weekly", when: "mon 19:00", repeat: "weekly" });
		const id = ctx.store.all()[0]?.id as string;
		ctx.store.update(id, { lastRunAt: "2026-10-12T17:00:00.000Z" });
		return { ...ctx, id };
	}

	it.each<{ change: string; args: Record<string, string>; at: string; next: string }>([
		{
			change: "days",
			args: { days: "thu" },
			at: "2026-10-15T17:20:00Z", // Thu 15 Oct 19:20, 20 minutes after a Thursday post would have been
			next: "Thu 22 Oct 2026, 19:00",
		},
		{
			change: "repeat",
			args: { repeat: "monthly" },
			at: "2026-11-12T18:20:00Z", // Thu 12 Nov 19:20, 20 minutes after a monthly post on the 12th
			next: "Sat 12 Dec 2026, 19:00",
		},
	])(
		"counts new $change from the edit, so it doesn't post straight away",
		async ({ args, at, next }) => {
			const ctx = await ranMonday();
			ctx.clock.now = new Date(at);
			const result = await ctx.run("edit", { schedule: ctx.id, ...args });
			expect(text(result.reply.embeds?.[0])).toContain(`• ${next}`);
			expect(ctx.store.get(ctx.id)?.lastRunAt).toBe(new Date(at).toISOString());
			await ctx.tick();
			expect(ctx.posted).toEqual([]);
		},
	);

	it("leaves when it last ran alone when the timing doesn't change", async () => {
		const ctx = await ranMonday();
		ctx.clock.now = new Date("2026-10-15T17:20:00Z");
		await ctx.run("edit", { schedule: ctx.id, text: "New text" });
		await ctx.run("edit", { schedule: ctx.id, repeat: "weekly", days: "mon" });
		expect(ctx.store.get(ctx.id)).toMatchObject({
			lastRunAt: "2026-10-12T17:00:00.000Z",
			post: { text: "New text" },
		});
	});

	it("refuses to turn a repeat into a one-off whose time has passed, before the form opens", async () => {
		const ctx = await ranMonday();
		ctx.clock.now = new Date("2026-10-15T17:20:00Z");
		const refusal =
			"That would leave it with nothing to post: a one-off needs a time that's still to come. Add `when` with the new time.";
		expect(await ctx.form("edit", { schedule: ctx.id, repeat: "once" })).toMatchObject({
			ready: false,
			refuse: { reply: { text: refusal } },
		});
		const result = await ctx.run("edit", { schedule: ctx.id, repeat: "once", text: "Last one" });
		expect(result.reply.text).toBe(refusal);
		expect(ctx.store.get(ctx.id)).toMatchObject({
			recurrence: { kind: "weekly" },
			post: { text: "Pizza night tonight!" },
		});
		await ctx.run("edit", { schedule: ctx.id, repeat: "once", when: "fri 19:00" });
		expect(ctx.store.get(ctx.id)).toMatchObject({
			start: "2026-10-16T19:00",
			recurrence: { kind: "once" },
		});
	});

	it("refuses someone else's schedule, an unknown id, and a one-off that already posted, without leaking", async () => {
		const { run, store, mine, theirs } = await withTwoOwners();
		store.update(mine.id, { lastRunAt: "2026-10-14T17:00:00.000Z" });
		for (const schedule of [theirs.id, "zzzzzz", mine.id, "Theirs"]) {
			const result = await run("edit", { schedule });
			expect(result.reply.text).toBe("I can't edit that schedule.");
			expect(result.private).toBe(true);
		}
		expect(store.get(theirs.id)?.post).toMatchObject({ text: "Someone else's post" });
		expect(store.get(mine.id)?.post).toMatchObject({ text: "Pizza night tonight!" });
	});

	it("needs the same access as /schedule", async () => {
		const admin = await setup().run("edit", {}, { userId: IDS.admin });
		expect(admin.reply.text).toBe(MESSAGES.deniedTier);
		const friend = await setup().run("edit", {}, { userId: IDS.friend });
		expect(friend.reply.text).toBe(MESSAGES.deniedTier);
		const guest = await setup().run("edit", {}, { userId: IDS.guest });
		expect(guest.reply.text).toBe(MESSAGES.deniedTier);
	});

	it("opens the form with this user's current text, and skips it when listing", async () => {
		const { form, mine, theirs } = await withTwoOwners();
		expect(await form("edit", {})).toEqual({ ready: true, fields: [] });
		expect(await form("edit", { schedule: mine.id })).toEqual({
			ready: true,
			title: "Edit · Wed 14 Oct 2026, 19:00",
			values: { text: "Pizza night tonight!" },
			fields: ["text"],
		});
		const refused = await form("edit", { schedule: theirs.id });
		expect(refused).toEqual({
			ready: false,
			refuse: { reply: { text: "I can't edit that schedule.", private: true }, private: true },
		});
	});

	it("prefills a poll's question and answers on the form", async () => {
		const ctx = setup();
		await ctx.poll({ name: "Vote" });
		const id = ctx.store.all()[0]?.id as string;
		expect(await ctx.form("edit", { schedule: id })).toEqual({
			ready: true,
			title: "Edit · Wed 14 Oct 2026, 19:00",
			values: { question: "Who's coming?", answers: "Yes\nNo\nMaybe" },
			fields: ["question", "answers"],
		});
	});

	it("refuses a bad when without opening the form, and does not save", async () => {
		const { form, store, mine } = await withTwoOwners();
		const bad = await form("edit", { schedule: mine.id, when: "someday" });
		expect(bad.ready).toBe(false);
		if (!bad.ready) expect(bad.refuse.reply.text).toMatch(/couldn't understand that time/);
		expect(store.get(mine.id)?.start).toBe("2026-10-14T19:00");
	});

	it("suggests only this user's still-upcoming schedules", async () => {
		const { suggest, store, mine, theirs } = await withTwoOwners();
		expect(await suggest("edit", "schedule", "")).toEqual([
			{ name: `Mine (${mine.id})`, value: mine.id },
		]);
		expect(await suggest("edit", "schedule", "Thei")).toEqual([]);
		expect(await suggest("edit", "schedule", theirs.id)).toEqual([]);
		store.update(mine.id, { lastRunAt: "2026-10-14T17:00:00.000Z" });
		expect(await suggest("edit", "schedule", "")).toEqual([]);
		expect(await suggest("delete", "schedule", "")).toHaveLength(2);
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
		const post = vi.fn(async () => ({ url: "https://example.test/m/1" }));
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
