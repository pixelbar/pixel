import {
	closeSync,
	copyFileSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { isMap, isSeq, parseDocument, type Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import { actorLogFields, actorRef, type PlatformActor, splitRef } from "../core/access.ts";
import { CAPABILITY_NAME } from "../core/capabilities.ts";
import type { CapabilityNotifier } from "../core/capability-notify.ts";
import { UserFacingError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type {
	AccessChange,
	AccessChangeResult,
	AccessStore,
	AccessView,
	MemberRecord,
	ReloadResult,
	TierCapabilityChange,
	TierCapabilityResult,
} from "../core/ports/access-store.ts";
import { MAX_REASON_LENGTH } from "../core/ports/access-store.ts";
import type { ErrorReporter } from "../core/ports/error-reporter.ts";
import {
	AccessConfigError,
	type AccessConfigPaths,
	buildAccessConfig,
	DISCORD_ID,
	loadAccessFiles,
	MAX_CAPABILITIES,
	type MembersFile,
	parseMembers,
	readFile,
	toRecord,
} from "./access-config.ts";

/**
 * The bot-managed members file. Every change goes through `apply` (one person)
 * or `setTierCapabilities` (a whole level), which:
 *
 *  1. re-reads the file (so hand edits aren't lost) and checks it is valid, together
 *     with the admins (the same checks as at startup),
 *  2. edits the YAML document, so comments and order survive,
 *  3. re-validates the result, builds the new view, writes it to a temp file and fsyncs it,
 *  4. checks the file wasn't edited meanwhile, keeps the old one as `.bak`,
 *  5. renames the temp file over the original (atomic on a normal filesystem),
 *  6. only then swaps the in-memory view and writes the audit record.
 *
 * Steps 1 to 6 contain no `await`, so Node can't run another change in the
 * middle of one: changes can't interleave or lose each other's updates, and no
 * lock is needed. (The bot is single-instance; two processes would not be safe.)
 * A capability-change DM is sent after that, and never fails the change.
 *
 * Error messages never include personal data.
 */

export class AccessStoreError extends UserFacingError {
	override name = "AccessStoreError";
}

/** The file operations that can fail halfway. Injectable so tests can make them fail. */
export type FileOps = {
	/** Creates `path` (it must not exist), writes `data`, and flushes it to disk. */
	writeTemp(path: string, data: string, mode: number): void;
	copy(from: string, to: string): void;
	rename(from: string, to: string): void;
	remove(path: string): void;
	/** Flushes the directory entry so the rename survives a crash. Best effort. */
	syncDir(dir: string): void;
};

export const nodeFileOps: FileOps = {
	writeTemp(path, data, mode) {
		const fd = openSync(path, "wx", mode);
		try {
			writeSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	},
	copy: (from, to) => copyFileSync(from, to),
	rename: (from, to) => renameSync(from, to),
	remove: (path) => unlinkSync(path),
	syncDir(dir) {
		try {
			const fd = openSync(dir, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} catch {
			// Not supported everywhere (e.g. Windows). The rename itself already happened.
		}
	},
};

export type FileAccessStoreDeps = {
	paths: AccessConfigPaths;
	logger: Logger;
	reporter: ErrorReporter;
	ops?: FileOps;
	/** DMs the person when capabilities actually change. Optional so tests can omit it. */
	notify?: Pick<CapabilityNotifier, "notify">;
};

export class FileAccessStore implements AccessStore {
	readonly #paths: AccessConfigPaths;
	readonly #logger: Logger;
	readonly #reporter: ErrorReporter;
	readonly #ops: FileOps;
	readonly #notify: Pick<CapabilityNotifier, "notify"> | undefined;
	#view: AccessView;
	#admins: string[][];

	private constructor(deps: FileAccessStoreDeps, loaded: { admins: string[][]; view: AccessView }) {
		this.#paths = deps.paths;
		this.#logger = deps.logger;
		this.#reporter = deps.reporter;
		this.#ops = deps.ops ?? nodeFileOps;
		this.#notify = deps.notify;
		this.#admins = loaded.admins;
		this.#view = loaded.view;
	}

	/** Loads both files. Throws `AccessConfigError` on any problem, so startup fails closed. */
	static open(deps: FileAccessStoreDeps): FileAccessStore {
		return new FileAccessStore(deps, loadAccessFiles(deps.paths));
	}

	get view(): AccessView {
		return this.#view;
	}

	async apply(change: AccessChange, by: PlatformActor): Promise<AccessChangeResult> {
		const result = this.#apply(change, by);
		if (change.kind === "set-capabilities" && result.before !== result.after) {
			try {
				await this.#notify?.notify(
					change.id,
					result.before?.capabilities ?? [],
					result.after.capabilities,
					by,
				);
			} catch (error) {
				this.#logger.warn(
					{
						event: "capability.dm_failed",
						...actorLogFields(by),
						target: `discord:${change.id}`,
						err: error,
					},
					"couldn't notify about a capability change",
				);
			}
		}
		return result;
	}

	async setTierCapabilities(
		change: TierCapabilityChange,
		by: PlatformActor,
	): Promise<TierCapabilityResult> {
		return this.#setTierCapabilities(change, by);
	}

	async reload(by: PlatformActor): Promise<ReloadResult> {
		let loaded: ReturnType<typeof loadAccessFiles>;
		try {
			loaded = loadAccessFiles(this.#paths);
		} catch (error) {
			if (!(error instanceof AccessConfigError)) throw error;
			this.#logger.warn(
				{ event: "access.reload_failed", ...actorLogFields(by) },
				`reload failed: ${error.message}`,
			);
			throw new AccessStoreError(
				`Reload failed, so I'm keeping the current data.\n${error.message}`,
			);
		}
		const before = this.#view.counts;
		this.#admins = loaded.admins;
		this.#view = loaded.view;
		const after = loaded.view.counts;
		this.#logger.info(
			{ event: "access.reloaded", ...actorLogFields(by), before, after },
			"access lists reloaded",
		);
		this.#reporter.breadcrumb("access", "reloaded", { actor: actorRef(by) });
		for (const warning of loaded.view.warnings) {
			this.#logger.warn({ event: "access_config.warning" }, warning);
		}
		return { before, after };
	}

	// Synchronous on purpose: see the class comment.
	#apply(change: AccessChange, by: PlatformActor): AccessChangeResult {
		const file = this.#paths.membersFile;
		const { id } = change;
		const ref = `discord:${id}`;
		validateChange(change);
		// Admins come only from admins.yaml. Their members entry may still hold capabilities.
		// This covers every id of an admin's, so a second account can't be used to demote them.
		if (change.kind === "set-tier" && this.#isAdminPerson(id)) {
			throw new AccessStoreError(
				"That person is an admin. Admins come from admins.yaml, so their level can't be changed here.",
			);
		}

		const raw = this.#read(file);
		const doc = parseDocument(raw);
		const current = this.#parseCurrent(raw, file).members;
		const index = current.findIndex((entry) => entry.ids.includes(ref));
		const before = index >= 0 ? toRecord(current[index] as (typeof current)[number]) : null;

		if (change.kind === "set-capabilities" && !before) {
			throw new AccessStoreError("That person isn't in the access list yet. Set their tier first.");
		}
		// Decided against the file just read, not the in-memory view, which may predate a
		// hand edit.
		const note =
			change.kind === "set-tier" && before?.note === undefined ? change.defaultNote : undefined;
		if (before && change.kind === "set-tier" && before.tier === change.tier && note === undefined) {
			return { before, after: before };
		}
		if (
			before &&
			change.kind === "set-capabilities" &&
			sameCapabilities(before.capabilities, change.capabilities)
		) {
			return { before, after: before };
		}

		edit(doc, change, index, note);
		const nextFile = this.#save(doc, raw);
		const updated = nextFile.members.find((entry) => entry.ids.includes(ref));
		const after = toRecord(updated as NonNullable<typeof updated>);
		this.#audit(change, by, before, after);
		return { before, after };
	}

	// Synchronous on purpose: see the class comment.
	#setTierCapabilities(change: TierCapabilityChange, by: PlatformActor): TierCapabilityResult {
		const file = this.#paths.membersFile;
		if (change.tier !== "member" && change.tier !== "friend") {
			throw new AccessStoreError("Only the member and friend levels can be given capabilities.");
		}
		validateReason(change.reason);
		validateCapabilities(change.capabilities);

		const raw = this.#read(file);
		const doc = parseDocument(raw);
		const before = this.#parseCurrent(raw, file).tiers[change.tier];
		if (sameCapabilities(before, change.capabilities)) return { before, after: before };

		editTier(doc, change);
		const after = this.#save(doc, raw).tiers[change.tier];
		this.#auditTier(change, by, before, after);
		return { before, after };
	}

	/**
	 * Checks the edited document, writes it and swaps the view. Throws before
	 * anything is written if the result is invalid.
	 */
	#save(doc: ReturnType<typeof parseDocument>, raw: string): MembersFile {
		const file = this.#paths.membersFile;
		// No padding inside [ ], so `ids: ["discord:123"]` round-trips exactly as written.
		const next = doc.toString({ flowCollectionPadding: false });
		// Our own edit must produce a valid file. If it doesn't, that is a bug, not user error.
		const nextFile = parseMembers(next, file);
		// Build the new view before writing, so a failing cross-file check can't leave the file
		// changed while the view and the audit record are not.
		const nextView = buildAccessConfig(this.#admins, nextFile, this.#paths);

		this.#writeFile(file, raw, next);
		this.#view = nextView;
		return nextFile;
	}

	/** Whether this Discord user, or any other id of the same person, is an admin. */
	#isAdminPerson(userId: string): boolean {
		const person = this.#view.records.get(userId);
		const userIds = person ? person.ids.map((ref) => splitRef(ref).userId) : [userId];
		return userIds.some((other) => this.#view.discord.get(other) === "admin");
	}

	#read(file: string) {
		try {
			return readFile(file);
		} catch (error) {
			if (!(error instanceof AccessConfigError)) throw error;
			this.#logger.error({ event: "access.read_failed" }, error.message);
			throw new AccessStoreError("Couldn't read the members file, so nothing was changed.");
		}
	}

	#parseCurrent(raw: string, file: string): MembersFile {
		try {
			const parsed = parseMembers(raw, file);
			// The same cross-file checks as startup: an id in two entries, an admin with no entry.
			buildAccessConfig(this.#admins, parsed, this.#paths);
			return parsed;
		} catch (error) {
			if (!(error instanceof AccessConfigError)) throw error;
			this.#logger.warn({ event: "access.file_invalid" }, error.message);
			throw new AccessStoreError(
				"The members file is invalid, so nothing was changed. Fix it, then run /admin reload.",
			);
		}
	}

	/** Temp file, flush, race check, backup, atomic rename. Any failure leaves the original in place. */
	#writeFile(file: string, raw: string, next: string): void {
		const temp = `${file}.${process.pid}.tmp`;
		try {
			this.#ops.writeTemp(temp, next, statSync(file).mode & 0o777);
			// A hand edit in the tiny window since we read the file would be lost by the rename.
			if (readFileSync(file, "utf8") !== raw) {
				throw new AccessStoreError(
					"The members file changed while I was saving, so nothing was changed. Try again.",
				);
			}
			this.#ops.copy(file, `${file}.bak`);
			this.#ops.rename(temp, file);
		} catch (error) {
			try {
				this.#ops.remove(temp);
			} catch {
				// The temp file may never have been created.
			}
			if (error instanceof AccessStoreError) throw error;
			this.#logger.error({ event: "access.write_failed", err: error }, "couldn't save the change");
			this.#reporter.captureBackground(error, "access-store");
			throw new AccessStoreError("Couldn't save the change, so nothing was changed.");
		}
		this.#ops.syncDir(dirname(file));
	}

	/** The one place every change is recorded: who, to whom, before and after. */
	#audit(
		change: AccessChange,
		by: PlatformActor,
		before: MemberRecord | null,
		after: MemberRecord,
	): void {
		const target = `${by.platform}:${change.id}`;
		this.#logger.info(
			{
				event: "access.changed",
				...actorLogFields(by),
				kind: change.kind,
				target,
				before: summarise(before),
				after: summarise(after),
				...(change.reason ? { reason: change.reason } : {}),
			},
			"access changed",
		);
		this.#reporter.breadcrumb("access", change.kind, {
			actor: actorRef(by),
			target,
			before: before?.tier ?? "none",
			after: after.tier,
			capabilities: after.capabilities.join(","),
		});
	}

	/** The audit record for a whole level: who, which level, before and after. */
	#auditTier(
		change: TierCapabilityChange,
		by: PlatformActor,
		before: readonly string[],
		after: readonly string[],
	): void {
		const target = `tier:${change.tier}`;
		this.#logger.info(
			{
				event: "access.changed",
				...actorLogFields(by),
				kind: "set-tier-capabilities",
				target,
				before: { capabilities: before },
				after: { capabilities: after },
				...(change.reason ? { reason: change.reason } : {}),
			},
			"access changed",
		);
		this.#reporter.breadcrumb("access", "set-tier-capabilities", {
			actor: actorRef(by),
			target,
			capabilities: after.join(","),
		});
	}
}

/** Tier and capabilities only. Notes are free text about a person and stay out of logs. */
function summarise(record: MemberRecord | null) {
	return record ? { tier: record.tier, capabilities: record.capabilities } : null;
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name) => right.includes(name));
}

function validateChange(change: AccessChange): void {
	if (!DISCORD_ID.test(change.id)) throw new AccessStoreError("That isn't a valid user ID.");
	validateReason(change.reason);
	if (change.kind === "set-capabilities") validateCapabilities(change.capabilities);
}

function validateReason(reason: string | undefined): void {
	if (reason !== undefined && [...reason].length > MAX_REASON_LENGTH) {
		throw new AccessStoreError(`A reason can be at most ${MAX_REASON_LENGTH} characters.`);
	}
}

function validateCapabilities(names: readonly string[]): void {
	if (names.length > MAX_CAPABILITIES || new Set(names).size !== names.length) {
		throw new AccessStoreError("That isn't a valid list of capabilities.");
	}
	if (!names.every((name) => CAPABILITY_NAME.test(name))) {
		throw new AccessStoreError("Capability names are lowercase words joined by '-'.");
	}
}

/** Sets one level's capabilities under `tiers:`, removing whatever is left empty. */
function editTier(doc: ReturnType<typeof parseDocument>, change: TierCapabilityChange): void {
	const path = ["tiers", change.tier, "capabilities"];
	if (change.capabilities.length > 0) {
		doc.setIn(path, doc.createNode([...change.capabilities]));
		return;
	}
	doc.deleteIn(path);
	const level = doc.getIn(["tiers", change.tier], true);
	if (isMap(level) && level.items.length === 0) doc.deleteIn(["tiers", change.tier]);
	const tiers = doc.get("tiers", true);
	if (isMap(tiers) && tiers.items.length === 0) doc.delete("tiers");
}

/** Edits the YAML document in place, keeping comments, order and quoting. `note` is new only. */
function edit(
	doc: ReturnType<typeof parseDocument>,
	change: AccessChange,
	index: number,
	note: string | undefined,
): void {
	const members = doc.get("members", true);
	if (!isSeq(members)) throw new Error("members is not a list"); // unreachable: validated above
	const seq = members as YAMLSeq;

	if (change.kind === "set-capabilities") {
		const path = ["members", index, "capabilities"];
		if (change.capabilities.length === 0) doc.deleteIn(path);
		else doc.setIn(path, doc.createNode([...change.capabilities]));
		return;
	}

	if (index >= 0) {
		doc.setIn(["members", index, "tier"], change.tier);
		if (note !== undefined) doc.setIn(["members", index, "note"], note);
		return;
	}

	const item = doc.createNode({
		ids: [`discord:${change.id}`],
		tier: change.tier,
		...(note !== undefined ? { note } : {}),
	}) as YAMLMap;
	if (!isMap(item)) throw new Error("couldn't create a members entry");
	// IDs must be quoted strings, or they lose precision when read back as numbers. A short
	// list stays on one line: ids: ["discord:123…"].
	const ids = item.get("ids");
	if (!isSeq(ids)) throw new Error("couldn't create a members entry");
	ids.flow = true;
	for (const entry of ids.items) (entry as Scalar).type = "QUOTE_DOUBLE";
	seq.flow = false;
	seq.add(item);
}
