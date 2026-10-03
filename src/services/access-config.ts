import { readFileSync } from "node:fs";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import type { PlatformActor, Tier } from "../core/access.ts";
import type { AccessView, MemberRecord, MemberTier } from "../core/ports/access-store.ts";
import type { TierSource } from "../core/ports/tier-source.ts";

/**
 * Loads the phase 1 access lists (config/admins.yaml, config/members.yaml).
 * Fails closed: any problem throws, and Pixel refuses to start.
 *
 * Error messages name the file, entry index and field, but never echo values —
 * the files contain personal data.
 */

export const DISCORD_ID = /^\d{17,20}$/;

const discordId = z
	.string({ error: 'must be a quoted string, e.g. "123456789012345678"' })
	.regex(DISCORD_ID, { error: "must be a Discord user ID (17–20 digits)" });

const adminsSchema = z.strictObject({
	admins: z
		.array(
			z.strictObject({
				name: z.string().trim().min(1),
				discordId,
			}),
		)
		.min(1, { error: "at least one admin is required" }),
});

/** Lowercase words joined by '-', e.g. "front-door". What the capability is called is up to #28. */
export const CAPABILITY_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_CAPABILITIES = 50;

const capabilities = z
	.array(z.string().regex(CAPABILITY_NAME, { error: "must be lowercase words joined by '-'" }))
	.max(MAX_CAPABILITIES, { error: `at most ${MAX_CAPABILITIES} capabilities` })
	.refine((names) => new Set(names).size === names.length, { error: "must not repeat a name" });

const membersSchema = z.strictObject({
	members: z.array(
		z.strictObject({
			discordId,
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

export function parseAdmins(source: string, file: string): { name: string; discordId: string }[] {
	return parseSource(file, source, adminsSchema).admins;
}

/** Parses and validates the text of the members file. Throws `AccessConfigError`. */
export function parseMembers(source: string, file: string): MemberEntry[] {
	return parseSource(file, source, membersSchema).members;
}

export function toRecord(entry: MemberEntry): MemberRecord {
	return {
		discordId: entry.discordId,
		tier: entry.tier,
		...(entry.note !== undefined ? { note: entry.note } : {}),
		capabilities: entry.capabilities ?? [],
	};
}

export function buildAccessConfig(
	admins: readonly { discordId: string }[],
	members: readonly MemberEntry[],
	paths: AccessConfigPaths,
): AccessConfig {
	assertUnique(admins, paths.adminsFile, "admins");
	assertUnique(members, paths.membersFile, "members");

	const discord = new Map<string, Exclude<Tier, "guest">>();
	const records = new Map<string, MemberRecord>();
	const warnings: string[] = [];
	const counts = { admins: admins.length, members: 0, friends: 0 };

	for (const admin of admins) discord.set(admin.discordId, "admin");
	members.forEach((member, index) => {
		records.set(member.discordId, toRecord(member));
		if (discord.has(member.discordId)) {
			warnings.push(
				`${paths.membersFile}: members[${index}] is also listed as an admin; admin takes precedence`,
			);
			return;
		}
		// A guest entry is someone who was demoted: no tier, so they're left out.
		const tier: MemberTier = member.tier;
		if (tier === "guest") return;
		discord.set(member.discordId, tier);
		if (tier === "member") counts.members++;
		else counts.friends++;
	});

	return { discord, records, counts, warnings };
}

function assertUnique(entries: readonly { discordId: string }[], file: string, key: string): void {
	const firstIndex = new Map<string, number>();
	entries.forEach((entry, index) => {
		const first = firstIndex.get(entry.discordId);
		if (first !== undefined) {
			throw new AccessConfigError(`${file}: ${key}[${index}] duplicates ${key}[${first}]`);
		}
		firstIndex.set(entry.discordId, index);
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
		if (actor.platform !== "discord") return null;
		return this.#store.view.discord.get(actor.userId) ?? null;
	}
}
