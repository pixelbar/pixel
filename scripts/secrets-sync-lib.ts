/**
 * The decisions behind `just pull` / `just push` and `just secrets-pull` / `secrets-push`,
 * kept apart from the prompts and the Azure calls so they can be tested. See
 * `secrets-sync.ts` for the flow. Nothing here prints a secret value: lines describe a
 * secret by its name and length. File secrets (admins.yaml, terraform.tfvars) hold no
 * tokens, so their diffs are shown.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { HOME_KINDS } from "../src/core/home-kinds/index.ts";
import { type Logger, silentLogger } from "../src/core/logger.ts";
import { AnnouncementRouteStore } from "../src/services/announcement-routes.ts";
import { HomeDevicesError } from "../src/services/home-devices.ts";
import { ParkingBookingStore } from "../src/services/parking-bookings.ts";
import { ParkingSpotStore } from "../src/services/parking-spots.ts";
import { ParkingWindowStore } from "../src/services/parking-windows.ts";
import { ScheduleStore } from "../src/services/schedules.ts";
import { ENVS, localFiles, type Target } from "./envs.ts";
import { validateDevices } from "./ha-devices-lib.ts";
import type { SecretEntry, SecretsManifest } from "./secrets-manifest.ts";

/** Where each env's secrets live on Azure, and the Container App that reads them. */
export type Vault = { vault: string; resourceGroup: string; app: string };

const vaultOf = ({ vault, resourceGroup, app }: Vault): Vault => ({ vault, resourceGroup, app });

export const VAULTS: Record<Target, Vault> = { dev: vaultOf(ENVS.dev), prod: vaultOf(ENVS.prod) };

/** The env file a target's env secrets are mirrored in. Same files as `just register`. */
export function envFile(target: Target): string {
	return ENVS[target].envFile;
}

/** The local copy of a target's `admins-yaml` secret. Gitignored (`config/*.yaml`). */
export function adminsFile(target: Target): string {
	return localFiles(target).adminsFile;
}

/** The stack's settings, shared through the `terraform-tfvars` secret. Gitignored (`*.tfvars`). */
export function tfvarsFile(target: Target): string {
	return join("infra", "envs", target, "terraform.tfvars");
}

/** Where Terraform's write-only inputs go instead: auto-loaded, gitignored, never synced. */
export function secretTfvarsFile(target: Target): string {
	return join("infra", "envs", target, "secrets.auto.tfvars");
}

/** The local file behind each secret that is a whole file rather than one env variable. */
const FILES: Record<string, (target: Target) => string> = {
	"admins-yaml": adminsFile,
	"terraform-tfvars": tfvarsFile,
};

/** Whether a secret is a whole local file (shown as a diff) rather than an env variable. */
export function isFile(entry: SecretEntry): boolean {
	return entry.delivery !== "env";
}

export function localFile(entry: SecretEntry, target: Target): string {
	const file = FILES[entry.vault];
	if (!file) throw new Error(`${entry.vault} has no local file`); // syncedSecrets only returns known ones
	return file(target);
}

/**
 * What the sync manages. `secrets` is the manifest's `app` group (`just secrets-pull`);
 * `all` adds the `tooling` group, which is the stack's tfvars (`just pull`). `infra`
 * secrets (the Tailscale key, the registry token) stay with Terraform and are never read
 * or written here.
 */
export function syncedSecrets(
	manifest: SecretsManifest,
	scope: "secrets" | "all" = "secrets",
): SecretEntry[] {
	return manifest.secrets.filter(
		(s) =>
			(s.group === "app" &&
				(s.delivery === "env" || (s.delivery === "file" && s.vault in FILES))) ||
			(scope === "all" && s.group === "tooling" && s.vault in FILES),
	);
}

/** Where a secret lives locally, for messages. */
export function localName(entry: SecretEntry, target: Target): string {
	return isFile(entry) ? localFile(entry, target) : `${entry.env} in ${envFile(target)}`;
}

/** A secret's value by its Key Vault name. Missing (or empty) means not set. */
export type Values = ReadonlyMap<string, string>;

/** Reads the managed secrets out of an env file's text and each file secret's text. */
export function localValues(
	entries: readonly SecretEntry[],
	envText: string | undefined,
	files: ReadonlyMap<string, string | undefined>,
): Map<string, string> {
	const env = envText === undefined ? {} : parseEnv(envText);
	const out = new Map<string, string>();
	for (const entry of entries) {
		const value = isFile(entry) ? files.get(entry.vault) : entry.env ? env[entry.env] : undefined;
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
export function describe(row: Row, direction: "push" | "pull", target: Target): string {
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
export function newEnvFile(target: Target): string {
	return [
		`# ${envFile(target)}: written by just secrets-pull ${target}. Add the other settings from .env.example.`,
		...(target === "prod" ? ["PIXEL_ENV=prod"] : ["PIXEL_ENV=dev"]),
		"",
	].join("\n");
}

/** `PIXEL_ENV` as an env file sets it, for `assertPixelEnv`. */
export function pixelEnvOf(envText: string | undefined): "local" | "dev" | "prod" {
	const value = envText === undefined ? undefined : parseEnv(envText).PIXEL_ENV;
	return value === "dev" || value === "prod" ? value : "local";
}

/**
 * The other env files whose Discord token must never reach this target's vault: the
 * Pixel Dev and Mini bots must never run as prod, and prod's token never belongs on dev.
 */
export function otherEnvFiles(target: Target): string[] {
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
		entry.delivery === "file"
			? "text/yaml"
			: entry.delivery === "tool"
				? "text/x-hcl"
				: "text/plain",
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

/** Top-level `name =` keys in a tfvars file. */
export function tfvarsKeys(text: string): string[] {
	return [...text.matchAll(/^([a-z_][a-z0-9_]*)\s*=/gm)].map(([, key]) => key ?? "");
}

/** Variables a stack declares, and which of them are sensitive (secret inputs). */
export function stackVariables(variablesTf: string): { all: Set<string>; sensitive: Set<string> } {
	const all = new Set<string>();
	const sensitive = new Set<string>();
	for (const [, name, body] of variablesTf.matchAll(/^variable "([a-z0-9_]+)" \{([\s\S]*?)^\}/gm)) {
		if (!name) continue;
		all.add(name);
		if (/^\s*sensitive\s*=\s*true/m.test(body ?? "")) sensitive.add(name);
	}
	return { all, sensitive };
}

/** `name = "value"` for a top-level string setting, if the file sets one. */
function tfvarsString(text: string, key: string): string | undefined {
	return text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}

/**
 * A tfvars file as it may be shown: the value of every sensitive variable is hidden,
 * commented-out ones included, so a diff never prints a secret even when the file
 * (wrongly) holds one.
 */
export function redactTfvars(text: string, sensitive: ReadonlySet<string>): string {
	return text.replace(
		/^(\s*#?\s*)([a-z_][a-z0-9_]*)(\s*=\s*)(.*)$/gm,
		(line, lead: string, key: string, eq: string) =>
			sensitive.has(key) ? `${lead}${key}${eq}(secret, hidden)` : line,
	);
}

/**
 * What's wrong with a tfvars file before it's shared. It must belong to this env (its
 * vault and storage account), only set variables the stack declares, and hold no secret:
 * sensitive inputs go in `secrets.auto.tfvars`, which never leaves the laptop. Problems
 * name keys, never values.
 */
export function tfvarsProblems(
	text: string,
	target: Target,
	variables: { all: ReadonlySet<string>; sensitive: ReadonlySet<string> },
): string[] {
	const problems: string[] = [];
	const file = tfvarsFile(target);
	for (const key of tfvarsKeys(text)) {
		if (variables.sensitive.has(key)) {
			problems.push(
				`${file} sets ${key}, which is a secret. Move it to ${secretTfvarsFile(target)}.`,
			);
		} else if (!variables.all.has(key)) {
			problems.push(`${file} sets ${key}, which infra/envs/${target} doesn't declare.`);
		}
	}
	const vault = tfvarsString(text, "key_vault_name");
	if (vault !== undefined && vault !== VAULTS[target].vault) {
		problems.push(
			`${file} says key_vault_name = "${vault}", but ${target} is ${VAULTS[target].vault}.`,
		);
	}
	const account = tfvarsString(text, "data_storage_account_name");
	if (account !== undefined && account !== ENVS[target].storageAccount) {
		problems.push(
			`${file} says data_storage_account_name = "${account}", but ${target} is ${ENVS[target].storageAccount}.`,
		);
	}
	return problems;
}

/**
 * What Pixel needs before it uses a pushed share file. `reload`: `/admin` → Reload the
 * access lists, or a restart. `restart`: it reads the file only when it starts, and its
 * next change writes what it holds in memory back over the file. `none`: it reads the
 * file each time it uses it.
 */
export type Pickup = "reload" | "restart" | "none";

/**
 * A file on the env's share that `just pull` mirrors and `just push` sends back when
 * you've edited the mirror. `check` reads the text the way Pixel does and says what's
 * wrong with it (members.yaml is checked with admins.yaml instead). Never mirrored:
 * `data/openr-session.json` (the door session's cookies) and `data/logs/`.
 */
export type ShareFile = {
	path: string;
	mirror: string;
	pickup: Pickup;
	check?: (text: string, label: string) => string | undefined;
};

/**
 * Loads a data file's text through Pixel's own store in a scratch folder, and returns
 * its problem with the scratch path replaced by `label`. `open` returns the store's
 * problem; a store without one counts an error it logs as one.
 */
function storeCheck(
	name: string,
	open: (file: string, logger: Logger) => string | undefined,
): NonNullable<ShareFile["check"]> {
	return (text, label) => {
		const dir = mkdtempSync(join(tmpdir(), "pixel-share-"));
		const file = join(dir, name);
		let logged: string | undefined;
		const logger: Logger = {
			...silentLogger,
			error: () => {
				logged ??= `${label} is invalid`;
			},
			child: () => logger,
		};
		try {
			writeFileSync(file, text, { mode: 0o600 });
			return (open(file, logger) ?? logged)?.replaceAll(file, label);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

function devicesCheck(text: string, label: string): string | undefined {
	try {
		validateDevices(text, HOME_KINDS);
		return undefined;
	} catch (error) {
		if (!(error instanceof HomeDevicesError)) throw error;
		return `${label}: ${error.message.replace(/^.*?devices\.yaml: /, "")}`;
	}
}

/** Pixel's `data/` files, by name: how each is checked and picked up. */
const DATA_FILES: readonly Omit<ShareFile, "mirror">[] = [
	{
		path: "schedules.yaml",
		pickup: "restart",
		check: storeCheck(
			"schedules.yaml",
			(file, logger) => new ScheduleStore({ file, logger }).problem,
		),
	},
	{
		path: "parking-spots.yaml",
		pickup: "restart",
		check: storeCheck(
			"parking-spots.yaml",
			(file, logger) => new ParkingSpotStore({ file, logger }).problem,
		),
	},
	{
		path: "parking-windows.yaml",
		pickup: "restart",
		check: storeCheck(
			"parking-windows.yaml",
			(file, logger) => new ParkingWindowStore({ file, logger }).problem,
		),
	},
	{
		path: "parking-bookings.yaml",
		pickup: "restart",
		check: storeCheck(
			"parking-bookings.yaml",
			(file, logger) => new ParkingBookingStore({ file, logger }).problem,
		),
	},
	{
		path: "announcement-routes.yaml",
		pickup: "restart",
		check: storeCheck("announcement-routes.yaml", (file, logger) => {
			new AnnouncementRouteStore({ file, logger });
			return undefined;
		}),
	},
	{ path: "closing-time.md", pickup: "none" },
];

export function shareFiles(target: Target): ShareFile[] {
	const files = localFiles(target);
	return [
		{ path: "members.yaml", mirror: files.membersFile, pickup: "reload" },
		{
			path: "home-assistant/devices.yaml",
			mirror: join(files.homeAssistantDir, "devices.yaml"),
			pickup: "reload",
			check: devicesCheck,
		},
		...DATA_FILES.map((file) => ({
			...file,
			path: `data/${file.path}`,
			mirror: join(files.dataDir, file.path),
		})),
	];
}

/**
 * What each share file was when it was last pulled, by share path: a SHA-256 of its
 * text, or null when it wasn't on the share. Kept in `pulledFile` so a push can tell
 * your edits from changes Pixel made since.
 */
export type Pulled = Record<string, string | null>;

export function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** The pull record. A missing or unreadable one is empty: nothing counts as pulled. */
export function parsePulled(text: string | undefined): Pulled {
	if (text === undefined) return {};
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return {};
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	return Object.fromEntries(
		Object.entries(data).filter(([, v]) => v === null || typeof v === "string"),
	) as Pulled;
}

/** The record of a pull: the state of every share file just read. */
export function pulledRecord(remotes: ReadonlyMap<string, string | undefined>): Pulled {
	return Object.fromEntries(
		[...remotes].map(([path, text]) => [path, text === undefined ? null : digest(text)]),
	);
}

/**
 * Whether the mirror changed since it was pulled (`base`). With no record of the pull,
 * any difference from the share counts, as it might be an edit.
 */
function edited(
	local: string | undefined,
	remote: string | undefined,
	base: string | null | undefined,
): boolean {
	if (local === undefined) return false;
	if (base === undefined) return local !== remote;
	return base === null || digest(local) !== base;
}

/**
 * What a pull does with one share file. `write` refreshes a mirror you haven't edited,
 * `remove` drops one whose file left the share, `ask` is your edit against a different
 * file on the share, and `keep` your new file the share doesn't have.
 */
export type PullStep = "same" | "absent" | "write" | "remove" | "ask" | "keep";

export function pullStep(
	local: string | undefined,
	remote: string | undefined,
	base: string | null | undefined,
): PullStep {
	if (local === remote) return remote === undefined ? "absent" : "same";
	if (!edited(local, remote, base)) return remote === undefined ? "remove" : "write";
	return remote === undefined ? "keep" : "ask";
}

export function describePull(file: ShareFile, step: PullStep): string {
	switch (step) {
		case "same":
			return `  = ${file.path} → ${file.mirror}`;
		case "absent":
			return `  - ${file.path}: not on the share`;
		case "write":
			return `  ~ ${file.path} → ${file.mirror}`;
		case "remove":
			return `  - ${file.path}: gone from the share, so ${file.mirror} is removed`;
		case "ask":
			return `  ! ${file.path}: you edited ${file.mirror}, and the share's differs`;
		case "keep":
			return `  + ${file.path}: only in ${file.mirror} (just push sends it)`;
	}
}

/**
 * What a push does with one share file. `create` and `change` send your edit;
 * `unedited` leaves a mirror you haven't touched since the pull (even if the share has
 * moved on); `unknown` is a mirror that differs with no record of its pull; `moved` is
 * your edit to a file that changed on the share since you pulled it.
 */
export type PushStep = "missing" | "same" | "unedited" | "unknown" | "moved" | "create" | "change";

export function pushStep(
	local: string | undefined,
	remote: string | undefined,
	base: string | null | undefined,
): PushStep {
	if (local === undefined) return "missing";
	if (local === remote) return "same";
	if (base === undefined) return "unknown";
	if (!edited(local, remote, base)) return "unedited";
	if ((remote === undefined ? null : digest(remote)) !== base) return "moved";
	return remote === undefined ? "create" : "change";
}

/** Whether a push uploads the mirror. */
export function pushes(step: PushStep): boolean {
	return step === "create" || step === "change";
}

/** One line for a share file in a push: local mirror → the share. Never its contents. */
export function describePush(file: ShareFile, step: PushStep, target: Target): string {
	switch (step) {
		case "missing":
			return `  - ${file.path}: no ${file.mirror} (left as it is)`;
		case "same":
			return `  = ${file.path}: the same`;
		case "unedited":
			return `  = ${file.path}: not edited since the pull (left as it is)`;
		case "unknown":
			return `  ? ${file.path}: ${file.mirror} differs, but there's no record of pulling it (left as it is: run just pull ${target} first)`;
		case "moved":
			return `  ! ${file.path}: changed on the share since you pulled it`;
		case "create":
			return `  + ${file.path}: new on the share (from ${file.mirror})`;
		case "change":
			return `  ~ ${file.path}: changes (from ${file.mirror})`;
	}
}

/** Whether `az storage file download` failed because the file isn't on the share. */
export function isShareNotFound(stderr: string): boolean {
	return /ResourceNotFound|ParentNotFound|specified resource does not exist/i.test(stderr);
}
