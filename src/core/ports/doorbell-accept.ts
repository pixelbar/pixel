/**
 * Accepting a doorbell call: asks pixel-phone to pick up and play "someone is on their
 * way". The first accept wins, from Discord or the button in the space, and pixel-phone
 * decides who was first. Who may ask is decided before this is called (the dispatcher:
 * `friend` and the `doorbell` capability); an implementation only makes the call.
 *
 * One attempt with a time limit, never retried: a late accept would answer a call nobody
 * is going to.
 */
export type DoorbellAccept = {
	/** Accepts `callId` for `by` (`discord:<id>`). Never throws. */
	accept(callId: string, by: string): Promise<AcceptResult>;
};

export type AcceptResult =
	/** Accepted: pixel-phone is picking up. */
	| { kind: "accepted" }
	/** Someone else was first. `via` is who asked pixel-phone; `by` is who, if they said. */
	| { kind: "already"; via: string; by?: string }
	/** The call stopped ringing, or there's no such call. */
	| { kind: "too-late" }
	/**
	 * Couldn't ask: a timeout, a network error, or an answer that means Pixel or
	 * pixel-phone is set up wrong (`status`, when there was one).
	 */
	| { kind: "failed"; why: "timeout" | "network" | "status" | "answer"; status?: number };
