/**
 * Validates the access list files, and the Home Assistant devices file, without
 * starting the bot.
 * Usage: just validate-config            the local bot's files (config/admins.yaml, …)
 *        just validate-config dev|prod   that env's, as `just pull <env>` wrote them
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME_KINDS } from "../src/core/home-kinds/index.ts";
import { AccessConfigError, loadAccessConfig } from "../src/services/access-config.ts";
import { DEVICES_FILE, HomeDevicesError, loadHomeDevices } from "../src/services/home-devices.ts";
import { isTarget } from "./envs.ts";
import { loadTarget, requireConfigFiles } from "./target.ts";

const args = process.argv.slice(2);
let vars: Record<string, string | undefined> = process.env;
let paths = {
	adminsFile: args[0] ?? "config/admins.yaml",
	membersFile: args[1] ?? "config/members.yaml",
};
let devicesDir = args[2] ?? "config/home-assistant";
if (isTarget(args[0])) {
	const loaded = loadTarget(args, "just validate-config [dev|prod]");
	requireConfigFiles(loaded);
	vars = loaded.vars;
	paths = {
		adminsFile: vars.PIXEL_ADMINS_FILE ?? paths.adminsFile,
		membersFile: vars.PIXEL_MEMBERS_FILE ?? paths.membersFile,
	};
	devicesDir = vars.PIXEL_HOME_ASSISTANT_DIR ?? devicesDir;
}

try {
	const { counts, warnings } = loadAccessConfig(paths);
	for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`);
	process.stdout.write(
		`OK: ${counts.admins} admins, ${counts.members} members, ${counts.friends} friends\n`,
	);

	// The devices file is only required when Home Assistant is set up, like at startup.
	if (vars.HOME_ASSISTANT_URL || existsSync(join(devicesDir, DEVICES_FILE))) {
		const { devices } = loadHomeDevices(devicesDir, HOME_KINDS);
		process.stdout.write(`OK: ${devices.length} Home Assistant devices\n`);
	} else {
		process.stdout.write("Home Assistant devices: not checked (Home Assistant isn't set up)\n");
	}
} catch (error) {
	if (!(error instanceof AccessConfigError || error instanceof HomeDevicesError)) throw error;
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
}
