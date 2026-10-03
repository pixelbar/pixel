import { describe, expect, it } from "vitest";
import { actor, IDS } from "../testing/fixtures.ts";
import { createPseudonymizer } from "./pseudonym.ts";
import { scrubDeep, scrubString } from "./scrub.ts";

describe("pseudonymizer", () => {
	const pseudonymize = createPseudonymizer("k".repeat(32));

	it("is stable and does not contain the ID", () => {
		const a = actor({ userId: IDS.member });
		expect(pseudonymize(a)).toBe(pseudonymize(a));
		expect(pseudonymize(a)).not.toContain(IDS.member);
		expect(pseudonymize(a)).toMatch(/^[0-9a-f]{16}$/);
	});

	it("differs per user and per key", () => {
		const a = actor({ userId: IDS.member });
		expect(pseudonymize(a)).not.toBe(pseudonymize(actor({ userId: IDS.friend })));
		expect(pseudonymize(a)).not.toBe(createPseudonymizer("j".repeat(32))(a));
	});
});

describe("scrub", () => {
	// Shaped like a Discord token but not a real one.
	const fakeToken = `${"A".repeat(26)}.${"B".repeat(6)}.${"C".repeat(38)}`;

	it("redacts Discord tokens and snowflakes", () => {
		expect(scrubString(`token ${fakeToken} user ${IDS.member}`)).toBe(
			"token [redacted-token] user [redacted-id]",
		);
	});

	it("leaves ordinary text and short numbers alone", () => {
		expect(scrubString("port 8080, 3 users")).toBe("port 8080, 3 users");
	});

	it("scrubs nested objects and arrays without mutating the input", () => {
		const input = { message: IDS.admin, extra: { list: [fakeToken, 42] } };
		const output = scrubDeep(input);
		expect(output).toEqual({ message: "[redacted-id]", extra: { list: ["[redacted-token]", 42] } });
		expect(input.message).toBe(IDS.admin);
	});

	it("handles cycles", () => {
		const input: Record<string, unknown> = { a: IDS.admin };
		input.self = input;
		expect(() => scrubDeep(input)).not.toThrow();
	});
});
