import { describe, expect, it } from "vitest";
import { SIGNATURE_TOLERANCE_SECONDS, sign, verify } from "./signature.ts";

const SECRET = "test-webhook-secret-not-a-real-one-0000";
const NOW = new Date("2026-10-20T12:00:00Z");
const SENT_AT = NOW.getTime() / 1000;
const BODY = '{"state":"open"}';

function check(overrides: Partial<Parameters<typeof verify>[0]> = {}) {
	return verify({
		secret: SECRET,
		timestamp: String(SENT_AT),
		signature: sign(SECRET, SENT_AT, BODY),
		body: BODY,
		now: NOW,
		...overrides,
	});
}

describe("sign", () => {
	it("is the hex HMAC-SHA256 of timestamp.body, with a sha256= prefix", () => {
		// A fixed vector (from openssl), so the sender can check its own implementation:
		//   printf '%s' '1700000000.{"state":"open"}' | openssl dgst -sha256 -hmac secret
		expect(sign("secret", 1_700_000_000, '{"state":"open"}')).toBe(
			"sha256=3b952390cdeffcd2f0e89af5b7edfa771f4e5c5770b143d542d4a1c624a9898f",
		);
	});
});

describe("verify", () => {
	it("accepts a request signed with the shared secret", () => {
		expect(check()).toEqual({ ok: true });
	});

	it("accepts an upper-case signature and whitespace around the headers", () => {
		const signature = ` ${sign(SECRET, SENT_AT, BODY).toUpperCase().replace("SHA256=", "sha256=")} `;
		expect(check({ signature, timestamp: ` ${SENT_AT} ` })).toEqual({ ok: true });
	});

	it.each([
		["no timestamp", { timestamp: undefined }],
		["no signature", { signature: undefined }],
	])("refuses a request with %s", (_name, overrides) => {
		expect(check(overrides)).toEqual({ ok: false, reason: "missing" });
	});

	it.each([
		["a timestamp that isn't a number", { timestamp: "yesterday" }],
		["a signature without the prefix", { signature: "a".repeat(64) }],
		["a signature of the wrong length", { signature: `sha256=${"a".repeat(63)}` }],
		["a signature that isn't hex", { signature: `sha256=${"z".repeat(64)}` }],
	])("refuses %s", (_name, overrides) => {
		expect(check(overrides)).toEqual({ ok: false, reason: "malformed" });
	});

	it("refuses a request sent too long ago, or too far ahead", () => {
		for (const offset of [SIGNATURE_TOLERANCE_SECONDS + 1, -(SIGNATURE_TOLERANCE_SECONDS + 1)]) {
			const sentAt = SENT_AT - offset;
			const signature = sign(SECRET, sentAt, BODY);
			expect(check({ timestamp: String(sentAt), signature })).toEqual({
				ok: false,
				reason: "stale",
			});
		}
	});

	it("allows a clock that is a little off", () => {
		const sentAt = SENT_AT - SIGNATURE_TOLERANCE_SECONDS;
		const signature = sign(SECRET, sentAt, BODY);
		expect(check({ timestamp: String(sentAt), signature })).toEqual({ ok: true });
	});

	it.each([
		["another secret", { signature: sign("some-other-secret", SENT_AT, BODY) }],
		["a changed body", { body: '{"state":"closed"}' }],
		["a changed timestamp", { timestamp: String(SENT_AT + 1) }],
	])("refuses a signature made with %s", (_name, overrides) => {
		expect(check(overrides)).toEqual({ ok: false, reason: "bad-signature" });
	});
});
