import { describe, expect, it } from "vitest";
import {
	examples,
	HOW_LONG_EXAMPLES,
	howLongRefusal,
	timeOfDayRefusal,
	WHEN_EXAMPLES,
	whenRefusal,
} from "../../src/core/time-help.ts";

const AMS = "Europe/Amsterdam";
const AT = { year: 2026, month: 10, day: 12, hour: 9, minute: 0 };

describe("time refusals", () => {
	it("name the field, say why, and show what works", () => {
		expect(whenRefusal({ kind: "unclear" }, { field: "When", zone: AMS })).toBe(
			"**When**: I couldn't understand it. Type a day, a time or both in Europe/Amsterdam, for example `19:00`, `fri 8pm`, `14th oct`, `tomorrow noon` or `in 2 hours`.",
		);
	});

	it.each([
		[{ kind: "empty" } as const, "it's empty."],
		[{ kind: "past", at: AT } as const, "that's Mon 12 Oct 2026, 09:00, which has already passed."],
		[
			{ kind: "before-start", at: AT } as const,
			"that's Mon 12 Oct 2026, 09:00, which isn't after it starts.",
		],
		[{ kind: "no-such-date", day: 31, month: 2, year: 2027 } as const, "there's no 31 Feb 2027."],
		[{ kind: "vague", word: "morning" } as const, "`morning` is too vague, so give a time."],
		[{ kind: "not-evening" } as const, "tonight means 17:00 to 23:59."],
	])("explain %o", (problem, why) => {
		expect(whenRefusal(problem, { field: "From", zone: AMS })).toContain(`**From**: ${why} Type`);
	});

	it("show how-long examples, or the caller's own, and a closing hint", () => {
		expect(howLongRefusal({ kind: "unclear" }, { field: "How long", zone: AMS })).toBe(
			"**How long**: I couldn't understand it. Type how long, or until when in Europe/Amsterdam, for example `45m`, `2h30`, `until 17:00` or `till 5pm`.",
		);
		expect(
			howLongRefusal(
				{ kind: "empty" },
				{ field: "For", zone: AMS, examples: ["2h", "rest of day"], hint: "Or press Cancel." },
			),
		).toBe(
			"**For**: it's empty. Type how long, or until when in Europe/Amsterdam, for example `2h` or `rest of day`. Or press Cancel.",
		);
	});

	it("show time-of-day examples", () => {
		expect(timeOfDayRefusal({ field: "Reset", zone: AMS, hint: "Change it in Settings." })).toBe(
			"**Reset**: I couldn't understand it. Type a time of day in Europe/Amsterdam, for example `17:00`, `5pm`, `1730`, `noon` or `midnight`. Change it in Settings.",
		);
	});

	it("list examples the way people write a list", () => {
		expect(examples([])).toBe("");
		expect(examples(["2h"])).toBe("`2h`");
		expect(examples(["a", "b", "c"])).toBe("`a`, `b` or `c`");
		expect(WHEN_EXAMPLES.length).toBeGreaterThan(3);
		expect(HOW_LONG_EXAMPLES.length).toBeGreaterThan(3);
	});
});
