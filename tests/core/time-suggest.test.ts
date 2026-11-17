import { describe, expect, it } from "vitest";
import { previewSuggestions, whyNot } from "../../src/core/time-suggest.ts";

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

describe("whyNot", () => {
	const AT = { year: 2026, month: 10, day: 12, hour: 9, minute: 0 };

	it("offers examples for what isn't understood yet", () => {
		expect(whyNot({ kind: "unclear" }, ["30m", "2h30", "rest of day", "4h"])).toBe(
			"Not understood yet. Try 30m, 2h30, rest of day",
		);
		expect(whyNot({ kind: "empty" }, ["2h"])).toBe("Not understood yet. Try 2h");
	});

	it("gives the reason as a sentence, in plain text", () => {
		expect(whyNot({ kind: "past", at: AT }, [])).toBe(
			"That's Mon 12 Oct 2026, 09:00, which has already passed.",
		);
		expect(whyNot({ kind: "vague", word: "morning" }, [])).toBe(
			'"morning" is too vague, so give a time.',
		);
	});
});
