import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { expect, describe as group, it } from "vitest";
import { loadSecretsManifest, type SecretEntry } from "../../scripts/secrets-manifest.ts";
import {
	adminsFile,
	azSetArgs,
	azShowArgs,
	compare,
	describe,
	describePull,
	describePush,
	digest,
	envFile,
	envValue,
	isFile,
	isNotFound,
	isShareNotFound,
	localFile,
	localName,
	localValues,
	newEnvFile,
	otherEnvFiles,
	parsePulled,
	parseShown,
	pixelEnvOf,
	pulledRecord,
	pullStep,
	pushes,
	pushStep,
	redactTfvars,
	reusedDiscordToken,
	type ShareFile,
	secretTfvarsFile,
	setEnvValues,
	shareFiles,
	stackVariables,
	syncedSecrets,
	tfvarsFile,
	tfvarsKeys,
	tfvarsProblems,
	toPull,
	toPush,
	VAULTS,
} from "../../scripts/secrets-sync-lib.ts";

// Obviously fake values: none of these is a real token.
const FAKE_TOKEN = "fake-discord-token-for-tests";
const OTHER_TOKEN = "another-fake-token";

const entries = syncedSecrets(loadSecretsManifest());
const byName = (name: string): SecretEntry => {
	const found = entries.find((e) => e.vault === name);
	if (!found) throw new Error(`no ${name}`);
	return found;
};

group("syncedSecrets", () => {
	it("manages the app secrets and never the infra ones", () => {
		const names = entries.map((e) => e.vault);
		expect(names).toContain("discord-token");
		expect(names).toContain("admins-yaml");
		expect(names).not.toContain("tailscale-auth-key");
		expect(names).not.toContain("ghcr-pull-token");
		expect(entries.every((e) => e.group === "app")).toBe(true);
	});

	it("adds the stack's tfvars only for just pull / push", () => {
		const all = syncedSecrets(loadSecretsManifest(), "all");
		const tfvars = all.find((e) => e.vault === "terraform-tfvars");
		expect(tfvars?.group).toBe("tooling");
		expect(all.map((e) => e.vault)).not.toContain("tailscale-auth-key");
		expect(entries.map((e) => e.vault)).not.toContain("terraform-tfvars");
		if (!tfvars) throw new Error("no tfvars");
		expect(isFile(tfvars)).toBe(true);
		expect(localFile(tfvars, "prod")).toBe("infra/envs/prod/terraform.tfvars");
		expect(localName(tfvars, "dev")).toBe("infra/envs/dev/terraform.tfvars");
		expect(azSetArgs(VAULTS.dev, tfvars, "/tmp/x")).toContain("text/x-hcl");
	});

	it("has no local file for a secret it doesn't know", () => {
		expect(() => localFile({ ...byName("admins-yaml"), vault: "other-file" }, "dev")).toThrow(
			"other-file has no local file",
		);
	});
});

group("paths", () => {
	it("uses the same env files as just register, and a gitignored admins copy", () => {
		expect(envFile("dev")).toBe(".env.dev");
		expect(envFile("prod")).toBe(".env.prod");
		expect(adminsFile("prod")).toBe("config/admins.prod.yaml");
		expect(localName(byName("discord-token"), "dev")).toBe("DISCORD_TOKEN in .env.dev");
		expect(localName(byName("admins-yaml"), "dev")).toBe("config/admins.dev.yaml");
	});

	it("points each env at its own vault and app", () => {
		expect(VAULTS.dev).toEqual({
			vault: "pixel-dev-kv",
			resourceGroup: "pixel-dev",
			app: "pixel-dev",
		});
		expect(VAULTS.prod.vault).toBe("pixel-prod-kv");
	});
});

group("localValues", () => {
	it("reads env secrets by their variable and admins from the file, skipping empty ones", () => {
		const env = `# comment\nDISCORD_TOKEN=${FAKE_TOKEN}\nSENTRY_DSN=\nPIXEL_ENV=dev\n`;
		const values = localValues(entries, env, new Map([["admins-yaml", "admins: []\n"]]));
		expect(values.get("discord-token")).toBe(FAKE_TOKEN);
		expect(values.get("admins-yaml")).toBe("admins: []\n");
		expect(values.has("sentry-dsn")).toBe(false);
		expect(values.has("home-assistant-token")).toBe(false);
	});

	it("is empty when there are no local files", () => {
		expect(localValues(entries, undefined, new Map()).size).toBe(0);
	});
});

group("compare", () => {
	const pick = [
		byName("discord-token"),
		byName("sentry-dsn"),
		byName("spacestate-user"),
		byName("spacestate-token"),
		byName("mastodon-access-token"),
	];
	const local = new Map([
		["discord-token", "VAL-LOCAL"],
		["sentry-dsn", "VAL-SAME"],
		["spacestate-user", "VAL-NEW"],
	]);
	const remote = new Map([
		["discord-token", "VAL-REMOTE"],
		["sentry-dsn", "VAL-SAME"],
		["spacestate-token", "VAL-ONLY-REMOTE"],
	]);
	const rows = compare(pick, local, remote);
	const status = Object.fromEntries(rows.map((r) => [r.entry.vault, r.status]));

	it("names each secret's state", () => {
		expect(status).toEqual({
			"discord-token": "changed",
			"sentry-dsn": "same",
			"spacestate-user": "local-only",
			"spacestate-token": "remote-only",
			"mastodon-access-token": "neither",
		});
	});

	it("pushes changed and new values, and never deletes", () => {
		expect(toPush(rows).map((r) => r.entry.vault)).toEqual(["discord-token", "spacestate-user"]);
	});

	it("pulls changed values and ones only Key Vault has", () => {
		expect(toPull(rows).map((r) => r.entry.vault)).toEqual(["discord-token", "spacestate-token"]);
	});

	it("describes rows without ever showing a value", () => {
		const lines = [
			...rows.map((r) => describe(r, "push", "dev")),
			...rows.map((r) => describe(r, "pull", "dev")),
		];
		for (const line of lines) {
			expect(line).not.toContain("VAL-");
		}
		expect(lines).toEqual([
			"  ~ discord-token (DISCORD_TOKEN in .env.dev): changes (10 characters → 9 characters)",
			"  = sentry-dsn (SENTRY_DSN in .env.dev): the same",
			"  + spacestate-user (SPACESTATE_USER in .env.dev): new in Key Vault (7 characters)",
			"  ! spacestate-token (SPACESTATE_TOKEN in .env.dev): only in Key Vault (left as it is; a push never deletes)",
			"  - mastodon-access-token (MASTODON_ACCESS_TOKEN in .env.dev): not set either side",
			"  ~ discord-token (DISCORD_TOKEN in .env.dev): changes (9 characters → 10 characters)",
			"  = sentry-dsn (SENTRY_DSN in .env.dev): the same",
			"  ! spacestate-user (SPACESTATE_USER in .env.dev): only local, not in Key Vault (left as it is)",
			"  + spacestate-token (SPACESTATE_TOKEN in .env.dev): new locally (15 characters)",
			"  - mastodon-access-token (MASTODON_ACCESS_TOKEN in .env.dev): not set either side",
		]);
	});

	it("says unset for a missing side", () => {
		const [row] = compare([byName("sentry-dsn")], new Map([["sentry-dsn", "x"]]), new Map());
		if (!row) throw new Error("no row");
		expect(describe({ ...row, status: "changed" }, "pull", "prod")).toContain(
			"(1 character → unset)",
		);
	});
});

group("envValue", () => {
	it("leaves token-shaped values bare", () => {
		expect(envValue("K", "abc.DEF-123_x:/+=@")).toBe("abc.DEF-123_x:/+=@");
		expect(envValue("K", "")).toBe("");
	});

	it("quotes values with spaces or a hash, and they read back the same", () => {
		for (const value of ["has space", "has#hash", "it's", 'say "hi"', "back\\slash"]) {
			const line = `K=${envValue("K", value)}`;
			expect(parseEnv(line).K).toBe(value);
		}
	});

	it("refuses what an env file can't hold", () => {
		expect(() => envValue("K", "two\nlines")).toThrow("K can't be written");
		expect(() => envValue("K", `both ' and "`)).toThrow("K can't be written");
	});
});

group("setEnvValues", () => {
	it("replaces in place, keeps comments, drops later duplicates and appends new keys", () => {
		const text = `# Pixel Dev\nPIXEL_ENV=dev\nexport DISCORD_TOKEN=old\n# keep me\nDISCORD_TOKEN=older\n`;
		const next = setEnvValues(
			text,
			new Map([
				["DISCORD_TOKEN", FAKE_TOKEN],
				["SENTRY_DSN", "https://key@example.invalid/1"],
			]),
		);
		expect(next).toBe(
			`# Pixel Dev\nPIXEL_ENV=dev\nDISCORD_TOKEN=${FAKE_TOKEN}\n# keep me\nSENTRY_DSN=https://key@example.invalid/1\n`,
		);
		expect(parseEnv(next).DISCORD_TOKEN).toBe(FAKE_TOKEN);
	});

	it("doesn't touch keys that only share a prefix", () => {
		expect(setEnvValues("DISCORD_TOKEN_X=1\n", new Map([["DISCORD_TOKEN", "2"]]))).toBe(
			"DISCORD_TOKEN_X=1\nDISCORD_TOKEN=2\n",
		);
	});

	it("starts an empty file", () => {
		expect(setEnvValues("", new Map([["A", "1"]]))).toBe("A=1\n");
	});
});

group("env guards", () => {
	it("starts a new env file with the right PIXEL_ENV", () => {
		expect(pixelEnvOf(newEnvFile("prod"))).toBe("prod");
		expect(pixelEnvOf(newEnvFile("dev"))).toBe("dev");
	});

	it("reads PIXEL_ENV, treating anything else as local", () => {
		expect(pixelEnvOf(undefined)).toBe("local");
		expect(pixelEnvOf("PIXEL_ENV=staging\n")).toBe("local");
		expect(pixelEnvOf("PIXEL_ENV=prod\n")).toBe("prod");
	});

	it("checks prod against the dev and Mini bots, and dev against prod", () => {
		expect(otherEnvFiles("prod")).toEqual([".env.dev", ".env"]);
		expect(otherEnvFiles("dev")).toEqual([".env.prod"]);
	});

	it("finds a Discord token that belongs to another bot", () => {
		const others = [
			{ file: ".env.dev", text: `DISCORD_TOKEN=${OTHER_TOKEN}\n` },
			{ file: ".env", text: `DISCORD_TOKEN=${FAKE_TOKEN}\n` },
		];
		expect(reusedDiscordToken(FAKE_TOKEN, others)).toBe(".env");
		expect(reusedDiscordToken("unique-fake", others)).toBeUndefined();
		expect(reusedDiscordToken(undefined, others)).toBeUndefined();
	});
});

group("az", () => {
	it("reads a secret's value as JSON", () => {
		expect(azShowArgs(VAULTS.dev, "discord-token")).toEqual([
			"keyvault",
			"secret",
			"show",
			"--only-show-errors",
			"--vault-name",
			"pixel-dev-kv",
			"--name",
			"discord-token",
			"--query",
			"value",
			"--output",
			"json",
		]);
	});

	it("sets a secret from a file, so the value is never in the command line", () => {
		const args = azSetArgs(VAULTS.prod, byName("admins-yaml"), "/tmp/x");
		expect(args).toContain("--file");
		expect(args).not.toContain("--value");
		expect(args.slice(args.indexOf("--vault-name"), args.indexOf("--vault-name") + 4)).toEqual([
			"--vault-name",
			"pixel-prod-kv",
			"--name",
			"admins-yaml",
		]);
		expect(args[args.indexOf("--content-type") + 1]).toBe("text/yaml");
		const token = azSetArgs(VAULTS.dev, byName("discord-token"), "/tmp/x");
		expect(token[token.indexOf("--content-type") + 1]).toBe("text/plain");
	});

	it("tells a missing secret from other failures", () => {
		expect(isNotFound("ERROR: (SecretNotFound) A secret with (name/id) x was not found")).toBe(
			true,
		);
		expect(isNotFound("ERROR: (Forbidden) Caller is not authorized")).toBe(false);
	});

	it("parses the shown value, including multi-line YAML", () => {
		expect(parseShown(JSON.stringify("admins:\n  - ids: []\n"))).toBe("admins:\n  - ids: []\n");
		expect(() => parseShown("null")).toThrow("isn't text");
	});
});

group("tfvars", () => {
	const variables = stackVariables(`variable "prefix" {
  type    = string
  default = "pixel"
}

variable "key_vault_name" {
  type = string
}

variable "data_storage_account_name" {
  type = string
}

variable "discord_token" {
  type      = string
  default   = null
  sensitive = true
  ephemeral = true
}
`);

	it("reads a stack's variables and which are secret", () => {
		expect([...variables.all].sort()).toEqual([
			"data_storage_account_name",
			"discord_token",
			"key_vault_name",
			"prefix",
		]);
		expect([...variables.sensitive]).toEqual(["discord_token"]);
	});

	it("reads the real stacks' variables, with the Tailscale key as a secret", () => {
		for (const env of ["dev", "prod"] as const) {
			const real = stackVariables(readFileSync(`infra/envs/${env}/variables.tf`, "utf8"));
			expect(real.sensitive.has("tailscale_auth_key")).toBe(true);
			// App secrets are no longer Terraform inputs at all (ADR 0017).
			expect(real.all.has("discord_token")).toBe(false);
			expect(real.sensitive.has("discord_app_id")).toBe(false);
			expect(real.all.has("discord_app_id")).toBe(true);
		}
	});

	it("reads the top-level keys, not indented or commented ones", () => {
		expect(
			tfvarsKeys('prefix = "pixel"\n# discord_token = "x"\nmap = {\n  inner = 1\n}\n'),
		).toEqual(["prefix", "map"]);
	});

	it("accepts the env's own settings", () => {
		const text =
			'prefix = "pixel"\nkey_vault_name = "pixel-dev-kv"\ndata_storage_account_name = "pixeldevdata"\n';
		expect(tfvarsProblems(text, "dev", variables)).toEqual([]);
	});

	it("refuses secrets, unknown variables and the other env's names, naming keys only", () => {
		const text = [
			`discord_token = "${FAKE_TOKEN}"`,
			'typo_name = "x"',
			'key_vault_name = "pixel-dev-kv"',
			'data_storage_account_name = "pixeldevdata"',
		].join("\n");
		const problems = tfvarsProblems(text, "prod", variables);
		expect(problems).toEqual([
			"infra/envs/prod/terraform.tfvars sets discord_token, which is a secret. Move it to infra/envs/prod/secrets.auto.tfvars.",
			"infra/envs/prod/terraform.tfvars sets typo_name, which infra/envs/prod doesn't declare.",
			'infra/envs/prod/terraform.tfvars says key_vault_name = "pixel-dev-kv", but prod is pixel-prod-kv.',
			'infra/envs/prod/terraform.tfvars says data_storage_account_name = "pixeldevdata", but prod is pixelproddata.',
		]);
		expect(problems.join("\n")).not.toContain(FAKE_TOKEN);
	});

	it("hides every sensitive value before a diff, commented ones too", () => {
		const text = [
			'prefix = "pixel"',
			`discord_token = "${FAKE_TOKEN}"`,
			`# discord_token = "${OTHER_TOKEN}"`,
			`  discord_token="${FAKE_TOKEN}"`,
			"# a comment about discord_token",
		].join("\n");
		const out = redactTfvars(text, variables.sensitive);
		expect(out).toBe(
			[
				'prefix = "pixel"',
				"discord_token = (secret, hidden)",
				"# discord_token = (secret, hidden)",
				"  discord_token=(secret, hidden)",
				"# a comment about discord_token",
			].join("\n"),
		);
		expect(out).not.toContain(FAKE_TOKEN);
		expect(out).not.toContain(OTHER_TOKEN);
	});

	it("keeps secret inputs in an auto-loaded file next to it", () => {
		expect(tfvarsFile("dev")).toBe("infra/envs/dev/terraform.tfvars");
		expect(secretTfvarsFile("dev")).toBe("infra/envs/dev/secrets.auto.tfvars");
	});
});

group("share files", () => {
	const at = (path: string): ShareFile => {
		const file = shareFiles("dev").find((f) => f.path === path);
		if (file === undefined) throw new Error(`no ${path}`);
		return file;
	};
	const check = (path: string, text: string) => at(path).check?.(text, `mirror/${path}`);

	it("mirrors every config and data file on the share under config/<env>/", () => {
		expect(shareFiles("prod").map((f) => [f.path, f.mirror, f.pickup])).toEqual([
			["members.yaml", "config/prod/members.yaml", "reload"],
			["home-assistant/devices.yaml", "config/home-assistant/prod/devices.yaml", "reload"],
			["data/schedules.yaml", "config/prod/data/schedules.yaml", "restart"],
			["data/parking-spots.yaml", "config/prod/data/parking-spots.yaml", "restart"],
			["data/parking-windows.yaml", "config/prod/data/parking-windows.yaml", "restart"],
			["data/parking-bookings.yaml", "config/prod/data/parking-bookings.yaml", "restart"],
			["data/announcement-routes.yaml", "config/prod/data/announcement-routes.yaml", "restart"],
			["data/closing-time.md", "config/prod/data/closing-time.md", "none"],
		]);
	});

	it("never mirrors the door session or the logs", () => {
		const paths = shareFiles("dev").map((f) => f.path);
		expect(paths).not.toContain("data/openr-session.json");
		expect(paths.some((p) => p.startsWith("data/logs"))).toBe(false);
	});

	it("checks each data file the way Pixel loads it, naming the mirror", () => {
		for (const path of [
			"data/schedules.yaml",
			"data/parking-spots.yaml",
			"data/parking-windows.yaml",
			"data/parking-bookings.yaml",
		]) {
			expect(check(path, "{")).toMatch(new RegExp(`^mirror/${path} `));
		}
		expect(check("data/announcement-routes.yaml", "routes: nope")).toBe(
			"mirror/data/announcement-routes.yaml is invalid",
		);
		expect(check("home-assistant/devices.yaml", "{")).toMatch(
			/^mirror\/home-assistant\/devices\.yaml: invalid YAML/,
		);
		expect(at("data/closing-time.md").check).toBeUndefined();
		expect(at("members.yaml").check).toBeUndefined();
	});

	it("passes files Pixel can read", () => {
		expect(check("data/schedules.yaml", "schedules: []\n")).toBeUndefined();
		expect(check("data/announcement-routes.yaml", "routes: []\n")).toBeUndefined();
		expect(check("home-assistant/devices.yaml", "devices: []\n")).toBeUndefined();
	});

	it("records what each file was when pulled", () => {
		const pulled = pulledRecord(
			new Map([
				["members.yaml", "a"],
				["data/schedules.yaml", undefined],
			]),
		);
		expect(pulled).toEqual({ "members.yaml": digest("a"), "data/schedules.yaml": null });
		expect(parsePulled(JSON.stringify(pulled))).toEqual(pulled);
	});

	it("reads a missing or broken record as nothing pulled", () => {
		expect(parsePulled(undefined)).toEqual({});
		expect(parsePulled("{")).toEqual({});
		expect(parsePulled("[]")).toEqual({});
		expect(parsePulled("null")).toEqual({});
		expect(parsePulled('{"a": 1, "b": null, "c": "x"}')).toEqual({ b: null, c: "x" });
	});

	it("refreshes mirrors you haven't edited and asks about ones you have", () => {
		const base = digest("old");
		expect(pullStep("x", "x", base)).toBe("same");
		expect(pullStep(undefined, undefined, undefined)).toBe("absent");
		expect(pullStep("old", "new", base)).toBe("write");
		expect(pullStep(undefined, "new", base)).toBe("write");
		expect(pullStep("old", undefined, base)).toBe("remove");
		expect(pullStep("mine", "new", base)).toBe("ask");
		expect(pullStep("mine", undefined, base)).toBe("keep");
		expect(pullStep("mine", undefined, null)).toBe("keep");
		// Without a record, any difference might be an edit.
		expect(pullStep("mine", "new", undefined)).toBe("ask");
		expect(pullStep("mine", undefined, undefined)).toBe("keep");
	});

	it("pushes only your edits, and only over what you pulled", () => {
		const base = digest("old");
		expect(pushStep(undefined, "old", base)).toBe("missing");
		expect(pushStep("x", "x", base)).toBe("same");
		// A stale mirror never goes back over Pixel's changes.
		expect(pushStep("old", "newer", base)).toBe("unedited");
		expect(pushStep("mine", "newer", undefined)).toBe("unknown");
		expect(pushStep("mine", "newer", base)).toBe("moved");
		expect(pushStep("mine", undefined, base)).toBe("moved");
		expect(pushStep("mine", "old", base)).toBe("change");
		expect(pushStep("mine", undefined, null)).toBe("create");
		expect(pushStep("mine", "new", null)).toBe("moved");
		expect(
			(["missing", "same", "unedited", "unknown", "moved", "create", "change"] as const).filter(
				pushes,
			),
		).toEqual(["create", "change"]);
	});

	it("describes a share file without its contents", () => {
		const members = at("members.yaml");
		expect(describePush(members, "same", "dev")).toBe("  = members.yaml: the same");
		expect(describePush(members, "change", "dev")).toBe(
			"  ~ members.yaml: changes (from config/dev/members.yaml)",
		);
		expect(describePush(members, "create", "dev")).toBe(
			"  + members.yaml: new on the share (from config/dev/members.yaml)",
		);
		expect(describePush(members, "missing", "dev")).toBe(
			"  - members.yaml: no config/dev/members.yaml (left as it is)",
		);
		expect(describePush(members, "unedited", "dev")).toContain("not edited since the pull");
		expect(describePush(members, "unknown", "dev")).toContain("run just pull dev first");
		expect(describePush(members, "moved", "dev")).toContain("changed on the share");
		expect(describePull(members, "same")).toBe("  = members.yaml → config/dev/members.yaml");
		expect(describePull(members, "write")).toBe("  ~ members.yaml → config/dev/members.yaml");
		expect(describePull(members, "absent")).toBe("  - members.yaml: not on the share");
		expect(describePull(members, "remove")).toContain("gone from the share");
		expect(describePull(members, "ask")).toContain("you edited config/dev/members.yaml");
		expect(describePull(members, "keep")).toContain("just push sends it");
	});

	it("tells a missing file from other failures", () => {
		expect(
			isShareNotFound("ERROR: The specified resource does not exist. ErrorCode: ResourceNotFound"),
		).toBe(true);
		expect(isShareNotFound("ERROR: ParentNotFound")).toBe(true);
		expect(isShareNotFound("ERROR: AuthorizationPermissionMismatch")).toBe(false);
	});
});
