import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ciPathNeeds } from "./ci-paths.ts";

const SCRIPT = fileURLToPath(new URL("./ci-paths.sh", import.meta.url));

type Case = {
	files: string[];
	check: boolean;
	image: boolean;
};

const CASES: Case[] = [
	// Neither: docs / changelog / infra markdown / other workflows
	{ files: ["docs/architecture.md"], check: false, image: false },
	{ files: ["docs/adr/0013-release-workflow.md"], check: false, image: false },
	{ files: ["docs/.vitepress/config.ts"], check: false, image: false },
	{ files: ["CHANGELOG.md"], check: false, image: false },
	{ files: ["README.md", "AGENTS.md"], check: false, image: false },
	{ files: ["infra/README.md", "infra/envs/prod/README.md"], check: false, image: false },
	{ files: ["infra/envs/dev/main.tf"], check: false, image: false },
	{ files: [".github/PULL_REQUEST_TEMPLATE.md"], check: false, image: false },
	{ files: [".github/workflows/docs.yml"], check: false, image: false },
	{ files: [".github/workflows/changelog.yml"], check: false, image: false },
	{ files: [".github/workflows/terraform.yml"], check: false, image: false },
	{
		files: ["docs/runbook.md", "CHANGELOG.md", "infra/bootstrap/README.md"],
		check: false,
		image: false,
	},
	{ files: [], check: false, image: false },

	// Check + image (source, content, deps, image build inputs)
	{ files: ["src/core/access.ts"], check: true, image: true },
	{ files: ["src/core/access.test.ts"], check: true, image: true },
	{ files: ["src/services/access-config.ts"], check: true, image: true },
	{ files: ["src/adapters/discord/handlers.ts"], check: true, image: true },
	{ files: ["content/info/rules.md"], check: true, image: true },
	{ files: ["pnpm-lock.yaml"], check: true, image: true },
	{ files: ["package.json"], check: true, image: true },
	{ files: ["pnpm-workspace.yaml"], check: true, image: true },
	{ files: ["tsconfig.json"], check: true, image: true },
	{ files: ["tsconfig.build.json"], check: true, image: true },
	{ files: ["justfile"], check: true, image: true },
	{ files: [".github/workflows/ci.yml"], check: true, image: true },
	{ files: ["docs/architecture.md", "src/core/dispatcher.ts"], check: true, image: true },

	// Check only
	{ files: ["scripts/ci-paths.ts"], check: true, image: false },
	{ files: ["scripts/register-env.ts"], check: true, image: false },
	{ files: ["config/members.example.yaml"], check: true, image: false },
	{ files: ["biome.json"], check: true, image: false },
	{ files: ["vitest.config.ts"], check: true, image: false },
	{ files: [".nvmrc"], check: true, image: false },

	// Image only
	{ files: ["Dockerfile"], check: false, image: true },
	{ files: [".dockerignore"], check: false, image: true },
	{ files: [".github/workflows/cd.yml"], check: false, image: true },
];

describe("ciPathNeeds", () => {
	it.each(CASES)("$check/$image for $files", ({ files, check, image }) => {
		expect(ciPathNeeds(files)).toEqual({ check, image });
	});
});

describe("ci-paths.sh", () => {
	const outputs: string[] = [];

	afterEach(() => {
		for (const dir of outputs) {
			rmSync(dir, { recursive: true, force: true });
		}
		outputs.length = 0;
	});

	it.each(CASES)("stdin $check/$image for $files", ({ files, check, image }) => {
		expect(bashPaths(files)).toEqual({ check, image });
	});

	it("writes GITHUB_OUTPUT", () => {
		const dir = mkdtempSync(join(tmpdir(), "pixel-ci-paths-"));
		outputs.push(dir);
		const file = join(dir, "out");
		bashPaths(["docs/runbook.md"], file);
		const text = readFileSync(file, "utf8");
		expect(text).toMatch(/^check=false$/m);
		expect(text).toMatch(/^image=false$/m);
	});

	it("runs both when BASE_SHA is missing", () => {
		const out = execFileSync("bash", [SCRIPT], {
			encoding: "utf8",
			env: withoutGitHubOutput({ ...process.env, BASE_SHA: "" }),
		});
		expect(out).toMatch(/^check=true$/m);
		expect(out).toMatch(/^image=true$/m);
	});
});

function bashPaths(
	files: readonly string[],
	githubOutput?: string,
): { check: boolean; image: boolean } {
	const env = withoutGitHubOutput({ ...process.env });
	if (githubOutput !== undefined) {
		env.GITHUB_OUTPUT = githubOutput;
	}
	const out = execFileSync("bash", [SCRIPT, "--stdin"], {
		encoding: "utf8",
		input: files.join("\n") + (files.length > 0 ? "\n" : ""),
		env,
	});
	const check = /^check=true$/m.test(out);
	const image = /^image=true$/m.test(out);
	if (!/^check=(true|false)$/m.test(out) || !/^image=(true|false)$/m.test(out)) {
		throw new Error(`unexpected script output:\n${out}`);
	}
	return { check, image };
}

function withoutGitHubOutput(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next = { ...env };
	delete next.GITHUB_OUTPUT;
	return next;
}
