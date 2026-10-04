import { describe, expect, it } from "vitest";
import { IDS } from "../testing/fixtures.ts";
import { scrubDeep, scrubString } from "./scrub.ts";

describe("scrub", () => {
	// Shaped like a Discord token but not a real one.
	const fakeToken = `${"A".repeat(26)}.${"B".repeat(6)}.${"C".repeat(38)}`;

	it("redacts Discord tokens", () => {
		expect(scrubString(`token ${fakeToken} here`)).toBe("token [redacted-token] here");
	});

	it("redacts Home Assistant long-lived tokens, which are JWTs", () => {
		const jwt = `eyJ${"h".repeat(30)}.eyJ${"p".repeat(60)}.${"s".repeat(43)}`;
		expect(scrubString(`Authorization: Bearer ${jwt} sent`)).toBe(
			"Authorization: Bearer [redacted-token] sent",
		);
		expect(scrubDeep({ nested: [{ header: `Bearer ${jwt}` }] })).toEqual({
			nested: [{ header: "Bearer [redacted-token]" }],
		});
	});

	it("keeps Discord IDs, which identify users in Sentry", () => {
		expect(scrubString(`user discord:${IDS.member}`)).toBe(`user discord:${IDS.member}`);
	});

	it("leaves ordinary text and numbers alone", () => {
		expect(scrubString("port 8080, 3 users")).toBe("port 8080, 3 users");
	});

	it("scrubs nested objects and arrays without mutating the input", () => {
		const input = { message: fakeToken, extra: { list: [fakeToken, 42, IDS.admin] } };
		const output = scrubDeep(input);
		expect(output).toEqual({
			message: "[redacted-token]",
			extra: { list: ["[redacted-token]", 42, IDS.admin] },
		});
		expect(input.message).toBe(fakeToken);
	});

	it("handles cycles", () => {
		const input: Record<string, unknown> = { a: fakeToken };
		input.self = input;
		expect(() => scrubDeep(input)).not.toThrow();
	});
});
