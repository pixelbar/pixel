/**
 * The decisions behind `just secrets-pull` and `just secrets-push`, kept apart from
 * the prompts and the Azure calls so they can be tested. See `secrets-sync.ts` for the
 * flow. Nothing here prints a value: lines describe a secret by its name and length.
 */
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { RegisterTarget } from "./register-env.ts";
import type { SecretEntry, SecretsManifest } from "./secrets-manifest.ts";

/** Where each env's secrets live on Azure, and the Container App that reads them. */
export type Vault = { vault: string; resourceGroup: string; app: string };

export const VAULTS: Record<RegisterTarget, Vault> = {
	dev: { vault: "pixel-dev-kv", resourceGroup: "pixel-dev", app: "pixel-dev" },
	prod: { vault: "pixel-prod-kv", resourceGroup: "pixel-prod", app: "pixel-prod" },
};

/** The env file a target's env secrets are mirrored in. Same files as `just register`. */
export function envFile(target: RegisterTarget): string {
	return `.env.${target}`;
}

/** The local copy of a target's `admins-yaml` secret. Gitignored (`config/*.yaml`). */
export function adminsFile(target: RegisterTarget): string {
	return join("config", `admins.${target}.yaml`);
}

/**
 * What the sync manages: the manifest's `app` secrets. `infra` ones (the Tailscale key,
 * the registry token) stay with Terraform and are never read or written here.
 */
export function syncedSecrets(manifest: SecretsManifest): SecretEntry[] {
	return manifest.secrets.filter(
		(s) => s.group === "app" && (s.delivery === "env" || s.delivery === "file"),
	);
}

/** Where a secret lives locally, for messages. */
export function localName(entry: SecretEntry, target: RegisterTarget): string {
	return entry.delivery === "file" ? adminsFile(target) : `${entry.env} in ${envFile(target)}`;
}

/** A secret's value by its Key Vault name. Missing (or empty) means not set. */
export type Values = ReadonlyMap<string, string>;

/** Reads the managed secrets out of an env file's text and the admins file's text. */
export function localValues(
	entries: readonly SecretEntry[],
	envText: string | undefined,
	adminsText: string | undefined,
): Map<string, string> {
	const env = envText === undefined ? {} : parseEnv(envText);
	const out = new Map<string, string>();
	for (const entry of entries) {
		const value = entry.delivery === "file" ? adminsText : entry.env ? env[entry.env] : undefined;
		if (value !== undefined && value !== "") out.set(entry.vault, value);
	}
	return out;
}

export type RowStatus = "same" | "changed" | "local-only" | "remote-only" | "neither";
export type Row = { entry: SecretEntry; local?: string; remote?: string; status: RowStatus };

/** Lines the local values up with what Key Vault has, one row per managed secret. */
export function compare(entries: readonly SecretEntry[], local: Values, remote: Values): Row[] {
	return entries.map((entry) => {
		const l = local.get(entry.vault);
		const r = remote.get(entry.vault);
		const status: RowStatus =
			l === undefined
				? r === undefined
					? "neither"
					: "remote-only"
				: r === undefined
					? "local-only"
					: l === r
						? "same"
						: "changed";
		return {
			entry,
			status,
			...(l !== undefined ? { local: l } : {}),
			...(r !== undefined ? { remote: r } : {}),
		};
	});
}

/** What a push writes to Key Vault: changed values and new ones. It never deletes. */
export function toPush(rows: readonly Row[]): Row[] {
	return rows.filter((row) => row.status === "changed" || row.status === "local-only");
}

/** What a pull writes locally: changed values and ones only Key Vault has. */
export function toPull(rows: readonly Row[]): Row[] {
	return rows.filter((row) => row.status === "changed" || row.status === "remote-only");
}

const chars = (value: string | undefined) =>
	value === undefined ? "unset" : `${value.length} character${value.length === 1 ? "" : "s"}`;

/**
 * One line per secret, never the value. `push` reads left to right as local → Key
 * Vault, `pull` as Key Vault → local.
 */
export function describe(row: Row, direction: "push" | "pull", target: RegisterTarget): string {
	const name = `${row.entry.vault} (${localName(row.entry, target)})`;
	const [from, to] = direction === "push" ? [row.local, row.remote] : [row.remote, row.local];
	switch (row.status) {
		case "same":
			return `  = ${name}: the same`;
		case "neither":
			return `  - ${name}: not set either side`;
		case "changed":
			return `  ~ ${name}: changes (${chars(to)} → ${chars(from)})`;
		case "local-only":
			return direction === "push"
				? `  + ${name}: new in Key Vault (${chars(from)})`
				: `  ! ${name}: only local, not in Key Vault (left as it is)`;
		case "remote-only":
			return direction === "pull"
				? `  + ${name}: new locally (${chars(from)})`
				: `  ! ${name}: only in Key Vault (left as it is; a push never deletes)`;
	}
}

const PLAIN = /^[A-Za-z0-9_\-.:/+=@,~%]*$/;

/** A value as it goes into an env file, quoted only when it has to be. */
export function envValue(key: string, value: string): string {
	if (PLAIN.test(value)) return value;
	if (!/[\n\r]/.test(value)) {
		if (!value.includes("'")) return `'${value}'`;
		// Double quotes expand escapes like \n, so only when there's no backslash.
		if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
	}
	throw new Error(`${key} can't be written to an env file safely. Set it by hand.`);
}

const assignment = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);

/**
 * Sets keys in an env file's text, keeping every other line (comments included) as it
 * is. An existing key is replaced where it is (later duplicates are dropped, since the
 * last one would win), and a new one goes at the end.
 */
export function setEnvValues(text: string, updates: ReadonlyMap<string, string>): string {
	const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
	for (const [key, value] of updates) {
		const line = `${key}=${envValue(key, value)}`;
		const match = assignment(key);
		const at = lines.findIndex((l) => match.test(l));
		if (at === -1) {
			lines.push(line);
			continue;
		}
		lines[at] = line;
		for (let i = lines.length - 1; i > at; i--) {
			if (match.test(lines[i] ?? "")) lines.splice(i, 1);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** The env file to start from when a pull finds none. */
export function newEnvFile(target: RegisterTarget): string {
	return [
		`# ${envFile(target)}: written by just secrets-pull ${target}. Add the other settings from .env.example.`,
		...(target === "prod" ? ["PIXEL_ENV=prod"] : ["PIXEL_ENV=dev"]),
		"",
	].join("\n");
}

/** `PIXEL_ENV` as an env file sets it, for `assertRegisterEnv`. */
export function pixelEnvOf(envText: string | undefined): "local" | "dev" | "prod" {
	const value = envText === undefined ? undefined : parseEnv(envText).PIXEL_ENV;
	return value === "dev" || value === "prod" ? value : "local";
}

/**
 * The other env files whose Discord token must never reach this target's vault: the
 * Pixel Dev and Mini bots must never run as prod, and prod's token never belongs on dev.
 */
export function otherEnvFiles(target: RegisterTarget): string[] {
	return target === "prod" ? [".env.dev", ".env"] : [".env.prod"];
}

/** The file that already holds this Discord token, if it's another bot's. */
export function reusedDiscordToken(
	token: string | undefined,
	others: readonly { file: string; text: string }[],
): string | undefined {
	if (!token) return undefined;
	return others.find((other) => parseEnv(other.text).DISCORD_TOKEN === token)?.file;
}

const AZ_QUIET = ["--only-show-errors"];

export function azShowArgs(vault: Vault, name: string): string[] {
	return [
		"keyvault",
		"secret",
		"show",
		...AZ_QUIET,
		"--vault-name",
		vault.vault,
		"--name",
		name,
		"--query",
		"value",
		"--output",
		"json",
	];
}

/** Sets a secret from a file, so the value never appears in a command line. */
export function azSetArgs(vault: Vault, entry: SecretEntry, file: string): string[] {
	return [
		"keyvault",
		"secret",
		"set",
		...AZ_QUIET,
		"--vault-name",
		vault.vault,
		"--name",
		entry.vault,
		"--file",
		file,
		"--encoding",
		"utf-8",
		"--content-type",
		entry.delivery === "file" ? "text/yaml" : "text/plain",
		"--output",
		"none",
	];
}

/** Whether `az keyvault secret show` failed because the secret doesn't exist. */
export function isNotFound(stderr: string): boolean {
	return /SecretNotFound|was not found/i.test(stderr);
}

/** The value out of `az keyvault secret show --query value --output json`. */
export function parseShown(stdout: string): string {
	const value: unknown = JSON.parse(stdout);
	if (typeof value !== "string") throw new Error("az returned a secret that isn't text");
	return value;
}
