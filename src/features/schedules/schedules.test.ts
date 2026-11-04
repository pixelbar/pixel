import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor, Tier } from "../../core/access.ts";
import { CapabilityRegistry } from "../../core/capabilities.ts";
import { type ChannelCheck, type ChannelPost, ChannelPosts } from "../../core/channel-posts.ts";
import type { ResolvedChannel } from "../../core/command.ts";
import { type ActionOutcome, Dispatcher, MESSAGES } from "../../core/dispatcher.ts";
import { IdentityService } from "../../core/identity.ts";
import { createInterpolator } from "../../core/interpolate.ts";
import { silentLogger } from "../../core/logger.ts";
import { nullErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import type { Embed, Reply } from "../../core/reply.ts";
import { type Control, type Form, UI_LIMITS } from "../../core/ui.ts";
import { MAX_SCHEDULES, type Schedule, ScheduleStore } from "../../services/schedules.ts";
import { actor, IDS } from "../../testing/fixtures.ts";
import {
	ACTIONS,
	createSchedulesFeature,
	PAGE_SIZE,
	parseAnswers,
	pollHours,
	SCHEDULE_CAPABILITY,
	SCHEDULE_MESSAGES,
	TICK_MS,
} from "./index.ts";

const AMS = "Europe/Amsterdam";
// Monday 12 October 2026, 10:00 in Amsterdam.
const NOW = new Date("2026-10-12T08:00:00Z");
const CHANNEL = "100000000000000050";
const OTHER_CHANNEL = "100000000000000051";
const OTHER_MEMBER = "100000000000000012";
const PEOPLE: Record<string, { tier: Tier; holds: string[] }> = {
	[IDS.member]: { tier: "member", holds: [SCHEDULE_CAPABILITY.name] },
	[OTHER_MEMBER]: { tier: "member", holds: [SCHEDULE_CAPABILITY.name] },
	[IDS.admin]: { tier: "admin", holds: [] },
	[IDS.friend]: { tier: "friend", holds: [SCHEDULE_CAPABILITY.name] },
};

const channel = (
	caller: Partial<ResolvedChannel["caller"]> = {},
	id = CHANNEL,
): ResolvedChannel => ({
	id,
	name: id === CHANNEL ? "general" : "events",
	caller: { canPost: true, canMentionEveryone: false, canCreatePolls: true, ...caller },
});

/** Every control on a reply, row by row. */
const controlsOf = (reply: Reply): Control[] => (reply.controls ?? []).flat();

/** Everything an embed says, for matching. */
const said = (embed: Embed | undefined) =>
	[
		embed?.title,
		embed?.description,
		...(embed?.fields ?? []).map((f) => `${f.name}: ${f.value}`),
	].join("\n");

/** Fails if Discord would refuse what's shown. */
function expectFits(outcome: ActionOutcome | { reply: Reply }) {
	if ("kind" in outcome && outcome.kind === "form") {
		const { form } = outcome;
		expect(form.fields.length).toBeLessThanOrEqual(UI_LIMITS.formFields);
		expect([...form.title].length).toBeLessThanOrEqual(UI_LIMITS.formTitle);
		for (const field of form.fields) {
			expect([...field.label].length).toBeLessThanOrEqual(UI_LIMITS.fieldLabel);
			expect([...(field.description ?? "")].length).toBeLessThanOrEqual(UI_LIMITS.fieldDescription);
		}
		return;
	}
	if (!("reply" in outcome)) return;
	const rows = outcome.reply.controls ?? [];
	expect(rows.length).toBeLessThanOrEqual(UI_LIMITS.rows);
	for (const row of rows) {
		expect(row.length).toBeLessThanOrEqual(UI_LIMITS.buttonsPerRow);
		for (const control of row) {
			if (control.kind === "select") {
				expect(row).toHaveLength(1);
				expect(control.options.length).toBeLessThanOrEqual(UI_LIMITS.options);
			}
		}
	}
}

function setup(options: { check?: ChannelCheck } = {}) {
	const store = new ScheduleStore({ logger: silentLogger });
	const posts = new ChannelPosts();
	const posted: ChannelPost[] = [];
	const clock = { now: NOW };
	const poster = {
		check: vi.fn(
			async (_id: string, _post: ChannelPost): Promise<ChannelCheck> =>
				options.check ?? { ok: true, name: "general" },
		),
		post: vi.fn(async (_id: string, post: ChannelPost) => {
			posted.push(post);
			return { url: `https://discord.com/channels/1/2/${posted.length}` };
		}),
	};
	posts.use(poster);
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
		rateLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 0, now: () => 0 }),
		logger,
		reporter: nullErrorReporter,
	});
	const who = (userId: string) =>
		actor({ userId, displayName: userId === IDS.member ? "Ada" : "Sam" });

	/** `/schedule`. */
	const open = async (userId: string = IDS.member) => {
		const result = await dispatcher.dispatch({ actor: who(userId), command: "schedule", args: {} });
		expectFits({ reply: result.reply });
		return result;
	};

	const act = async (
		action: string,
		args: Record<string, string | number>,
		opts: { userId?: string; channels?: Record<string, ResolvedChannel> } = {},
	) => {
		const outcome = await dispatcher.act({
			actor: who(opts.userId ?? IDS.member),
			action,
			args,
			...(opts.channels ? { channels: opts.channels } : {}),
		});
		expectFits(outcome);
		return outcome;
	};

	/** Uses the control labelled `label` (or the select whose placeholder it is). */
	const click = (
		reply: Reply,
		label: string,
		values: string[] = [],
		userId: string = IDS.member,
	) => {
		const control = controlsOf(reply).find(
			(c) =>
				(c.kind === "select" ? c.placeholder : c.label) === label ||
				(c.kind !== "select" && c.label.startsWith(label)),
		);
		if (!control || control.kind === "link") throw new Error(`no control "${label}"`);
		const args = { ...control.call.args } as Record<string, string | number>;
		if (control.kind === "select") args[control.arg] = values.join(", ");
		return act(control.call.action, args, { userId });
	};

	/** Submits a form with these fields (and a picked channel). */
	const submit = (
		form: Form,
		fields: Record<string, string>,
		opts: { channel?: ResolvedChannel; userId?: string } = {},
	) => {
		const picked = opts.channel === undefined ? channel() : opts.channel;
		return act(
			form.submit.action,
			{ ...(form.submit.args as Record<string, string>), ...fields, channel: picked.id },
			{ channels: { channel: picked }, ...(opts.userId ? { userId: opts.userId } : {}) },
		);
	};

	/** Opens the form for a new message or poll. */
	const newForm = async (kind: "message" | "poll") => {
		const outcome = await click(
			(await open()).reply,
			kind === "message" ? "New message" : "New poll",
		);
		if (outcome.kind !== "form") throw new Error("expected a form");
		return outcome.form;
	};

	/** The draft panel for a new message. */
	const draftMessage = async (
		fields: Record<string, string> = {},
		ch: ResolvedChannel = channel(),
	) =>
		submit(
			await newForm("message"),
			{ when: "wed 19:00", repeat: "once", text: "Pizza night tonight!", ...fields },
			{ channel: ch },
		);

	const draftPoll = async (fields: Record<string, string> = {}, ch: ResolvedChannel = channel()) =>
		submit(
			await newForm("poll"),
			{
				when: "wed 19:00",
				repeat: "once",
				question: "Who's coming?",
				answers: "Yes\nNo\nMaybe",
				...fields,
			},
			{ channel: ch },
		);

	/** Makes and saves a message, returning the schedule's panel. */
	const message = async (fields: Record<string, string> = {}, ch: ResolvedChannel = channel()) =>
		click(replyOf(await draftMessage(fields, ch)), "Schedule");

	/** A stored schedule's panel. */
	const panel = async (id: string, userId: string = IDS.member) =>
		act(ACTIONS.open, { id }, { userId });

	/** One check by the background runner at the clock's time, as `start()` does. */
	const tick = async () => {
		const stop = feature.start?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		stop?.();
	};

	return {
		store,
		poster,
		posted,
		clock,
		tick,
		feature,
		dispatcher,
		info,
		open,
		act,
		click,
		submit,
		newForm,
		draftMessage,
		draftPoll,
		message,
		panel,
	};
}

/** The reply an action replaced its message with. */
function replyOf(outcome: ActionOutcome): Reply {
	if (outcome.kind !== "update") {
		throw new Error(`expected an update, got ${JSON.stringify(outcome)}`);
	}
	return outcome.reply;
}

function formOf(outcome: ActionOutcome): Form {
	if (outcome.kind !== "form") throw new Error(`expected a form, got ${JSON.stringify(outcome)}`);
	return outcome.form;
}

const labels = (reply: Reply) =>
	controlsOf(reply).map((c) => (c.kind === "select" ? `[${c.placeholder}]` : c.label));

const button = (reply: Reply, label: string) =>
	controlsOf(reply).find((c) => c.kind === "button" && c.label.startsWith(label)) as
		| Extract<Control, { kind: "button" }>
		| undefined;

const selectOf = (reply: Reply, placeholder: string) =>
	controlsOf(reply).find((c) => c.kind === "select" && c.placeholder === placeholder) as
		| Extract<Control, { kind: "select" }>
		| undefined;

/** Adds a schedule straight to the store. */
function add(store: ScheduleStore, over: Partial<Omit<Schedule, "id">> = {}): Schedule {
	return store.add({
		name: "Pizza",
		channelId: CHANNEL,
		channelName: "general",
		post: { kind: "message", text: "Pizza night tonight!", mentions: false },
		start: "2026-10-14T19:00",
		recurrence: { kind: "once" },
		paused: false,
		createdBy: { ref: `discord:${IDS.member}`, name: "Ada" },
		createdAt: NOW.toISOString(),
		lastRunAt: null,
		...over,
	});
}

describe("pollHours", () => {
	it("reads poll durations with the shared duration parser, in whole hours", () => {
		expect(pollHours("1 hour")).toBe(1);
		expect(pollHours("3 days")).toBe(72);
		expect(pollHours("2 weeks")).toBe(336);
		expect(pollHours("90m")).toBeUndefined();
		expect(pollHours("soon")).toBeUndefined();
	});
});

describe("parseAnswers", () => {
	it("takes one per line, trimmed, without blanks or repeats", () => {
		expect(parseAnswers(" Yes \n\nNo\nYes\n")).toEqual(["Yes", "No"]);
		expect(() => parseAnswers("Yes")).toThrow(/2 to 10/);
		expect(() => parseAnswers(`Yes\n${"x".repeat(56)}`)).toThrow(/at most 55/);
	});
});

describe("who may schedule", () => {
	it("is a member holding schedule-posts; an admin without it, a friend with it and a guest are refused", async () => {
		const { open, act } = setup();
		expect((await open()).reply.embeds?.[0]?.title).toBe("Scheduled posts");
		for (const userId of [IDS.admin, IDS.friend, IDS.guest]) {
			expect((await open(userId)).reply.text).toBe(MESSAGES.deniedTier);
			expect(await act(ACTIONS.home, {}, { userId })).toEqual({
				kind: "refused",
				reply: { text: MESSAGES.deniedTier, private: true },
			});
		}
	});

	it("is one command with no options, and every action needs the same access", () => {
		const { feature } = setup();
		expect(feature.commands).toEqual([
			expect.objectContaining({ name: "schedule", private: true, access: expect.anything() }),
		]);
		expect(feature.commands?.[0]).not.toHaveProperty("subcommands");
		expect(feature.commands?.[0]?.options).toBeUndefined();
		for (const action of feature.actions ?? []) {
			expect(action.access).toEqual({ minTier: "member", capability: "schedule-posts" });
		}
		expect((feature.actions ?? []).map((a) => a.name).sort()).toEqual(
			Object.values(ACTIONS).sort(),
		);
	});

	it("registers the capability with a description for admins", () => {
		expect(SCHEDULE_CAPABILITY).toEqual({
			name: "schedule-posts",
			description: "Schedule messages and polls in channels they can post in",
		});
	});
});

describe("the list", () => {
	it("says when nothing is scheduled, and offers only the New buttons", async () => {
		const { open } = setup();
		const { reply } = await open();
		expect(reply.private).toBe(true);
		expect(said(reply.embeds?.[0])).toContain("Nothing is scheduled yet");
		expect(labels(reply)).toEqual(["New message", "New poll"]);
		expect(button(reply, "New message")?.style).toBe("primary");
	});

	it("counts them, and lists soonest first with paused and finished ones last", async () => {
		const { open, store } = setup();
		add(store, { name: "Later", start: "2026-10-20T19:00" });
		add(store, { name: "Paused", paused: true });
		add(store, {
			name: "Theirs",
			start: "2026-10-13T19:00",
			createdBy: { ref: `discord:${OTHER_MEMBER}`, name: "Sam" },
		});
		add(store, { name: "Finished", start: "2026-10-12T09:00", lastRunAt: NOW.toISOString() });
		add(store, {
			name: "Soonest",
			start: "2026-10-12T19:00",
			recurrence: { kind: "monthly", everyMonths: 2 },
		});
		const { reply } = await open();
		expect(said(reply.embeds?.[0])).toContain("**5** scheduled · **4** yours · **1** paused");
		expect(said(reply.embeds?.[0])).toContain(`Times are in ${AMS}.`);
		const list = selectOf(reply, "Choose a schedule…");
		expect(list?.options.map((o) => o.label)).toEqual([
			"💬 Soonest",
			"💬 Theirs",
			"💬 Later",
			"💬 Paused",
			"💬 Finished",
		]);
		expect(list?.options.map((o) => o.description)).toEqual([
			"#general · next Mon 12 Oct 2026, 19:00 · every 2 months on the 12th",
			"#general · next Tue 13 Oct 2026, 19:00 · once · by Sam",
			"#general · next Tue 20 Oct 2026, 19:00 · once",
			"#general · paused · once",
			"#general · finished · once",
		]);
		expect(labels(reply)).toEqual(["[Choose a schedule…]", "New message", "New poll"]);
	});

	it("pages past 25, with Previous and Next", async () => {
		const { open, click, store } = setup();
		for (let i = 0; i < 30; i++)
			add(store, {
				name: `Post ${i}`,
				start: `2026-10-${String(13 + (i % 15)).padStart(2, "0")}T19:00`,
			});
		const first = (await open()).reply;
		expect(selectOf(first, "Choose a schedule…")?.options).toHaveLength(PAGE_SIZE);
		expect(said(first.embeds?.[0])).toContain("Page 1 of 2.");
		expect(button(first, "‹ Previous")?.disabled).toBe(true);
		expect(button(first, "Next ›")?.disabled).toBeUndefined();
		const second = replyOf(await click(first, "Next ›"));
		expect(selectOf(second, "Choose a schedule…")?.options).toHaveLength(5);
		expect(said(second.embeds?.[0])).toContain("Page 2 of 2.");
		expect(button(second, "Next ›")?.disabled).toBe(true);
		// A page that's gone (schedules deleted since) shows the last one.
		expect(said(replyOf(await click(second, "Next ›")).embeds?.[0])).toContain("Page 2 of 2.");
	});

	it("shows names people chose as plain text, not formatting", async () => {
		const { panel, store } = setup();
		const { id } = add(store, { name: "**@everyone** [x](https://e.x)" });
		expect(said(replyOf(await panel(id)).embeds?.[0])).toContain(
			"\\*\\*@everyone\\*\\* \\[x\\](https://e.x)",
		);
	});
});

describe("making a message", () => {
	it("opens a form for the channel, when, repeat and text", async () => {
		const { newForm } = setup();
		const form = await newForm("message");
		expect(form.title).toBe("New message");
		expect(form.fields.map((f) => [f.kind, f.name])).toEqual([
			["channel", "channel"],
			["text", "when"],
			["radio", "repeat"],
			["text", "text"],
		]);
		const repeat = form.fields[2];
		expect(repeat?.kind === "radio" && repeat.options.map((o) => [o.label, o.selected])).toEqual([
			["Once", true],
			["Weekly", undefined],
			["Every 2 weeks", undefined],
			["Monthly", undefined],
			["Every 2 months", undefined],
		]);
		expect(form.fields[1]?.description).toContain(AMS);
	});

	it("shows a draft with the time it understood and the post filled in, and saves nothing yet", async () => {
		const { draftMessage, store } = setup();
		const reply = replyOf(await draftMessage({ text: "Pizza on {{day}} {{date}} ({{unknown}})" }));
		expect(reply.text).toBe("Pizza on Wednesday 14 October 2026 ({{unknown}})");
		const summary = said(reply.embeds?.[0]);
		expect(summary).toContain("New message");
		expect(summary).toContain("Nothing is saved until you press **Schedule**.");
		expect(summary).toContain("**#general** · first post **Wed 14 Oct 2026, 19:00**");
		expect(summary).toContain("Name: Pizza on {{day}} {{date}} ({{unknown}})");
		expect(labels(reply)).toEqual(["Schedule", "Edit details", "Rename", "Cancel"]);
		expect(button(reply, "Schedule")?.disabled).toBeUndefined();
		expect(store.all()).toEqual([]);
	});

	it("saves on Schedule, keeps tokens in the store, and shows the schedule", async () => {
		const { message, store, info } = setup();
		const reply = replyOf(await message({ text: "On {{date}}" }));
		expect(store.all()).toHaveLength(1);
		expect(store.all()[0]).toMatchObject({
			name: "On {{date}}",
			channelId: CHANNEL,
			channelName: "general",
			post: { kind: "message", text: "On {{date}}", mentions: false },
			start: "2026-10-14T19:00",
			recurrence: { kind: "once" },
			createdBy: { ref: `discord:${IDS.member}`, name: "Ada" },
		});
		expect(said(reply.embeds?.[0])).toContain("✅ **Scheduled.**");
		expect(reply.text).toBe("On 14 October 2026");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.created", kind: "message", recurrence: "once" }),
			"scheduled a post",
		);
	});

	it.each<[string, Record<string, string>, ResolvedChannel | undefined, string]>([
		["a time it can't read", { when: "someday" }, undefined, "couldn't understand that time"],
		["a time that's passed", { when: "today 9:00" }, undefined, "couldn't understand that time"],
		["an empty message", { text: "   " }, undefined, SCHEDULE_MESSAGES.emptyMessage],
		["a channel they can't post in", {}, channel({ canPost: false }), SCHEDULE_MESSAGES.cantPost],
	])("explains %s in the draft, and won't save it", async (_, fields, ch, problem) => {
		const { draftMessage, click, store } = setup();
		const reply = replyOf(await draftMessage(fields, ch));
		expect(said(reply.embeds?.[0])).toContain(`⚠️ `);
		expect(said(reply.embeds?.[0])).toContain(problem);
		expect(reply.embeds?.[0]?.accent).toBe("warning");
		expect(button(reply, "Schedule")?.disabled).toBe(true);
		expect(button(reply, "Edit details")?.style).toBe("primary");
		// Even if the button is used anyway, nothing is saved.
		expect(said(replyOf(await click(reply, "Schedule")).embeds?.[0])).toContain(problem);
		expect(store.all()).toEqual([]);
	});

	it("says why Pixel itself can't post there", async () => {
		const { draftMessage } = setup({ check: { ok: false, problem: "it can't see the channel" } });
		expect(said(replyOf(await draftMessage()).embeds?.[0])).toContain(
			"I can't post there: it can't see the channel.",
		);
	});

	it("refuses a message that tokens would push over 2000 characters", async () => {
		const { draftMessage } = setup();
		const reply = replyOf(await draftMessage({ text: `${"x".repeat(1986)}{{date}}` }));
		expect(said(reply.embeds?.[0])).toMatch(/2000-character limit/);
		expect(button(reply, "Schedule")?.disabled).toBe(true);
	});

	it("reopens the form with what was typed, to fix it", async () => {
		const { draftMessage, click } = setup();
		const reply = replyOf(await draftMessage({ when: "someday", repeat: "monthly", text: "Hi" }));
		const form = formOf(await click(reply, "Edit details"));
		expect(form.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "channel", value: CHANNEL }),
				expect.objectContaining({ name: "when", value: "someday" }),
				expect.objectContaining({ name: "text", value: "Hi" }),
			]),
		);
		const repeat = form.fields.find((f) => f.name === "repeat");
		expect(repeat?.kind === "radio" && repeat.options.find((o) => o.selected)?.value).toBe(
			"monthly",
		);
	});

	it("offers days for a weekly repeat, starting on the first post's day", async () => {
		const { draftMessage, click, submit, store } = setup();
		const reply = replyOf(await draftMessage({ repeat: "weekly" }));
		const days = selectOf(reply, "Which days?");
		expect(days?.options.filter((o) => o.selected).map((o) => o.value)).toEqual(["wed"]);
		expect(days?.max).toBe(7);
		const changed = replyOf(await click(reply, "Which days?", ["wed", "sat"]));
		expect(said(changed.embeds?.[0])).toContain("weekly on Wednesday and Saturday");
		// Back to once: the days go.
		const form = formOf(await click(changed, "Edit details"));
		const once = replyOf(await submit(form, { when: "wed 19:00", repeat: "once", text: "x" }));
		expect(selectOf(once, "Which days?")).toBeUndefined();
		const fortnightly = replyOf(
			await submit(formOf(await click(once, "Edit details")), {
				when: "wed 19:00",
				repeat: "fortnightly",
				text: "x",
			}),
		);
		expect(said(fortnightly.embeds?.[0])).toContain("every 2 weeks on Wednesday");
		await click(fortnightly, "Schedule");
		expect(store.all()[0]?.recurrence).toEqual({ kind: "weekly", everyWeeks: 2, days: ["wed"] });
	});

	it.each([
		["monthly", { kind: "monthly", everyMonths: 1 }, "monthly on the 14th"],
		["every-2-months", { kind: "monthly", everyMonths: 2 }, "every 2 months on the 14th"],
	])("repeats %s, and opens an edit on the same choice", async (repeat, recurrence, shown) => {
		const { draftMessage, click, panel, store } = setup();
		const reply = replyOf(await draftMessage({ repeat }));
		expect(said(reply.embeds?.[0])).toContain(shown);
		await click(reply, "Schedule");
		const saved = store.all()[0] as Schedule;
		expect(saved.recurrence).toEqual(recurrence);
		const form = formOf(await click(replyOf(await panel(saved.id)), "Edit"));
		const radio = form.fields.find((f) => f.name === "repeat");
		expect(radio?.kind === "radio" && radio.options.find((o) => o.selected)?.value).toBe(repeat);
	});

	it("refuses a days choice it can't read", async () => {
		const { draftMessage, act } = setup();
		const reply = replyOf(await draftMessage({ repeat: "weekly" }));
		const draft = selectOf(reply, "Which days?")?.call.args?.draft as string;
		expect(await act(ACTIONS.days, { draft, days: "funday" })).toEqual({
			kind: "refused",
			reply: { text: "Choose at least one day.", private: true },
		});
	});

	it("only offers pings where the person could ping everyone, and saves them", async () => {
		const { draftMessage, click, store } = setup();
		expect(labels(replyOf(await draftMessage()))).not.toContain("Pings: off");
		const reply = replyOf(await draftMessage({}, channel({ canMentionEveryone: true })));
		expect(labels(reply)).toContain("Pings: off");
		const on = replyOf(await click(reply, "Pings"));
		expect(labels(on)).toContain("Pings: on");
		expect(said(on.embeds?.[0])).toContain("pings on");
		await click(on, "Schedule");
		expect(store.all()[0]?.post).toMatchObject({ mentions: true });
	});

	it("keeps the pings switch to turn them off if they're on where they're not allowed", async () => {
		const { draftMessage, click, submit } = setup();
		const allowed = replyOf(await draftMessage({}, channel({ canMentionEveryone: true })));
		const on = replyOf(await click(allowed, "Pings"));
		const moved = replyOf(
			await submit(formOf(await click(on, "Edit details")), {
				when: "wed 19:00",
				repeat: "once",
				text: "x",
			}),
		);
		expect(said(moved.embeds?.[0])).toContain(SCHEDULE_MESSAGES.cantPing);
		expect(labels(moved)).toContain("Pings: on");
		expect(button(replyOf(await click(moved, "Pings")), "Schedule")?.disabled).toBeUndefined();
	});

	it("is renamed with a form, and goes back to the text's start when the name is cleared", async () => {
		const { draftMessage, click, act, store } = setup();
		const reply = replyOf(await draftMessage());
		const form = formOf(await click(reply, "Rename"));
		expect(form.fields).toEqual([expect.objectContaining({ name: "name", required: false })]);
		const named = replyOf(
			await act(form.submit.action, { ...(form.submit.args as object), name: "Pizza" } as never),
		);
		expect(said(named.embeds?.[0])).toContain("Name: Pizza");
		expect(formOf(await click(named, "Rename")).fields[0]).toMatchObject({ value: "Pizza" });
		const cleared = replyOf(await act(form.submit.action, form.submit.args as never));
		expect(said(cleared.embeds?.[0])).toContain("Name: Pizza night tonight!");
		await click(named, "Schedule");
		expect(store.all()[0]?.name).toBe("Pizza night tonight!");
	});

	it("cancels without saving", async () => {
		const { draftMessage, click, store } = setup();
		const reply = replyOf(await click(replyOf(await draftMessage()), "Cancel"));
		expect(said(reply.embeds?.[0])).toContain("Nothing was saved.");
		expect(store.all()).toEqual([]);
	});

	it("says the store is full rather than failing", async () => {
		const { draftMessage, click, store } = setup();
		for (let i = 0; i < MAX_SCHEDULES; i++) add(store);
		const outcome = await click(replyOf(await draftMessage()), "Schedule");
		expect(outcome).toEqual({
			kind: "refused",
			reply: { text: expect.stringContaining("Delete one first"), private: true },
		});
	});
});

describe("making a poll", () => {
	it("asks for the question and answers on the form", async () => {
		const { newForm } = setup();
		const form = await newForm("poll");
		expect(form.title).toBe("New poll");
		expect(form.fields.map((f) => f.name)).toEqual([
			"channel",
			"when",
			"repeat",
			"question",
			"answers",
		]);
	});

	it("shows the poll, a day and one answer by default, and saves the chosen settings", async () => {
		const { draftPoll, click, store } = setup();
		const reply = replyOf(await draftPoll({ question: "Coming on {{date}}?" }));
		expect(reply.text).toBeUndefined();
		expect(said(reply.embeds?.[1])).toContain("🗳 Coming on 14 October 2026?");
		expect(said(reply.embeds?.[0])).toContain("A poll open for 1 day, one answer each");
		const duration = selectOf(reply, "How long can people vote?");
		expect(duration?.options.find((o) => o.selected)?.value).toBe("1 day");
		const longer = replyOf(await click(reply, "How long can people vote?", ["3 days"]));
		const several = replyOf(await click(longer, "Several answers"));
		expect(said(several.embeds?.[0])).toContain("A poll open for 3 days, several answers allowed");
		expect(labels(several)).toContain("Several answers: on");
		await click(several, "Schedule");
		expect(store.all()[0]?.post).toEqual({
			kind: "poll",
			question: "Coming on {{date}}?",
			answers: ["Yes", "No", "Maybe"],
			durationHours: 72,
			multiple: true,
		});
	});

	it.each<[string, Record<string, string>, ResolvedChannel | undefined, string | RegExp]>([
		["one answer", { answers: "Yes" }, undefined, /2 to 10 different answers/],
		["an empty question", { question: " " }, undefined, SCHEDULE_MESSAGES.emptyQuestion],
		["a channel without polls", {}, channel({ canCreatePolls: false }), SCHEDULE_MESSAGES.cantPoll],
	])("explains %s in the draft", async (_, fields, ch, problem) => {
		const { draftPoll } = setup();
		const reply = replyOf(await draftPoll(fields, ch));
		expect(said(reply.embeds?.[0])).toMatch(problem);
		expect(reply.embeds).toHaveLength(1);
		expect(button(reply, "Schedule")?.disabled).toBe(true);
	});

	it("fits every row Discord allows, even weekly", async () => {
		const { draftPoll } = setup();
		const reply = replyOf(await draftPoll({ repeat: "weekly" }));
		expect(reply.controls).toHaveLength(4);
	});
});

describe("poll reminders", () => {
	const remindersOf = async (ctx: ReturnType<typeof setup>, reply: Reply) =>
		formOf(await ctx.click(reply, "Reminders"));
	const remind = (
		ctx: ReturnType<typeof setup>,
		form: Form,
		fields: Record<string, string>,
		ch?: ResolvedChannel,
	) =>
		ctx.act(
			form.submit.action,
			{
				...(form.submit.args as Record<string, string>),
				...fields,
				...(ch ? { "remind-in": ch.id } : {}),
			},
			ch ? { channels: { "remind-in": ch } } : {},
		);

	it("are off to begin with, and only offered on a poll", async () => {
		const ctx = setup();
		const poll = replyOf(await ctx.draftPoll());
		expect(labels(poll)).toContain("Reminders: off");
		expect(said(poll.embeds?.[0])).toContain("Reminders: None");
		expect(labels(replyOf(await ctx.draftMessage()))).not.toContain("Reminders: off");
		const message = replyOf(await ctx.draftMessage());
		const draft = button(message, "Rename")?.call.args?.draft as string;
		expect(await ctx.act(ACTIONS.reminders, { draft })).toEqual({
			kind: "refused",
			reply: { text: "Reminders only work for polls.", private: true },
		});
	});

	it("are set on a form, shown on the draft, and saved with the poll", async () => {
		const ctx = setup();
		const form = await remindersOf(ctx, replyOf(await ctx.draftPoll()));
		expect(form.title).toBe("Reminders");
		expect(form.fields.map((f) => [f.kind, f.name, f.required])).toEqual([
			["text", "remind-at", false],
			["channel", "remind-in", false],
		]);
		const set = replyOf(
			await remind(ctx, form, { "remind-at": "6pm" }, channel({}, OTHER_CHANNEL)),
		);
		expect(labels(set)).toContain("Reminders: daily at 18:00");
		expect(said(set.embeds?.[0])).toContain(
			`Reminders: Every day at 18:00 (${AMS}) in #general, while the poll is open`,
		);
		const reopened = await remindersOf(ctx, set);
		expect(reopened.fields).toEqual([
			expect.objectContaining({ name: "remind-at", value: "6pm" }),
			expect.objectContaining({ name: "remind-in", value: OTHER_CHANNEL }),
		]);
		const saved = replyOf(await ctx.click(set, "Schedule"));
		expect(ctx.store.all()[0]?.reminder).toEqual({
			channelId: OTHER_CHANNEL,
			channelName: "general",
			at: "18:00",
		});
		expect(said(saved.embeds?.[0])).toContain("Reminders: Every day at 18:00");
		expect(ctx.info).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.created", reminderChannelId: OTHER_CHANNEL }),
			"scheduled a post",
		);
	});

	it.each<[string, Record<string, string>, ResolvedChannel | undefined, string]>([
		[
			"a time it can't read",
			{ "remind-at": "teatime" },
			channel(),
			"couldn't understand the reminder time",
		],
		["no channel", { "remind-at": "18:00" }, undefined, SCHEDULE_MESSAGES.noReminderChannel],
		[
			"a channel the person can't post in",
			{ "remind-at": "18:00" },
			channel({ canPost: false }),
			SCHEDULE_MESSAGES.cantRemind,
		],
	])("explain %s on the draft", async (_, fields, ch, problem) => {
		const ctx = setup();
		const form = await remindersOf(ctx, replyOf(await ctx.draftPoll()));
		const reply = replyOf(await remind(ctx, form, fields, ch));
		expect(said(reply.embeds?.[0])).toContain(problem);
		expect(said(reply.embeds?.[0])).toContain("Reminders: Not set up yet");
		expect(button(reply, "Schedule")?.disabled).toBe(true);
		if (fields["remind-at"] === "teatime")
			expect(labels(reply)).toContain("Reminders: daily at teatime");
	});

	it("say why Pixel itself can't post a reminder there", async () => {
		const ctx = setup();
		const form = await remindersOf(ctx, replyOf(await ctx.draftPoll()));
		ctx.poster.check.mockImplementation(
			async (id: string): Promise<ChannelCheck> =>
				id === OTHER_CHANNEL
					? { ok: false, problem: "it can't see the channel" }
					: { ok: true, name: "general" },
		);
		const reply = replyOf(
			await remind(ctx, form, { "remind-at": "18:00" }, channel({}, OTHER_CHANNEL)),
		);
		expect(said(reply.embeds?.[0])).toContain(
			"I can't send reminders there: it can't see the channel.",
		);
	});

	it("keep an unchanged reminder on an edit, and are turned off by clearing the time", async () => {
		const ctx = setup();
		const { id } = add(ctx.store, {
			post: {
				kind: "poll",
				question: "Q?",
				answers: ["a", "b"],
				durationHours: 24,
				multiple: false,
			},
			reminder: { channelId: OTHER_CHANNEL, channelName: "events", at: "18:00" },
		});
		expect(said(replyOf(await ctx.panel(id)).embeds?.[0])).toContain(
			"Reminders: Every day at 18:00 (Europe/Amsterdam) in #events, while the poll is open",
		);
		const form = formOf(await ctx.click(replyOf(await ctx.panel(id)), "Edit"));
		const draft = replyOf(
			await ctx.submit(form, {
				when: "14 oct 2026 19:00",
				repeat: "once",
				question: "New?",
				answers: "a\nb",
			}),
		);
		expect(labels(draft)).toContain("Reminders: daily at 18:00");
		// Unchanged, so the person isn't checked again; Pixel still is.
		await ctx.click(draft, "Save changes");
		expect(ctx.store.get(id)?.reminder).toEqual({
			channelId: OTHER_CHANNEL,
			channelName: "general",
			at: "18:00",
		});
		const again = replyOf(
			await ctx.submit(formOf(await ctx.click(replyOf(await ctx.panel(id)), "Edit")), {
				when: "14 oct 2026 19:00",
				repeat: "once",
				question: "New?",
				answers: "a\nb",
			}),
		);
		const off = replyOf(await remind(ctx, await remindersOf(ctx, again), {}));
		expect(labels(off)).toContain("Reminders: off");
		await ctx.click(off, "Save changes");
		expect(ctx.store.get(id)?.reminder).toBeUndefined();
	});
});

describe("a schedule's panel", () => {
	it("shows the owner what it will post next, with Edit, Pause and Delete", async () => {
		const { panel, store } = setup();
		const { id } = add(store, {
			post: { kind: "message", text: "Pizza on {{date}}", mentions: false },
			recurrence: { kind: "weekly", everyWeeks: 1, days: ["wed"] },
		});
		const reply = replyOf(await panel(id));
		expect(reply.text).toBe("Pizza on 14 October 2026");
		const summary = said(reply.embeds?.[0]);
		expect(summary).toContain("Next post: **Wed 14 Oct 2026, 19:00**");
		expect(summary).toContain("Made by you.");
		expect(summary).toContain("Repeats: Weekly on Wednesday");
		expect(summary).toContain("Wed 21 Oct 2026, 19:00");
		expect(labels(reply)).toEqual(["Edit", "Pause", "Delete", "← All schedules"]);
		expect(button(reply, "Delete")?.style).toBe("danger");
	});

	it("shows someone else's read-only, and says why", async () => {
		const { panel, store } = setup();
		const { id } = add(store, { createdBy: { ref: `discord:${OTHER_MEMBER}`, name: "Sam" } });
		const reply = replyOf(await panel(id));
		expect(said(reply.embeds?.[0])).toContain("Made by Sam. Only they can change it.");
		expect(labels(reply)).toEqual(["← All schedules"]);
	});

	it("shows a poll as its question and answers", async () => {
		const { panel, store } = setup();
		const { id } = add(store, {
			post: {
				kind: "poll",
				question: "Q {{date}}?",
				answers: ["a", "b"],
				durationHours: 5,
				multiple: false,
			},
			recurrence: { kind: "monthly", everyMonths: 1 },
		});
		const reply = replyOf(await panel(id));
		expect(reply.text).toBeUndefined();
		expect(said(reply.embeds?.[1])).toContain("🗳 Q 14 October 2026?");
		expect(said(reply.embeds?.[1])).toContain("Open for: 5h");
		expect(said(reply.embeds?.[0])).toContain("Monthly on the 14th");
	});

	it("goes back to the list, and says so when a schedule has gone", async () => {
		const { panel, click, store } = setup();
		const { id } = add(store);
		const reply = replyOf(await panel(id));
		expect(replyOf(await click(reply, "← All schedules")).embeds?.[0]?.title).toBe(
			"Scheduled posts",
		);
		store.remove(id);
		expect(said(replyOf(await panel(id)).embeds?.[0])).toContain(SCHEDULE_MESSAGES.scheduleGone);
		expect(said(replyOf(await click(reply, "Pause")).embeds?.[0])).toContain(
			SCHEDULE_MESSAGES.scheduleGone,
		);
	});

	it("opens from the list", async () => {
		const { open, click, store } = setup();
		const { id } = add(store);
		const reply = replyOf(await click((await open()).reply, "Choose a schedule…", [id]));
		expect(reply.embeds?.[0]?.title).toBe("💬 Pizza");
	});
});

describe("pausing, resuming and deleting", () => {
	it("pauses and resumes in place, and a paused one doesn't post", async () => {
		const { panel, click, store, clock, tick, posted, info } = setup();
		const { id } = add(store, { recurrence: { kind: "weekly", everyWeeks: 1, days: ["wed"] } });
		const paused = replyOf(await click(replyOf(await panel(id)), "Pause"));
		expect(said(paused.embeds?.[0])).toContain("⏸ **Paused.** It won't post until you resume it.");
		expect(labels(paused)).toEqual(["Edit", "Resume", "Delete", "← All schedules"]);
		expect(paused.embeds?.[0]?.accent).toBe("neutral");
		expect(store.get(id)?.paused).toBe(true);
		expect(info).toHaveBeenCalledWith({ event: "schedule.paused", id }, "paused a schedule");
		clock.now = new Date("2026-10-14T17:00:30Z");
		await tick();
		expect(posted).toEqual([]);
		// Resumed from now on: the post missed while paused doesn't go out late.
		const resumed = replyOf(await click(paused, "Resume"));
		expect(said(resumed.embeds?.[0])).toContain("▶️ **Resumed.**");
		expect(said(resumed.embeds?.[0])).toContain("Next post: **Wed 21 Oct 2026, 19:00**");
		expect(store.get(id)).toMatchObject({ paused: false, lastRunAt: clock.now.toISOString() });
		await tick();
		expect(posted).toEqual([]);
	});

	it("won't resume a one-off whose time passed while it was paused", async () => {
		const { panel, act, store, clock } = setup();
		const { id } = add(store, { paused: true });
		clock.now = new Date("2026-10-15T08:00:00Z");
		const reply = replyOf(await panel(id));
		expect(said(reply.embeds?.[0])).toContain(SCHEDULE_MESSAGES.cantResume);
		expect(labels(reply)).toEqual(["Delete", "← All schedules"]);
		expect(await act(ACTIONS.resume, { id })).toEqual({
			kind: "refused",
			reply: { text: SCHEDULE_MESSAGES.cantResume, private: true },
		});
	});

	it("says when a one-off has finished", async () => {
		const { panel, store } = setup();
		const { id } = add(store, { lastRunAt: "2026-10-14T17:00:00.000Z" });
		const reply = replyOf(await panel(id));
		expect(said(reply.embeds?.[0])).toContain("It has nothing left to post.");
		expect(labels(reply)).toEqual(["Delete", "← All schedules"]);
	});

	it("asks before deleting, and goes back to the list after", async () => {
		const { panel, click, store, info } = setup();
		const { id } = add(store);
		const confirm = replyOf(await click(replyOf(await panel(id)), "Delete"));
		expect(confirm.embeds?.[0]?.title).toBe("Delete Pizza?");
		expect(labels(confirm)).toEqual(["Delete schedule", "Cancel"]);
		expect(button(confirm, "Delete schedule")?.style).toBe("danger");
		expect(store.get(id)).toBeDefined();
		expect(replyOf(await click(confirm, "Cancel")).embeds?.[0]?.title).toBe("💬 Pizza");
		const gone = replyOf(await click(confirm, "Delete schedule"));
		expect(said(gone.embeds?.[0])).toContain("🗑 Deleted **Pizza**.");
		expect(store.all()).toEqual([]);
		expect(info).toHaveBeenCalledWith({ event: "schedule.deleted", id }, "deleted a schedule");
	});

	it.each([ACTIONS.pause, ACTIONS.resume, ACTIONS.delete, ACTIONS.confirmDelete, ACTIONS.edit])(
		"lets only the owner %s, logging the refusal",
		async (action) => {
			const { act, store, info } = setup();
			const { id } = add(store, { createdBy: { ref: `discord:${OTHER_MEMBER}`, name: "Sam" } });
			expect(await act(action, { id })).toEqual({
				kind: "refused",
				reply: { text: SCHEDULE_MESSAGES.notYours, private: true },
			});
			expect(store.get(id)).toMatchObject({ paused: false });
			expect(info).toHaveBeenCalledWith(
				expect.objectContaining({
					event: "schedule.edit_refused",
					id,
					user: `discord:${IDS.member}`,
				}),
				expect.any(String),
			);
		},
	);
});

describe("editing", () => {
	async function editForm(ctx: ReturnType<typeof setup>, id: string) {
		return formOf(await ctx.click(replyOf(await ctx.panel(id)), "Edit"));
	}

	it("opens the form filled in with what's saved", async () => {
		const ctx = setup();
		const { id } = add(ctx.store, {
			recurrence: { kind: "weekly", everyWeeks: 2, days: ["wed", "sat"] },
		});
		const form = await editForm(ctx, id);
		expect(form.title).toBe("Edit message");
		expect(form.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "channel", value: CHANNEL }),
				expect.objectContaining({ name: "when", value: "14 oct 2026 19:00" }),
				expect.objectContaining({ name: "text", value: "Pizza night tonight!" }),
			]),
		);
		const repeat = form.fields.find((f) => f.name === "repeat");
		expect(repeat?.kind === "radio" && repeat.options.find((o) => o.selected)?.value).toBe(
			"fortnightly",
		);
	});

	it("saves new text without retiming, so nothing goes out early or late", async () => {
		const ctx = setup();
		const { id } = add(ctx.store, {
			recurrence: { kind: "weekly", everyWeeks: 1, days: ["wed"] },
			lastRunAt: "2026-10-07T17:00:00.000Z",
		});
		const form = await editForm(ctx, id);
		const draft = replyOf(
			await ctx.submit(form, { when: "14 oct 2026 19:00", repeat: "weekly", text: "New text" }),
		);
		expect(draft.embeds?.[0]?.title).toBe("Changes to Pizza");
		expect(said(draft.embeds?.[0])).toContain("Nothing is saved until you press **Save changes**.");
		expect(said(draft.embeds?.[0])).toContain("next post **Wed 14 Oct 2026, 19:00**");
		expect(ctx.store.get(id)?.post).toMatchObject({ text: "Pizza night tonight!" });
		const saved = replyOf(await ctx.click(draft, "Save changes"));
		expect(said(saved.embeds?.[0])).toContain("✅ **Saved.**");
		expect(ctx.store.get(id)).toMatchObject({
			post: { text: "New text" },
			start: "2026-10-14T19:00",
			lastRunAt: "2026-10-07T17:00:00.000Z",
		});
		expect(ctx.info).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.edited", id }),
			"edited a schedule",
		);
	});

	it("retimes from now when the time changes, and can move it to another channel", async () => {
		const ctx = setup();
		const { id } = add(ctx.store, { name: "Kept" });
		const form = await editForm(ctx, id);
		const draft = replyOf(
			await ctx.submit(
				form,
				{ when: "fri 20:00", repeat: "once", text: "Pizza night tonight!" },
				{ channel: channel({}, OTHER_CHANNEL) },
			),
		);
		await ctx.click(draft, "Save changes");
		expect(ctx.store.get(id)).toMatchObject({
			name: "Kept",
			start: "2026-10-16T20:00",
			channelId: OTHER_CHANNEL,
			lastRunAt: NOW.toISOString(),
		});
	});

	it("checks the channel again, for what the person may do there now", async () => {
		const ctx = setup();
		const { id } = add(ctx.store);
		const draft = replyOf(
			await ctx.submit(
				await editForm(ctx, id),
				{ when: "14 oct 2026 19:00", repeat: "once", text: "x" },
				{ channel: channel({ canPost: false }) },
			),
		);
		expect(said(draft.embeds?.[0])).toContain(SCHEDULE_MESSAGES.cantPost);
		expect(button(draft, "Save changes")?.disabled).toBe(true);
	});

	it("won't turn a repeat into a one-off whose time has passed", async () => {
		const ctx = setup();
		const { id } = add(ctx.store, {
			start: "2026-10-05T19:00",
			recurrence: { kind: "weekly", everyWeeks: 1, days: ["mon"] },
		});
		const form = await editForm(ctx, id);
		const when = form.fields.find((f) => f.name === "when");
		const draft = replyOf(
			await ctx.submit(form, {
				when: (when?.kind === "text" && when.value) || "",
				repeat: "once",
				text: "x",
			}),
		);
		expect(said(draft.embeds?.[0])).toContain(SCHEDULE_MESSAGES.nothingLeft);
	});

	it("edits a poll's question, answers and duration", async () => {
		const ctx = setup();
		const { id } = add(ctx.store, {
			post: {
				kind: "poll",
				question: "Q?",
				answers: ["a", "b"],
				durationHours: 24,
				multiple: true,
			},
		});
		const form = await editForm(ctx, id);
		expect(form.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "question", value: "Q?" }),
				expect.objectContaining({ name: "answers", value: "a\nb" }),
			]),
		);
		const draft = replyOf(
			await ctx.submit(form, {
				when: "14 oct 2026 19:00",
				repeat: "once",
				question: "New?",
				answers: "x\ny\nz",
			}),
		);
		expect(labels(draft)).toContain("Several answers: on");
		const longer = replyOf(await ctx.click(draft, "How long can people vote?", ["1 week"]));
		await ctx.click(longer, "Save changes");
		expect(ctx.store.get(id)?.post).toEqual({
			kind: "poll",
			question: "New?",
			answers: ["x", "y", "z"],
			durationHours: 168,
			multiple: true,
		});
	});

	it("cancels back to the schedule, unchanged", async () => {
		const ctx = setup();
		const { id } = add(ctx.store);
		const draft = replyOf(
			await ctx.submit(await editForm(ctx, id), {
				when: "14 oct 2026 19:00",
				repeat: "once",
				text: "Changed",
			}),
		);
		const back = replyOf(await ctx.click(draft, "Cancel"));
		expect(said(back.embeds?.[0])).toContain("Nothing was changed.");
		expect(ctx.store.get(id)?.post).toMatchObject({ text: "Pizza night tonight!" });
	});

	it("explains when the schedule was deleted while it was being edited", async () => {
		const ctx = setup();
		const { id } = add(ctx.store);
		const form = await editForm(ctx, id);
		ctx.store.remove(id);
		const draft = replyOf(
			await ctx.submit(form, { when: "14 oct 2026 19:00", repeat: "once", text: "x" }),
		);
		expect(said(draft.embeds?.[0])).toContain(SCHEDULE_MESSAGES.scheduleGone);
		expect(said(replyOf(await ctx.click(draft, "Cancel")).embeds?.[0])).toContain(
			"Nothing was saved.",
		);
	});

	it("isn't offered, and refuses, once a schedule has nothing left to post", async () => {
		const ctx = setup();
		const { id } = add(ctx.store, { lastRunAt: "2026-10-14T17:00:00.000Z" });
		expect(await ctx.act(ACTIONS.edit, { id })).toEqual({
			kind: "refused",
			reply: { text: SCHEDULE_MESSAGES.nothingLeft, private: true },
		});
	});
});

describe("drafts", () => {
	it("belong to the person who started them", async () => {
		const { draftMessage, act } = setup();
		const reply = replyOf(await draftMessage());
		const save = button(reply, "Schedule");
		const theirs = replyOf(
			await act(ACTIONS.save, save?.call.args as Record<string, string>, { userId: OTHER_MEMBER }),
		);
		expect(said(theirs.embeds?.[0])).toContain(SCHEDULE_MESSAGES.draftGone);
	});

	it("expire after half an hour untouched", async () => {
		const { draftMessage, click, clock, store } = setup();
		const reply = replyOf(await draftMessage());
		clock.now = new Date(NOW.getTime() + 31 * 60_000);
		expect(said(replyOf(await click(reply, "Schedule")).embeds?.[0])).toContain(
			SCHEDULE_MESSAGES.draftGone,
		);
		expect(store.all()).toEqual([]);
	});

	it("drop the least recently touched one at the cap, not one still being worked on", async () => {
		const { newForm, draftMessage, act } = setup();
		const kept = button(replyOf(await draftMessage()), "Rename")?.call.args as Record<
			string,
			string
		>;
		const idle = (await newForm("message")).submit.args as Record<string, string>;
		for (let i = 0; i < 98; i++) await newForm("message");
		// The first draft is touched, so the idle one is now the least recent.
		await act(ACTIONS.renamed, { ...kept, name: "Kept" });
		await newForm("message");
		expect((await act(ACTIONS.details, kept)).kind).toBe("form");
		expect(said(replyOf(await act(ACTIONS.details, idle)).embeds?.[0])).toContain(
			SCHEDULE_MESSAGES.draftGone,
		);
	});

	it("are saved once, even when Schedule is clicked twice while Pixel checks the channel", async () => {
		const { draftMessage, click, poster, store } = setup();
		const reply = replyOf(await draftMessage());
		let release: (check: ChannelCheck) => void = () => {};
		poster.check.mockImplementationOnce(
			() => new Promise<ChannelCheck>((resolve) => (release = resolve)),
		);
		const first = click(reply, "Schedule");
		const second = await click(reply, "Schedule");
		release({ ok: true, name: "general" });
		expect(said(replyOf(await first).embeds?.[0])).toContain("✅ **Scheduled.**");
		expect(second).toEqual({
			kind: "refused",
			reply: { text: SCHEDULE_MESSAGES.saving, private: true },
		});
		expect(store.all()).toHaveLength(1);
	});

	it("are kept to a hundred, dropping the oldest", async () => {
		const { newForm, act } = setup();
		const first = await newForm("message");
		for (let i = 0; i < 100; i++) await newForm("message");
		const outcome = replyOf(
			await act(ACTIONS.details, first.submit.args as Record<string, string>),
		);
		expect(said(outcome.embeds?.[0])).toContain(SCHEDULE_MESSAGES.draftGone);
	});
});

describe("the background runner", () => {
	beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-14T17:00:10Z") }));
	afterEach(() => vi.useRealTimers());

	it("checks straight away and every 30 seconds, and stops when told", async () => {
		const store = new ScheduleStore({ logger: silentLogger });
		const posts = new ChannelPosts();
		const post = vi.fn(async () => ({ url: "https://discord.com/channels/1/2/3" }));
		posts.use({ check: async () => ({ ok: true, name: "g" }), post });
		add(store, { start: "2026-10-14T19:01" });
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
