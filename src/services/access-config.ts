import { readFileSync } from "node:fs";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import type { PlatformActor, Tier } from "../core/access.ts";
import type { TierSource } from "../core/ports/tier-source.ts";

/**
 * Loads the phase 1 access lists (config/admins.yaml, config/members.yaml).
 * Fails closed: any problem throws, and Pixel refuses to start.
 *
 * Error messages name the file, entry index and field, but never echo values —
 * the files contain personal data.
 */

const discordId = z
	.string({ error: 'must be a quoted string, e.g. "123456789012345678"' })
	.regex(/^\d{17,20}$/, { error: "must be a Discord user ID (17–20 digits)" });

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

const membersSchema = z.strictObject({
	members: z.array(
		z.strictObject({
			discordId,
			tier: z.enum(["member", "friend"]),
			note: z.string().optional(),
		}),
	),
});

export type PaidTier = "member" | "friend";

export type AccessConfig = {
	/** Discord user ID → tier. Only non-guest tiers appear. */
	readonly discord: ReadonlyMap<string, Exclude<Tier, "guest">>;
	readonly counts: { readonly admins: number; readonly members: number; readonly friends: number };
	/** Non-fatal issues, safe to log (no IDs). */
	readonly warnings: readonly string[];
};

export class AccessConfigError extends Error {
	override name = "AccessConfigError";
}

export type AccessConfigPaths = { adminsFile: string; membersFile: string };

export function loadAccessConfig(paths: AccessConfigPaths): AccessConfig {
	const admins = parseFile(paths.adminsFile, adminsSchema).admins;
	const members = parseFile(paths.membersFile, membersSchema).members;
	return buildAccessConfig(admins, members, paths);
}

function buildAccessConfig(
	admins: readonly { discordId: string }[],
	members: readonly { discordId: string; tier: PaidTier }[],
	paths: AccessConfigPaths,
): AccessConfig {
	assertUnique(admins, paths.adminsFile, "admins");
	assertUnique(members, paths.membersFile, "members");

	const discord = new Map<string, Exclude<Tier, "guest">>();
	const warnings: string[] = [];
	const counts = { admins: admins.length, members: 0, friends: 0 };

	for (const admin of admins) discord.set(admin.discordId, "admin");
	members.forEach((member, index) => {
		if (discord.has(member.discordId)) {
			warnings.push(
				`${paths.membersFile}: members[${index}] is also listed as an admin; admin takes precedence`,
			);
			return;
		}
		discord.set(member.discordId, member.tier);
		if (member.tier === "member") counts.members++;
		else counts.friends++;
	});

	return { discord, counts, warnings };
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

function parseFile<T>(file: string, schema: z.ZodType<T>): T {
	let source: string;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
		throw new AccessConfigError(`${file}: cannot read file (${code})`);
	}

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

/** Phase 1 tier source: tiers straight from the access config files. */
export class ConfigTierSource implements TierSource {
	readonly name = "access-config";
	readonly #config: AccessConfig;

	constructor(config: AccessConfig) {
		this.#config = config;
	}

	async tierFor(actor: PlatformActor): Promise<Tier | null> {
		if (actor.platform !== "discord") return null;
		return this.#config.discord.get(actor.userId) ?? null;
	}
}
