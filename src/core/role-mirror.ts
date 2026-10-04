import type { Logger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

/**
 * A one-way mirror from Pixel to a platform's roles. Pixel's own data is the
 * source of truth for tiers, so this only ever pushes: Pixel never reads a role
 * to decide anyone's tier, and nothing is pulled back.
 *
 * Only `member` and `friend` have roles. Admin has none, and a guest simply
 * holds neither. Roles other than the mapped ones are never touched.
 *
 * Nothing is cached: every call asks the backend, so renamed or moved roles and
 * changed permissions are noticed straight away.
 */

export const MIRRORED_TIERS = ["member", "friend"] as const;
export type MirroredTier = (typeof MIRRORED_TIERS)[number];

/** What Pixel wants someone to hold: the role of one tier, or neither (a guest). */
export type WantedLevel = MirroredTier | "guest";

/** Whether one tier's role is being mirrored, and if not, why. */
export type TierMirrorState =
	| { tier: MirroredTier; status: "unconfigured" }
	| { tier: MirroredTier; status: "on"; role: string }
	| { tier: MirroredTier; status: "off"; reason: string };

/** A tier whose role couldn't be mirrored, and why (plain words, no personal data). */
export type TierOff = { tier: MirroredTier; reason: string };

export type MirrorResult =
	/** Nothing is mapped, or the platform isn't connected: nothing was touched. */
	| { kind: "unconfigured" }
	/** `off` lists tiers that are configured but not being mirrored, so the admin can see why. */
	| { kind: "in-sync"; off: TierOff[] }
	| { kind: "updated"; added: string[]; removed: string[]; off: TierOff[] }
	/** `reason` is plain words with no personal data. */
	| { kind: "failed"; reason: string };

export type RoleHolding = { tier: MirroredTier; role: string; has: boolean };

export type Inspection =
	| { kind: "unconfigured" }
	| { kind: "not-in-server" }
	| { kind: "failed"; reason: string }
	| { kind: "ok"; holdings: RoleHolding[] };

/** Implemented by a platform adapter (Discord). */
export type MirrorBackend = {
	states(): Promise<readonly TierMirrorState[]>;
	/** Makes the person's mapped roles match `wanted`. `reason` goes in the platform's audit log. */
	apply(userId: string, wanted: WantedLevel, reason: string): Promise<MirrorResult>;
	/** Which mapped roles the person holds right now. Read-only. */
	inspect(userId: string): Promise<Inspection>;
};

export type RoleMirrorOptions = { logger: Logger; reporter: ErrorReporter };

const UNEXPECTED = "Discord didn't accept the change";

export class RoleMirror {
	readonly #logger: Logger;
	readonly #reporter: ErrorReporter;
	#backend: MirrorBackend | undefined;

	constructor({ logger, reporter }: RoleMirrorOptions) {
		this.#logger = logger.child({ component: "role-mirror" });
		this.#reporter = reporter;
	}

	/** A platform adapter plugs its backend in once it's connected. */
	attach(backend: MirrorBackend): void {
		this.#backend = backend;
	}

	async states(): Promise<readonly TierMirrorState[]> {
		if (!this.#backend) return MIRRORED_TIERS.map((tier) => ({ tier, status: "unconfigured" }));
		try {
			return await this.#backend.states();
		} catch (error) {
			return this.#unexpected(error, "states", (reason) =>
				MIRRORED_TIERS.map((tier) => ({ tier, status: "off", reason })),
			);
		}
	}

	async apply(userId: string, wanted: WantedLevel, reason: string): Promise<MirrorResult> {
		if (!this.#backend) return { kind: "unconfigured" };
		try {
			return await this.#backend.apply(userId, wanted, reason);
		} catch (error) {
			return this.#unexpected(error, "apply", (why) => ({ kind: "failed", reason: why }));
		}
	}

	async inspect(userId: string): Promise<Inspection> {
		if (!this.#backend) return { kind: "unconfigured" };
		try {
			return await this.#backend.inspect(userId);
		} catch (error) {
			return this.#unexpected(error, "inspect", (why) => ({ kind: "failed", reason: why }));
		}
	}

	/**
	 * Checks every tier and says so: configured tiers that work are logged, ones
	 * that don't are logged and reported once each. A tier that can't be
	 * mirrored is turned off on its own; the rest keep working. Run at startup
	 * and on `/admin reload`, not on every change.
	 */
	async check(): Promise<readonly TierMirrorState[]> {
		const states = await this.states();
		for (const state of states) {
			if (state.status === "unconfigured") {
				this.#logger.info({ event: "role_mirror.unconfigured", tier: state.tier }, "not mirrored");
			} else if (state.status === "on") {
				this.#logger.info({ event: "role_mirror.on", tier: state.tier }, "role mirroring is on");
			} else {
				this.#logger.error(
					{ event: "role_mirror.off", tier: state.tier },
					`role mirroring for ${state.tier} is off: ${state.reason}`,
				);
				this.#reporter.captureBackground(
					new Error(`Role mirroring for ${state.tier} is off: ${state.reason}`),
					"role-mirror",
				);
			}
		}
		return states;
	}

	#unexpected<T>(error: unknown, action: string, make: (reason: string) => T): T {
		this.#logger.error({ event: "role_mirror.failed", action, err: error }, "role mirror failed");
		this.#reporter.captureBackground(error, "role-mirror");
		return make(UNEXPECTED);
	}
}
