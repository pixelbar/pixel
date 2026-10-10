import { describe, expect, it } from "vitest";
import { isConsumedInteractionError } from "./interaction-errors.ts";

describe("isConsumedInteractionError", () => {
	it("matches Discord 40060 (already acknowledged) and 10062 (unknown interaction)", () => {
		expect(isConsumedInteractionError({ code: 40060 })).toBe(true);
		expect(isConsumedInteractionError({ code: 10062 })).toBe(true);
		expect(isConsumedInteractionError({ code: "40060" })).toBe(true);
		expect(isConsumedInteractionError({ code: "10062" })).toBe(true);
	});

	it("ignores other errors", () => {
		expect(isConsumedInteractionError(undefined)).toBe(false);
		expect(isConsumedInteractionError("already acknowledged")).toBe(false);
		expect(isConsumedInteractionError({ message: "Unknown interaction" })).toBe(false);
		expect(isConsumedInteractionError({ code: 50013 })).toBe(false);
		expect(isConsumedInteractionError(new Error("boom"))).toBe(false);
	});
});
