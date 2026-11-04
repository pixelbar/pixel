/**
 * Loads the env a laptop tool acts on: `dev` or `prod` from the command line, and
 * that env's file (`.env.dev`, falling back to `.env`, or `.env.prod`) without
 * letting anything `just` loaded from another env file leak in. Then checks the
 * file's `PIXEL_ENV` matches, so a prod token never reaches the Pixel Dev guild.
 * Config paths point at what `just pull <env>` wrote (`localFiles`), unless the env
 * file names others.
 *
 * In GitHub Actions the Release workflow passes the env through the job instead
 * (`PIXEL_ENV_SOURCE=process`, ADR 0014), so no file is read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICES_FILE } from "../src/services/home-devices.ts";
import {
	assertPixelEnv,
	chooseEnvFile,
	ENV_FILES,
	ENVS,
	EnvError,
	missingFilesProblem,
	type PixelEnv,
	parseTarget,
	pixelEnvOf,
	type Target,
	targetEnvironment,
	withLocalFiles,
} from "./envs.ts";

export type LoadedTarget = {
	target: Target;
	env: PixelEnv;
	/** The environment to hand to `loadConfig`. */
	vars: Record<string, string | undefined>;
};

/** Like `readTarget`, but prints the problem and exits when there is one. */
export function loadTarget(argv: readonly string[], usage: string): LoadedTarget {
	try {
		return readTarget(argv, usage);
	} catch (error) {
		exitOn(error);
	}
}

export function readTarget(argv: readonly string[], usage: string): LoadedTarget {
	const target = parseTarget(argv, usage);
	let vars: Record<string, string | undefined>;
	if (process.env.PIXEL_ENV_SOURCE === "process" && process.env.GITHUB_ACTIONS === "true") {
		vars = process.env;
	} else {
		const { file, note } = chooseEnvFile(target, existsSync);
		if (note) process.stdout.write(`${note}\n`);
		const others = ENV_FILES.filter(existsSync).map((f) => readFileSync(f, "utf8"));
		vars = targetEnvironment(process.env, others, readFileSync(file, "utf8"));
	}
	assertPixelEnv(target, pixelEnvOf(vars));
	return { target, env: ENVS[target], vars: withLocalFiles(target, vars) };
}

/**
 * The files `buildCore` reads for this env: the access lists, and the devices file
 * when Home Assistant is set up. Exits with what to run when one isn't on the laptop.
 */
export function requireConfigFiles({ target, vars }: LoadedTarget): void {
	const files = [vars.PIXEL_ADMINS_FILE, vars.PIXEL_MEMBERS_FILE];
	if (vars.HOME_ASSISTANT_URL && vars.HOME_ASSISTANT_TOKEN) {
		files.push(join(vars.PIXEL_HOME_ASSISTANT_DIR ?? "", DEVICES_FILE));
	}
	const problem = missingFilesProblem(
		target,
		files.filter((f) => f !== undefined),
		existsSync,
	);
	if (problem) exitOn(new EnvError(problem));
}

function exitOn(error: unknown): never {
	if (!(error instanceof EnvError)) throw error;
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
}
