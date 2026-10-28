import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	applyProblem,
	assertPixelEnv,
	chooseEnvFile,
	deployProblem,
	ENVS,
	localFiles,
	missingFilesProblem,
	parseTarget,
	pixelEnvOf,
	SUBSCRIPTION,
	shellAssignments,
	subscriptionProblem,
	TARGETS,
	targetEnvironment,
	withLocalFiles,
} from "./envs.ts";

describe("parseTarget", () => {
	it("accepts dev and prod", () => {
		expect(parseTarget(["dev"])).toBe("dev");
		expect(parseTarget(["prod"])).toBe("prod");
	});

	it("refuses a missing or unknown target, with the usage", () => {
		expect(() => parseTarget([])).toThrow(/Expected dev or prod/);
		expect(() => parseTarget(["local"], "just register dev|prod")).toThrow(
			/just register dev\|prod/,
		);
		expect(() => parseTarget(["dev", "prod"])).toThrow(/Expected dev or prod/);
	});
});

describe("assertPixelEnv", () => {
	it("allows local or dev files on dev", () => {
		expect(() => assertPixelEnv("dev", "local")).not.toThrow();
		expect(() => assertPixelEnv("dev", "dev")).not.toThrow();
	});

	it("allows only PIXEL_ENV=prod on prod", () => {
		expect(() => assertPixelEnv("prod", "prod")).not.toThrow();
	});

	it("refuses a prod file on dev", () => {
		expect(() => assertPixelEnv("dev", "prod")).toThrow(/PIXEL_ENV=prod/);
	});

	it("refuses a non-prod file on prod", () => {
		expect(() => assertPixelEnv("prod", "local")).toThrow(/PIXEL_ENV is not prod/);
		expect(() => assertPixelEnv("prod", "dev")).toThrow(/Never copy the Pixel Dev token/);
	});
});

describe("pixelEnvOf", () => {
	it("reads dev and prod, and treats anything else as local", () => {
		expect(pixelEnvOf({ PIXEL_ENV: "prod" })).toBe("prod");
		expect(pixelEnvOf({ PIXEL_ENV: "dev" })).toBe("dev");
		expect(pixelEnvOf({ PIXEL_ENV: "staging" })).toBe("local");
		expect(pixelEnvOf({})).toBe("local");
	});
});

describe("chooseEnvFile", () => {
	const has =
		(...files: string[]) =>
		(file: string) =>
			files.includes(file);

	it("uses the env's own file", () => {
		expect(chooseEnvFile("dev", has(".env.dev", ".env"))).toEqual({ file: ".env.dev" });
		expect(chooseEnvFile("prod", has(".env.prod"))).toEqual({ file: ".env.prod" });
	});

	it("lets dev fall back to .env, with a note", () => {
		const chosen = chooseEnvFile("dev", has(".env"));
		expect(chosen.file).toBe(".env");
		expect(chosen.note).toMatch(/no \.env\.dev/);
	});

	it("never lets prod fall back", () => {
		expect(() => chooseEnvFile("prod", has(".env", ".env.dev"))).toThrow(
			/Missing \.env\.prod.*Never copy \.env or \.env\.dev/,
		);
	});

	it("says how to make a missing dev file", () => {
		expect(() => chooseEnvFile("dev", has())).toThrow(/Missing \.env\.dev/);
	});
});

describe("targetEnvironment", () => {
	it("drops every key any env file sets, then applies the chosen file", () => {
		const shell = { PATH: "/bin", DISCORD_TOKEN: "local-token", HOME_ASSISTANT_URL: "http://x" };
		const env = targetEnvironment(
			shell,
			["DISCORD_TOKEN=local-token\nHOME_ASSISTANT_URL=http://x\n", "DISCORD_TOKEN=dev-token\n"],
			"DISCORD_TOKEN=dev-token\nPIXEL_ENV=dev\n",
		);
		expect(env).toEqual({ PATH: "/bin", DISCORD_TOKEN: "dev-token", PIXEL_ENV: "dev" });
		// The shell's own environment is left alone.
		expect(shell.DISCORD_TOKEN).toBe("local-token");
	});
});

describe("guards", () => {
	it("only lets az act on the Pixel subscription", () => {
		expect(subscriptionProblem(`${SUBSCRIPTION}\n`)).toBeUndefined();
		expect(subscriptionProblem("00000000-0000-0000-0000-000000000000")).toMatch(
			/az account set --subscription/,
		);
	});

	it("needs PIXEL_APPLY_PROD=1 to apply prod, and nothing for dev", () => {
		expect(applyProblem("dev", undefined)).toBeUndefined();
		expect(applyProblem("prod", "1")).toBeUndefined();
		expect(applyProblem("prod", undefined)).toMatch(/PIXEL_APPLY_PROD=1 just tf-apply prod/);
		expect(applyProblem("prod", "yes")).toMatch(/Refusing/);
	});

	it("never deploys prod from a laptop", () => {
		expect(deployProblem("dev")).toBeUndefined();
		expect(deployProblem("prod")).toMatch(/Release workflow/);
	});
});

describe("shellAssignments", () => {
	it("gives a recipe plain names to eval", () => {
		const lines = shellAssignments("prod").trim().split("\n");
		expect(lines).toContain("resource_group=pixel-prod");
		expect(lines).toContain("app_name=pixel-prod");
		expect(lines).toContain("is_prod=1");
		// Nothing a shell would expand or split.
		for (const line of lines) expect(line).toMatch(/^[a-z_]+=[A-Za-z0-9._-]+$/);
	});
});

describe("ENVS matches the Terraform stacks", () => {
	for (const target of TARGETS) {
		it(`${target} uses the names in infra/envs/${target}`, () => {
			const tfvars = readFileSync(`infra/envs/${target}/terraform.example.tfvars`, "utf8");
			const value = (key: string) =>
				tfvars.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
			const env = ENVS[target];
			expect(env.target).toBe(target);
			expect(value("subscription_id")).toBe(SUBSCRIPTION);
			expect(value("key_vault_name")).toBe(env.vault);
			expect(value("data_storage_account_name")).toBe(env.storageAccount);
			expect(env.resourceGroup).toBe(`pixel-${target}`);
			expect(env.prod).toBe(target === "prod");
		});
	}
});

describe("localFiles", () => {
	it("keeps each env's pulled config apart from the local bot's", () => {
		expect(localFiles("dev")).toEqual({
			adminsFile: "config/admins.dev.yaml",
			membersFile: "config/dev/members.yaml",
			homeAssistantDir: "config/home-assistant/dev",
			announcementRoutesFile: "config/dev/announcement-routes.yaml",
		});
		expect(Object.values(localFiles("prod"))).not.toContain("config/admins.yaml");
	});
});

describe("withLocalFiles", () => {
	it("points Pixel's config paths at the env's pulled files", () => {
		expect(withLocalFiles("prod", { PIXEL_ENV: "prod" })).toEqual({
			PIXEL_ENV: "prod",
			PIXEL_ADMINS_FILE: "config/admins.prod.yaml",
			PIXEL_MEMBERS_FILE: "config/prod/members.yaml",
			PIXEL_HOME_ASSISTANT_DIR: "config/home-assistant/prod",
		});
	});

	it("keeps a path the env file sets, and treats an empty one as unset", () => {
		const vars = withLocalFiles("dev", {
			PIXEL_ADMINS_FILE: "elsewhere/admins.yaml",
			PIXEL_MEMBERS_FILE: "",
		});
		expect(vars.PIXEL_ADMINS_FILE).toBe("elsewhere/admins.yaml");
		expect(vars.PIXEL_MEMBERS_FILE).toBe("config/dev/members.yaml");
	});
});

describe("missingFilesProblem", () => {
	it("is fine when every file is there", () => {
		expect(missingFilesProblem("dev", ["a", "b"], () => true)).toBeUndefined();
	});

	it("names what's missing and says to pull that env", () => {
		const problem = missingFilesProblem("prod", ["a", "b"], (f) => f === "a");
		expect(problem).toBe("Missing b. Run: just pull prod");
	});
});

describe("the justfile", () => {
	it("takes Azure names from scripts/env.ts instead of spelling them", () => {
		const justfile = readFileSync("justfile", "utf8");
		expect(justfile).not.toContain(SUBSCRIPTION);
		for (const env of Object.values(ENVS)) {
			expect(justfile).not.toContain(env.vault);
			expect(justfile).not.toContain(env.storageAccount);
			expect(justfile).not.toMatch(new RegExp(`["=]${env.resourceGroup}\\b`));
		}
	});
});
