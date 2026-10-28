import { type PlatformActor, splitRef, tierRank } from "./access.ts";
import type { Logger } from "./logger.ts";
import type { AccessStore, AccessView, MemberTier } from "./ports/access-store.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";
import type { HolderList, MirroredTier, RoleHolder, RoleMirror } from "./role-mirror.ts";

/**
 * Keeps the members file in step with the mapped Discord roles: someone given
 * the member or friend role gets that level, and someone whose role is taken
 * away becomes a guest. Every change goes through the access store, so it is
 * validated and audited like an admin's. See
 * [ADR 0020](../../docs/adr/0020-two-way-role-sync.md).
 *
 * Roles are read here and nowhere else. A command is still decided from the
 * members file alone, never from a role.
 *
 * Safeguards:
 *  - admins are never touched (they come from admins.yaml);
 *  - nothing runs unless every configured tier's role works (`holders` fails otherwise);
 *  - a tier whose role isn't mapped is left alone;
 *  - someone whose roles Pixel pushed since the run started, or just before, is skipped,
 *    and so is anyone whose level changed in Pixel after the plan was made;
 *  - more than `MAX_DEMOTIONS` removals in one run are all held back and reported,
 *    since that looks like a mistake (a role cleared, or the sync turned on before
 *    `/admin sync` brought Discord into line).
 */

export const MAX_DEMOTIONS = 5;

export type SyncChange = {
	/** The Discord user ID to change (the first of the person's IDs for an existing entry). */
	userId: string;
	/** Their level in Pixel when the plan was made. `none` means no entry. */
	from: MemberTier | "none";
	to: MemberTier;
	/** Their username, written as the note only if the entry has none. */
	username?: string;
};

export type SyncPlan = { changes: SyncChange[]; heldBack: number };

const RANKED: readonly MirroredTier[] = ["member", "friend"];

/** The highest tier among those held. */
function highest(tiers: readonly MirroredTier[]): MirroredTier | undefined {
	return RANKED.find((tier) => tiers.includes(tier));
}

function discordIds(ids: readonly string[]): string[] {
	return ids.flatMap((ref) => {
		const { platform, userId } = splitRef(ref);
		return platform === "discord" ? [userId] : [];
	});
}

/** What to change so the members file matches the roles. Pure: reads nothing, writes nothing. */
export function planSync(
	view: AccessView,
	managed: readonly MirroredTier[],
	people: readonly RoleHolder[],
	maxDemotions = MAX_DEMOTIONS,
): SyncPlan {
	const holders = new Map(people.map((person) => [person.userId, person]));
	const isManaged = (tier: MemberTier): tier is MirroredTier =>
		tier !== "guest" && managed.includes(tier);
	const changes: SyncChange[] = [];
	const demotions: SyncChange[] = [];
	const seen = new Set<string>();

	// Everyone already in the file, once per person even when they have several IDs.
	for (const record of new Set(view.records.values())) {
		const ids = discordIds(record.ids);
		for (const id of ids) seen.add(id);
		const [first] = ids;
		if (!first || ids.some((id) => view.discord.get(id) === "admin")) continue;
		const held = ids.flatMap((id) => holders.get(id)?.tiers ?? []);
		const want = highest(held.filter((tier) => managed.includes(tier)));
		if (want === undefined) {
			if (isManaged(record.tier)) {
				demotions.push({ userId: first, from: record.tier, to: "guest" });
			}
			continue;
		}
		if (record.tier === want) continue;
		// A higher level whose role isn't mapped stays: the sync can't see it.
		if (!isManaged(record.tier) && tierRank(record.tier) > tierRank(want)) continue;
		changes.push({ userId: first, from: record.tier, to: want });
	}

	// Role holders who aren't in the file yet.
	for (const person of people) {
		if (seen.has(person.userId) || view.discord.get(person.userId) === "admin") continue;
		const want = highest(person.tiers.filter((tier) => managed.includes(tier)));
		if (want === undefined) continue;
		changes.push({ userId: person.userId, from: "none", to: want, username: person.username });
	}

	if (demotions.length > maxDemotions) return { changes, heldBack: demotions.length };
	return { changes: [...changes, ...demotions], heldBack: 0 };
}

export type RoleSyncDeps = {
	access: Pick<AccessStore, "view" | "apply">;
	roles: Pick<RoleMirror, "holders" | "appliedSince">;
	logger: Logger;
	reporter: ErrorReporter;
	everyMs: number;
	/** Milliseconds since the epoch. Injectable for tests. */
	now?: () => number;
};

export type SyncOutcome =
	| { kind: "unconfigured" }
	| { kind: "failed"; reason: string }
	| { kind: "done"; applied: number; skipped: number; heldBack: number };

export class RoleSync {
	readonly #access: RoleSyncDeps["access"];
	readonly #roles: RoleSyncDeps["roles"];
	readonly #logger: Logger;
	readonly #reporter: ErrorReporter;
	readonly #everyMs: number;
	readonly #now: () => number;
	#running = false;
	/** The last problem reported, so a problem that persists is reported once, not every run. */
	#lastProblem: string | undefined;

	constructor({ access, roles, logger, reporter, everyMs, now = Date.now }: RoleSyncDeps) {
		this.#access = access;
		this.#roles = roles;
		this.#logger = logger.child({ component: "role-sync" });
		this.#reporter = reporter;
		this.#everyMs = everyMs;
		this.#now = now;
	}

	/** Runs now and then every `everyMs`. Returns the stop function. */
	start(): () => void {
		const tick = () => {
			this.run().catch((error: unknown) => {
				this.#logger.error({ event: "role_sync.failed", err: error }, "role sync failed");
				this.#reporter.captureBackground(error, "role-sync");
			});
		};
		tick();
		const timer = setInterval(tick, this.#everyMs);
		return () => clearInterval(timer);
	}

	async run(): Promise<SyncOutcome> {
		// A slow Discord could make runs overlap; the next tick picks up anything missed.
		if (this.#running) return { kind: "done", applied: 0, skipped: 0, heldBack: 0 };
		this.#running = true;
		try {
			return await this.#run();
		} finally {
			this.#running = false;
		}
	}

	async #run(): Promise<SyncOutcome> {
		// Anyone whose roles Pixel pushed within two runs of now is left for a later run.
		const since = this.#now() - 2 * this.#everyMs;
		const list: HolderList = await this.#roles.holders();
		if (list.kind === "unconfigured") return list;
		if (list.kind === "failed") {
			this.#problem(`Role sync is paused: ${list.reason}`);
			return list;
		}

		const plan = planSync(this.#access.view, list.managed, list.people);
		const by: PlatformActor = {
			platform: "discord",
			userId: list.self,
			displayName: "Pixel (Discord role sync)",
			chat: "group",
		};
		let applied = 0;
		let skipped = 0;
		for (const change of plan.changes) {
			const now = this.#access.view.records.get(change.userId)?.tier ?? "none";
			if (now !== change.from || this.#roles.appliedSince(change.userId, since)) {
				skipped++;
				continue;
			}
			try {
				await this.#access.apply(
					{
						kind: "set-tier",
						id: change.userId,
						tier: change.to,
						...(change.username ? { defaultNote: change.username } : {}),
						reason: change.to === "guest" ? "Discord role removed" : `Has the ${change.to} role`,
					},
					by,
				);
				applied++;
			} catch (error) {
				// One person failing (for example an invalid file) doesn't stop the rest.
				skipped++;
				this.#logger.warn(
					{ event: "role_sync.change_failed", target: `discord:${change.userId}`, err: error },
					"couldn't apply a role sync change",
				);
			}
		}

		if (plan.heldBack > 0) {
			this.#problem(
				`Role sync held back ${plan.heldBack} removals (more than ${MAX_DEMOTIONS} at once). ` +
					"Check the Discord roles, or run /admin sync to push Pixel's levels to Discord.",
			);
		} else {
			this.#problem(undefined);
		}
		if (applied > 0) {
			this.#logger.info(
				{ event: "role_sync.applied", applied, skipped },
				"synced levels from roles",
			);
		}
		return { kind: "done", applied, skipped, heldBack: plan.heldBack };
	}

	/** Logs and reports a problem when it first appears, and logs when it clears. */
	#problem(message: string | undefined): void {
		if (message === this.#lastProblem) return;
		if (message === undefined) {
			this.#logger.info({ event: "role_sync.ok" }, "role sync is working again");
		} else {
			this.#logger.warn({ event: "role_sync.problem" }, message);
			this.#reporter.captureBackground(new Error(message), "role-sync");
		}
		this.#lastProblem = message;
	}
}
