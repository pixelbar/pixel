import { describe, expect, it, vi } from "vitest";
import type { ChannelPost } from "../../core/channel-posts.ts";
import { createInterpolator } from "../../core/interpolate.ts";
import { silentLogger } from "../../core/logger.ts";
import { type Schedule, ScheduleStore } from "../../services/schedules.ts";
import { dueOccurrence, dueReminder, LATE_LIMIT_MS, runDue } from "./runner.ts";

const AMS = "Europe/Amsterdam";
const sample = (over: Partial<Omit<Schedule, "id">> = {}): Omit<Schedule, "id"> => ({
	name: "Weekly",
	channelId: "100000000000000050",
	channelName: "general",
	post: { kind: "message", text: "Hello", mentions: false },
	start: "2026-10-14T19:00",
	recurrence: { kind: "weekly", everyWeeks: 1, days: ["wed", "sat"] },
	paused: false,
	createdBy: { ref: "discord:100000000000000002", name: "Ada" },
	createdAt: "2026-10-12T08:00:00.000Z",
	lastRunAt: null,
	...over,
});

// Wednesday 14 October 2026, 19:00 in Amsterdam is 17:00 UTC.
const WED_19 = new Date("2026-10-14T17:00:00Z");
const plus = (ms: number) => new Date(WED_19.getTime() + ms);

function setup(options: { allowed?: boolean; fail?: boolean; ready?: boolean } = {}) {
	const store = new ScheduleStore({ logger: silentLogger });
	const posted: [string, ChannelPost][] = [];
	const posts = {
		ready: options.ready ?? true,
		post: vi.fn(async (channelId: string, post: ChannelPost) => {
			if (options.fail) throw new Error("discord down");
			posted.push([channelId, post]);
			return { url: `https://example.test/m/${posted.length}` };
		}),
	};
	const warn = vi.fn();
	const error = vi.fn();
	const logger = { ...silentLogger, warn, error };
	logger.child = () => logger;
	const reporter = { captureBackground: vi.fn(), breadcrumb: vi.fn() };
	const handled = new Set<string>();
	const stillAllowed = vi.fn(async () => options.allowed ?? true);
	const run = (now: Date) =>
		runDue(
			{
				store,
				posts,
				timezone: AMS,
				interpolator: createInterpolator({ timezone: AMS }),
				stillAllowed,
				logger,
				reporter,
				handled,
			},
			now,
		);
	return { store, posts, posted, warn, error, reporter, run, stillAllowed, handled };
}

describe("dueOccurrence", () => {
	it("is nothing before the first time, and the occurrence once it has come", () => {
		const schedule = sample();
		expect(dueOccurrence(schedule, AMS, plus(-1000))).toBeUndefined();
		expect(dueOccurrence(schedule, AMS, WED_19)).toEqual({ at: WED_19, skipped: 0 });
	});

	it("is only the latest when several were missed, and counts the rest", () => {
		const due = dueOccurrence(sample(), AMS, new Date("2026-10-22T08:00:00Z"));
		// Wed 14 and Sat 17 were missed; Wed 21 is the latest.
		expect(due).toEqual({ at: new Date("2026-10-21T17:00:00Z"), skipped: 2 });
	});

	it("starts from the last one handled", () => {
		expect(
			dueOccurrence(sample({ lastRunAt: WED_19.toISOString() }), AMS, plus(60_000)),
		).toBeUndefined();
	});

	it("is nothing for a start that can't be read", () => {
		expect(dueOccurrence(sample({ start: "bad" }), AMS, WED_19)).toBeUndefined();
	});
});

describe("runDue", () => {
	it("posts a due schedule once, and remembers it", async () => {
		const { store, posted, run, reporter } = setup();
		const s = store.add(sample());
		await run(plus(10_000));
		await run(plus(40_000));
		expect(posted).toEqual([
			["100000000000000050", { kind: "message", text: "Hello", mentions: false }],
		]);
		expect(store.get(s.id)?.lastRunAt).toBe(WED_19.toISOString());
		expect(reporter.breadcrumb).toHaveBeenCalledWith(
			"schedule",
			`posted ${s.id}`,
			expect.any(Object),
		);
	});

	it("posts the next occurrence when it comes", async () => {
		const { store, posted, run } = setup();
		store.add(sample());
		await run(plus(10_000));
		await run(new Date("2026-10-17T17:00:30Z"));
		expect(posted).toHaveLength(2);
	});

	it("removes a one-off once it's posted", async () => {
		const { store, posted, run } = setup();
		store.add(sample({ recurrence: { kind: "once" } }));
		await run(plus(10_000));
		expect(posted).toHaveLength(1);
		expect(store.all()).toEqual([]);
	});

	it("still posts up to an hour late, and skips anything later, logging it", async () => {
		const late = setup();
		late.store.add(sample());
		await late.run(plus(LATE_LIMIT_MS));
		expect(late.posted).toHaveLength(1);

		const tooLate = setup();
		const s = tooLate.store.add(sample());
		await tooLate.run(plus(LATE_LIMIT_MS + 1000));
		expect(tooLate.posted).toEqual([]);
		expect(tooLate.store.get(s.id)?.lastRunAt).toBe(WED_19.toISOString());
		expect(tooLate.warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.skipped" }),
			expect.any(String),
		);
	});

	it("posts only the latest after an outage, and says how many it missed", async () => {
		const { store, posted, run, warn } = setup();
		store.add(sample());
		await run(new Date("2026-10-21T17:30:00Z"));
		expect(posted).toHaveLength(1);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.missed", missed: 2 }),
			expect.any(String),
		);
	});

	it("doesn't post paused schedules", async () => {
		const { store, posted, run } = setup();
		store.add(sample({ paused: true }));
		await run(plus(10_000));
		expect(posted).toEqual([]);
	});

	it("pauses a schedule whose creator can no longer schedule posts, instead of posting", async () => {
		const { store, posted, run, stillAllowed, warn } = setup({ allowed: false });
		const s = store.add(sample());
		await run(plus(10_000));
		expect(posted).toEqual([]);
		expect(stillAllowed).toHaveBeenCalledWith("discord:100000000000000002");
		expect(store.get(s.id)?.paused).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.paused_no_access" }),
			expect.any(String),
		);
	});

	it("never retries a failed post: it reports it and waits for the next occurrence", async () => {
		const { store, posts, run, reporter, error } = setup({ fail: true });
		const s = store.add(sample());
		await run(plus(10_000));
		await run(plus(40_000));
		expect(posts.post).toHaveBeenCalledTimes(1);
		expect(store.get(s.id)?.lastRunAt).toBe(WED_19.toISOString());
		expect(reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "schedules");
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.failed" }),
			expect.any(String),
		);
	});

	it("never posts twice even when it can't record that it posted", async () => {
		const { store, posts, run, reporter } = setup();
		store.add(sample());
		vi.spyOn(store, "update").mockImplementation(() => {
			throw new Error("disk full");
		});
		await run(plus(10_000));
		await run(plus(40_000));
		expect(posts.post).toHaveBeenCalledTimes(1);
		expect(reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "schedules");
	});

	it("fills tokens in a message at post time, not compose time", async () => {
		const { store, posted, run } = setup();
		const s = store.add(
			sample({
				post: { kind: "message", text: "Open {{day}} {{date}} ({{unknown}})", mentions: false },
			}),
		);
		await run(plus(10_000));
		expect(posted).toEqual([
			[
				"100000000000000050",
				{
					kind: "message",
					text: "Open Wednesday 14 October 2026 ({{unknown}})",
					mentions: false,
				},
			],
		]);
		expect(store.get(s.id)?.post).toMatchObject({
			text: "Open {{day}} {{date}} ({{unknown}})",
		});
	});

	it("offsets date tokens from the scheduled day, not a late send", async () => {
		const { store, posted, run } = setup();
		store.add(
			sample({
				start: "2026-10-14T23:30",
				post: {
					kind: "message",
					text: "{{day}} {{date}} → {{day+2}} {{date+2}}",
					mentions: false,
				},
			}),
		);
		// Scheduled Wed 23:30; sent Thu 00:20 (50 minutes late, still within the hour).
		await run(new Date("2026-10-14T22:20:00Z"));
		expect(posted).toEqual([
			[
				"100000000000000050",
				{
					kind: "message",
					text: "Wednesday 14 October 2026 → Friday 16 October 2026",
					mentions: false,
				},
			],
		]);
	});

	it("fills tokens in a poll question and answers at post time", async () => {
		const { store, posted, run } = setup();
		store.add(
			sample({
				post: {
					kind: "poll",
					question: "Open {{dateWithTime}}?",
					answers: ["Yes {{day}}", "No {{month}}"],
					durationHours: 24,
					multiple: false,
				},
			}),
		);
		await run(plus(10_000));
		expect(posted).toEqual([
			[
				"100000000000000050",
				{
					kind: "poll",
					question: "Open 14 October 2026, 19:00 CEST?",
					answers: ["Yes Wednesday", "No October"],
					durationHours: 24,
					multiple: false,
				},
			],
		]);
	});

	describe("reads each schedule fresh, so a change made while another posts counts", () => {
		async function twoDue(change: (store: ScheduleStore, second: string) => void) {
			const ctx = setup();
			ctx.store.add(sample({ post: { kind: "message", text: "First", mentions: false } }));
			const second = ctx.store.add(
				sample({ post: { kind: "message", text: "Second", mentions: false } }),
			);
			ctx.posts.post.mockImplementationOnce(async (channelId: string, post: ChannelPost) => {
				ctx.posted.push([channelId, post]);
				change(ctx.store, second.id);
				return { url: "https://example.test/m/1" };
			});
			await ctx.run(plus(10_000));
			return { ...ctx, second };
		}

		it("doesn't post one deleted meanwhile", async () => {
			const { posted, store } = await twoDue((store, id) => store.remove(id));
			expect(posted.map(([, post]) => post)).toEqual([
				{ kind: "message", text: "First", mentions: false },
			]);
			expect(store.all()).toHaveLength(1);
		});

		it("doesn't post one paused meanwhile, and leaves it paused and unrecorded", async () => {
			const { posted, store, second } = await twoDue((store, id) =>
				store.update(id, { paused: true }),
			);
			expect(posted).toHaveLength(1);
			expect(store.get(second.id)).toMatchObject({ paused: true, lastRunAt: null });
		});

		it("posts the edited text of one edited meanwhile", async () => {
			const { posted } = await twoDue((store, id) =>
				store.update(id, { post: { kind: "message", text: "Edited", mentions: false } }),
			);
			expect(posted.map(([, post]) => post)).toEqual([
				{ kind: "message", text: "First", mentions: false },
				{ kind: "message", text: "Edited", mentions: false },
			]);
		});

		it("doesn't post one moved to another time meanwhile", async () => {
			const { posted, store, second } = await twoDue((store, id) =>
				store.update(id, { start: "2026-10-15T19:00", recurrence: { kind: "once" } }),
			);
			expect(posted).toHaveLength(1);
			expect(store.get(second.id)?.lastRunAt).toBeNull();
		});

		it("doesn't post one deleted or paused while checking its creator's access", async () => {
			for (const change of [
				(store: ScheduleStore, id: string) => store.remove(id),
				(store: ScheduleStore, id: string) => store.update(id, { paused: true }),
			]) {
				const { store, posts, run, stillAllowed } = setup();
				const s = store.add(sample());
				stillAllowed.mockImplementationOnce(async () => {
					change(store, s.id);
					return true;
				});
				await run(plus(10_000));
				expect(posts.post).not.toHaveBeenCalled();
			}
		});
	});

	it("clips a post that tokens made too long instead of failing, and logs no text", async () => {
		const { store, posted, run, warn, error } = setup();
		// Stored before the create-time check existed: "{{date}}" (8) fills to 15 characters.
		store.add(
			sample({ post: { kind: "message", text: `${"x".repeat(1990)}{{date}}`, mentions: false } }),
		);
		await run(plus(10_000));
		const sent = posted[0]?.[1];
		expect(sent?.kind === "message" && [...sent.text].length).toBe(2000);
		expect(sent?.kind === "message" && sent.text.endsWith("…")).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.clipped" }),
			expect.any(String),
		);
		expect(error).not.toHaveBeenCalled();
		expect(JSON.stringify(warn.mock.calls)).not.toContain("xxxx");
	});

	it("does nothing until Discord is ready, or while the file is broken", async () => {
		const notReady = setup({ ready: false });
		notReady.store.add(sample());
		await notReady.run(plus(10_000));
		expect(notReady.posts.post).not.toHaveBeenCalled();
		// Not handled yet, so it goes out once Discord is ready.
		expect(notReady.handled.size).toBe(0);

		const broken = setup();
		broken.store.add(sample());
		Object.defineProperty(broken.store, "problem", { value: "invalid" });
		await broken.run(plus(10_000));
		expect(broken.posts.post).not.toHaveBeenCalled();
	});
});

describe("poll reminders", () => {
	const REMIND = "100000000000000051";
	const POLL: ChannelPost = {
		kind: "poll",
		question: "Who's *coming*?",
		answers: ["Yes", "No"],
		durationHours: 72,
		multiple: false,
	};
	// Amsterdam is UTC+2 until 25 October.
	const at = (iso: string) => new Date(`${iso}Z`);
	const withReminder = (time = "18:00", over: Partial<Omit<Schedule, "id">> = {}) =>
		sample({
			post: POLL,
			recurrence: { kind: "weekly", everyWeeks: 1, days: ["wed"] },
			reminder: { channelId: REMIND, channelName: "chat", at: time },
			...over,
		});

	it("remembers the poll it posted, and reminds every day it's open with a link", async () => {
		const ctx = setup();
		const { id } = ctx.store.add(withReminder());
		await ctx.run(plus(10_000));
		expect(ctx.store.get(id)?.lastPoll).toEqual({
			question: "Who's *coming*?",
			url: "https://example.test/m/1",
			postedAt: WED_19.toISOString(),
			closesAt: plus(10_000 + 72 * 3_600_000).toISOString(),
		});
		// Wed 18:00 was before the poll: the first reminder is Thursday's.
		await ctx.run(at("2026-10-15T15:59:00"));
		expect(ctx.posted).toHaveLength(1);
		await ctx.run(at("2026-10-15T16:00:05"));
		await ctx.run(at("2026-10-15T16:00:35"));
		expect(ctx.posted.slice(1)).toEqual([
			[
				REMIND,
				{
					kind: "message",
					text: "🗳️ Reminder: vote on **Who's \\*coming\\*?** before Sat 17 Oct 2026, 19:00: https://example.test/m/1",
					mentions: false,
				},
			],
		]);
		await ctx.run(at("2026-10-16T16:00:05"));
		await ctx.run(at("2026-10-17T16:00:05"));
		// Closed Saturday at 19:00: nothing on Sunday.
		await ctx.run(at("2026-10-18T16:00:05"));
		expect(ctx.posted.map(([channel]) => channel)).toEqual([
			"100000000000000050",
			REMIND,
			REMIND,
			REMIND,
		]);
	});

	it("reminds the same day when the time comes after the poll", async () => {
		const ctx = setup();
		ctx.store.add(withReminder("20:00"));
		await ctx.run(plus(10_000));
		await ctx.run(at("2026-10-14T18:00:05"));
		expect(ctx.posted.at(-1)?.[0]).toBe(REMIND);
		// Saturday's 20:00 is after it closes at 19:00.
		await ctx.run(at("2026-10-17T18:00:05"));
		expect(ctx.posted.filter(([channel]) => channel === REMIND)).toHaveLength(1);
	});

	it("has nothing due without a reminder or a posted poll", () => {
		const reminder = { channelId: REMIND, channelName: "chat", at: "18:00" };
		const lastPoll = {
			question: "Q",
			url: "https://example.test/m/1",
			postedAt: WED_19.toISOString(),
			closesAt: plus(72 * 3_600_000).toISOString(),
		};
		const now = at("2026-10-15T16:00:05");
		expect(dueReminder({ lastPoll }, AMS, now)).toBeUndefined();
		expect(dueReminder({ reminder }, AMS, now)).toBeUndefined();
		expect(dueReminder({ reminder, lastPoll }, AMS, now)?.at).toEqual(at("2026-10-15T16:00:00"));
	});

	it("skips a reminder more than an hour late, and remembers it", async () => {
		const ctx = setup();
		const { id } = ctx.store.add(withReminder());
		await ctx.run(plus(10_000));
		await ctx.run(at("2026-10-15T17:30:00"));
		expect(ctx.posted).toHaveLength(1);
		expect(ctx.warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.reminder_skipped" }),
			expect.any(String),
		);
		expect(ctx.store.get(id)?.lastReminderAt).toBe(at("2026-10-15T16:00:00").toISOString());
	});

	it("doesn't remind while paused", async () => {
		const ctx = setup();
		const { id } = ctx.store.add(withReminder());
		await ctx.run(plus(10_000));
		ctx.store.update(id, { paused: true });
		await ctx.run(at("2026-10-15T16:00:05"));
		expect(ctx.posted).toHaveLength(1);
	});

	it("pauses instead of reminding when its creator lost access", async () => {
		const ctx = setup();
		const { id } = ctx.store.add(withReminder());
		await ctx.run(plus(10_000));
		ctx.stillAllowed.mockResolvedValue(false);
		await ctx.run(at("2026-10-15T16:00:05"));
		expect(ctx.posted).toHaveLength(1);
		expect(ctx.store.get(id)?.paused).toBe(true);
	});

	it("doesn't remind when the reminder was turned off while it checked", async () => {
		const ctx = setup();
		const { id } = ctx.store.add(withReminder());
		await ctx.run(plus(10_000));
		ctx.stillAllowed.mockImplementation(async () => {
			ctx.store.update(id, { reminder: undefined });
			return true;
		});
		await ctx.run(at("2026-10-15T16:00:05"));
		expect(ctx.posted).toHaveLength(1);
	});

	it("reports a reminder that fails, and doesn't try it again", async () => {
		const ctx = setup();
		const { id } = ctx.store.add(withReminder());
		await ctx.run(plus(10_000));
		ctx.posts.post.mockRejectedValueOnce(new Error("discord down"));
		await ctx.run(at("2026-10-15T16:00:05"));
		expect(ctx.error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "schedule.reminder_failed" }),
			expect.any(String),
		);
		expect(ctx.reporter.captureBackground).toHaveBeenCalled();
		expect(ctx.store.get(id)?.lastReminderAt).toBe(at("2026-10-15T16:00:00").toISOString());
	});

	it("keeps a one-off poll with reminders until it closes, then removes it", async () => {
		const ctx = setup();
		const { id } = ctx.store.add(withReminder("18:00", { recurrence: { kind: "once" } }));
		const plain = ctx.store.add(sample({ post: POLL, recurrence: { kind: "once" } }));
		await ctx.run(plus(10_000));
		expect(ctx.store.get(plain.id)).toBeUndefined();
		await ctx.run(at("2026-10-15T16:00:05"));
		expect(ctx.posted.at(-1)?.[0]).toBe(REMIND);
		await ctx.run(at("2026-10-17T17:00:11"));
		expect(ctx.store.get(id)).toBeUndefined();
	});

	it("keeps a repeat edited into a one-off until that one-off has posted", async () => {
		const ctx = setup();
		const { id } = ctx.store.add(withReminder());
		await ctx.run(plus(10_000));
		// Edited (as /schedule edit does) into a one-off after the old poll closed.
		ctx.store.update(id, {
			recurrence: { kind: "once" },
			start: "2026-10-28T19:00",
			lastRunAt: at("2026-10-20T08:00:00").toISOString(),
		});
		await ctx.run(at("2026-10-20T08:00:05"));
		expect(ctx.store.get(id)).toBeDefined();
		await ctx.run(at("2026-10-28T18:00:05"));
		expect(ctx.posted.at(-1)?.[1]).toEqual(POLL);
		expect(ctx.store.get(id)?.lastPoll?.postedAt).toBe(at("2026-10-28T18:00:00").toISOString());
	});

	it("drops a one-off whose start can't be read once its poll closed", async () => {
		const ctx = setup();
		const { id } = ctx.store.add(withReminder("18:00", { recurrence: { kind: "once" } }));
		await ctx.run(plus(10_000));
		ctx.store.update(id, { start: "not a time" });
		await ctx.run(at("2026-10-17T17:00:11"));
		expect(ctx.store.get(id)).toBeUndefined();
	});

	it("logs a reminder it can't record or a finished one-off it can't remove", async () => {
		const ctx = setup();
		const { id } = ctx.store.add(withReminder("18:00", { recurrence: { kind: "once" } }));
		await ctx.run(plus(10_000));
		vi.spyOn(ctx.store, "update").mockImplementation(() => {
			throw new Error("disk full");
		});
		vi.spyOn(ctx.store, "remove").mockImplementation(() => {
			throw new Error("disk full");
		});
		await ctx.run(at("2026-10-15T16:00:05"));
		await ctx.run(at("2026-10-17T17:00:11"));
		expect(ctx.error).toHaveBeenCalledTimes(2);
		expect(ctx.store.get(id)).toBeDefined();
	});
});
