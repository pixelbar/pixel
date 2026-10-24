import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How the space state service signs the webhook it sends when the space opens or closes.
 *
 *   X-Spacestate-Timestamp: <unix seconds when it was sent>
 *   X-Spacestate-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the shared secret>
 *
 * The timestamp is inside what is signed, so an old request can't be sent again with a new
 * time, and one older than {@link SIGNATURE_TOLERANCE_SECONDS} is refused. Even a valid one
 * only makes Pixel read SpaceAPI again: nothing in the body is trusted.
 */

export const TIMESTAMP_HEADER = "x-spacestate-timestamp";
export const SIGNATURE_HEADER = "x-spacestate-signature";

/** How far the sender's clock may be from Pixel's, either way. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const TIMESTAMP = /^\d{1,12}$/;

export type SignatureCheck =
	| { ok: true }
	/** Why it was refused. For the log only: the caller is told nothing more than "unauthorized". */
	| { ok: false; reason: "missing" | "malformed" | "stale" | "bad-signature" };

/** The signature header value for a body sent at `timestamp` (unix seconds). */
export function sign(secret: string, timestamp: number, body: string): string {
	return `sha256=${hmac(secret, `${timestamp}.${body}`).toString("hex")}`;
}

export function verify(options: {
	secret: string;
	timestamp: string | undefined;
	signature: string | undefined;
	body: string;
	now: Date;
}): SignatureCheck {
	const { secret, timestamp, signature, body, now } = options;
	if (timestamp === undefined || signature === undefined) return { ok: false, reason: "missing" };
	const match = SIGNATURE.exec(signature.trim().toLowerCase());
	const sentAt = timestamp.trim();
	if (!match?.[1] || !TIMESTAMP.test(sentAt)) return { ok: false, reason: "malformed" };

	const skew = Math.abs(now.getTime() / 1000 - Number(sentAt));
	if (skew > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };

	const expected = hmac(secret, `${sentAt}.${body}`);
	const given = Buffer.from(match[1], "hex");
	// Both are 32 bytes: the pattern above fixes the length, so this never throws.
	return timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: "bad-signature" };
}

function hmac(secret: string, data: string): Buffer {
	return createHmac("sha256", secret).update(data).digest();
}
