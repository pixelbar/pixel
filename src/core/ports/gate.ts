import type { Principal } from "../access.ts";

/**
 * Opens the parking gate, for someone who has just been given a spot. Who may open it
 * is decided before this is called (the dispatcher, and a booking); an implementation
 * only makes the call. It must fail closed: a time limit, no retries and no queueing,
 * because a late opening must never happen.
 */
export type Gate = {
	open(request: { principal: Principal; spot: string }): Promise<GateResult>;
};

export type GateResult =
	| { opened: true }
	/** `not-connected`: Pixel can't open the gate at all (yet). `failed`: it tried and couldn't. */
	| { opened: false; reason: "not-connected" | "failed" };

/** Until the gate's API is connected: never opens anything. */
export const notConnectedGate: Gate = {
	open: async () => ({ opened: false, reason: "not-connected" }),
};
