import type { Logger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

/**
 * Pixel's tiers and a platform's roles, kept in step both ways. Pushing
 * (`apply`) happens when an admin changes someone's level. Reading
 * (`holders`) is only for the role sync (`core/role-sync.ts`), which changes
 * the members file through the access store; a role is never consulted when
 * a command runs, so the dispatcher still decides from Pixel's own data
 * ([ADR 0020](../../docs/adr/0020-two-way-role-sync.md)).
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

/** Someone holding at least one of the mapped roles. */
export type RoleHolder = {
	userId: string;
	/** Their platform username, for the members file's note. For humans only. */
	username: string;
	/** The tiers whose role they hold. */
	tiers: readonly MirroredTier[];
};

export type HolderList =
	| { kind: "unconfigured" }
	/** `reason` is plain words with no personal data. */
	| { kind: "failed"; reason: string }
	| {
			kind: "ok";
			/** The tiers whose roles were read. People at any other tier are left alone. */
			managed: readonly MirroredTier[];
			/** Everyone in the server holding a managed role. Anyone missing holds none. */
			people: readonly RoleHolder[];
			/** The bot's own user ID, which the audit log names as the one making the change. */
			self: string;
	  };

/** Implemented by a platform adapter (Discord). */
export type MirrorBackend = {
	states(): Promise<readonly TierMirrorState[]>;
	/** Makes the person's mapped roles match `wanted`. `reason` goes in the platform's audit log. */
	apply(userId: string, wanted: WantedLevel, reason: string): Promise<MirrorResult>;
	/** Which mapped roles the person holds right now. Read-only. */
	inspect(userId: string): Promise<Inspection>;
	/**
	 * Everyone holding a mapped role. Read-only. Fails unless every configured
	 * tier is on, so a renamed or broken role can't make everyone look like
	 * they lost it.
	 */
	holders(): Promise<HolderList>;
};

export type RoleMirrorOptions = {
	logger: Logger;
	reporter: ErrorReporter;
	/** Milliseconds since the epoch. Injectable for tests. */
	now?: () => number;
};

/** How long `apply` calls are remembered for `appliedSince`. */
const REMEMBER_MS = 60 * 60_000;

const UNEXPECTED = "Discord didn't accept the change";

export class RoleMirror {
	readonly #logger: Logger;
	readonly #reporter: ErrorReporter;
	readonly #now: () => number;
	#backend: MirrorBackend | undefined;
	/** User ID → when Pixel last pushed their roles. */
	readonly #applied = new Map<string, number>();

	constructor({ logger, reporter, now = Date.now }: RoleMirrorOptions) {
		this.#logger = logger.child({ component: "role-mirror" });
		this.#reporter = reporter;
		this.#now = now;
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
		this.#remember(userId);
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

	async holders(): Promise<HolderList> {
		if (!this.#backend) return { kind: "unconfigured" };
		try {
			return await this.#backend.holders();
		} catch (error) {
			return this.#unexpected(error, "holders", (why) => ({ kind: "failed", reason: why }));
		}
	}

	/**
	 * Whether Pixel pushed this person's roles at or after `since` (ms). The
	 * role sync leaves them alone, so a role list read before an admin's change
	 * can't undo it.
	 */
	appliedSince(userId: string, since: number): boolean {
		return (this.#applied.get(userId) ?? Number.NEGATIVE_INFINITY) >= since;
	}

	#remember(userId: string): void {
		const now = this.#now();
		for (const [id, at] of this.#applied) {
			if (at < now - REMEMBER_MS) this.#applied.delete(id);
		}
		this.#applied.set(userId, now);
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
