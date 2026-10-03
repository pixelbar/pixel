import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actor, IDS } from "../testing/fixtures.ts";
import { AccessConfigError, ConfigTierSource, loadAccessConfig } from "./access-config.ts";

let dir: string;
let paths: { adminsFile: string; membersFile: string };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-access-"));
	paths = { adminsFile: join(dir, "admins.yaml"), membersFile: join(dir, "members.yaml") };
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(admins: string, members: string) {
	writeFileSync(paths.adminsFile, admins);
	writeFileSync(paths.membersFile, members);
}

const ADMINS = `admins:\n  - name: Ada\n    discordId: "${IDS.admin}"\n`;
const MEMBERS = `members:
  - discordId: "${IDS.member}"
    tier: member
    note: paid yearly
  - discordId: "${IDS.friend}"
    tier: friend
`;

describe("loadAccessConfig", () => {
	it("loads valid files", () => {
		write(ADMINS, MEMBERS);
		const config = loadAccessConfig(paths);
		expect(config.discord.get(IDS.admin)).toBe("admin");
		expect(config.discord.get(IDS.member)).toBe("member");
		expect(config.discord.get(IDS.friend)).toBe("friend");
		expect(config.discord.get(IDS.guest)).toBeUndefined();
		expect(config.counts).toEqual({ admins: 1, members: 1, friends: 1 });
		expect(config.warnings).toEqual([]);
	});

	it("accepts an empty members list", () => {
		write(ADMINS, "members: []\n");
		expect(loadAccessConfig(paths).counts).toEqual({ admins: 1, members: 0, friends: 0 });
	});

	it("rejects unquoted (numeric) IDs, which would silently lose precision", () => {
		write(`admins:\n  - name: Ada\n    discordId: ${IDS.admin}\n`, "members: []\n");
		expect(() => loadAccessConfig(paths)).toThrow(
			/admins\[0\]\.discordId: must be a quoted string/,
		);
	});

	it("rejects IDs that aren't snowflakes", () => {
		write(`admins:\n  - name: Ada\n    discordId: "ada#1234"\n`, "members: []\n");
		expect(() => loadAccessConfig(paths)).toThrow(/must be a Discord user ID/);
	});

	it("rejects an empty admin list", () => {
		write("admins: []\n", "members: []\n");
		expect(() => loadAccessConfig(paths)).toThrow(/at least one admin is required/);
	});

	it("rejects unknown tiers", () => {
		write(ADMINS, `members:\n  - discordId: "${IDS.member}"\n    tier: admin\n`);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[0\]\.tier/);
	});

	it("rejects unknown keys, catching typos", () => {
		write(ADMINS, `members:\n  - discordId: "${IDS.member}"\n    teir: member\n`);
		expect(() => loadAccessConfig(paths)).toThrow(AccessConfigError);
	});

	it("rejects duplicate IDs within a file", () => {
		write(
			ADMINS,
			`members:
  - discordId: "${IDS.member}"
    tier: member
  - discordId: "${IDS.member}"
    tier: friend
`,
		);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[1\] duplicates members\[0\]/);
	});

	it("lets admin win over a members entry, with a warning that contains no IDs", () => {
		write(ADMINS, `members:\n  - discordId: "${IDS.admin}"\n    tier: friend\n`);
		const config = loadAccessConfig(paths);
		expect(config.discord.get(IDS.admin)).toBe("admin");
		expect(config.counts).toEqual({ admins: 1, members: 0, friends: 0 });
		expect(config.warnings).toHaveLength(1);
		expect(config.warnings[0]).not.toContain(IDS.admin);
	});

	it("fails on a missing file", () => {
		writeFileSync(paths.adminsFile, ADMINS);
		expect(() => loadAccessConfig(paths)).toThrow(/members\.yaml: cannot read file \(ENOENT\)/);
	});

	it("reports root-level problems clearly", () => {
		write(`- "${IDS.admin}"\n`, "members: []\n");
		expect(() => loadAccessConfig(paths)).toThrow(/\(root\)/);
	});

	it("fails on an empty file", () => {
		write("", "members: []\n");
		expect(() => loadAccessConfig(paths)).toThrow(/admins\.yaml: invalid access list/);
	});

	it("fails when the path is a directory", () => {
		writeFileSync(paths.membersFile, "members: []\n");
		paths.adminsFile = dir;
		expect(() => loadAccessConfig(paths)).toThrow(/cannot read file \(EISDIR\)/);
	});

	it("fails on invalid YAML without echoing file contents", () => {
		write(`admins:\n  - name: "${IDS.admin}\n    discordId: [\n`, "members: []\n");
		let message = "";
		try {
			loadAccessConfig(paths);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/invalid YAML/);
		expect(message).not.toContain(IDS.admin);
	});

	it("never echoes values in validation errors", () => {
		write(
			`admins:\n  - name: Ada\n    discordId: "${IDS.admin}"\n    extra: "${IDS.guest}"\n`,
			"members: []\n",
		);
		expect(() => loadAccessConfig(paths)).toThrow(AccessConfigError);
		try {
			loadAccessConfig(paths);
		} catch (error) {
			expect((error as Error).message).not.toContain(IDS.guest);
			expect((error as Error).message).not.toContain(IDS.admin);
		}
	});
});

describe("guests and capabilities", () => {
	const withEntry = (lines: string) =>
		write(ADMINS, `members:\n  - discordId: "${IDS.member}"\n${lines}`);

	it("keeps a guest entry but gives it no tier and doesn't count it", () => {
		withEntry("    tier: guest\n    capabilities:\n      - front-door\n");
		const config = loadAccessConfig(paths);
		expect(config.discord.has(IDS.member)).toBe(false);
		expect(config.counts).toEqual({ admins: 1, members: 0, friends: 0 });
		expect(config.records.get(IDS.member)).toEqual({
			discordId: IDS.member,
			tier: "guest",
			capabilities: ["front-door"],
		});
	});

	it("defaults to no capabilities and passes the note through", () => {
		withEntry("    tier: member\n    note: hi\n");
		expect(loadAccessConfig(paths).records.get(IDS.member)).toEqual({
			discordId: IDS.member,
			tier: "member",
			note: "hi",
			capabilities: [],
		});
	});

	it.each([
		[
			"a bad name",
			"    tier: member\n    capabilities:\n      - Front Door\n",
			/capabilities\[0\]/,
		],
		["a repeated name", "    tier: member\n    capabilities: [a, a]\n", /must not repeat/],
		["a non-list", "    tier: member\n    capabilities: front-door\n", /capabilities/],
	])("rejects %s", (_label, lines, message) => {
		withEntry(lines);
		expect(() => loadAccessConfig(paths)).toThrow(message);
	});

	it("rejects more capabilities than the limit", () => {
		const names = Array.from({ length: 51 }, (_, i) => `c${i}`).join(", ");
		withEntry(`    tier: member\n    capabilities: [${names}]\n`);
		expect(() => loadAccessConfig(paths)).toThrow(/at most 50/);
	});
});

describe("ConfigTierSource", () => {
	it("returns tiers for listed Discord users and null otherwise", async () => {
		write(ADMINS, MEMBERS);
		const source = new ConfigTierSource({ view: loadAccessConfig(paths) });
		expect(await source.tierFor(actor({ userId: IDS.member }))).toBe("member");
		expect(await source.tierFor(actor({ userId: IDS.guest }))).toBeNull();
	});

	it("only vouches for Discord identities", async () => {
		write(ADMINS, MEMBERS);
		const source = new ConfigTierSource({ view: loadAccessConfig(paths) });
		// Another platform's user with a colliding numeric ID must not inherit a Discord tier.
		const telegramUser = actor({ userId: IDS.admin, platform: "telegram" as never });
		expect(await source.tierFor(telegramUser)).toBeNull();
	});
});
