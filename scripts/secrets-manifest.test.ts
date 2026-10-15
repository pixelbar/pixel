import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	appEnvSecrets,
	enabledSecrets,
	loadSecretsManifest,
	MANIFEST_FILE,
	parseSecretsManifest,
	SecretsManifestError,
	terraformSecrets,
} from "./secrets-manifest.ts";

const read = (file: string) => readFileSync(file, "utf8");

/** A small valid manifest, with one thing changed per test. */
const BASE = `
version: 1
features:
  always: Every stack
  mastodon: Mastodon is set up
secrets:
  - vault: discord-token
    group: app
    delivery: env
    env: DISCORD_TOKEN
    feature: always
    description: The bot token.
  - vault: admins-yaml
    group: app
    delivery: file
    feature: always
    description: The admin list.
  - vault: mastodon-access-token
    group: app
    delivery: env
    env: MASTODON_ACCESS_TOKEN
    feature: mastodon
    description: The Mastodon token.
  - vault: tailscale-auth-key
    group: infra
    delivery: sidecar-env
    env: TS_AUTHKEY
    feature: always
    description: The sidecar key.
`;

function rejection(source: string): string {
	try {
		parseSecretsManifest(source, "test.yaml");
	} catch (error) {
		expect(error).toBeInstanceOf(SecretsManifestError);
		return (error as Error).message;
	}
	throw new Error("expected the manifest to be rejected");
}

describe("parseSecretsManifest", () => {
	it("reads a valid manifest", () => {
		const manifest = parseSecretsManifest(BASE);
		expect(manifest.secrets.map((s) => s.vault)).toEqual([
			"discord-token",
			"admins-yaml",
			"mastodon-access-token",
			"tailscale-auth-key",
		]);
		expect(Object.keys(manifest.features)).toEqual(["always", "mastodon"]);
	});

	it("rejects text that isn't YAML, without echoing it", () => {
		const message = rejection("a: [unclosed");
		expect(message).toBe("test.yaml is not valid YAML");
	});

	it.each([
		["a missing version", BASE.replace("version: 1", "")],
		["another version", BASE.replace("version: 1", "version: 2")],
		["an unknown top-level key", `${BASE}\nextra: true\n`],
		[
			"an unknown key on a secret",
			BASE.replace(
				"group: app\n    delivery: file",
				"group: app\n    delivery: file\n    value: nope",
			),
		],
		["no secrets", "version: 1\nfeatures:\n  always: x\nsecrets: []\n"],
		["an uppercase vault name", BASE.replace("vault: discord-token", "vault: Discord_Token")],
		["a lowercase env", BASE.replace("env: DISCORD_TOKEN", "env: discord_token")],
		["an unknown group", BASE.replace("group: infra", "group: other")],
		["an unknown delivery", BASE.replace("delivery: file", "delivery: pigeon")],
		["an empty description", BASE.replace("description: The bot token.", 'description: ""')],
	])("rejects %s", (_label, source) => {
		expect(rejection(source)).toMatch(/^test\.yaml is invalid:/);
	});

	it("rejects a secret listed twice", () => {
		const source = BASE.replace("vault: admins-yaml", "vault: discord-token");
		expect(rejection(source)).toContain('"discord-token" is listed twice');
	});

	it("rejects an env used twice", () => {
		const source = BASE.replace("env: MASTODON_ACCESS_TOKEN", "env: DISCORD_TOKEN");
		expect(rejection(source)).toContain("reuses the env DISCORD_TOKEN");
	});

	it("needs an env for env and sidecar-env, and refuses one otherwise", () => {
		expect(rejection(BASE.replace("    env: DISCORD_TOKEN\n", ""))).toContain(
			'"discord-token" is delivered as env, so it needs an env',
		);
		expect(rejection(BASE.replace("    env: TS_AUTHKEY\n", ""))).toContain(
			'"tailscale-auth-key" is delivered as sidecar-env, so it needs an env',
		);
		expect(
			rejection(BASE.replace("delivery: file", "delivery: file\n    env: ADMINS_FILE")),
		).toContain('"admins-yaml" is delivered as file, so it has no env');
	});

	it("refuses a feature that isn't declared", () => {
		const source = BASE.replace("feature: mastodon", "feature: bluesky");
		expect(rejection(source)).toContain('uses the feature "bluesky", which isn\'t declared');
	});

	it("requires the always feature to be declared", () => {
		const source = BASE.replace("  always: Every stack\n", "");
		expect(rejection(source)).toContain('the feature "always" must be declared');
	});

	it("keeps the app group to what the app itself receives", () => {
		const source = BASE.replace("group: infra", "group: app");
		expect(rejection(source)).toContain(
			'"tailscale-auth-key" is in the app group but is delivered as sidecar-env',
		);
	});

	it("keeps the tooling group and the tool delivery together", () => {
		expect(rejection(BASE.replace("group: infra", "group: tooling"))).toContain(
			'"tailscale-auth-key": the tooling group and the tool delivery go together',
		);
		expect(
			rejection(BASE.replace("delivery: sidecar-env\n    env: TS_AUTHKEY", "delivery: tool")),
		).toContain('"tailscale-auth-key": the tooling group and the tool delivery go together');
	});

	it("collects every problem at once", () => {
		const source = BASE.replace("vault: admins-yaml", "vault: discord-token").replace(
			"feature: mastodon",
			"feature: bluesky",
		);
		const message = rejection(source);
		expect(message).toContain("is listed twice");
		expect(message).toContain("which isn't declared");
	});

	it("never repeats a bad value from the file", () => {
		for (const [from, to] of [
			["env: DISCORD_TOKEN", "env: hunter2-secret"],
			["group: infra", "group: hunter2-secret"],
			["delivery: file", "delivery: hunter2-secret"],
			["vault: discord-token", "vault: hunter2-SECRET"],
		] as const) {
			expect(rejection(BASE.replace(from, to))).not.toContain("hunter2");
		}
	});
});

describe("enabledSecrets and appEnvSecrets", () => {
	const manifest = parseSecretsManifest(BASE);

	it("always includes the always secrets, and the others only when their feature is on", () => {
		expect(enabledSecrets(manifest, new Set()).map((s) => s.vault)).toEqual([
			"discord-token",
			"admins-yaml",
			"tailscale-auth-key",
		]);
		expect(enabledSecrets(manifest, new Set(["mastodon"])).map((s) => s.vault)).toContain(
			"mastodon-access-token",
		);
	});

	it("maps environment variables to vault names for the app's env secrets only", () => {
		expect(appEnvSecrets(enabledSecrets(manifest, new Set(["mastodon"])))).toEqual({
			DISCORD_TOKEN: "discord-token",
			MASTODON_ACCESS_TOKEN: "mastodon-access-token",
		});
	});
});

describe("loadSecretsManifest", () => {
	it("names a missing file without a path hint beyond the file given", () => {
		expect(() => loadSecretsManifest("does-not-exist.yaml")).toThrow(
			"cannot read does-not-exist.yaml (ENOENT)",
		);
	});
});

/**
 * The manifest is the one list of secrets. Everything below fails when another place
 * that has to know about a secret disagrees with it, and names what to fix.
 */
describe("the real manifest", () => {
	const manifest = loadSecretsManifest(MANIFEST_FILE);
	const envSecrets = manifest.secrets.filter((s) => s.delivery === "env");

	const secretsTf = read("infra/modules/pixel/secrets.tf");
	const localsTf = read("infra/modules/pixel/locals.tf");
	const moduleVariables = read("infra/modules/pixel/variables.tf");

	/** `"vault-name" = var.name` lines inside `managed_secret_values`. */
	const writeMap = (() => {
		const start = secretsTf.indexOf("managed_secret_values = {");
		const end = secretsTf.indexOf("\n  }", start);
		const block = secretsTf.slice(start, end);
		return [...block.matchAll(/^\s+"([a-z0-9-]+)"\s*=\s*var\.([a-z_]+)\s*$/gm)].map(
			([, vault, variable]) => ({ vault: vault ?? "", variable: variable ?? "" }),
		);
	})();

	it("lists every secret Terraform can write, and nothing else", () => {
		expect(writeMap.map((w) => w.vault).sort()).toEqual(
			terraformSecrets(manifest)
				.map((s) => s.vault)
				.sort(),
		);
	});

	it("keeps the tooling group out of Terraform", () => {
		expect(localsTf).toMatch(/if s\.group != "tooling" && local\.secret_features\[s\.feature\]/);
		for (const s of manifest.secrets.filter((s) => s.group === "tooling")) {
			expect(writeMap.map((w) => w.vault)).not.toContain(s.vault);
			expect(enabledSecrets(manifest, new Set(Object.keys(manifest.features)))).not.toContainEqual(
				s,
			);
		}
	});

	it("has an ephemeral, sensitive Terraform variable for every secret, in the module and both stacks", () => {
		for (const { vault, variable } of writeMap) {
			const block = moduleVariables.match(
				new RegExp(`variable "${variable}" \\{([\\s\\S]*?)\\n\\}`),
			)?.[1];
			expect(
				block,
				`${vault}: variable "${variable}" in infra/modules/pixel/variables.tf`,
			).toBeDefined();
			expect(block, `${variable} must be ephemeral`).toMatch(/ephemeral\s*=\s*true/);
			expect(block, `${variable} must be sensitive`).toMatch(/sensitive\s*=\s*true/);

			for (const env of ["dev", "prod"]) {
				expect(
					read(`infra/envs/${env}/variables.tf`),
					`${vault}: variable "${variable}" in infra/envs/${env}/variables.tf`,
				).toMatch(new RegExp(`variable "${variable}" \\{`));
				expect(
					read(`infra/envs/${env}/main.tf`),
					`${vault}: ${variable} passed through in infra/envs/${env}/main.tf`,
				).toMatch(new RegExp(`^\\s+${variable}\\s+=\\s+var\\.${variable}\\s*$`, "m"));
			}
		}
	});

	it("has a Terraform condition for every feature the manifest declares, and no others", () => {
		const start = localsTf.indexOf("secret_features = {");
		const block = localsTf.slice(start, localsTf.indexOf("\n  }", start));
		const keys = [...block.matchAll(/^\s+([a-z][a-z0-9-]*)\s+=/gm)].map(([, key]) => key);
		expect(keys.sort()).toEqual(Object.keys(manifest.features).sort());
	});

	it("is the only place the Terraform locals name a secret", () => {
		for (const { vault } of manifest.secrets) {
			expect(localsTf, `${vault} is hard-coded in locals.tf`).not.toContain(`"${vault}"`);
		}
		expect(localsTf).toContain("secrets.manifest.yaml");
	});

	it("reads the app's secrets from env vars config.ts knows about", () => {
		const config = read("src/config.ts");
		for (const { env, vault } of envSecrets) {
			expect(config, `${vault}: ${env} in src/config.ts`).toMatch(new RegExp(`\\b${env}:`));
		}
	});

	it("documents each environment variable in .env.example, the config table and the runbook", () => {
		const example = read(".env.example");
		const architecture = read("docs/architecture.md");
		const runbook = read("docs/runbook.md");
		for (const { env, vault } of envSecrets) {
			expect(example, `${vault}: ${env} in .env.example`).toMatch(
				new RegExp(`^#?\\s*${env}=`, "m"),
			);
			expect(architecture, `${vault}: ${env} in docs/architecture.md`).toContain(`\`${env}\``);
			expect(runbook, `${vault}: ${env} in docs/runbook.md`).toContain(env);
		}
	});

	it("names every secret's Key Vault name in the runbook or the infra docs", () => {
		const docs = `${read("docs/runbook.md")}\n${read("docs/infra.md")}\n${read("infra/modules/pixel/variables.tf")}`;
		for (const { vault } of manifest.secrets) {
			expect(docs, `${vault} in the runbook, infra doc or Terraform variables`).toContain(vault);
		}
	});

	it("keeps the Pixel container's secret env vars to the app group", () => {
		for (const secret of envSecrets) expect(secret.group).toBe("app");
	});

	it("never holds anything that looks like a secret value", () => {
		const text = read(MANIFEST_FILE);
		expect(text).not.toMatch(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/); // a JWT, such as a Home Assistant token
		expect(text).not.toMatch(/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,40}/); // a Discord bot token
		expect(text).not.toMatch(/https?:\/\/\S+@/); // credentials in a URL (a DSN)
	});
});
