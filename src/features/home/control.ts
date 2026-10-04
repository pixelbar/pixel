import { type Home, HomeRequestError } from "../../core/home.ts";
import type { KindAction } from "../../core/home-kinds/index.ts";
import type { HomeDevice } from "../../services/home-devices.ts";

/**
 * Runs one action on one device, safely: check, act, confirm.
 *
 * - **Check:** read the state first. If the device is already there, say so and
 *   send nothing. If it's unavailable or unknown, send nothing: an action nobody
 *   can confirm is one to refuse.
 * - **Act:** make exactly one call, the one the kind's catalogue says. Never a retry
 *   and never queued: a late unlock must never happen. If Home Assistant can't be
 *   reached the call isn't made.
 * - **Confirm:** poll for the end state until a time limit, and report what really
 *   happened: done, still in progress, no change, failed (jammed, went unavailable),
 *   or unconfirmed.
 *
 * One action at a time per device, with a short cool-down after, so a double click
 * can't send two. It knows nothing about people or permissions: the caller has
 * already decided who may do this.
 */

export type ControlResult =
	| { outcome: "done"; before: string; after: string }
	| { outcome: "already"; before: string }
	/** Sent, and the device was still working at the time limit. */
	| { outcome: "in-progress"; before: string; after: string }
	/** Sent, and nothing changed by the time limit. */
	| { outcome: "no-change"; before: string; after: string }
	/** Sent, and the device reported a problem such as `jammed`, or went unavailable. */
	| { outcome: "failed"; before: string; after: string }
	/** Might have been sent, but Home Assistant couldn't be reached to find out. */
	| { outcome: "unconfirmed"; before: string }
	/** Home Assistant answered and refused. Nothing happened. */
	| { outcome: "rejected"; before: string }
	| {
			outcome: "not-attempted";
			reason: "busy" | "cooldown" | "missing" | "unavailable" | "under-way";
			/** What the device reported, when it did. */
			before?: string;
	  };

export type DeviceControlOptions = {
	home: Pick<Home, "getStates" | "callService">;
	/** Milliseconds, for timing. Tests use a fake clock. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** How often to look for the end state. */
	pollMs?: number;
	/** How long to wait for the end state before reporting what is. */
	timeoutMs?: number;
	/** How long after an action before the same device may be acted on again. */
	cooldownMs?: number;
};

export const DEFAULT_POLL_MS = 500;
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_COOLDOWN_MS = 3000;

/** States that mean nobody can say what the device is doing. */
const NO_READING = new Set(["unavailable", "unknown"]);

/** A toggle has more than one end state, so "done" means the state changed. */
export function flips(action: Pick<KindAction, "done">): boolean {
	return action.done.length > 1;
}

export class DeviceControl {
	readonly #home: DeviceControlOptions["home"];
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #pollMs: number;
	readonly timeoutMs: number;
	readonly #cooldownMs: number;
	readonly #busy = new Set<string>();
	readonly #finished = new Map<string, number>();

	constructor(options: DeviceControlOptions) {
		this.#home = options.home;
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	}

	/**
	 * Runs the action. Throws only when it couldn't even read the state (Home Assistant
	 * unreachable or not set up), in which case nothing was sent.
	 */
	async run(
		device: HomeDevice,
		action: KindAction,
	): Promise<ControlResult & { durationMs: number }> {
		const start = this.#now();
		const result = await this.#run(device, action, start);
		return { ...result, durationMs: this.#now() - start };
	}

	async #run(device: HomeDevice, action: KindAction, start: number): Promise<ControlResult> {
		const key = device.entityId;
		if (this.#busy.has(key)) return { outcome: "not-attempted", reason: "busy" };
		const finished = this.#finished.get(key);
		if (finished !== undefined && start - finished < this.#cooldownMs) {
			return { outcome: "not-attempted", reason: "cooldown" };
		}

		// Claimed before the first await, so two runs at once can't both get past this point.
		this.#busy.add(key);
		let sent = false;
		try {
			const current = (await this.#home.getStates([key])).get(key);
			if (!current) return { outcome: "not-attempted", reason: "missing" };
			const before = current.state.toLowerCase();
			if (NO_READING.has(before)) {
				return { outcome: "not-attempted", reason: "unavailable", before };
			}
			if (!flips(action) && action.done.includes(before)) return { outcome: "already", before };
			if (action.working?.includes(before)) {
				return { outcome: "not-attempted", reason: "under-way", before };
			}

			sent = true;
			try {
				await this.#home.callService({
					domain: action.serviceDomain ?? key.slice(0, key.indexOf(".")),
					service: action.service,
					entityId: key,
					...(action.data ? { data: action.data } : {}),
				});
			} catch (error) {
				if (error instanceof HomeRequestError) return { outcome: "rejected", before };
				// Out of time or out of reach: it may or may not have arrived, and it won't be sent again.
				return { outcome: "unconfirmed", before };
			}
			return await this.#confirm(key, action, before, start);
		} finally {
			this.#busy.delete(key);
			if (sent) this.#finished.set(key, this.#now());
		}
	}

	/** Watches for the end state, until the time limit, and says what it found. */
	async #confirm(
		key: string,
		action: KindAction,
		before: string,
		start: number,
	): Promise<ControlResult> {
		let after = before;
		for (;;) {
			await this.#sleep(this.#pollMs);
			try {
				const current = (await this.#home.getStates([key])).get(key);
				after = current ? current.state.toLowerCase() : "unavailable";
			} catch {
				return { outcome: "unconfirmed", before };
			}
			const reached = flips(action)
				? after !== before && action.done.includes(after)
				: action.done.includes(after);
			if (reached) return { outcome: "done", before, after };
			if (after === "jammed" || (NO_READING.has(after) && after !== before)) {
				return { outcome: "failed", before, after };
			}
			if (this.#now() - start >= this.timeoutMs) {
				return action.working?.includes(after)
					? { outcome: "in-progress", before, after }
					: { outcome: "no-change", before, after };
			}
		}
	}
}
