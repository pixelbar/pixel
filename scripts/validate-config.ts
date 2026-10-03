/**
 * Validates the access list files without starting the bot.
 * Usage: just validate-config
 */
import { AccessConfigError, loadAccessConfig } from "../src/services/access-config.ts";

const paths = {
	adminsFile: process.argv[2] ?? "config/admins.yaml",
	membersFile: process.argv[3] ?? "config/members.yaml",
};

try {
	const { counts, warnings } = loadAccessConfig(paths);
	for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`);
	process.stdout.write(
		`OK: ${counts.admins} admins, ${counts.members} members, ${counts.friends} friends\n`,
	);
} catch (error) {
	if (!(error instanceof AccessConfigError)) throw error;
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
}
