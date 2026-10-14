/**
 * Adds Home Assistant devices to an env's allow-list on Azure.
 * Usage: just ha-devices dev  or  just ha-devices prod
 *
 * 1. Pulls the env's `devices.yaml` from its Azure Files share. The remote is the
 *    truth: if the local mirror (`config/home-assistant/<env>/devices.yaml`) has
 *    edits the remote doesn't, it stops (or, if you say so, drops them).
 * 2. Asks Home Assistant what it has and shows it with the list: what's listed
 *    starts ticked. Tick to add, untick to remove (`/` searches, `s` shows only
 *    what's ticked, esc goes back). New devices then get a name, actions and tier.
 * 3. Checks the new file exactly as Pixel will, shows it, and on a yes uploads it,
 *    but only if the remote hasn't changed since step 1. Then updates the mirror.
 *
 * Needs `az login` on the Pixel subscription, and HOME_ASSISTANT_URL and
 * HOME_ASSISTANT_TOKEN in that env's file. The token is never printed. Pixel
 * picks the change up on `/admin reload`.
 */
import { execFile } from "node:child_process";
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
import { join } from "node:path";
import { promisify } from "node:util";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { HomeAssistantBackend } from "../src/adapters/home-assistant/backend.ts";
import { loadConfig } from "../src/config.ts";
import { HOME_KINDS } from "../src/core/home-kinds/index.ts";
import { silentLogger } from "../src/core/logger.ts";
import {
	DEVICES_FILE,
	HomeDevicesError,
	type HomeDevicesView,
} from "../src/services/home-devices.ts";
import { devicePicker } from "./device-picker.ts";
import {
	actionChoices,
	appendDevices,
	azDownloadArgs,
	azUploadArgs,
	checkName,
	choiceLabel,
	compareMirror,
	type DeviceChoice,
	defaultDescription,
	deviceChoices,
	mirrorDir,
	type NewDevice,
	planChanges,
	REMOTES,
	removeDevices,
	tiersFor,
	validateDevices,
} from "./ha-devices-lib.ts";
import { buildInventory, type InventoryEntry } from "./ha-inventory.ts";
import { assertRegisterEnv, parseRegisterTarget } from "./register-env.ts";

const run = promisify(execFile);
const CONNECT_TIMEOUT_MS = 15_000;

class Stop extends Error {
	override name = "Stop";
}

const say = (text = "") => process.stdout.write(`${text}\n`);

const target = parseRegisterTarget(process.argv.slice(2));
const config = loadConfig();
assertRegisterEnv(target, config.env);
const remote = REMOTES[target];
const work = mkdtempSync(join(tmpdir(), "pixel-ha-devices-"));

async function az(args: string[]): Promise<void> {
	try {
		await run("az", args);
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Stop(`az failed: ${stderr || (error as Error).message}\nIs \`az login\` done?`);
	}
}

async function pull(name: string): Promise<string> {
	const dest = join(work, name);
	await az(azDownloadArgs(remote, dest));
	return readFileSync(dest, "utf8");
}

function writeMirror(text: string): void {
	const dir = mirrorDir(target);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, DEVICES_FILE);
	writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
	renameSync(`${file}.tmp`, file);
}

async function showDiff(local: string, remoteText: string): Promise<void> {
	const a = join(work, "local.yaml");
	const b = join(work, "remote.yaml");
	writeFileSync(a, local);
	writeFileSync(b, remoteText);
	try {
		await run("diff", ["-u", "--label", "local", "--label", "remote", a, b]);
	} catch (error) {
		// diff exits 1 when the files differ, which is the point.
		say((error as { stdout?: string }).stdout ?? "");
	}
}

/** Everything Home Assistant has that Pixel has a kind for, marked when it's already listed. */
async function inventory(listed: HomeDevicesView): Promise<InventoryEntry[]> {
	if (!config.homeAssistant) {
		const file = target === "prod" ? ".env.prod" : ".env.dev (or .env)";
		throw new Stop(
			`Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN in ${file}: the non-admin token Pixel uses.`,
		);
	}
	const backend = new HomeAssistantBackend({ ...config.homeAssistant, logger: silentLogger });
	try {
		const timeout = new Promise<void>((resolve) => setTimeout(resolve, CONNECT_TIMEOUT_MS).unref());
		await Promise.race([backend.settled, timeout]);
		const status = backend.status();
		if (status.kind !== "connected") {
			const why = status.kind === "off" ? status.reason : "it didn't answer in time";
			throw new Stop(`Couldn't reach Home Assistant: ${why}.`);
		}
		if (status.adminToken) say("warning: this Home Assistant token belongs to an admin user.");
		return buildInventory(await backend.listEntities(), HOME_KINDS, listed).entries;
	} finally {
		backend.close();
	}
}

async function pick(choices: readonly DeviceChoice[]): Promise<DeviceChoice[]> {
	return devicePicker({
		message: "Devices on the list (ticked)",
		items: choices.map((choice) => ({
			value: choice,
			label: choiceLabel(choice),
			keywords: `${choice.entry.name} ${choice.entry.kind}`,
			checked: choice.listed,
		})),
	});
}

async function configure(entry: InventoryEntry, taken: Set<string>): Promise<NewDevice> {
	const kind = HOME_KINDS.get(entry.kind);
	if (!kind) throw new Error(`Unknown kind ${entry.kind}`); // the inventory only lists known kinds
	say();
	say(`${entry.friendlyName ?? entry.entity} (${entry.entity}, ${kind.name})`);
	const name = await input({
		message: "Name people type",
		default: entry.name,
		validate: (value) => checkName(value.trim(), taken),
	});
	taken.add(name.trim());

	const offered = actionChoices(kind, target);
	if (kind.name === "door") {
		say(
			target === "dev"
				? "Doors are read-only on dev: dev must not control the real doors."
				: "Careful: a door with unlock lets anyone with ha-doors open the building from Discord.",
		);
	}
	const actions =
		offered.length === 0
			? []
			: await checkbox({
					message: "Allowed actions (none means read-only)",
					choices: offered.map((a) => ({ name: a.name, value: a.name, checked: a.checked })),
				});

	const tiers = tiersFor(kind);
	const minTier = await select({
		message: "Lowest tier that may use it",
		choices: tiers.map((tier) => ({ name: tier, value: tier })),
		default: tiers.includes("member") ? "member" : tiers[0],
	});

	const description = await input({
		message: "Description (optional, up to 100 characters)",
		default: defaultDescription(entry),
		validate: (value) => value.trim().length <= 100 || "Up to 100 characters",
	});

	return {
		name: name.trim(),
		entity: entry.entity,
		kind: kind.name,
		actions,
		...(description.trim() ? { description: description.trim() } : {}),
		minTier,
	};
}

async function main(): Promise<void> {
	say(`Pulling ${remote.path} from ${remote.account} (${target})…`);
	const pulled = await pull("pulled.yaml");
	const current = validateDevices(pulled, HOME_KINDS);

	const mirror = join(mirrorDir(target), DEVICES_FILE);
	const local = existsSync(mirror) ? readFileSync(mirror, "utf8") : undefined;
	switch (compareMirror(local, pulled)) {
		case "missing":
			say(`Created ${mirror} from the remote.`);
			writeMirror(pulled);
			break;
		case "same":
			break;
		case "differs": {
			say(`${mirror} has changes that aren't on ${target}:`);
			await showDiff(local as string, pulled);
			const replace = await confirm({
				message: `Throw away the local changes and use ${target}'s file?`,
				default: false,
			});
			if (!replace) throw new Stop("Stopped. Nothing was pushed.");
			writeMirror(pulled);
		}
	}

	say("Asking Home Assistant what it has…");
	const choices = deviceChoices(await inventory(current), current);
	if (choices.length === 0) {
		say("Home Assistant has nothing Pixel can use, and the list is empty.");
		return;
	}
	const { add, remove } = planChanges(choices, await pick(choices));
	if (add.length === 0 && remove.length === 0) {
		say("No changes. Nothing was pushed.");
		return;
	}
	if (remove.length > 0) say(`Removing: ${remove.join(", ")}`);

	// A removed device's name is free again.
	const taken = new Set(current.devices.map((d) => d.name).filter((n) => !remove.includes(n)));
	const additions: NewDevice[] = [];
	for (const entry of add) additions.push(await configure(entry, taken));

	const next = appendDevices(removeDevices(pulled, remove), additions);
	const view = validateDevices(next, HOME_KINDS);
	say();
	await showDiff(pulled, next);
	const push = await confirm({
		message: `Push ${view.devices.length} devices to ${target.toUpperCase()} (${remote.account})?`,
		default: false,
	});
	if (!push) throw new Stop("Stopped. Nothing was pushed.");

	// Someone else may have changed it while you were picking.
	if ((await pull("before-push.yaml")) !== pulled) {
		throw new Stop(
			`${target}'s file changed while you were picking. Run it again. Nothing was pushed.`,
		);
	}
	const source = join(work, "next.yaml");
	writeFileSync(source, next, { mode: 0o600 });
	await az(azUploadArgs(remote, source));
	if ((await pull("after-push.yaml")) !== next) {
		throw new Stop(`Uploaded, but ${target}'s file doesn't read back the same. Check it by hand.`);
	}
	writeMirror(next);
	say(`Pushed to ${target} and updated ${mirror}.`);
	say(`Now run /admin reload in the ${target} Discord server so Pixel picks it up.`);
}

try {
	await main();
} catch (error) {
	if (error instanceof Stop || error instanceof HomeDevicesError) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	} else if (error instanceof Error && error.name === "ExitPromptError") {
		process.stderr.write("Cancelled. Nothing was pushed.\n");
		process.exitCode = 130;
	} else {
		process.stderr.write(
			`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exitCode = 1;
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
// The Home Assistant client keeps retrying a connection that never came up and its close()
// can't stop that, so leave explicitly once the files are cleaned up, or the process hangs.
process.exit();
