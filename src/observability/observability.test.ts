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
		const output = scrubDeep(input);
		expect(output.a).toBe("[redacted-token]");
		expect(output.self).toBe(output);
	});

	it("scrubs an object every time it is referenced, not only the first", () => {
		const shared = { header: fakeToken };
		const output = scrubDeep({ a: shared, b: shared, list: [shared] });
		expect(JSON.stringify(output)).not.toContain(fakeToken);
		expect(output.b).toEqual({ header: "[redacted-token]" });
		expect(output.list[0]).toBe(output.a);
		expect(shared.header).toBe(fakeToken);
	});

	it("keeps an Error's name, message, stack and own fields, scrubbed", () => {
		const error = Object.assign(new Error(`failed with ${fakeToken}`, { cause: fakeToken }), {
			code: 50027,
		});
		const output = scrubDeep({ error }).error as unknown as Record<string, unknown>;
		expect(output).toMatchObject({
			name: "Error",
			message: "failed with [redacted-token]",
			cause: "[redacted-token]",
			code: 50027,
		});
		expect(output.stack).toContain("failed with [redacted-token]");
		expect(JSON.stringify(output)).not.toContain(fakeToken);

		const bare = new TypeError("no stack");
		bare.stack = undefined;
		expect(scrubDeep(bare)).toEqual({ name: "TypeError", message: "no stack" });
	});

	// Shaped like a Discord interaction token but not a real one.
	const interactionToken = `aW50ZXJhY3Rpb246fake${"x".repeat(60)}`;
	const interactionId = "100000000000000099";

	it("redacts the interaction token in Discord interaction callback URLs", () => {
		expect(
			scrubString(
				`POST https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`,
			),
		).toBe(`POST https://discord.com/api/v10/interactions/${interactionId}/[redacted]/callback`);
	});

	it("redacts the token in Discord webhook URLs, which interaction follow-ups use", () => {
		expect(
			scrubString(`/api/v10/webhooks/${interactionId}/${interactionToken}/messages/@original`),
		).toBe(`/api/v10/webhooks/${interactionId}/[redacted]/messages/@original`);
		expect(scrubString(`/webhooks/${interactionId}/${interactionToken}?wait=true`)).toBe(
			`/webhooks/${interactionId}/[redacted]?wait=true`,
		);
	});

	it("leaves other Discord API paths alone", () => {
		const path = `/api/v10/channels/${interactionId}/messages/${IDS.member}`;
		expect(scrubString(path)).toBe(path);
		expect(scrubString(`/api/v10/channels/${interactionId}/webhooks`)).toBe(
			`/api/v10/channels/${interactionId}/webhooks`,
		);
	});
});
