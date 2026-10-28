import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../core/logger.ts";
import { MAX_SCHEDULES, type Schedule, ScheduleStore, ScheduleStoreError } from "./schedules.ts";

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-schedules-"));
	file = join(dir, "data", "schedules.yaml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sample = (over: Partial<Omit<Schedule, "id">> = {}): Omit<Schedule, "id"> => ({
	name: "Weekly poll",
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

function logs() {
	const error = vi.fn();
	const logger = { ...silentLogger, error };
	logger.child = () => logger;
	return { logger, error };
}

describe("ScheduleStore", () => {
	it("starts empty without a file, and saves what's added", () => {
		const store = new ScheduleStore({ file, logger: silentLogger });
		expect(store.problem).toBeUndefined();
		expect(store.all()).toEqual([]);
		const added = store.add(sample());
		expect(added.id).toMatch(/^[a-z0-9]{6}$/);
		expect(store.get(added.id)).toEqual(added);
		expect(readFileSync(file, "utf8")).toContain("NOT safe to delete");
		expect(new ScheduleStore({ file, logger: silentLogger }).all()).toEqual([added]);
	});

	it("keeps a poll and every kind of repeat across a restart", () => {
		const store = new ScheduleStore({ file, logger: silentLogger });
		store.add(
			sample({
				post: {
					kind: "poll",
					question: "Who's in?",
					answers: ["Yes", "No"],
					durationHours: 24,
					multiple: true,
				},
			}),
		);
		store.add(sample({ recurrence: { kind: "monthly", everyMonths: 2 } }));
		store.add(sample({ recurrence: { kind: "once" }, lastRunAt: "2026-10-14T17:00:00.000Z" }));
		expect(new ScheduleStore({ file, logger: silentLogger }).all()).toEqual(store.all());
	});

	it("updates and removes, and says when something is gone", () => {
		const store = new ScheduleStore({ file, logger: silentLogger });
		const added = store.add(sample());
		expect(store.update(added.id, { paused: true })?.paused).toBe(true);
		expect(new ScheduleStore({ file, logger: silentLogger }).get(added.id)?.paused).toBe(true);
		expect(store.update("nope00", { paused: true })).toBeUndefined();
		expect(store.remove(added.id)?.id).toBe(added.id);
		expect(store.remove(added.id)).toBeUndefined();
		expect(new ScheduleStore({ file, logger: silentLogger }).all()).toEqual([]);
	});

	it("gives every schedule its own ID", () => {
		const store = new ScheduleStore({ logger: silentLogger });
		const ids = new Set(Array.from({ length: 30 }, () => store.add(sample()).id));
		expect(ids.size).toBe(30);
	});

	it("keeps a poll's reminder and the poll it last posted across a restart, and drops a removed one", () => {
		const store = new ScheduleStore({ file, logger: silentLogger });
		const { id } = store.add(
			sample({
				post: {
					kind: "poll",
					question: "In?",
					answers: ["Yes", "No"],
					durationHours: 24,
					multiple: false,
				},
				reminder: { channelId: "100000000000000051", channelName: "chat", at: "18:00" },
				lastPoll: {
					question: "In?",
					url: "https://discord.com/channels/1/2/3",
					postedAt: "2026-10-14T17:00:00.000Z",
					closesAt: "2026-10-15T17:00:00.000Z",
				},
				lastReminderAt: "2026-10-15T16:00:00.000Z",
			}),
		);
		expect(new ScheduleStore({ file, logger: silentLogger }).all()).toEqual(store.all());
		store.update(id, { reminder: undefined });
		expect(readFileSync(file, "utf8")).not.toContain("reminder:");
		expect(new ScheduleStore({ file, logger: silentLogger }).get(id)?.reminder).toBeUndefined();
	});

	it.each([
		[
			"a reminder on a message",
			"    reminder: { channelId: '100000000000000051', channelName: c, at: '18:00' }\n",
		],
		[
			"a reminder time that isn't a time of day",
			"    post: { kind: poll, question: q, answers: [a, b], durationHours: 1, multiple: false }\n    reminder: { channelId: '100000000000000051', channelName: c, at: '24:00' }\n",
		],
		[
			"a poll link that isn't https",
			"    lastPoll: { question: q, url: 'javascript:alert(1)', postedAt: 2026-10-14T17:00:00.000Z, closesAt: 2026-10-15T17:00:00.000Z }\n",
		],
	])("refuses %s", (_label, extra) => {
		mkdirSync(join(dir, "data"), { recursive: true });
		const base =
			"schedules:\n  - id: abc234\n    name: n\n    channelId: '100000000000000050'\n    channelName: g\n    start: 2026-10-14T19:00\n    recurrence: { kind: once }\n    paused: false\n    createdBy: { ref: 'discord:1', name: A }\n    createdAt: 2026-10-12T08:00:00.000Z\n    lastRunAt: null\n";
		const post = extra.includes("post:")
			? ""
			: "    post: { kind: message, text: hi, mentions: false }\n";
		writeFileSync(file, base + post + extra);
		expect(new ScheduleStore({ file, logger: logs().logger }).problem).toBeDefined();
	});

	it("refuses more than the limit", () => {
		const store = new ScheduleStore({ logger: silentLogger });
		for (let i = 0; i < MAX_SCHEDULES; i++) store.add(sample());
		expect(() => store.add(sample())).toThrow(ScheduleStoreError);
	});

	it.each([
		["invalid YAML", "schedules: [oops\n"],
		["the wrong shape", "schedules: nope\n"],
		["a bad schedule", "schedules:\n  - id: x\n"],
		[
			"a repeated id",
			`schedules:\n${["a", "b"].map(() => "  - id: abc234\n    name: n\n    channelId: '100000000000000050'\n    channelName: g\n    post: { kind: message, text: hi, mentions: false }\n    start: 2026-10-14T19:00\n    recurrence: { kind: once }\n    paused: false\n    createdBy: { ref: 'discord:1', name: A }\n    createdAt: 2026-10-12T08:00:00.000Z\n    lastRunAt: null\n").join("")}`,
		],
	])(
		"runs nothing and changes nothing when the file has %s, and never overwrites it",
		(_label, text) => {
			mkdirSync(join(dir, "data"), { recursive: true });
			writeFileSync(file, text);
			const { logger, error } = logs();
			const store = new ScheduleStore({ file, logger });
			expect(store.problem).toBeDefined();
			expect(store.all()).toEqual([]);
			expect(() => store.add(sample())).toThrow(/invalid/);
			expect(() => store.update("abc234", {})).toThrow(ScheduleStoreError);
			expect(() => store.remove("abc234")).toThrow(ScheduleStoreError);
			expect(readFileSync(file, "utf8")).toBe(text);
			expect(error).toHaveBeenCalledWith(
				expect.objectContaining({ event: "schedules.unreadable" }),
				expect.any(String),
			);
		},
	);

	it("can't read a directory where the file should be", () => {
		mkdirSync(file, { recursive: true });
		expect(new ScheduleStore({ file, logger: silentLogger }).problem).toMatch(/cannot read/);
	});

	it("leaves everything as it was when saving fails", () => {
		const store = new ScheduleStore({ file, logger: silentLogger });
		writeFileSync(join(dir, "data"), "a file where the directory should be");
		expect(() => store.add(sample())).toThrow(/Couldn't save/);
		expect(store.all()).toEqual([]);
	});
});
