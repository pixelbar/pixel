import { parseEnv } from "node:util";
import { expect, describe as group, it } from "vitest";
import { loadSecretsManifest, type SecretEntry } from "./secrets-manifest.ts";
import {
	adminsFile,
	azSetArgs,
	azShowArgs,
	compare,
	describe,
	envFile,
	envValue,
	isNotFound,
	localName,
	localValues,
	newEnvFile,
	otherEnvFiles,
	parseShown,
	pixelEnvOf,
	reusedDiscordToken,
	setEnvValues,
	syncedSecrets,
	toPull,
	toPush,
	VAULTS,
} from "./secrets-sync-lib.ts";

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
		const values = localValues(entries, env, "admins: []\n");
		expect(values.get("discord-token")).toBe(FAKE_TOKEN);
		expect(values.get("admins-yaml")).toBe("admins: []\n");
		expect(values.has("sentry-dsn")).toBe(false);
		expect(values.has("home-assistant-token")).toBe(false);
	});

	it("is empty when there are no local files", () => {
		expect(localValues(entries, undefined, undefined).size).toBe(0);
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
