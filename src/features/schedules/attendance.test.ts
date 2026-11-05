import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../../core/access.ts";
import {
	ATTEND_ACTION,
	type AttendanceMessage,
	type ChannelPost,
	type PostOptions,
} from "../../core/channel-posts.ts";
import { UserFacingError } from "../../core/errors.ts";
import { createInterpolator } from "../../core/interpolate.ts";
import { silentLogger } from "../../core/logger.ts";
import type { ActionContext } from "../../core/ui.ts";
import { type AttendancePoll, AttendanceStore } from "../../services/attendance.ts";
import type { Schedule } from "../../services/schedules.ts";
import { IDS } from "../../testing/fixtures.ts";
import {
	ATTEND_ACCESS,
	ATTEND_MESSAGES,
	attendanceMessage,
	coming,
	createAttendancePolls,
	listNames,
	resultsPost,
	resultValues,
	statusInstant,
} from "./attendance.ts";

const AMS = "Europe/Amsterdam";
/** Friday 6 November 2026, 09:00 in Amsterdam. */
const NOW = new Date("2026-11-06T08:00:00.000Z");
const ADA = `discord:${IDS.member}`;
const CHANNEL = "100000000000000050";
const RESULTS = "100000000000000051";

const poll = (over: Partial<AttendancePoll> = {}): AttendancePoll => ({
	id: "0123456789ab",
	scheduleId: "abc234",
	createdBy: ADA,
	channelId: CHANNEL,
	messageId: "100000000000000099",
	url: "https://discord.com/channels/1/2/3",
	question: "Who's coming?",
	answers: [
		{ label: "Coming", counts: true },
		{ label: "Maybe", counts: true },
		{ label: "Not coming", counts: false },
	],
	postedAt: NOW.toISOString(),
	// 23:00 in Amsterdam.
	closesAt: "2026-11-06T22:00:00.000Z",
	closed: false,
	votes: [],
	...over,
});

const vote = (n: number, name: string, answer: number) => ({
	ref: `discord:${String(100000000000000100 + n)}`,
	name,
	answer,
});

describe("listNames", () => {
	it("joins names like a person would, and says nobody when there are none", () => {
		expect(listNames([])).toBe("nobody");
		expect(listNames(["Ada"])).toBe("Ada");
		expect(listNames(["Ada", "Sam"])).toBe("Ada and Sam");
		expect(listNames(["Ada", "Sam", "Kim"])).toBe("Ada, Sam and Kim");
	});

	it("escapes markdown, so a name can't format or mention anything", () => {
		expect(listNames(["*Ada*", "<@123>", "   "])).toBe("\\*Ada\\*, \\<@123\\> and someone");
	});

	it("shows at most so many, then how many more", () => {
		expect(listNames(["Ada", "Sam", "Kim"], 2)).toBe("Ada, Sam and 1 more");
		expect(listNames(["Ada", "Sam"], 0)).toBe("2 more");
	});
});

describe("totals", () => {
	const voted = poll({
		votes: [vote(1, "Ada", 0), vote(2, "Sam", 2), vote(3, "Kim", 1)],
	});

	it("counts only the answers that count as coming", () => {
		expect(coming(voted)).toEqual(["Ada", "Kim"]);
		expect(resultValues(voted)).toEqual({
			count: "2",
			names: "Ada and Kim",
			question: "Who's coming?",
			link: "https://discord.com/channels/1/2/3",
		});
	});

	it("fills the creator's template at post time, dated for the poll's occurrence, without pings", () => {
		const fill = createInterpolator({ timezone: AMS });
		expect(resultsPost("{{count}} on {{day}}: {{names}}. {{link}}", voted, fill)).toEqual({
			kind: "message",
			text: "2 on Friday: Ada and Kim. https://discord.com/channels/1/2/3",
			mentions: false,
		});
	});

	it("clips a filled template to Discord's limit", () => {
		const fill = createInterpolator({ timezone: AMS });
		const long = poll({
			votes: Array.from({ length: 100 }, (_, i) => vote(i, "x".repeat(40), 0)),
		});
		const post = resultsPost("{{names}}", long, fill);
		expect(post.kind === "message" && [...post.text].length).toBe(2000);
		expect(post.kind === "message" && post.text.endsWith("…")).toBe(true);
	});
});

describe("attendanceMessage", () => {
	it("shows each answer's total and who picked it, and when it closes", () => {
		const message = attendanceMessage(
			poll({ votes: [vote(1, "Ada", 0), vote(2, "Sam", 0)] }),
			AMS,
			NOW,
		);
		expect(message).toEqual({
			pollId: "0123456789ab",
			answers: ["Coming", "Maybe", "Not coming"],
			open: true,
			text: [
				"🗳️ **Who's coming?**",
				"",
				"**Coming**: 2 · Ada and Sam",
				"**Maybe**: 0",
				"**Not coming**: 0",
				"",
				"Open until Fri 6 Nov 2026, 23:00. Press an answer to pick it, and again to take it back.",
			].join("\n"),
		});
	});

	it("is closed once it has closed or its time has passed", () => {
		expect(attendanceMessage(poll({ closed: true }), AMS, NOW).open).toBe(false);
		const late = attendanceMessage(poll(), AMS, new Date("2026-11-06T22:00:00.000Z"));
		expect(late.open).toBe(false);
		expect(late.text).toContain("Closed Fri 6 Nov 2026, 23:00.");
	});

	it("cuts long lists of names down until it fits", () => {
		const votes = Array.from({ length: 200 }, (_, i) => vote(i, `Person number ${i}`, i % 3));
		const message = attendanceMessage(poll({ votes }), AMS, NOW);
		expect([...message.text].length).toBeLessThanOrEqual(2000);
		expect(message.text).toMatch(/\*\*Coming\*\*: 67 · .* and \d+ more/);
	});
});

describe("statusInstant", () => {
	const posted = NOW;
	it("is that time on the day it closes", () => {
		expect(statusInstant("17:00", posted, new Date("2026-11-06T22:00:00.000Z"), AMS)).toEqual(
			new Date("2026-11-06T16:00:00.000Z"),
		);
	});

	it("counts a poll closing at midnight as closing on the day before", () => {
		// Midnight between Friday and Saturday in Amsterdam.
		expect(statusInstant("5pm", posted, new Date("2026-11-06T23:00:00.000Z"), AMS)).toEqual(
			new Date("2026-11-06T16:00:00.000Z"),
		);
	});

	it("is the closing day's time for a poll open for days", () => {
		expect(statusInstant("17:00", posted, new Date("2026-11-08T22:00:00.000Z"), AMS)).toEqual(
			new Date("2026-11-08T16:00:00.000Z"),
		);
	});

	it("is none when that's before it's posted, after it closes, or not a time", () => {
		expect(
			statusInstant("08:00", posted, new Date("2026-11-06T22:00:00.000Z"), AMS),
		).toBeUndefined();
		expect(
			statusInstant("23:30", posted, new Date("2026-11-06T22:00:00.000Z"), AMS),
		).toBeUndefined();
		expect(
			statusInstant("soon", posted, new Date("2026-11-06T22:00:00.000Z"), AMS),
		).toBeUndefined();
	});
});

function setup(options: { allowed?: boolean; ready?: boolean } = {}) {
	const store = new AttendanceStore({ logger: silentLogger });
	const clock = { now: NOW };
	const edits: AttendanceMessage[] = [];
	const posted: { channelId: string; post: ChannelPost; options?: PostOptions }[] = [];
	let editFails = false;
	let release: (() => void) | undefined;
	const posts = {
		ready: options.ready ?? true,
		postAttendance: vi.fn(async (_channelId: string, _message: AttendanceMessage) => ({
			url: "https://discord.com/channels/1/2/3",
			messageId: "100000000000000099",
		})),
		editAttendance: vi.fn(async (_c: string, _m: string, message: AttendanceMessage) => {
			if (release === undefined && hold) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			if (editFails) throw new Error("Missing Access");
			edits.push(message);
		}),
		post: vi.fn(async (channelId: string, post: ChannelPost, options?: PostOptions) => {
			posted.push({ channelId, post, ...(options ? { options } : {}) });
			return { url: "https://discord.com/channels/1/2/4", messageId: "4" };
		}),
	};
	let hold = false;
	const info = vi.fn();
	const warn = vi.fn();
	const error = vi.fn();
	const logger = { ...silentLogger, info, warn, error };
	logger.child = () => logger;
	const reporter = { captureBackground: vi.fn(), breadcrumb: vi.fn() };
	const polls = createAttendancePolls({
		store,
		posts,
		timezone: AMS,
		interpolator: createInterpolator({ timezone: AMS }),
		logger,
		reporter,
		now: () => clock.now,
	});
	const principal: Principal = {
		platform: "discord",
		userId: IDS.member,
		displayName: "Ada",
		chat: "group",
		tier: "guest",
		capabilities: [],
	};
	const click = (args: Record<string, string | number>, who: Partial<Principal> = {}) =>
		polls.action.handler({
			args,
			users: {},
			channels: {},
			principal: { ...principal, ...who },
			logger,
		} as ActionContext);
	const stillAllowed = vi.fn(async () => options.allowed ?? true);
	const handled = new Set<string>();
	const run = (at: Date) => polls.runDue(at, stillAllowed, handled);
	return {
		store,
		clock,
		edits,
		posted,
		posts,
		polls,
		click,
		run,
		reporter,
		info,
		warn,
		error,
		stillAllowed,
		failEdits: (fail = true) => {
			editFails = fail;
		},
		holdEdits: () => {
			hold = true;
		},
		releaseEdits: () => release?.(),
	};
}

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
	id: "abc234",
	name: "Friday",
	channelId: CHANNEL,
	channelName: "general",
	post: {
		kind: "attendance",
		question: "Who's coming?",
		answers: [
			{ label: "Coming", counts: true },
			{ label: "Not coming", counts: false },
		],
		durationHours: 14,
	},
	start: "2026-11-06T09:00",
	recurrence: { kind: "once" },
	paused: false,
	createdBy: { ref: ADA, name: "Ada" },
	createdAt: NOW.toISOString(),
	lastRunAt: null,
	...over,
});

const FILLED = {
	kind: "attendance" as const,
	question: "Who's coming on Friday?",
	answers: [
		{ label: "Coming", counts: true },
		{ label: "Not coming", counts: false },
	],
	durationHours: 14,
};

const RESULTS_SETTINGS = {
	channelId: RESULTS,
	channelName: "results",
	statusAt: "17:00",
	statusText: "So far {{count}}: {{names}}",
	closedText: "Closed: {{count}} coming on {{day}}",
};

describe("posting an attendance poll", () => {
	it("posts its message with no votes, and starts counting with the results settings copied", async () => {
		const t = setup();
		const posted = await t.polls.post(schedule({ results: RESULTS_SETTINGS }), FILLED, NOW);
		expect(posted).toEqual({
			question: "Who's coming on Friday?",
			url: "https://discord.com/channels/1/2/3",
			postedAt: NOW.toISOString(),
			// 14 hours from when it was sent: 23:00.
			closesAt: "2026-11-06T22:00:00.000Z",
		});
		const [channelId, message] = t.posts.postAttendance.mock.calls[0] ?? [];
		expect(channelId).toBe(CHANNEL);
		expect(message?.answers).toEqual(["Coming", "Not coming"]);
		expect(message?.open).toBe(true);
		const [stored] = t.store.all();
		expect(stored).toEqual(
			expect.objectContaining({
				id: message?.pollId,
				scheduleId: "abc234",
				createdBy: ADA,
				messageId: "100000000000000099",
				question: "Who's coming on Friday?",
				results: {
					channelId: RESULTS,
					statusAt: "2026-11-06T16:00:00.000Z",
					statusText: "So far {{count}}: {{names}}",
					closedText: "Closed: {{count}} coming on {{day}}",
				},
				closed: false,
				votes: [],
			}),
		);
	});

	it("leaves the status post out when its time doesn't fall while it's open", async () => {
		const t = setup();
		await t.polls.post(
			schedule({ results: { ...RESULTS_SETTINGS, statusAt: "08:00" } }),
			FILLED,
			NOW,
		);
		expect(t.store.all()[0]?.results).not.toHaveProperty("statusAt");
		const plain = setup();
		const { statusAt: _, ...noStatus } = RESULTS_SETTINGS;
		await plain.polls.post(schedule({ results: noStatus }), FILLED, NOW);
		expect(plain.store.all()[0]?.results).not.toHaveProperty("statusAt");
	});

	it("posts nothing while the attendance file is broken", async () => {
		const t = setup();
		Object.defineProperty(t.store, "problem", { value: "broken" });
		await expect(t.polls.post(schedule(), FILLED, NOW)).rejects.toThrow(/unavailable/);
		expect(t.posts.postAttendance).not.toHaveBeenCalled();
	});
});

describe("voting", () => {
	it("is open to anyone", () => {
		const t = setup();
		expect(t.polls.action.name).toBe(ATTEND_ACTION);
		expect(t.polls.action.access).toEqual(ATTEND_ACCESS);
		expect(ATTEND_ACCESS).toEqual({ minTier: "guest" });
	});

	it("records the clicker by ID, answers privately, and updates the message", async () => {
		const t = setup();
		t.store.add(poll(), NOW);
		const result = await t.click({ poll: "0123456789ab", answer: 0 });
		expect(result).toEqual({
			reply: { private: true, text: ATTEND_MESSAGES.chose("Coming") },
		});
		expect(t.store.get("0123456789ab")?.votes).toEqual([{ ref: ADA, name: "Ada", answer: 0 }]);
		await t.polls.refresh("0123456789ab");
		expect(t.edits.at(-1)?.text).toContain("**Coming**: 1 · Ada");
		expect(t.info).toHaveBeenCalledWith(
			{ event: "attendance.voted", poll: "0123456789ab", took: "answer" },
			expect.any(String),
		);
	});

	it("takes an answer back when it's picked again", async () => {
		const t = setup();
		t.store.add(poll(), NOW);
		await t.click({ poll: "0123456789ab", answer: 1 });
		expect(await t.click({ poll: "0123456789ab", answer: 1 })).toEqual({
			reply: { private: true, text: ATTEND_MESSAGES.tookBack },
		});
		expect(t.store.get("0123456789ab")?.votes).toEqual([]);
	});

	it("refuses a poll that has gone, an answer it doesn't have, or a made-up ID", async () => {
		const t = setup();
		t.store.add(poll(), NOW);
		for (const args of [
			{ poll: "ffffffffffff", answer: 0 },
			{ poll: "0123456789ab", answer: 3 },
			{ poll: "0123456789ab", answer: -1 },
			{ poll: "../../etc", answer: 0 },
		]) {
			await expect(t.click(args)).rejects.toThrow(new UserFacingError(ATTEND_MESSAGES.gone));
		}
		expect(t.store.get("0123456789ab")?.votes).toEqual([]);
	});

	it("says attendance polls aren't working, not that the poll has gone, while the file is broken", async () => {
		const t = setup();
		t.store.add(poll(), NOW);
		Object.defineProperty(t.store, "problem", { value: "broken" });
		await expect(t.click({ poll: "0123456789ab", answer: 0 })).rejects.toThrow(
			new UserFacingError(ATTEND_MESSAGES.unavailable),
		);
	});

	it("refuses once it has closed, even before the runner has closed it", async () => {
		const t = setup();
		t.store.add(poll(), NOW);
		t.clock.now = new Date("2026-11-06T22:00:00.000Z");
		await expect(t.click({ poll: "0123456789ab", answer: 0 })).rejects.toThrow(
			ATTEND_MESSAGES.closed,
		);
		t.store.add(poll({ id: "0123456789ac", closed: true }), NOW);
		t.clock.now = NOW;
		await expect(t.click({ poll: "0123456789ac", answer: 0 })).rejects.toThrow(
			ATTEND_MESSAGES.closed,
		);
	});

	it("makes one more edit for clicks during an edit, from the latest totals", async () => {
		const t = setup();
		t.store.add(poll(), NOW);
		t.holdEdits();
		const first = t.polls.refresh("0123456789ab");
		t.store.vote("0123456789ab", ADA, "Ada", 0);
		void t.polls.refresh("0123456789ab");
		t.store.vote("0123456789ab", `discord:${IDS.friend}`, "Sam", 0);
		const again = t.polls.refresh("0123456789ab");
		await new Promise((resolve) => setTimeout(resolve, 0));
		t.releaseEdits();
		await first;
		await again;
		expect(t.posts.editAttendance).toHaveBeenCalledTimes(2);
		expect(t.edits.at(-1)?.text).toContain("**Coming**: 2 · Ada and Sam");
	});

	it("logs and reports an edit that fails, and the next click tries again", async () => {
		const t = setup();
		t.store.add(poll(), NOW);
		t.failEdits();
		await t.polls.refresh("0123456789ab");
		expect(t.error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "attendance.refresh_failed", poll: "0123456789ab" }),
			expect.any(String),
		);
		expect(t.reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "attendance");
		await t.polls.refresh("0123456789ab");
		expect(t.posts.editAttendance).toHaveBeenCalledTimes(2);
	});

	it("does nothing for a poll that has gone", async () => {
		const t = setup();
		await t.polls.refresh("ffffffffffff");
		expect(t.posts.editAttendance).not.toHaveBeenCalled();
	});
});

describe("results", () => {
	const withResults = (over: Partial<AttendancePoll> = {}) =>
		poll({
			results: {
				channelId: RESULTS,
				statusAt: "2026-11-06T16:00:00.000Z",
				statusText: "So far {{count}}: {{names}}",
				closedText: "Closed: {{count}} coming on {{day}}",
			},
			votes: [vote(1, "Ada", 0), vote(2, "Sam", 2)],
			...over,
		});

	it("posts the totals so far once, at the status time, in the results channel", async () => {
		const t = setup();
		t.store.add(withResults(), NOW);
		await t.run(new Date("2026-11-06T15:59:00.000Z"));
		expect(t.posted).toEqual([]);
		await t.run(new Date("2026-11-06T16:00:30.000Z"));
		await t.run(new Date("2026-11-06T16:01:00.000Z"));
		expect(t.posted).toEqual([
			{ channelId: RESULTS, post: { kind: "message", text: "So far 1: Ada", mentions: false } },
		]);
		expect(t.store.get("0123456789ab")?.statusHandled).toBe(true);
		expect(t.stillAllowed).toHaveBeenCalledWith(ADA);
	});

	it("replies to the poll when the results go in its own channel", async () => {
		const t = setup();
		const own = withResults({ statusHandled: true });
		t.store.add(
			{
				...own,
				results: { ...(own.results as NonNullable<typeof own.results>), channelId: CHANNEL },
			},
			NOW,
		);
		const closing = new Date("2026-11-06T22:00:10.000Z");
		t.clock.now = closing;
		await t.run(closing);
		expect(t.posted).toEqual([
			{
				channelId: CHANNEL,
				post: { kind: "message", text: "Closed: 1 coming on Friday", mentions: false },
				options: { replyTo: "100000000000000099" },
			},
		]);
	});

	it("replies to the poll with the totals so far, too", async () => {
		const t = setup();
		const own = withResults();
		t.store.add(
			{
				...own,
				results: { ...(own.results as NonNullable<typeof own.results>), channelId: CHANNEL },
			},
			NOW,
		);
		await t.run(new Date("2026-11-06T16:00:30.000Z"));
		expect(t.posted).toEqual([
			{
				channelId: CHANNEL,
				post: { kind: "message", text: "So far 1: Ada", mentions: false },
				options: { replyTo: "100000000000000099" },
			},
		]);
	});

	it("closes it: the buttons go, and the closing totals are posted once", async () => {
		const t = setup();
		t.store.add(withResults({ statusHandled: true }), NOW);
		const closing = new Date("2026-11-06T22:00:10.000Z");
		t.clock.now = closing;
		await t.run(closing);
		await t.run(closing);
		expect(t.store.get("0123456789ab")?.closed).toBe(true);
		expect(t.edits).toHaveLength(1);
		expect(t.edits[0]?.open).toBe(false);
		expect(t.posted).toEqual([
			{
				channelId: RESULTS,
				post: { kind: "message", text: "Closed: 1 coming on Friday", mentions: false },
			},
		]);
	});

	it("keeps trying to take a closed poll's buttons away until the edit works, posting its results once", async () => {
		const t = setup();
		t.store.add(withResults({ statusHandled: true }), NOW);
		t.failEdits();
		await t.run(new Date("2026-11-06T22:00:10.000Z"));
		expect(t.store.get("0123456789ab")?.closed).toBe(true);
		expect(t.store.get("0123456789ab")?.closeShown).toBeUndefined();
		await t.run(new Date("2026-11-06T22:00:40.000Z"));
		expect(t.edits).toEqual([]);
		t.failEdits(false);
		await t.run(new Date("2026-11-06T22:01:10.000Z"));
		expect(t.edits).toHaveLength(1);
		expect(t.edits[0]?.open).toBe(false);
		expect(t.store.get("0123456789ab")?.closeShown).toBe(true);
		await t.run(new Date("2026-11-06T22:01:40.000Z"));
		expect(t.edits).toHaveLength(1);
		expect(t.posted).toHaveLength(1);
		expect(t.posts.editAttendance).toHaveBeenCalledTimes(3);
	});

	it("gives up taking the buttons away a day after it closed", async () => {
		const t = setup();
		t.store.add(poll({ closed: true }), NOW);
		await t.run(new Date("2026-11-07T22:00:00.000Z"));
		expect(t.posts.editAttendance).not.toHaveBeenCalled();
		await t.run(new Date("2026-11-07T21:59:00.000Z"));
		expect(t.posts.editAttendance).toHaveBeenCalledTimes(1);
	});

	it("logs and reports a closed poll it can't record as shown", async () => {
		const t = setup();
		t.store.add(poll({ closed: true }), NOW);
		const update = vi.spyOn(t.store, "update").mockImplementation(() => {
			throw new Error("disk full");
		});
		await t.run(new Date("2026-11-06T22:10:00.000Z"));
		expect(t.error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "attendance.failed", poll: "0123456789ab" }),
			expect.any(String),
		);
		update.mockRestore();
	});

	it("closes one without results by removing its buttons only", async () => {
		const t = setup();
		t.store.add(poll(), NOW);
		await t.run(new Date("2026-11-06T22:01:00.000Z"));
		expect(t.store.get("0123456789ab")?.closed).toBe(true);
		expect(t.edits).toHaveLength(1);
		expect(t.posted).toEqual([]);
	});

	it("skips a results post more than an hour late, but still closes the poll", async () => {
		const t = setup();
		t.store.add(withResults(), NOW);
		await t.run(new Date("2026-11-06T17:30:00.000Z"));
		expect(t.posted).toEqual([]);
		expect(t.store.get("0123456789ab")?.statusHandled).toBe(true);
		await t.run(new Date("2026-11-07T01:00:00.000Z"));
		expect(t.posted).toEqual([]);
		expect(t.store.get("0123456789ab")?.closed).toBe(true);
		expect(t.warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "attendance.results_skipped", kind: "close" }),
			expect.any(String),
		);
	});

	it("posts no results once its creator may no longer schedule posts", async () => {
		const t = setup({ allowed: false });
		t.store.add(withResults(), NOW);
		await t.run(new Date("2026-11-06T16:00:00.000Z"));
		await t.run(new Date("2026-11-06T22:00:00.000Z"));
		expect(t.posted).toEqual([]);
		expect(t.store.get("0123456789ab")?.closed).toBe(true);
		expect(t.warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "attendance.results_no_access", createdBy: ADA }),
			expect.any(String),
		);
	});

	it("logs and reports a results post that fails, without trying it again", async () => {
		const t = setup();
		t.store.add(withResults(), NOW);
		t.posts.post.mockRejectedValueOnce(new Error("Missing Permissions"));
		await t.run(new Date("2026-11-06T16:00:00.000Z"));
		await t.run(new Date("2026-11-06T16:00:30.000Z"));
		expect(t.posts.post).toHaveBeenCalledTimes(1);
		expect(t.error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "attendance.failed", poll: "0123456789ab" }),
			expect.any(String),
		);
		expect(t.reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "attendance");
	});

	it("does nothing until posting is ready, or while the file is broken", async () => {
		const notReady = setup({ ready: false });
		notReady.store.add(withResults(), NOW);
		await notReady.run(new Date("2026-11-06T22:00:00.000Z"));
		expect(notReady.store.get("0123456789ab")?.closed).toBe(false);
		const broken = setup();
		broken.store.add(withResults(), NOW);
		Object.defineProperty(broken.store, "problem", { value: "broken" });
		await broken.run(new Date("2026-11-06T22:00:00.000Z"));
		expect(broken.posts.editAttendance).not.toHaveBeenCalled();
	});
});
