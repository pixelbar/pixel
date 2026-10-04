import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actor, IDS } from "../testing/fixtures.ts";
import {
	AccessConfigError,
	ConfigTierSource,
	loadAccessConfig,
	StoreCapabilitySource,
} from "./access-config.ts";

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

const ADMINS = `admins:\n  - id: "discord:${IDS.admin}"\n`;
/** Every admin needs a members entry too. */
const ADMIN_ENTRY = `  - id: "discord:${IDS.admin}"\n    tier: member\n    note: Ada\n`;
const members = (rest = "") => `members:\n${ADMIN_ENTRY}${rest}`;
const MEMBERS = members(`  - id: "discord:${IDS.member}"
    tier: member
    note: paid yearly
  - id: "discord:${IDS.friend}"
    tier: friend
`);

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

	it("keeps an admin's members entry (capabilities, note) while counting them once, as admin", () => {
		write(
			ADMINS,
			`members:\n  - id: "discord:${IDS.admin}"\n    tier: friend\n    note: Ada\n    capabilities:\n      - front-door\n`,
		);
		const config = loadAccessConfig(paths);
		expect(config.discord.get(IDS.admin)).toBe("admin");
		expect(config.counts).toEqual({ admins: 1, members: 0, friends: 0 });
		expect(config.records.get(IDS.admin)).toEqual({
			discordId: IDS.admin,
			tier: "friend",
			note: "Ada",
			capabilities: ["front-door"],
		});
		expect(config.warnings).toEqual([]);
	});

	it("accepts a members list that holds only the admins", () => {
		write(ADMINS, members());
		expect(loadAccessConfig(paths).counts).toEqual({ admins: 1, members: 0, friends: 0 });
	});

	it("refuses an admin who has no members entry, without echoing the ID", () => {
		write(ADMINS, "members: []\n");
		const error = (() => {
			try {
				loadAccessConfig(paths);
			} catch (e) {
				return e as Error;
			}
		})();
		expect(error).toBeInstanceOf(AccessConfigError);
		expect(error?.message).toMatch(/admins\[0\] has no entry in .*members\.yaml/);
		expect(error?.message).not.toContain(IDS.admin);
	});

	it("refuses the old admins formats, which had names, or were bare strings", () => {
		write(`admins:\n  - name: Ada\n    discordId: "${IDS.admin}"\n`, MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/admins\[0\]/);
		write(`admins:\n  - "discord:${IDS.admin}"\n`, MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/admins\[0\]/);
	});

	it("refuses an old members file that uses discordId, which was renamed to id", () => {
		write(ADMINS, `members:\n  - discordId: "${IDS.admin}"\n    tier: member\n`);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[0\]/);
	});

	it("refuses a bare ID without its platform, telling you what it should look like", () => {
		write(`admins:\n  - id: "${IDS.admin}"\n`, MEMBERS);
		const error = (() => {
			try {
				loadAccessConfig(paths);
			} catch (e) {
				return e as Error;
			}
		})();
		expect(error?.message).toMatch(/admins\[0\]\.id: must be a platform and user ID, e\.g\. "discord:/);
		expect(error?.message).not.toContain(IDS.admin);
	});

	it("rejects unquoted values, which YAML would read as numbers and round", () => {
		write(`admins:\n  - id: ${IDS.admin}\n`, MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/admins\[0\]\.id: must be a quoted string/);
	});

	it.each([
		["a platform that doesn't exist yet", `telegram:${"1".repeat(17)}`],
		["an ID that isn't a snowflake", "discord:ada#1234"],
		["an ID that is too short", "discord:123"],
		["an empty ID", "discord:"],
		["a different case", `Discord:${"1".repeat(17)}`],
	])("rejects %s, in either file", (_label, ref) => {
		write(`admins:\n  - id: "${ref}"\n`, MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/admins\[0\]\.id: must be a platform and user ID/);
		write(ADMINS, `members:\n  - id: "${ref}"\n    tier: member\n`);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[0\]\.id: must be a platform and user ID/);
	});

	it("matches an admin to their members entry by the same id string", () => {
		write(ADMINS, MEMBERS);
		const config = loadAccessConfig(paths);
		expect(config.discord.get(IDS.admin)).toBe("admin");
		expect(config.records.get(IDS.admin)?.discordId).toBe(IDS.admin);
		expect(config.discord.has(`discord:${IDS.admin}`)).toBe(false);
	});

	it("rejects an empty admin list", () => {
		write("admins: []\n", MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/at least one admin is required/);
	});

	it("rejects duplicate admins", () => {
		write(`admins:\n  - id: "discord:${IDS.admin}"\n  - id: "discord:${IDS.admin}"\n`, MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/admins\[1\] duplicates admins\[0\]/);
	});

	it("rejects unknown tiers", () => {
		write(ADMINS, members(`  - id: "discord:${IDS.member}"\n    tier: admin\n`));
		expect(() => loadAccessConfig(paths)).toThrow(/members\[1\]\.tier/);
	});

	it("rejects unknown keys, catching typos", () => {
		write(ADMINS, members(`  - id: "discord:${IDS.member}"\n    teir: member\n`));
		expect(() => loadAccessConfig(paths)).toThrow(AccessConfigError);
	});

	it("rejects duplicate IDs within a file", () => {
		write(
			ADMINS,
			members(`  - id: "discord:${IDS.member}"
    tier: member
  - id: "discord:${IDS.member}"
    tier: friend
`),
		);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[2\] duplicates members\[1\]/);
	});

	it("fails on a missing file", () => {
		writeFileSync(paths.adminsFile, ADMINS);
		expect(() => loadAccessConfig(paths)).toThrow(/members\.yaml: cannot read file \(ENOENT\)/);
	});

	it("reports root-level problems clearly", () => {
		write(`- "discord:${IDS.admin}"\n`, MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/\(root\)/);
	});

	it("fails on an empty file", () => {
		write("", MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/admins\.yaml: invalid access list/);
	});

	it("fails when the path is a directory", () => {
		writeFileSync(paths.membersFile, MEMBERS);
		paths.adminsFile = dir;
		expect(() => loadAccessConfig(paths)).toThrow(/cannot read file \(EISDIR\)/);
	});

	it("fails on invalid YAML without echoing file contents", () => {
		write(`admins:\n  - id: "discord:${IDS.admin}\n  - [\n`, MEMBERS);
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
		write(`admins:\n  - id: "discord:${IDS.admin}"\nextra: "${IDS.guest}"\n`, MEMBERS);
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
		write(ADMINS, members(`  - id: "discord:${IDS.member}"\n${lines}`));

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

describe("StoreCapabilitySource", () => {
	const withCapabilities = () =>
		write(
			ADMINS,
			members(
				`  - id: "discord:${IDS.member}"\n    tier: member\n    capabilities:\n      - front-door\n`,
			),
		);

	it("reports a person's capabilities, and none for someone unlisted", async () => {
		withCapabilities();
		const source = new StoreCapabilitySource({ view: loadAccessConfig(paths) });
		expect(await source.capabilitiesFor(actor({ userId: IDS.member }))).toEqual(["front-door"]);
		expect(await source.capabilitiesFor(actor({ userId: IDS.guest }))).toEqual([]);
		expect(await source.capabilitiesFor(actor({ userId: IDS.admin }))).toEqual([]);
	});

	it("reads the store's current view each time", async () => {
		withCapabilities();
		const store = { view: loadAccessConfig(paths) };
		const source = new StoreCapabilitySource(store);
		write(ADMINS, MEMBERS);
		store.view = loadAccessConfig(paths);
		expect(await source.capabilitiesFor(actor({ userId: IDS.member }))).toEqual([]);
	});

	it("only speaks for Discord identities", async () => {
		withCapabilities();
		const source = new StoreCapabilitySource({ view: loadAccessConfig(paths) });
		const telegramUser = actor({ userId: IDS.member, platform: "telegram" as never });
		expect(await source.capabilitiesFor(telegramUser)).toEqual([]);
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
