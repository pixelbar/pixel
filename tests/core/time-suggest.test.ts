import { describe, expect, it } from "vitest";
import {
	describeEnd,
	describeHowLong,
	HOW_LONG_SUGGESTIONS,
	previewSuggestions,
	suggestHowLong,
	suggestTimeOfDay,
	suggestWhen,
} from "../../src/core/time-suggest.ts";

const AMS = "Europe/Amsterdam";
// Monday 12 October 2026, 10:00 in Amsterdam.
const NOW = new Date("2026-10-12T08:00:00Z");
const names = (list: { name: string }[]) => list.map((s) => s.name);

describe("previewSuggestions", () => {
	const preview = (text: string) =>
		text.startsWith("ok")
			? ({ ok: true, label: text.toUpperCase() } as const)
			: ({ ok: false, why: `can't use ${text}` } as const);

	it("puts what was typed first, then examples that contain it, never twice", () => {
		expect(previewSuggestions(" ok  one ", preview, ["ok one", "ok one two", "bad one"])).toEqual([
			{ name: "ok one → OK ONE", value: "ok one" },
			{ name: "ok one two → OK ONE TWO", value: "ok one two" },
		]);
	});

	it("offers the usable examples when nothing is typed", () => {
		expect(previewSuggestions("", preview, ["ok a", "bad b", "ok c"])).toEqual([
			{ name: "ok a → OK A", value: "ok a" },
			{ name: "ok c → OK C", value: "ok c" },
		]);
	});

	it("says why only when nothing can be offered, with what was typed as the value", () => {
		expect(previewSuggestions("one", preview, ["ok one"])).toEqual([
			{ name: "ok one → OK ONE", value: "ok one" },
		]);
		expect(previewSuggestions("zzz", preview, ["ok one"])).toEqual([
			{ name: "can't use zzz", value: "zzz" },
		]);
		expect(previewSuggestions("", preview, ["bad"])).toEqual([]);
	});
});

describe("suggestWhen", () => {
	it("shows the moment, with the examples that contain what was typed", () => {
		expect(suggestWhen("fri 8pm", NOW, AMS)).toEqual([
			{ name: "fri 8pm → Fri 16 Oct 2026, 20:00", value: "fri 8pm" },
		]);
		expect(names(suggestWhen("noon", NOW, AMS))).toEqual([
			"noon → Mon 12 Oct 2026, 12:00",
			"tomorrow noon → Tue 13 Oct 2026, 12:00",
		]);
		expect(names(suggestWhen("", NOW, AMS))).toEqual([
			"19:00 → Mon 12 Oct 2026, 19:00",
			"fri 8pm → Fri 16 Oct 2026, 20:00",
			"14th oct → Wed 14 Oct 2026, 19:00",
			"tomorrow noon → Tue 13 Oct 2026, 12:00",
			"in 2 hours → Mon 12 Oct 2026, 12:00",
		]);
	});

	it("says why it can't use what was typed, in plain text", () => {
		expect(names(suggestWhen("today 9", NOW, AMS))).toEqual([
			"That's Mon 12 Oct 2026, 09:00, which has already passed.",
		]);
		expect(names(suggestWhen("tomorrow morning", NOW, AMS))).toEqual([
			'"morning" is too vague, so give a time.',
		]);
		expect(names(suggestWhen("zzz", NOW, AMS))).toEqual([
			"Not understood yet. Try 19:00, fri 8pm, 14th oct",
		]);
	});

	it("reads after another start, with now still the real now", () => {
		const tomorrow = new Date("2026-10-13T08:00:00Z");
		expect(names(suggestWhen("17:00", tomorrow, AMS, { now: NOW, examples: [] }))).toEqual([
			"17:00 → Tue 13 Oct 2026, 17:00",
		]);
		expect(names(suggestWhen("in 1 hour", tomorrow, AMS, { now: NOW, examples: [] }))).toEqual([
			"That's Mon 12 Oct 2026, 11:00, which isn't after it starts.",
		]);
	});
});

describe("suggestTimeOfDay", () => {
	it("shows the time of day, or examples to try", () => {
		expect(suggestTimeOfDay("5pm")).toEqual([{ name: "5pm → 17:00", value: "5pm" }]);
		expect(names(suggestTimeOfDay("mid"))).toEqual(["midnight → 00:00"]);
		expect(names(suggestTimeOfDay("teatime"))).toEqual([
			"Not understood yet. Try 17:00, 5pm, 1730",
		]);
	});
});

describe("suggestHowLong", () => {
	it("shows when a duration ends, and how long an end is", () => {
		expect(suggestHowLong("2h30", NOW, AMS)).toEqual([
			{ name: "2h30 → until 12:30", value: "2h30" },
		]);
		expect(names(suggestHowLong("until 17:00", NOW, AMS))).toEqual([
			"until 17:00 → 7h, until 17:00",
		]);
		expect(names(suggestHowLong("1 day", NOW, AMS))).toEqual([
			"1 day → until Tue 13 Oct 2026, 10:00",
		]);
		expect(names(suggestHowLong("", NOW, AMS))).toHaveLength(HOW_LONG_SUGGESTIONS.length);
	});

	it("says why it can't use what was typed", () => {
		expect(names(suggestHowLong("ages", NOW, AMS, { examples: [] }))).toEqual([
			"Not understood yet. Try 30m, 1h, 2h",
		]);
		const tomorrow = new Date("2026-10-13T08:00:00Z");
		expect(
			names(suggestHowLong("until now+1h", tomorrow, AMS, { now: NOW, examples: [] })),
		).toEqual(["That's Mon 12 Oct 2026, 11:00, which isn't after it starts."]);
	});

	it("describes an end by its time today, or its date otherwise", () => {
		const today = { year: 2026, month: 10, day: 12, hour: 10, minute: 0 };
		expect(describeEnd({ ...today, hour: 17 }, today)).toBe("17:00");
		expect(describeEnd({ ...today, day: 13, hour: 8 }, today)).toBe("Tue 13 Oct 2026, 08:00");
		const end = new Date("2026-10-12T15:00:00Z");
		expect(describeHowLong({ end, minutes: 420, by: "end" }, NOW, AMS)).toBe("7h, until 17:00");
		expect(describeHowLong({ end, minutes: 420, by: "duration" }, NOW, AMS)).toBe("until 17:00");
	});
});
