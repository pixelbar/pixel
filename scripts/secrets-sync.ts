/**
 * Syncs an env's config and secrets between Azure and this laptop.
 * Usage: just pull dev|prod, just push dev|prod (everything below), or
 *        just secrets-pull dev|prod, just secrets-push dev|prod (app secrets only).
 *
 * What, from infra/secrets.manifest.yaml (ADRs 0015 and 0016):
 *   - `app` secrets: env secrets in `.env.<env>` under their environment variable, and
 *     `admins-yaml` in `config/admins.<env>.yaml`.
 *   - `tooling` (just pull / push only): the stack's settings, `terraform-tfvars`, in
 *     `infra/envs/<env>/terraform.tfvars`. Secret Terraform inputs never go in it: they
 *     belong in `secrets.auto.tfvars`, which stays on the laptop.
 *   - just pull also mirrors `members.yaml`, `devices.yaml` and `announcement-routes.yaml`
 *     from the env's file share, read-only: Pixel and `just ha-devices` write those.
 * `infra` secrets stay with Terraform and are never touched.
 *
 * pull: reads every managed secret from the env's vault and writes it locally, so you
 *       can edit it. If a local value differs (an edit you haven't pushed), it shows
 *       which and asks before overwriting.
 * push: reads the vault (the live values), compares it with the local ones, shows what
 *       would change and asks. Before writing it checks the vault hasn't changed since,
 *       and after writing it reads every value back. A push never deletes a secret.
 *       Then it offers to restart the Container App if an app secret changed (it reads
 *       secrets at startup), and says to plan and apply if the tfvars changed.
 *
 * Secret values are never printed: a secret is shown by name and length. File secrets
 * (admins.yaml, terraform.tfvars) hold no tokens, so their diffs are shown. Needs `az
 * login` with Key Vault Secrets Officer on the vault, and the storage access `just
 * ha-devices` uses (admins.yaml is checked against the share's members.yaml).
 */
import { execFile, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { confirm, input } from "@inquirer/prompts";
import {
	AccessConfigError,
	buildAccessConfig,
	parseAdmins,
	parseMembers,
} from "../src/services/access-config.ts";
import { assertPixelEnv, ENVS, EnvError, type Target } from "./envs.ts";
import { loadSecretsManifest, type SecretEntry, SecretsManifestError } from "./secrets-manifest.ts";
import {
	azSetArgs,
	azShowArgs,
	compare,
	describe,
	envFile,
	isFile,
	isNotFound,
	isShareNotFound,
	localFile,
	localValues,
	newEnvFile,
	otherEnvFiles,
	parseShown,
	pixelEnvOf,
	type Row,
	redactTfvars,
	reusedDiscordToken,
	setEnvValues,
	shareFiles,
	stackVariables,
	syncedSecrets,
	tfvarsProblems,
	toPull,
	toPush,
	VAULTS,
} from "./secrets-sync-lib.ts";
import { azDownloadArgs, shareRemote } from "./share.ts";

const run = promisify(execFile);

class Stop extends Error {
	override name = "Stop";
}

const say = (text = "") => process.stdout.write(`${text}\n`);

type Mode = "pull" | "push";
type Scope = "secrets" | "all";

function parseArgs(argv: readonly string[]): { target: Target; mode: Mode; scope: Scope } {
	const [target, mode, flag] = argv;
	if (
		(target === "dev" || target === "prod") &&
		(mode === "pull" || mode === "push") &&
		(argv.length === 2 || (argv.length === 3 && flag === "--all"))
	) {
		return { target, mode, scope: flag === "--all" ? "all" : "secrets" };
	}
	throw new Stop("Usage: just pull|push dev|prod  or  just secrets-pull|secrets-push dev|prod");
}

const work = mkdtempSync(join(tmpdir(), "pixel-secrets-"));

function readText(file: string): string | undefined {
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Writes a local file readable only by you, atomically. */
function writePrivate(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
	renameSync(`${file}.tmp`, file);
}

function azFailure(error: unknown): string {
	const stderr = (error as { stderr?: string }).stderr?.trim();
	return stderr || (error as Error).message;
}

/** The local text of each file secret, by vault name. */
function localFiles(
	entries: readonly SecretEntry[],
	target: Target,
): Map<string, string | undefined> {
	return new Map(
		entries.filter(isFile).map((e) => [e.vault, readText(localFile(e, target))] as const),
	);
}

/** Every managed secret the vault has. A missing one is simply not in the map. */
async function readVault(
	target: Target,
	entries: readonly SecretEntry[],
): Promise<Map<string, string>> {
	const vault = VAULTS[target];
	const out = new Map<string, string>();
	await Promise.all(
		entries.map(async (entry) => {
			try {
				const { stdout } = await run("az", azShowArgs(vault, entry.vault), {
					maxBuffer: 1 << 20,
				});
				out.set(entry.vault, parseShown(stdout));
			} catch (error) {
				const why = azFailure(error);
				if (isNotFound(why)) return;
				// az's own message names the vault and the secret, never the value.
				throw new Stop(
					`Couldn't read ${entry.vault} from ${vault.vault}: ${why}\nIs \`az login\` done?`,
				);
			}
		}),
	);
	return out;
}

/** Shows how a file secret would change. They hold no tokens, so a diff is fine. */
async function showDiff(
	from: string | undefined,
	to: string,
	labels: [string, string],
): Promise<void> {
	const a = join(work, "from");
	const b = join(work, "to");
	writeFileSync(a, from ?? "", { mode: 0o600 });
	writeFileSync(b, to, { mode: 0o600 });
	try {
		await run("diff", ["-u", "--label", labels[0], "--label", labels[1], a, b]);
	} catch (error) {
		// diff exits 1 when the files differ, which is the point.
		say((error as { stdout?: string }).stdout ?? "");
	}
}

/** Downloads a file from the env's share. Undefined when it isn't there. */
async function download(target: Target, path: string): Promise<string | undefined> {
	// Downloads run in parallel, so each gets its own file.
	const dest = join(work, `download-${path.replaceAll("/", "_")}`);
	try {
		await run("az", azDownloadArgs(shareRemote(target, path), dest));
	} catch (error) {
		const why = azFailure(error);
		if (isShareNotFound(why)) return undefined;
		throw new Stop(`Couldn't read ${path} from ${ENVS[target].storageAccount}: ${why}`);
	}
	return readFileSync(dest, "utf8");
}

/** Checks admins.yaml against the env's members.yaml on the share, as Pixel does at startup. */
async function checkAdmins(target: Target, entry: SecretEntry, text: string): Promise<void> {
	const members = await download(target, "members.yaml");
	if (members === undefined)
		throw new Stop(`${target}'s share has no members.yaml to check against.`);
	const paths = { adminsFile: localFile(entry, target), membersFile: `members.yaml on ${target}` };
	buildAccessConfig(
		parseAdmins(text, paths.adminsFile),
		parseMembers(members, paths.membersFile),
		paths,
	);
}

function variablesOf(target: Target) {
	return stackVariables(readFileSync(`infra/envs/${target}/variables.tf`, "utf8"));
}

/** Refuses a tfvars file that's for the other env, sets an unknown variable or holds a secret. */
function checkTfvars(target: Target, text: string): void {
	const problems = tfvarsProblems(text, target, variablesOf(target));
	if (problems.length > 0) throw new Stop(`${problems.join("\n")}\nNothing was pushed.`);
}

/** A file secret's text as it may be shown in a diff: never a tfvars secret value. */
function shown(entry: SecretEntry, target: Target, text: string | undefined): string | undefined {
	if (text === undefined || entry.vault !== "terraform-tfvars") return text;
	return redactTfvars(text, variablesOf(target).sensitive);
}

function summary(rows: readonly Row[], mode: Mode, target: Target): void {
	for (const row of rows) say(describe(row, mode, target));
	say();
}

/** Mirrors the share's config files, read-only, asking before replacing one that differs. */
async function pullShare(target: Target): Promise<void> {
	say(`Reading config files from ${ENVS[target].storageAccount} (${target})…`);
	const files = await Promise.all(
		shareFiles(target).map(async (file) => ({
			...file,
			remote: await download(target, file.path),
		})),
	);
	const differs = files.filter((f) => {
		const local = readText(f.mirror);
		return f.remote !== undefined && local !== undefined && local !== f.remote;
	});
	for (const f of files) {
		if (f.remote === undefined) say(`  - ${f.path}: not on the share`);
		else say(`  ${differs.includes(f) ? "~" : "="} ${f.path} → ${f.mirror}`);
	}
	say();
	if (differs.length > 0) {
		for (const f of differs)
			await showDiff(readText(f.mirror), f.remote as string, [f.mirror, f.path]);
		const ok = await confirm({
			message: `Replace ${differs.length} local mirror(s) with ${target}'s? They're read-only copies: Pixel and just ha-devices change the real ones.`,
			default: true,
		});
		if (!ok) {
			say("Left the mirrors as they are.");
			return;
		}
	}
	for (const f of files) if (f.remote !== undefined) writePrivate(f.mirror, f.remote);
}

async function pull(target: Target, entries: readonly SecretEntry[], scope: Scope): Promise<void> {
	const vault = VAULTS[target];
	const envPath = envFile(target);
	const envText = readText(envPath);
	assertPixelEnv(target, envText === undefined ? target : pixelEnvOf(envText));

	say(`Reading ${entries.length} secrets from ${vault.vault} (${target})…`);
	const remote = await readVault(target, entries);
	const rows = compare(entries, localValues(entries, envText, localFiles(entries, target)), remote);
	summary(rows, "pull", target);

	const changes = toPull(rows);
	if (changes.length === 0) {
		say("Nothing to pull from Key Vault: local already matches.");
	} else {
		for (const row of changes) {
			if (isFile(row.entry) && row.remote !== undefined) {
				await showDiff(
					shown(row.entry, target, row.local),
					shown(row.entry, target, row.remote) ?? "",
					[localFile(row.entry, target), `${vault.vault}/${row.entry.vault}`],
				);
			}
		}
		const overwrites = changes.filter((row) => row.status === "changed");
		if (overwrites.length > 0) {
			const ok = await confirm({
				message: `Overwrite ${overwrites.length} local value(s) with ${target}'s? Local edits you haven't pushed are lost.`,
				default: false,
			});
			if (!ok) throw new Stop("Stopped. Nothing was written.");
		}
		const env = new Map<string, string>();
		const written = new Set<string>();
		for (const row of changes) {
			if (row.remote === undefined) continue;
			if (isFile(row.entry)) {
				writePrivate(localFile(row.entry, target), row.remote);
				written.add(localFile(row.entry, target));
			} else if (row.entry.env) env.set(row.entry.env, row.remote);
		}
		if (env.size > 0) {
			writePrivate(envPath, setEnvValues(envText ?? newEnvFile(target), env));
			written.add(envPath);
		}
		say(`Pulled ${changes.length} secret(s) into ${[...written].join(", ")}.`);
	}

	if (scope === "all") await pullShare(target);
	say();
	say(`Edit what you need, then run: just ${scope === "all" ? "push" : "secrets-push"} ${target}`);
	if (scope === "all") say(`For Terraform: just tf-plan ${target}`);
}

async function push(target: Target, entries: readonly SecretEntry[], scope: Scope): Promise<void> {
	const vault = VAULTS[target];
	const envPath = envFile(target);
	const envText = readText(envPath);
	if (envText === undefined) {
		throw new Stop(
			`Missing ${envPath}. Run just ${scope === "all" ? "pull" : "secrets-pull"} ${target} first.`,
		);
	}
	assertPixelEnv(target, pixelEnvOf(envText));
	const local = localValues(entries, envText, localFiles(entries, target));

	const others = otherEnvFiles(target).flatMap((file) => {
		const text = readText(file);
		return text === undefined ? [] : [{ file, text }];
	});
	const reused = reusedDiscordToken(local.get("discord-token"), others);
	if (reused) {
		throw new Stop(
			`${envPath} has the same DISCORD_TOKEN as ${reused}: that's another bot. Never push it to ${target}. Nothing was pushed.`,
		);
	}

	say(`Reading ${entries.length} secrets from ${vault.vault} (${target})…`);
	const live = await readVault(target, entries);
	const rows = compare(entries, local, live);
	summary(rows, "push", target);

	const changes = toPush(rows);
	if (changes.length === 0) {
		say(`Nothing to push: ${vault.vault} already matches.`);
		return;
	}
	for (const row of changes) {
		if (!isFile(row.entry) || row.local === undefined) continue;
		// Check before showing anything: a tfvars that holds a secret stops here.
		if (row.entry.vault === "terraform-tfvars") checkTfvars(target, row.local);
		await showDiff(
			shown(row.entry, target, row.remote),
			shown(row.entry, target, row.local) ?? "",
			[`${vault.vault}/${row.entry.vault}`, localFile(row.entry, target)],
		);
		if (row.entry.vault === "admins-yaml") {
			await checkAdmins(target, row.entry, row.local);
			say(`${localFile(row.entry, target)} is valid with ${target}'s members.yaml.`);
		}
	}

	const ok = await confirm({
		message: `Push ${changes.length} secret(s) to ${target.toUpperCase()} (${vault.vault})?`,
		default: false,
	});
	if (!ok) throw new Stop("Stopped. Nothing was pushed.");
	if (target === "prod") {
		const typed = await input({ message: "This changes the production bot. Type prod to go on" });
		if (typed.trim() !== "prod") throw new Stop("Stopped. Nothing was pushed.");
	}

	// Someone else may have changed the vault while you were reading the diff.
	const changing = changes.map((row) => row.entry);
	const again = await readVault(target, changing);
	for (const entry of changing) {
		if (again.get(entry.vault) !== live.get(entry.vault)) {
			throw new Stop(
				`${entry.vault} changed in ${vault.vault} since it was read. Run it again. Nothing was pushed.`,
			);
		}
	}

	const done: string[] = [];
	for (const row of changes) {
		const source = join(work, "value");
		writeFileSync(source, row.local ?? "", { mode: 0o600 });
		try {
			await run("az", azSetArgs(vault, row.entry, source));
		} catch (error) {
			const pushed =
				done.length > 0 ? ` Already pushed: ${done.join(", ")}.` : " Nothing was pushed.";
			throw new Stop(`Couldn't set ${row.entry.vault}: ${azFailure(error)}.${pushed}`);
		} finally {
			rmSync(source, { force: true });
		}
		done.push(row.entry.vault);
	}
	const back = await readVault(target, changing);
	const wrong = changing.filter((entry) => back.get(entry.vault) !== local.get(entry.vault));
	if (wrong.length > 0) {
		throw new Stop(
			`Pushed, but ${wrong.map((e) => e.vault).join(", ")} don't read back the same. Check by hand.`,
		);
	}
	say(`Pushed ${done.join(", ")} to ${vault.vault}.`);

	if (changing.some((e) => e.group === "tooling")) {
		say(
			`The shared tfvars changed. Nothing is applied yet: run just tf-plan ${target}, then apply.`,
		);
	}
	if (!changing.some((e) => e.group === "app")) return;
	say(
		"If this env's tfvars set write_secrets = true, update secrets.auto.tfvars too, or the next apply that bumps secrets_version puts the old values back.",
	);
	say();
	say(`${vault.app} reads secrets when it starts, so it keeps the old values until it restarts.`);
	const restart = await confirm({
		message: `Restart ${vault.app} now (just restart ${target})?`,
		default: false,
	});
	if (!restart) {
		say(`Restart it when you're ready: just restart ${target}`);
		return;
	}
	const result = spawnSync("just", ["restart", target], { stdio: "inherit" });
	if (result.status !== 0) {
		throw new Stop(`just restart ${target} failed. Run it again, or restart from the portal.`);
	}
}

async function main(): Promise<void> {
	const { target, mode, scope } = parseArgs(process.argv.slice(2));
	const entries = syncedSecrets(loadSecretsManifest(), scope);
	if (mode === "pull") await pull(target, entries, scope);
	else await push(target, entries, scope);
}

try {
	await main();
} catch (error) {
	if (
		error instanceof Stop ||
		error instanceof SecretsManifestError ||
		error instanceof AccessConfigError
	) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	} else if (error instanceof Error && error.name === "ExitPromptError") {
		process.stderr.write("Cancelled. Nothing more was written.\n");
		process.exitCode = 130;
	} else if (error instanceof EnvError) {
		// assertPixelEnv: the env file is for the other bot.
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	} else {
		process.stderr.write(
			`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exitCode = 1;
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
