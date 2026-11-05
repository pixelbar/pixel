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
 *   - just pull also mirrors the env's file share: `members.yaml`, `devices.yaml` and
 *     Pixel's `data/` files (schedules, parking, announcement routes, closing time), and
 *     records what it pulled. just push sends back the ones you edited since (shown as a
 *     diff, checked the way Pixel reads them, and only if Pixel hasn't changed them
 *     since). The door session's cookies and the logs are never mirrored.
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
import * as Sentry from "@sentry/node";
import { scrubDeep } from "../src/observability/scrub.ts";
import {
	AccessConfigError,
	buildAccessConfig,
	parseAdmins,
	parseMembers,
} from "../src/services/access-config.ts";
import {
	type AuditEntry,
	adminsAudit,
	auditAttributes,
	describeAudit,
	membersAudit,
} from "./access-audit.ts";
import {
	assertPixelEnv,
	ENVS,
	EnvError,
	localFiles as envLocalFiles,
	type Target,
} from "./envs.ts";
import { loadSecretsManifest, type SecretEntry, SecretsManifestError } from "./secrets-manifest.ts";
import {
	azSetArgs,
	azShowArgs,
	compare,
	describe,
	describePull,
	describePush,
	digest,
	envFile,
	isFile,
	isNotFound,
	isShareNotFound,
	localFile,
	localValues,
	newEnvFile,
	otherEnvFiles,
	type Pulled,
	type PushStep,
	parsePulled,
	parseShown,
	pixelEnvOf,
	pulledRecord,
	pullStep,
	pushes,
	pushStep,
	type Row,
	redactTfvars,
	reusedDiscordToken,
	type ShareFile,
	setEnvValues,
	shareFiles,
	stackVariables,
	syncedSecrets,
	tfvarsProblems,
	toPull,
	toPush,
	VAULTS,
} from "./secrets-sync-lib.ts";
import { azDownloadArgs, azUploadArgs, shareRemote } from "./share.ts";

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

type Access = { text: string; label: string };

/** Checks admins.yaml against members.yaml, as Pixel does at startup. */
function checkAccess(admins: Access, members: Access): void {
	const paths = { adminsFile: admins.label, membersFile: members.label };
	buildAccessConfig(
		parseAdmins(admins.text, paths.adminsFile),
		parseMembers(members.text, paths.membersFile),
		paths,
	);
}

/** Who is logged in to Azure: the account that makes the change, so the one audited. */
async function azOperator(): Promise<string> {
	try {
		const { stdout } = await run("az", ["account", "show", "--query", "user.name", "-o", "tsv"]);
		const name = stdout.trim();
		if (name) return name;
	} catch {
		// Falls through to the same message.
	}
	throw new Stop("Couldn't tell who is logged in to Azure, for the audit. Is `az login` done?");
}

/**
 * Sends the audit to Sentry Logs as Pixel's own `access.changed` lines go there. A
 * failure to send never undoes the push: it says so, and the diff on your screen and
 * the file's history are the record.
 */
async function sendAudit(
	dsn: string,
	target: Target,
	operator: string,
	entries: readonly AuditEntry[],
): Promise<void> {
	Sentry.init({
		dsn,
		environment: target,
		defaultIntegrations: false,
		dataCollection: { userInfo: false },
		beforeSendLog: (log) => scrubDeep(log),
	});
	for (const entry of entries)
		Sentry.logger.info("access changed", auditAttributes(entry, target, operator));
	const sent = await Sentry.flush(10_000);
	await Sentry.close();
	say(
		sent
			? `Sent ${entries.length} access.changed record(s) to Sentry.`
			: `Couldn't reach Sentry: the access.changed record(s) above weren't sent.`,
	);
}

/** A share file `just push` sends back: your edit, and what the share has now. */
type SharePush = { file: ShareFile; local: string; remote: string | undefined; step: PushStep };

function readPulled(target: Target): Pulled {
	return parsePulled(readText(envLocalFiles(target).pulledFile));
}

function writePulled(target: Target, pulled: Pulled): void {
	writePrivate(envLocalFiles(target).pulledFile, `${JSON.stringify(pulled, null, "\t")}\n`);
}

/**
 * Compares each mirror with the share and with what was pulled, one line each, and
 * returns your edits. Stops if one of them changed on the share since the pull, or
 * isn't a file Pixel can read.
 */
async function planShare(target: Target): Promise<SharePush[]> {
	say(`Reading config files from ${ENVS[target].storageAccount} (${target})…`);
	const pulled = readPulled(target);
	const files = await Promise.all(
		shareFiles(target).map(async (file) => {
			const local = readText(file.mirror);
			const remote = await download(target, file.path);
			return { file, local, remote, step: pushStep(local, remote, pulled[file.path]) };
		}),
	);
	for (const f of files) say(describePush(f.file, f.step, target));
	say();
	const moved = files.filter((f) => f.step === "moved").map((f) => f.file.path);
	if (moved.length > 0) {
		throw new Stop(
			`${moved.join(", ")} changed on ${target}'s share since you pulled (Pixel, or someone else). Run just pull ${target}, which shows both and asks, redo your edit, and push again. Nothing was pushed.`,
		);
	}
	const edits = files.flatMap((f) =>
		f.local !== undefined && pushes(f.step)
			? [{ file: f.file, local: f.local, remote: f.remote, step: f.step }]
			: [],
	);
	const problems = edits.flatMap((f) => f.file.check?.(f.local, f.file.mirror) ?? []);
	if (problems.length > 0) {
		throw new Stop(`Pixel couldn't read this:\n${problems.join("\n")}\nNothing was pushed.`);
	}
	return edits;
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

/**
 * Mirrors the share's files, keeping the ones you've edited unless you say otherwise,
 * and records what the share had so a push can tell your edits from Pixel's changes.
 */
async function pullShare(target: Target): Promise<void> {
	say(`Reading config files from ${ENVS[target].storageAccount} (${target})…`);
	const pulled = readPulled(target);
	const files = await Promise.all(
		shareFiles(target).map(async (file) => {
			const local = readText(file.mirror);
			const remote = await download(target, file.path);
			return { file, local, remote, step: pullStep(local, remote, pulled[file.path]) };
		}),
	);
	for (const f of files) say(describePull(f.file, f.step));
	say();
	const asks = files.filter((f) => f.step === "ask");
	let replace = false;
	if (asks.length > 0) {
		for (const f of asks) await showDiff(f.local, f.remote as string, [f.file.mirror, f.file.path]);
		replace = await confirm({
			message: `Replace your edits to ${asks.length} file(s) with ${target}'s? Your edits are lost.`,
			default: false,
		});
		if (!replace)
			say(`Kept your edits. just push ${target} sends them over what's on the share now.`);
	}
	for (const f of files) {
		if (f.remote !== undefined && (f.step === "write" || (f.step === "ask" && replace)))
			writePrivate(f.file.mirror, f.remote);
		if (f.step === "remove") rmSync(f.file.mirror, { force: true });
	}
	// A file whose edit you kept keeps its old record, so a push still sees the share moved.
	const record = pulledRecord(new Map(files.map((f) => [f.file.path, f.remote])));
	if (!replace) {
		for (const f of asks) {
			if (pulled[f.file.path] === undefined) delete record[f.file.path];
			else record[f.file.path] = pulled[f.file.path] as string | null;
		}
	}
	writePulled(target, record);
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
	const share = scope === "all" ? await planShare(target) : [];
	if (changes.length === 0 && share.length === 0) {
		say(
			`Nothing to push: ${vault.vault}${scope === "all" ? " and the share" : ""} already match${scope === "all" ? "" : "es"}.`,
		);
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
	}
	for (const f of share) {
		await showDiff(f.remote, f.local, [
			`${ENVS[target].storageAccount}/${f.file.path}`,
			f.file.mirror,
		]);
	}
	if (share.some((f) => f.file.pickup === "restart")) {
		say(
			`Pixel reads ${share
				.filter((f) => f.file.pickup === "restart")
				.map((f) => f.file.path)
				.join(", ")} only when it starts, so pushing means restarting ${vault.app} right after.`,
		);
	}

	// Pixel refuses to start unless admins.yaml and members.yaml agree, so check the pair
	// as it will be after this push.
	const adminsRow = changes.find((row) => row.entry.vault === "admins-yaml");
	const membersPush = share.find((f) => f.file.path === "members.yaml");
	if (adminsRow?.local !== undefined || membersPush !== undefined) {
		const adminsEntry = rows.find((row) => row.entry.vault === "admins-yaml")?.entry;
		const adminsText = adminsRow?.local ?? live.get("admins-yaml");
		if (adminsEntry === undefined || adminsText === undefined) {
			throw new Stop(`${vault.vault} has no admins-yaml to check members.yaml against.`);
		}
		const admins = {
			text: adminsText,
			label: adminsRow ? localFile(adminsEntry, target) : `${vault.vault}/admins-yaml`,
		};
		const membersText = membersPush?.local ?? (await download(target, "members.yaml"));
		if (membersText === undefined)
			throw new Stop(`${target}'s share has no members.yaml to check against.`);
		const members = {
			text: membersText,
			label: membersPush ? membersPush.file.mirror : `members.yaml on ${target}`,
		};
		checkAccess(admins, members);
		say(`${admins.label} and ${members.label} are valid together.`);
	}

	// Pixel's admin commands log access.changed; a hand edit gets the same record, by
	// whoever is logged in to Azure, so Sentry Logs has the whole history.
	const adminsChanged =
		adminsRow?.local !== undefined ? adminsAudit(adminsRow.remote, adminsRow.local) : [];
	const membersChanged = membersPush ? membersAudit(membersPush.remote, membersPush.local) : [];
	const dsn = local.get("sentry-dsn") ?? live.get("sentry-dsn");
	const operator =
		adminsChanged.length + membersChanged.length > 0 ? await azOperator() : undefined;
	if (operator !== undefined) {
		say();
		say(`access.changed, as azure:${operator}:`);
		for (const entry of [...adminsChanged, ...membersChanged]) say(describeAudit(entry));
		if (dsn === undefined) say(`${target} has no SENTRY_DSN, so this won't be sent to Sentry.`);
		say();
	}

	const what = [
		...(changes.length > 0 ? [`${changes.length} secret(s)`] : []),
		...share.map((f) => f.file.path),
	].join(" and ");
	const ok = await confirm({
		message: `Push ${what} to ${target.toUpperCase()}?`,
		default: false,
	});
	if (!ok) throw new Stop("Stopped. Nothing was pushed.");
	if (target === "prod") {
		const typed = await input({ message: "This changes the production bot. Type prod to go on" });
		if (typed.trim() !== "prod") throw new Stop("Stopped. Nothing was pushed.");
	}

	// Someone else may have changed the vault, or Pixel members.yaml (an admin command),
	// while you were reading the diff.
	const changing = changes.map((row) => row.entry);
	const again = await readVault(target, changing);
	for (const entry of changing) {
		if (again.get(entry.vault) !== live.get(entry.vault)) {
			throw new Stop(
				`${entry.vault} changed in ${vault.vault} since it was read. Run it again. Nothing was pushed.`,
			);
		}
	}
	for (const f of share) {
		if ((await download(target, f.file.path)) !== f.remote) {
			throw new Stop(
				`${f.file.path} changed on ${target}'s share since it was read (an admin command?). Run just pull ${target}, redo your edit, and push again. Nothing was pushed.`,
			);
		}
	}

	// Whatever was written is audited, even if a later step fails.
	const audited: AuditEntry[] = [];
	try {
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
			if (row.entry.vault === "admins-yaml") audited.push(...adminsChanged);
		}
		const back = await readVault(target, changing);
		const wrong = changing.filter((entry) => back.get(entry.vault) !== local.get(entry.vault));
		if (wrong.length > 0) {
			throw new Stop(
				`Pushed, but ${wrong.map((e) => e.vault).join(", ")} don't read back the same. Check by hand.`,
			);
		}
		if (done.length > 0) say(`Pushed ${done.join(", ")} to ${vault.vault}.`);

		for (const f of share) {
			const source = join(work, "upload");
			writeFileSync(source, f.local, { mode: 0o600 });
			try {
				await run("az", azUploadArgs(shareRemote(target, f.file.path), source));
			} catch (error) {
				const pushed = done.length > 0 ? ` Already pushed: ${done.join(", ")}.` : "";
				throw new Stop(`Couldn't upload ${f.file.path}: ${azFailure(error)}.${pushed}`);
			} finally {
				rmSync(source, { force: true });
			}
			if (f.file.path === "members.yaml") audited.push(...membersChanged);
			if ((await download(target, f.file.path)) !== f.local) {
				throw new Stop(`Uploaded, but ${f.file.path} doesn't read back the same. Check by hand.`);
			}
			done.push(f.file.path);
			say(`Uploaded ${f.file.path} to ${ENVS[target].storageAccount}.`);
		}
		if (share.length > 0) {
			const pulled = readPulled(target);
			for (const f of share) pulled[f.file.path] = digest(f.local);
			writePulled(target, pulled);
		}
	} finally {
		if (operator !== undefined && dsn !== undefined && audited.length > 0)
			await sendAudit(dsn, target, operator, audited);
	}

	if (changing.some((e) => e.group === "tooling")) {
		say(
			`The shared tfvars changed. Nothing is applied yet: run just tf-plan ${target}, then apply.`,
		);
	}
	const appChanged = changing.some((e) => e.group === "app");
	const restartFiles = share.filter((f) => f.file.pickup === "restart").map((f) => f.file.path);
	const reloadFiles = share.filter((f) => f.file.pickup === "reload").map((f) => f.file.path);
	if (!appChanged && restartFiles.length === 0 && reloadFiles.length === 0) return;
	if (appChanged) {
		say(`${vault.app} reads secrets when it starts, so it keeps the old values until it restarts.`);
	}
	if (restartFiles.length > 0) {
		say(
			`${vault.app} reads ${restartFiles.join(", ")} only when it starts, and its next change to one writes what it holds back over your edit. Restart it now.`,
		);
	} else if (!appChanged) {
		say(
			`${vault.app} keeps the old ${reloadFiles.join(", ")} until /admin → Reload the access lists in Discord, or a restart.`,
		);
	}
	const restart = await confirm({
		message: `Restart ${vault.app} now (just restart ${target})?`,
		default: restartFiles.length > 0,
	});
	if (!restart) {
		say(
			restartFiles.length > 0
				? `Restart it as soon as you can, before anyone changes ${restartFiles.join(", ")} through Pixel: just restart ${target}`
				: `Restart it when you're ready: just restart ${target}`,
		);
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
