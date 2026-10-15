/**
 * Syncs an env's app secrets between Azure Key Vault and this laptop.
 * Usage: just secrets-pull dev|prod  or  just secrets-push dev|prod
 *
 * Which secrets: the `app` group in infra/secrets.manifest.yaml (ADR 0015). Env secrets
 * live in `.env.dev` / `.env.prod` under their environment variable; `admins-yaml` in
 * `config/admins.<env>.yaml`. `infra` secrets stay with Terraform and are never touched.
 *
 * pull: reads every managed secret from the env's vault and writes it locally, so you
 *       can edit it. If a local value differs (an edit you haven't pushed), it shows
 *       which and asks before overwriting.
 * push: reads the vault (the live values), compares it with the local ones, shows what
 *       would change and asks. Before writing it checks the vault hasn't changed since,
 *       and after writing it reads every value back. A push never deletes a secret.
 *       Then it offers to restart the Container App, which reads secrets at startup.
 *
 * Values are never printed: a secret is shown by name and length. `admins.yaml` isn't a
 * token, so its diff is shown, and it is checked against the env's `members.yaml` the
 * way Pixel checks it at startup. Needs `az login` with Key Vault Secrets Officer on
 * the vault (and Storage File Data Privileged Reader on the share for `admins-yaml`).
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
import { azDownloadArgs, REMOTES } from "./ha-devices-lib.ts";
import { assertRegisterEnv, type RegisterTarget } from "./register-env.ts";
import { loadSecretsManifest, type SecretEntry, SecretsManifestError } from "./secrets-manifest.ts";
import {
	adminsFile,
	azSetArgs,
	azShowArgs,
	compare,
	describe,
	envFile,
	isNotFound,
	localValues,
	newEnvFile,
	otherEnvFiles,
	parseShown,
	pixelEnvOf,
	type Row,
	reusedDiscordToken,
	setEnvValues,
	syncedSecrets,
	toPull,
	toPush,
	VAULTS,
} from "./secrets-sync-lib.ts";

const run = promisify(execFile);

class Stop extends Error {
	override name = "Stop";
}

const say = (text = "") => process.stdout.write(`${text}\n`);

function parseArgs(argv: readonly string[]): { target: RegisterTarget; mode: "pull" | "push" } {
	const [target, mode] = argv;
	if (
		(target === "dev" || target === "prod") &&
		(mode === "pull" || mode === "push") &&
		argv.length === 2
	) {
		return { target, mode };
	}
	throw new Stop("Usage: just secrets-pull dev|prod  or  just secrets-push dev|prod");
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

/** Every managed secret the vault has. A missing one is simply not in the map. */
async function readVault(
	target: RegisterTarget,
	entries: readonly SecretEntry[],
): Promise<Map<string, string>> {
	const vault = VAULTS[target];
	const out = new Map<string, string>();
	await Promise.all(
		entries.map(async (entry) => {
			try {
				const { stdout } = await run("az", azShowArgs(vault, entry.vault), { maxBuffer: 1 << 20 });
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

/** Shows how admins.yaml would change. It's IDs, not a token, so a diff is fine. */
async function showAdminsDiff(
	from: string | undefined,
	to: string,
	labels: [string, string],
): Promise<void> {
	const a = join(work, "from.yaml");
	const b = join(work, "to.yaml");
	writeFileSync(a, from ?? "", { mode: 0o600 });
	writeFileSync(b, to, { mode: 0o600 });
	try {
		await run("diff", ["-u", "--label", labels[0], "--label", labels[1], a, b]);
	} catch (error) {
		// diff exits 1 when the files differ, which is the point.
		say((error as { stdout?: string }).stdout ?? "");
	}
}

/** Checks admins.yaml against the env's members.yaml on the share, as Pixel does at startup. */
async function checkAdmins(target: RegisterTarget, text: string): Promise<void> {
	const file = adminsFile(target);
	const members = join(work, "members.yaml");
	try {
		await run("az", azDownloadArgs({ ...REMOTES[target], path: "members.yaml" }, members));
	} catch (error) {
		throw new Stop(
			`Couldn't read members.yaml from ${REMOTES[target].account} to check ${file}: ${azFailure(error)}`,
		);
	}
	const paths = { adminsFile: file, membersFile: `members.yaml on ${target}` };
	buildAccessConfig(
		parseAdmins(text, paths.adminsFile),
		parseMembers(readFileSync(members, "utf8"), paths.membersFile),
		paths,
	);
}

function summary(rows: readonly Row[], mode: "pull" | "push", target: RegisterTarget): void {
	for (const row of rows) say(describe(row, mode, target));
	say();
}

async function pull(target: RegisterTarget, entries: readonly SecretEntry[]): Promise<void> {
	const vault = VAULTS[target];
	const envPath = envFile(target);
	const envText = readText(envPath);
	const adminsText = readText(adminsFile(target));
	assertRegisterEnv(target, envText === undefined ? target : pixelEnvOf(envText));

	say(`Reading ${entries.length} secrets from ${vault.vault} (${target})…`);
	const remote = await readVault(target, entries);
	const rows = compare(entries, localValues(entries, envText, adminsText), remote);
	summary(rows, "pull", target);

	const changes = toPull(rows);
	if (changes.length === 0) {
		say("Nothing to pull: local already matches Key Vault.");
		return;
	}
	const overwrites = changes.filter((row) => row.status === "changed");
	const admins = changes.find((row) => row.entry.delivery === "file");
	if (admins?.remote !== undefined) {
		await showAdminsDiff(admins.local, admins.remote, [
			adminsFile(target),
			`${vault.vault}/admins-yaml`,
		]);
	}
	if (overwrites.length > 0) {
		const ok = await confirm({
			message: `Overwrite ${overwrites.length} local value(s) with ${target}'s? Local edits you haven't pushed are lost.`,
			default: false,
		});
		if (!ok) throw new Stop("Stopped. Nothing was written.");
	}

	const env = new Map<string, string>();
	for (const row of changes) {
		if (row.remote === undefined) continue;
		if (row.entry.delivery === "file") writePrivate(adminsFile(target), row.remote);
		else if (row.entry.env) env.set(row.entry.env, row.remote);
	}
	if (env.size > 0) writePrivate(envPath, setEnvValues(envText ?? newEnvFile(target), env));
	say(
		`Pulled ${changes.length} secret(s) into ${envPath}${admins ? ` and ${adminsFile(target)}` : ""}.`,
	);
	say(`Edit them there, then run: just secrets-push ${target}`);
}

async function push(target: RegisterTarget, entries: readonly SecretEntry[]): Promise<void> {
	const vault = VAULTS[target];
	const envPath = envFile(target);
	const envText = readText(envPath);
	if (envText === undefined)
		throw new Stop(`Missing ${envPath}. Run just secrets-pull ${target} first.`);
	assertRegisterEnv(target, pixelEnvOf(envText));
	const local = localValues(entries, envText, readText(adminsFile(target)));

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
	const admins = changes.find((row) => row.entry.delivery === "file");
	if (admins?.local !== undefined) {
		await showAdminsDiff(admins.remote, admins.local, [
			`${vault.vault}/admins-yaml`,
			adminsFile(target),
		]);
		await checkAdmins(target, admins.local);
		say(`${adminsFile(target)} is valid with ${target}'s members.yaml.`);
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
	say(
		"If this env's terraform.tfvars has write_secrets = true, update it too, or the next apply that bumps secrets_version puts the old values back.",
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
	if (result.status !== 0)
		throw new Stop(`just restart ${target} failed. Run it again, or restart from the portal.`);
}

async function main(): Promise<void> {
	const { target, mode } = parseArgs(process.argv.slice(2));
	const entries = syncedSecrets(loadSecretsManifest());
	if (mode === "pull") await pull(target, entries);
	else await push(target, entries);
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
	} else if (error instanceof Error && error.message.startsWith("Refusing")) {
		// assertRegisterEnv: the env file is for the other bot.
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
