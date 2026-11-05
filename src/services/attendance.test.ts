import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../core/logger.ts";
import {
	type AttendancePoll,
	AttendanceStore,
	AttendanceStoreError,
	MAX_POLLS,
	MAX_VOTES,
} from "./attendance.ts";

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-attendance-"));
	file = join(dir, "data", "attendance.yaml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date("2026-11-06T12:00:00.000Z");
const ADA = "discord:100000000000000002";
const SAM = "discord:100000000000000003";

const sample = (over: Partial<AttendancePoll> = {}): AttendancePoll => ({
	id: "0123456789ab",
	scheduleId: "abc234",
	createdBy: ADA,
	channelId: "100000000000000050",
	messageId: "100000000000000099",
	url: "https://discord.com/channels/1/2/3",
	question: "Who's coming?",
	answers: [
		{ label: "Coming", counts: true },
		{ label: "Not coming", counts: false },
	],
	postedAt: "2026-11-06T08:00:00.000Z",
	closesAt: "2026-11-06T23:00:00.000Z",
	closed: false,
	votes: [],
	...over,
});

function logs() {
	const error = vi.fn();
	const logger = { ...silentLogger, error };
	logger.child = () => logger;
	return { logger, error };
}

describe("AttendanceStore", () => {
	it("starts empty without a file, and keeps what's added across a restart", () => {
		const store = new AttendanceStore({ file, logger: silentLogger });
		expect(store.problem).toBeUndefined();
		expect(store.all()).toEqual([]);
		const poll = sample({
			results: {
				channelId: "100000000000000051",
				statusAt: "2026-11-06T16:00:00.000Z",
				statusText: "{{count}} so far",
				closedText: "{{count}} coming",
			},
		});
		store.add(poll, NOW);
		expect(readFileSync(file, "utf8")).toContain("Deleting it loses the votes");
		expect(new AttendanceStore({ file, logger: silentLogger }).get(poll.id)).toEqual(poll);
	});

	it("gives fresh IDs that buttons can carry", () => {
		const store = new AttendanceStore({ logger: silentLogger });
		store.add(sample(), NOW);
		const id = store.newId();
		expect(id).toMatch(/^[0-9a-f]{12}$/);
		expect(id).not.toBe("0123456789ab");
	});

	it("records an answer, switches it, and takes it back when the same one is picked again", () => {
		const store = new AttendanceStore({ file, logger: silentLogger });
		store.add(sample(), NOW);
		expect(store.vote("0123456789ab", ADA, "Ada", 0)?.answer).toBe(0);
		expect(store.vote("0123456789ab", SAM, "Sam", 0)?.answer).toBe(0);
		const switched = store.vote("0123456789ab", ADA, "Ada L.", 1);
		expect(switched?.answer).toBe(1);
		expect(switched?.poll.votes).toEqual([
			{ ref: SAM, name: "Sam", answer: 0 },
			{ ref: ADA, name: "Ada L.", answer: 1 },
		]);
		const back = store.vote("0123456789ab", ADA, "Ada", 1);
		expect(back?.answer).toBeUndefined();
		expect(back?.poll.votes).toEqual([{ ref: SAM, name: "Sam", answer: 0 }]);
		expect(new AttendanceStore({ file, logger: silentLogger }).get("0123456789ab")?.votes).toEqual([
			{ ref: SAM, name: "Sam", answer: 0 },
		]);
	});

	it("keeps at most 100 characters of a name", () => {
		const store = new AttendanceStore({ logger: silentLogger });
		store.add(sample(), NOW);
		expect(store.vote("0123456789ab", ADA, "x".repeat(150), 0)?.poll.votes[0]?.name).toHaveLength(
			100,
		);
	});

	it("says a poll has gone, and refuses an answer it doesn't have", () => {
		const store = new AttendanceStore({ logger: silentLogger });
		store.add(sample(), NOW);
		expect(store.vote("ffffffffffff", ADA, "Ada", 0)).toBeUndefined();
		expect(() => store.vote("0123456789ab", ADA, "Ada", 2)).toThrow(/out of range/);
		expect(() => store.vote("0123456789ab", ADA, "Ada", -1)).toThrow(/out of range/);
		expect(store.update("ffffffffffff", { closed: true })).toBeUndefined();
	});

	it("takes no more votes than it can hold, but still lets people change theirs", () => {
		const store = new AttendanceStore({ logger: silentLogger });
		const votes = Array.from({ length: MAX_VOTES }, (_, i) => ({
			ref: `discord:${String(100000000000000000 + i)}`,
			name: "x",
			answer: 0,
		}));
		store.add(sample({ votes }), NOW);
		expect(() => store.vote("0123456789ab", ADA, "Ada", 0)).toThrow(AttendanceStoreError);
		expect(store.vote("0123456789ab", "discord:100000000000000000", "x", 1)?.answer).toBe(1);
	});

	it("marks the status post and the close as handled", () => {
		const store = new AttendanceStore({ logger: silentLogger });
		store.add(sample(), NOW);
		expect(store.update("0123456789ab", { statusHandled: true })?.statusHandled).toBe(true);
		expect(store.update("0123456789ab", { closed: true })?.closed).toBe(true);
	});

	it("drops closed polls a week after they closed, then the oldest closed when full", () => {
		const store = new AttendanceStore({ logger: silentLogger });
		const id = (n: number) => n.toString(16).padStart(12, "0");
		store.add(sample({ id: id(1), closed: true, closesAt: "2026-10-01T00:00:00.000Z" }), NOW);
		store.add(sample({ id: id(2), closed: true }), NOW);
		expect(store.all().map((p) => p.id)).toEqual([id(2)]);
		for (let n = 3; n <= MAX_POLLS + 1; n++) store.add(sample({ id: id(n) }), NOW);
		expect(store.all()).toHaveLength(MAX_POLLS);
		expect(store.get(id(2))).toBeDefined();
		store.add(sample({ id: id(500) }), NOW);
		expect(store.all()).toHaveLength(MAX_POLLS);
		expect(store.get(id(2))).toBeUndefined();
		// Every one left is open: none is dropped to make room.
		expect(() => store.add(sample({ id: id(501) }), NOW)).toThrow(AttendanceStoreError);
	});

	it("fails closed on a file that can't be read, isn't YAML or is invalid, and never overwrites it", () => {
		mkdirSync(join(dir, "data"), { recursive: true });
		const bad = [
			"polls: [",
			"polls:\n  - id: nope\n",
			`polls:\n${[sample(), sample()].map((p) => `  - ${JSON.stringify(p)}`).join("\n")}\n`,
			`polls:\n  - ${JSON.stringify(sample({ votes: [{ ref: ADA, name: "Ada", answer: 5 }] }))}\n`,
			`polls:\n  - ${JSON.stringify(
				sample({
					votes: [
						{ ref: ADA, name: "Ada", answer: 0 },
						{ ref: ADA, name: "Ada", answer: 1 },
					],
				}),
			)}\n`,
		];
		for (const source of bad) {
			writeFileSync(file, source);
			const { logger, error } = logs();
			const store = new AttendanceStore({ file, logger });
			expect(store.problem).toBeDefined();
			expect(error).toHaveBeenCalledWith(
				{ event: "attendance.unreadable" },
				expect.stringContaining("no votes will be taken"),
			);
			expect(() => store.add(sample(), NOW)).toThrow(AttendanceStoreError);
			expect(() => store.vote("0123456789ab", ADA, "Ada", 0)).toThrow(AttendanceStoreError);
			expect(() => store.update("0123456789ab", { closed: true })).toThrow(AttendanceStoreError);
			expect(readFileSync(file, "utf8")).toBe(source);
		}
		rmSync(file);
		mkdirSync(file);
		expect(new AttendanceStore({ file, logger: silentLogger }).problem).toMatch(/cannot read/);
	});

	it("says so, and changes nothing, when it can't save", () => {
		mkdirSync(join(dir, "data"), { recursive: true });
		// A directory where the temp file goes makes writing it fail.
		mkdirSync(`${file}.tmp`);
		const { logger, error } = logs();
		const store = new AttendanceStore({ file, logger });
		expect(() => store.add(sample(), NOW)).toThrow(AttendanceStoreError);
		expect(store.all()).toEqual([]);
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "attendance.save_failed" }),
			expect.any(String),
		);
	});
});
