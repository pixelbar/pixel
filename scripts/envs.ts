/**
 * The one definition of Pixel's environments for the laptop tools (#116): which
 * env file each reads, where it lives on Azure, and the guards every tool shares.
 * Scripts and `just` recipes take these from here and never spell a resource
 * group, vault, storage account or subscription themselves (recipes read them
 * with `scripts/env.ts shell <env>`).
 *
 * Pure: nothing here reads a file, the environment or Azure, so it can be tested.
 * `scripts/env.ts` does the reading.
 */
import { join } from "node:path";
import { parseEnv } from "node:util";

/** An environment that runs on Azure. `local` is `just dev` on a laptop and has none of this. */
export type Target = "dev" | "prod";

export const TARGETS: readonly Target[] = ["dev", "prod"];

/** The Azure subscription both environments live in. */
export const SUBSCRIPTION = "d150e252-e2f0-47fb-8a4a-c3f29e9aebd4";

export type PixelEnv = {
	target: Target;
	/** Resource group, Container App and the name in `PIXEL_ENV`. */
	resourceGroup: string;
	app: string;
	/** Key Vault holding the app secrets and the shared tfvars. */
	vault: string;
	/** Azure Files account and share Pixel mounts at `/app/persist`. */
	storageAccount: string;
	share: string;
	/** The laptop env file for this env's Discord application. */
	envFile: string;
	/** Changes here reach the production bot, so tools ask harder before writing. */
	prod: boolean;
};

export const ENVS: Readonly<Record<Target, PixelEnv>> = {
	dev: {
		target: "dev",
		resourceGroup: "pixel-dev",
		app: "pixel-dev",
		vault: "pixel-dev-kv",
		storageAccount: "pixeldevdata",
		share: "pixel",
		envFile: ".env.dev",
		prod: false,
	},
	prod: {
		target: "prod",
		resourceGroup: "pixel-prod",
		app: "pixel-prod",
		vault: "pixel-prod-kv",
		storageAccount: "pixelproddata",
		share: "pixel",
		envFile: ".env.prod",
		prod: true,
	},
};

/** Every env file a laptop may have. `.env` is the local bot (`just dev`). */
export const ENV_FILES = [".env", ".env.dev", ".env.prod"] as const;

/**
 * Where `just pull <env>` (and `just secrets-pull`, `just ha-devices`) put an env's
 * config on the laptop. All gitignored. `config/admins.yaml`, `config/members.yaml` and
 * `config/home-assistant/` are the local bot's (`just dev`), never an env's.
 */
export type LocalFiles = {
	/** The `admins-yaml` Key Vault secret. */
	adminsFile: string;
	/** Read-only mirror of the share's `members.yaml`. */
	membersFile: string;
	/** Holds the read-only mirror of the share's `home-assistant/devices.yaml`. */
	homeAssistantDir: string;
	/** Read-only mirror of the share's `data/announcement-routes.yaml`. */
	announcementRoutesFile: string;
};

export function localFiles(target: Target): LocalFiles {
	return {
		adminsFile: join("config", `admins.${target}.yaml`),
		membersFile: join("config", target, "members.yaml"),
		homeAssistantDir: join("config", "home-assistant", target),
		announcementRoutesFile: join("config", target, "announcement-routes.yaml"),
	};
}

/**
 * Points Pixel's config paths at the env's pulled files, so a tool that builds the core
 * for `dev` reads dev's access lists and devices, not the local bot's. A path the env
 * file (or the shell) sets itself wins.
 */
export function withLocalFiles(
	target: Target,
	vars: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const files = localFiles(target);
	return {
		...vars,
		PIXEL_ADMINS_FILE: vars.PIXEL_ADMINS_FILE || files.adminsFile,
		PIXEL_MEMBERS_FILE: vars.PIXEL_MEMBERS_FILE || files.membersFile,
		PIXEL_HOME_ASSISTANT_DIR: vars.PIXEL_HOME_ASSISTANT_DIR || files.homeAssistantDir,
	};
}

/** What to run when files an env's tool needs aren't on the laptop, or undefined when they are. */
export function missingFilesProblem(
	target: Target,
	files: readonly string[],
	exists: (file: string) => boolean,
): string | undefined {
	const missing = files.filter((file) => !exists(file));
	if (missing.length === 0) return undefined;
	return `Missing ${missing.join(", ")}. Run: just pull ${target}`;
}

export class EnvError extends Error {
	override name = "EnvError";
}

export function isTarget(value: unknown): value is Target {
	return value === "dev" || value === "prod";
}

/** The env a tool was given: exactly one argument, `dev` or `prod`. */
export function parseTarget(argv: readonly string[], usage = "just <recipe> dev|prod"): Target {
	const [target] = argv;
	if (isTarget(target) && argv.length === 1) return target;
	throw new EnvError(`Expected dev or prod (${usage})`);
}

/**
 * Stops a prod token being used on the Pixel Dev guild, and the reverse. `pixelEnv`
 * is what the env file says in `PIXEL_ENV`.
 */
export function assertPixelEnv(target: Target, pixelEnv: "local" | "dev" | "prod"): void {
	if (target === "prod" && pixelEnv !== "prod") {
		throw new EnvError(
			"Refusing prod: PIXEL_ENV is not prod. .env.prod must set PIXEL_ENV=prod. Never copy the Pixel Dev token.",
		);
	}
	if (target === "dev" && pixelEnv === "prod") {
		throw new EnvError("Refusing dev: PIXEL_ENV=prod. dev is the Pixel Dev / test guild only.");
	}
}

/** `PIXEL_ENV` as an env file (or a parsed environment) sets it. */
export function pixelEnvOf(env: Record<string, string | undefined>): "local" | "dev" | "prod" {
	const value = env.PIXEL_ENV;
	return value === "dev" || value === "prod" ? value : "local";
}

/**
 * Which env file a Discord tool (`register`, `command-access`, `ha-devices`) reads.
 * Dev falls back to `.env` (with a note); prod never does.
 */
export function chooseEnvFile(
	target: Target,
	exists: (file: string) => boolean,
): { file: string; note?: string } {
	const { envFile } = ENVS[target];
	if (exists(envFile)) return { file: envFile };
	if (target === "dev" && exists(".env")) {
		return {
			file: ".env",
			note: "Using .env (no .env.dev). Copy .env.example to .env.dev to keep Pixel Dev separate from a local bot.",
		};
	}
	throw new EnvError(
		target === "prod"
			? "Missing .env.prod. Copy .env.example to .env.prod and set PIXEL_ENV=prod plus the production Discord application. Never copy .env or .env.dev."
			: "Missing .env.dev. Copy .env.example to .env.dev and fill in the Pixel Dev / test Discord application.",
	);
}

/**
 * The environment a tool runs with: what the shell has, minus every key any env file
 * sets (`just` loads `.env` into every recipe, which must not leak into another bot),
 * plus the chosen file.
 */
export function targetEnvironment(
	shell: Record<string, string | undefined>,
	envFiles: readonly string[],
	chosen: string,
): Record<string, string | undefined> {
	const env = { ...shell };
	for (const text of envFiles) {
		for (const key of Object.keys(parseEnv(text))) delete env[key];
	}
	return { ...env, ...parseEnv(chosen) };
}

/** Why `az` can't act on this env's Container App, or undefined when it can. */
export function subscriptionProblem(current: string): string | undefined {
	if (current.trim() === SUBSCRIPTION) return undefined;
	return `az is not on the Pixel subscription (${SUBSCRIPTION}). Run: az account set --subscription ${SUBSCRIPTION}`;
}

/**
 * Terraform applies to prod need a maintainer to say so (`PIXEL_APPLY_PROD=1`).
 * Coding agents must not apply prod or write prod secrets.
 */
export function applyProblem(target: Target, approved: string | undefined): string | undefined {
	if (target !== "prod" || approved === "1") return undefined;
	return [
		"Refusing just tf-apply prod. Coding agents must not apply prod or write prod secrets.",
		"A maintainer runs: PIXEL_APPLY_PROD=1 just tf-apply prod",
	].join("\n");
}

/** `deploy` rolls a locally built image. Prod only ships from the Release workflow. */
export function deployProblem(target: Target): string | undefined {
	if (target === "dev") return undefined;
	return "Refusing just deploy prod: prod ships from the Release workflow (Actions → Release on main), never from a laptop.";
}

/** Shell assignments for a `just` recipe to `eval`. Every value is a plain name. */
export function shellAssignments(target: Target): string {
	const env = ENVS[target];
	return [
		`subscription=${SUBSCRIPTION}`,
		`resource_group=${env.resourceGroup}`,
		`app_name=${env.app}`,
		`key_vault=${env.vault}`,
		`storage_account=${env.storageAccount}`,
		`share=${env.share}`,
		`env_file=${env.envFile}`,
		`is_prod=${env.prod ? 1 : 0}`,
		"",
	].join("\n");
}
