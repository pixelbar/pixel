/**
 * Validates the access list files, and the Home Assistant devices file, without
 * starting the bot.
 * Usage: just validate-config
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME_KINDS } from "../src/core/home-kinds/index.ts";
import { AccessConfigError, loadAccessConfig } from "../src/services/access-config.ts";
import { DEVICES_FILE, HomeDevicesError, loadHomeDevices } from "../src/services/home-devices.ts";

const paths = {
	adminsFile: process.argv[2] ?? "config/admins.yaml",
	membersFile: process.argv[3] ?? "config/members.yaml",
};
const devicesDir = process.argv[4] ?? "config/home-assistant";

try {
	const { counts, warnings } = loadAccessConfig(paths);
	for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`);
	process.stdout.write(
		`OK: ${counts.admins} admins, ${counts.members} members, ${counts.friends} friends\n`,
	);

	// The devices file is only required when Home Assistant is set up, like at startup.
	if (process.env.HOME_ASSISTANT_URL || existsSync(join(devicesDir, DEVICES_FILE))) {
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
