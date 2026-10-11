import { describe, expect, it, vi } from "vitest";
import type { ChannelPost } from "../../core/channel-posts.ts";
import { createInterpolator } from "../../core/interpolate.ts";
import { silentLogger } from "../../core/logger.ts";
import { type Schedule, ScheduleStore } from "../../services/schedules.ts";
import { dueOccurrence, LATE_LIMIT_MS, runDue } from "./runner.ts";

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
