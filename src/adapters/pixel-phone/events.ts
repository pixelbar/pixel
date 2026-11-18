import { z } from "zod";
import { CALL_ID, type DoorbellEvent } from "../../core/doorbell.ts";

/**
 * pixel-phone's call events, contract version 1 (pixel-phone's `docs/events.md`). Each
 * queue message is one JSON object as plain text. Fields this version doesn't know are
 * ignored, so pixel-phone can add some without breaking Pixel; a change in meaning comes
 * as `version: 2`, which Pixel ignores until it knows it.
 *
 * The caller's and the called number (`from`, `to`) are dropped here: Pixel has no use for
 * them, and doesn't keep or log phone numbers.
 */

const callId = z.string().regex(CALL_ID);
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const base = { version: z.literal(1), callId, occurredAt: instant };

const v1 = z.discriminatedUnion("type", [
	z.object({ ...base, type: z.literal("ringing"), acceptBy: instant }),
	z.object({
		...base,
		type: z.literal("accepted"),
		via: z.string().min(1).max(64),
		by: z.string().min(1).max(64).optional(),
	}),
	z.object({ ...base, type: z.literal("missed"), reason: z.enum(["timeout", "caller_hung_up"]) }),
	z.object({ ...base, type: z.literal("busy"), activeCallId: callId }),
	z.object({
		...base,
		type: z.literal("ended"),
		reason: z.enum(["playback_finished", "caller_hung_up", "abandoned"]),
	}),
]);

/** Queue messages larger than this aren't pixel-phone's (a real one is a few hundred bytes). */
const MAX_MESSAGE_LENGTH = 4096;

export type ParsedMessage =
	| { ok: true; event: DoorbellEvent }
	/**
	 * `json`: not one JSON object. `version`: a version Pixel doesn't know (yet).
	 * `invalid`: version 1, but not as the contract says.
	 */
	| { ok: false; why: "json" | "version" | "invalid" };

/** Reads one queue message. Never throws, and never says what was in it. */
export function parseMessage(text: string): ParsedMessage {
	if (text.length > MAX_MESSAGE_LENGTH) return { ok: false, why: "invalid" };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, why: "json" };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, why: "json" };
	}
	if ((raw as { version?: unknown }).version !== 1) return { ok: false, why: "version" };
	const result = v1.safeParse(raw);
	if (!result.success) return { ok: false, why: "invalid" };
	const { version: _version, ...event } = result.data;
	return { ok: true, event };
}
