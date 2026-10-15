/**
 * What `just` recipes ask about an environment, so none of them spells an Azure
 * name or a guard itself. Definitions: `scripts/envs.ts`.
 *
 *   just env dev                      print dev's settings (names only, never a secret)
 *   tsx scripts/env.ts shell <env>    shell assignments for a recipe to eval
 *   tsx scripts/env.ts check-az <env> fail unless az is signed in to the Pixel subscription
 *   tsx scripts/env.ts apply <env>    fail on prod unless PIXEL_APPLY_PROD=1
 *   tsx scripts/env.ts deploy <env>   fail on prod (it ships from the Release workflow)
 */
import { execFileSync } from "node:child_process";
import {
	applyProblem,
	deployProblem,
	ENVS,
	EnvError,
	parseTarget,
	SUBSCRIPTION,
	shellAssignments,
	subscriptionProblem,
} from "./envs.ts";

const USAGE = "scripts/env.ts show|shell|check-az|apply|deploy dev|prod";

function currentSubscription(): string {
	try {
		return execFileSync("az", ["account", "show", "--query", "id", "-o", "tsv"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		throw new EnvError("az isn't signed in. Run: az login");
	}
}

function main(argv: readonly string[]): void {
	const [command, ...rest] = argv;
	const target = parseTarget(rest, USAGE);
	const env = ENVS[target];
	let problem: string | undefined;
	switch (command) {
		case "show":
			process.stdout.write(
				[
					`${target}${env.prod ? " (production)" : ""}`,
					`  env file         ${env.envFile}`,
					`  subscription     ${SUBSCRIPTION}`,
					`  resource group   ${env.resourceGroup}`,
					`  container app    ${env.app}`,
					`  key vault        ${env.vault}`,
					`  file share       ${env.storageAccount}/${env.share}`,
					"",
				].join("\n"),
			);
			return;
		case "shell":
			process.stdout.write(shellAssignments(target));
			return;
		case "check-az":
			problem = subscriptionProblem(currentSubscription());
			break;
		case "apply":
			problem = applyProblem(target, process.env.PIXEL_APPLY_PROD);
			break;
		case "deploy":
			problem = deployProblem(target);
			break;
		default:
			throw new EnvError(`Usage: ${USAGE}`);
	}
	if (problem) throw new EnvError(problem);
}

try {
	main(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof EnvError)) throw error;
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
}
