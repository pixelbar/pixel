import { readFileSync } from "node:fs";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import { actorRef, type PlatformActor, type Tier } from "../core/access.ts";
import { CAPABILITY_NAME } from "../core/capabilities.ts";
import type { AccessView, MemberRecord, MemberTier } from "../core/ports/access-store.ts";
import type { CapabilitySource } from "../core/ports/capability-source.ts";
import type { TierSource } from "../core/ports/tier-source.ts";

/**
 * Loads the phase 1 access lists (config/admins.yaml, config/members.yaml).
 * Fails closed: any problem throws, and Pixel refuses to start.
 *
 * Error messages name the file, entry index and field, but never echo values —
 * the files contain personal data.
 */

export const DISCORD_ID = /^\d{17,20}$/;

// People are identified by platform-prefixed IDs ("discord:<id>", "telegram:<id>") in both
// files, and inside Pixel too, so IDs from different platforms can never be confused. One
// person can have several, so each entry holds a list of them, and an admin entry matches its
// members entry by the IDs they share.
export const TELEGRAM_ID = /^[1-9]\d{0,15}$/;
export const PLATFORM_ID = /^(discord:\d{17,20}|telegram:[1-9]\d{0,15})$/;

const platformId = z
	.string({ error: 'must be a quoted string, e.g. "discord:123456789012345678"' })
	.regex(PLATFORM_ID, {
		error:
			'must be a platform and user ID, e.g. "discord:123456789012345678" (17–20 digits) or "telegram:123456789"',
	});

const ids = z
	.array(platformId)
	.min(1, { error: "at least one id is required" })
	.max(10, { error: "at most 10 ids" })
	.refine((list) => new Set(list).size === list.length, { error: "must not repeat an id" });

// Admins are just IDs. Each admin must also have an entry in the members file holding all of
// those IDs, which holds everything else about them (membership level, capabilities, note).
const adminsSchema = z.strictObject({
	admins: z.array(z.strictObject({ ids })).min(1, { error: "at least one admin is required" }),
});

export const MAX_CAPABILITIES = 50;

const capabilities = z
	.array(z.string().regex(CAPABILITY_NAME, { error: "must be lowercase words joined by '-'" }))
	.max(MAX_CAPABILITIES, { error: `at most ${MAX_CAPABILITIES} capabilities` })
	.refine((names) => new Set(names).size === names.length, { error: "must not repeat a name" });

const membersSchema = z.strictObject({
	members: z.array(
		z.strictObject({
			ids,
			// `guest` keeps the entry (and its capabilities) for someone who was demoted.
			tier: z.enum(["member", "friend", "guest"]),
			note: z.string().optional(),
			capabilities: capabilities.optional(),
		}),
	),
});

type MemberEntry = z.infer<typeof membersSchema>["members"][number];

export type AccessConfig = AccessView;

export class AccessConfigError extends Error {
	override name = "AccessConfigError";
}

export type AccessConfigPaths = { adminsFile: string; membersFile: string };

export function loadAccessConfig(paths: AccessConfigPaths): AccessConfig {
	return loadAccessFiles(paths).view;
}

/** Like `loadAccessConfig`, but also returns the parsed admins so a store can rebuild its view. */
export function loadAccessFiles(paths: AccessConfigPaths) {
	const admins = parseAdmins(readFile(paths.adminsFile), paths.adminsFile);
	const members = parseMembers(readFile(paths.membersFile), paths.membersFile);
	return { admins, view: buildAccessConfig(admins, members, paths) };
}

/** Each admin as the list of their IDs. */
export function parseAdmins(source: string, file: string): string[][] {
	return parseSource(file, source, adminsSchema).admins.map((admin) => admin.ids);
}

/** Parses and validates the text of the members file. Throws `AccessConfigError`. */
export function parseMembers(source: string, file: string): MemberEntry[] {
	return parseSource(file, source, membersSchema).members;
}

export function toRecord(entry: MemberEntry): MemberRecord {
	return {
		ids: entry.ids,
		tier: entry.tier,
		...(entry.note !== undefined ? { note: entry.note } : {}),
		capabilities: entry.capabilities ?? [],
	};
}

export function buildAccessConfig(
	admins: readonly (readonly string[])[],
	members: readonly MemberEntry[],
	paths: AccessConfigPaths,
): AccessConfig {
	assertUniqueAcross(
		admins.map((admin) => admin),
		paths.adminsFile,
		"admins",
	);
	assertUniqueAcross(
		members.map((m) => m.ids),
		paths.membersFile,
		"members",
	);

	// Each person (members entry) is reachable under each of their IDs.
	const records = new Map<string, MemberRecord>();
	const ownerOf = new Map<string, number>();
	members.forEach((member, index) => {
		const record = toRecord(member);
		for (const ref of member.ids) {
			records.set(ref, record);
			ownerOf.set(ref, index);
		}
	});

	// An admin entry must point at one members entry that holds all of its IDs.
	const adminIds = new Set<string>();
	const adminPeople = new Set<number>();
	admins.forEach((refs, index) => {
		const owners = new Set(refs.map((ref) => ownerOf.get(ref)));
		if (owners.has(undefined)) {
			throw new AccessConfigError(
				`${paths.adminsFile}: admins[${index}] has an id with no entry in ${paths.membersFile}. Add them there first, with a tier of member, friend or guest`,
			);
		}
		if (owners.size > 1) {
			throw new AccessConfigError(
				`${paths.adminsFile}: admins[${index}] lists ids that belong to different entries in ${paths.membersFile}`,
			);
		}
		for (const ref of refs) adminIds.add(ref);
		adminPeople.add([...owners][0] as number);
	});

	const tiers = new Map<string, Exclude<Tier, "guest">>();
	const counts = { admins: adminPeople.size, members: 0, friends: 0 };

	members.forEach((member, index) => {
		const tier: MemberTier = member.tier;
		// A guest entry is someone who was demoted: no tier, so they're left out.
		if (tier !== "guest") {
			for (const ref of member.ids) {
				if (!adminIds.has(ref)) tiers.set(ref, tier);
			}
		}
		// Admins keep their members entry (capabilities, note), but count once, as admins.
		if (adminPeople.has(index) || tier === "guest") return;
		if (tier === "member") counts.members++;
		else counts.friends++;
	});
	for (const ref of adminIds) tiers.set(ref, "admin");

	return { tiers, records, counts, warnings: [] };
}

/** Each ID may appear once across all entries of a file. Messages name positions, never IDs. */
function assertUniqueAcross(
	entries: readonly (readonly string[])[],
	file: string,
	key: string,
): void {
	const first = new Map<string, string>();
	entries.forEach((refs, entry) => {
		refs.forEach((ref, position) => {
			const where = `${key}[${entry}].ids[${position}]`;
			const seen = first.get(ref);
			if (seen !== undefined) {
				throw new AccessConfigError(`${file}: ${where} duplicates ${seen}`);
			}
			first.set(ref, where);
		});
	});
}

export function readFile(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
		throw new AccessConfigError(`${file}: cannot read file (${code})`);
	}
}

function parseSource<T>(file: string, source: string, schema: z.ZodType<T>): T {
	let data: unknown;
	try {
		data = parse(source);
	} catch (error) {
		// YAML errors include a snippet of the offending line; report position only.
		const pos = error instanceof YAMLParseError ? error.linePos?.[0] : undefined;
		const where = pos ? ` at line ${pos.line}, column ${pos.col}` : "";
		throw new AccessConfigError(`${file}: invalid YAML${where}`);
	}

	const result = schema.safeParse(data);
	if (!result.success) {
		const problems = result.error.issues.map(
			(issue) => `  - ${formatPath(issue.path)}: ${issue.message}`,
		);
		throw new AccessConfigError(`${file}: invalid access list\n${problems.join("\n")}`);
	}
	return result.data;
}

function formatPath(path: readonly PropertyKey[]): string {
	if (path.length === 0) return "(root)";
	return path
		.map((part, i) =>
			typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`,
		)
		.join("");
}

/**
 * Phase 1 tier source: tiers straight from the access store. It reads the
 * store's current view on every call, so changes apply immediately.
 */
export class ConfigTierSource implements TierSource {
	readonly name = "access-config";
	readonly #store: { readonly view: AccessView };

	constructor(store: { readonly view: AccessView }) {
		this.#store = store;
	}

	async tierFor(actor: PlatformActor): Promise<Tier | null> {
		return this.#store.view.tiers.get(actorRef(actor)) ?? null;
	}
}

/** Capabilities straight from the access store's members entries. The dispatcher decides whether they count. */
export class StoreCapabilitySource implements CapabilitySource {
	readonly name = "access-config";
	readonly #store: { readonly view: AccessView };

	constructor(store: { readonly view: AccessView }) {
		this.#store = store;
	}

	async capabilitiesFor(actor: PlatformActor): Promise<readonly string[]> {
		return this.#store.view.records.get(actorRef(actor))?.capabilities ?? [];
	}
}
