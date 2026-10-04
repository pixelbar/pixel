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

const ADMINS = `admins:\n  - ids: ["discord:${IDS.admin}"]\n`;
/** Every admin needs a members entry too. */
const ADMIN_ENTRY = `  - ids: ["discord:${IDS.admin}"]\n    tier: member\n    note: Ada\n`;
const members = (rest = "") => `members:\n${ADMIN_ENTRY}${rest}`;
const MEMBERS = members(`  - ids: ["discord:${IDS.member}"]
    tier: member
    note: paid yearly
  - ids: ["discord:${IDS.friend}"]
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
			`members:\n  - ids: ["discord:${IDS.admin}"]\n    tier: friend\n    note: Ada\n    capabilities:\n      - front-door\n`,
		);
		const config = loadAccessConfig(paths);
		expect(config.discord.get(IDS.admin)).toBe("admin");
		expect(config.counts).toEqual({ admins: 1, members: 0, friends: 0 });
		expect(config.records.get(IDS.admin)).toEqual({
			ids: [`discord:${IDS.admin}`],
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
		expect(error?.message).toMatch(/admins\[0\] has an id with no entry in .*members\.yaml/);
		expect(error?.message).not.toContain(IDS.admin);
	});

	it("refuses the older formats: names, single id keys, bare strings and discordId", () => {
		const forms = [
			`admins:\n  - name: Ada\n    discordId: "${IDS.admin}"\n`,
			`admins:\n  - id: "discord:${IDS.admin}"\n`,
			`admins:\n  - "discord:${IDS.admin}"\n`,
		];
		for (const form of forms) {
			write(form, MEMBERS);
			expect(() => loadAccessConfig(paths)).toThrow(/admins\[0\]/);
		}
		write(ADMINS, `members:\n  - discordId: "${IDS.admin}"\n    tier: member\n`);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[0\]/);
		write(ADMINS, `members:\n  - id: "discord:${IDS.admin}"\n    tier: member\n`);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[0\]/);
	});

	it("refuses a bare ID without its platform, telling you what it should look like", () => {
		write(`admins:\n  - ids: ["${IDS.admin}"]\n`, MEMBERS);
		const error = (() => {
			try {
				loadAccessConfig(paths);
			} catch (e) {
				return e as Error;
			}
		})();
		expect(error?.message).toMatch(
			/admins\[0\]\.ids\[0\]: must be a platform and user ID, e\.g\. "discord:/,
		);
		expect(error?.message).not.toContain(IDS.admin);
	});

	it("rejects unquoted values, which YAML would read as numbers and round", () => {
		write(`admins:\n  - ids: [${IDS.admin}]\n`, MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/admins\[0\]\.ids\[0\]: must be a quoted string/);
	});

	it.each([
		["a platform that doesn't exist yet", `telegram:${"1".repeat(17)}`],
		["an ID that isn't a snowflake", "discord:ada#1234"],
		["an ID that is too short", "discord:123"],
		["an empty ID", "discord:"],
		["a different case", `Discord:${"1".repeat(17)}`],
	])("rejects %s, in either file", (_label, ref) => {
		write(`admins:\n  - ids: ["${ref}"]\n`, MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(
			/admins\[0\]\.ids\[0\]: must be a platform and user ID/,
		);
		write(ADMINS, `members:\n  - ids: ["${ref}"]\n    tier: member\n`);
		expect(() => loadAccessConfig(paths)).toThrow(
			/members\[0\]\.ids\[0\]: must be a platform and user ID/,
		);
	});

	it("needs at least one id per entry, and not too many", () => {
		write(`admins:\n  - ids: []\n`, MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/admins\[0\]\.ids: at least one id is required/);
		write(ADMINS, `members:\n  - ids: []\n    tier: member\n`);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[0\]\.ids: at least one id is required/);
		const many = Array.from({ length: 11 }, (_, i) => `"discord:${100000000000000100 + i}"`).join(
			", ",
		);
		write(ADMINS, `members:\n  - ids: [${many}]\n    tier: member\n`);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[0\]\.ids: at most 10 ids/);
	});

	it("matches an admin to their members entry by the same id string", () => {
		write(ADMINS, MEMBERS);
		const config = loadAccessConfig(paths);
		expect(config.discord.get(IDS.admin)).toBe("admin");
		expect(config.records.get(IDS.admin)?.ids).toEqual([`discord:${IDS.admin}`]);
		expect(config.discord.has(`discord:${IDS.admin}`)).toBe(false);
	});

	it("rejects an empty admin list", () => {
		write("admins: []\n", MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(/at least one admin is required/);
	});

	it("rejects duplicate admins", () => {
		write(
			`admins:\n  - ids: ["discord:${IDS.admin}"]\n  - ids: ["discord:${IDS.admin}"]\n`,
			MEMBERS,
		);
		expect(() => loadAccessConfig(paths)).toThrow(/admins\[1\]\.ids\[0\] duplicates admins\[0\]\.ids\[0\]/);
	});

	it("rejects unknown tiers", () => {
		write(ADMINS, members(`  - ids: ["discord:${IDS.member}"]\n    tier: admin\n`));
		expect(() => loadAccessConfig(paths)).toThrow(/members\[1\]\.tier/);
	});

	it("rejects unknown keys, catching typos", () => {
		write(ADMINS, members(`  - ids: ["discord:${IDS.member}"]\n    teir: member\n`));
		expect(() => loadAccessConfig(paths)).toThrow(AccessConfigError);
	});

	it("rejects duplicate IDs within a file", () => {
		write(
			ADMINS,
			members(`  - ids: ["discord:${IDS.member}"]
    tier: member
  - ids: ["discord:${IDS.member}"]
    tier: friend
`),
		);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[2\]\.ids\[0\] duplicates members\[1\]\.ids\[0\]/);
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
		write(`admins:\n  - ids: ["discord:${IDS.admin}"\n  - [\n`, MEMBERS);
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
		write(`admins:\n  - ids: ["discord:${IDS.admin}"]\nextra: "${IDS.guest}"\n`, MEMBERS);
		expect(() => loadAccessConfig(paths)).toThrow(AccessConfigError);
		try {
			loadAccessConfig(paths);
		} catch (error) {
			expect((error as Error).message).not.toContain(IDS.guest);
			expect((error as Error).message).not.toContain(IDS.admin);
		}
	});
});

describe("one person with several ids", () => {
	const SECOND = "100000000000000070";
	const THIRD = "100000000000000071";
	const person = (extra = "") =>
		`  - ids: ["discord:${IDS.member}", "discord:${SECOND}"]\n    tier: member\n    capabilities:\n      - front-door\n${extra}`;

	it("gives each of a person's ids the same tier, capabilities and record", () => {
		write(ADMINS, members(person()));
		const config = loadAccessConfig(paths);
		expect(config.discord.get(IDS.member)).toBe("member");
		expect(config.discord.get(SECOND)).toBe("member");
		expect(config.records.get(IDS.member)).toBe(config.records.get(SECOND));
		expect(config.records.get(SECOND)?.ids).toEqual([`discord:${IDS.member}`, `discord:${SECOND}`]);
		expect(config.records.get(SECOND)?.capabilities).toEqual(["front-door"]);
	});

	it("counts a person once, however many ids they have", () => {
		write(ADMINS, members(person()));
		expect(loadAccessConfig(paths).counts).toEqual({ admins: 1, members: 1, friends: 0 });
	});

	it("leaves out all of a guest's ids", () => {
		write(ADMINS, members(person().replace("tier: member", "tier: guest")));
		const config = loadAccessConfig(paths);
		expect(config.discord.has(IDS.member)).toBe(false);
		expect(config.discord.has(SECOND)).toBe(false);
		expect(config.counts).toEqual({ admins: 1, members: 0, friends: 0 });
	});

	it("refuses an id that appears twice across entries, naming positions and never the id", () => {
		write(
			ADMINS,
			members(
				`  - ids: ["discord:${IDS.member}"]\n    tier: member\n  - ids: ["discord:${SECOND}", "discord:${IDS.member}"]\n    tier: friend\n`,
			),
		);
		const error = (() => {
			try {
				loadAccessConfig(paths);
			} catch (e) {
				return e as Error;
			}
		})();
		expect(error?.message).toMatch(/members\[2\]\.ids\[1\] duplicates members\[1\]\.ids\[0\]/);
		expect(error?.message).not.toContain(IDS.member);
	});

	it("refuses an id repeated inside one entry", () => {
		write(
			ADMINS,
			members(`  - ids: ["discord:${IDS.member}", "discord:${IDS.member}"]\n    tier: member\n`),
		);
		expect(() => loadAccessConfig(paths)).toThrow(/members\[1\]\.ids: must not repeat an id/);
	});

	it("makes only the listed ids admin, while the whole person counts once as an admin", () => {
		write(`admins:\n  - ids: ["discord:${IDS.member}"]\n`, members(person()));
		const config = loadAccessConfig(paths);
		expect(config.discord.get(IDS.member)).toBe("admin");
		expect(config.discord.get(SECOND)).toBe("member");
		expect(config.counts).toEqual({ admins: 1, members: 1, friends: 0 });
	});

	it("accepts an admin entry that lists several of one person's ids", () => {
		write(`admins:\n  - ids: ["discord:${IDS.member}", "discord:${SECOND}"]\n`, members(person()));
		const config = loadAccessConfig(paths);
		expect(config.discord.get(IDS.member)).toBe("admin");
		expect(config.discord.get(SECOND)).toBe("admin");
	});

	it("refuses an admin entry whose ids belong to different people", () => {
		write(
			`admins:\n  - ids: ["discord:${IDS.member}", "discord:${THIRD}"]\n`,
			members(`${person()}  - ids: ["discord:${THIRD}"]\n    tier: friend\n`),
		);
		expect(() => loadAccessConfig(paths)).toThrow(
			/admins\[0\] lists ids that belong to different entries/,
		);
	});

	it("refuses an admin id that has no members entry, even if another of its ids does", () => {
		write(`admins:\n  - ids: ["discord:${IDS.member}", "discord:${THIRD}"]\n`, members(person()));
		expect(() => loadAccessConfig(paths)).toThrow(/admins\[0\] has an id with no entry/);
	});

	it("refuses an id listed as an admin twice", () => {
		write(
			`admins:\n  - ids: ["discord:${IDS.admin}"]\n  - ids: ["discord:${IDS.admin}"]\n`,
			MEMBERS,
		);
		expect(() => loadAccessConfig(paths)).toThrow(
			/admins\[1\]\.ids\[0\] duplicates admins\[0\]\.ids\[0\]/,
		);
	});
});

describe("guests and capabilities", () => {
	const withEntry = (lines: string) =>
		write(ADMINS, members(`  - ids: ["discord:${IDS.member}"]\n${lines}`));

	it("keeps a guest entry but gives it no tier and doesn't count it", () => {
		withEntry("    tier: guest\n    capabilities:\n      - front-door\n");
		const config = loadAccessConfig(paths);
		expect(config.discord.has(IDS.member)).toBe(false);
		expect(config.counts).toEqual({ admins: 1, members: 0, friends: 0 });
		expect(config.records.get(IDS.member)).toEqual({
			ids: [`discord:${IDS.member}`],
			tier: "guest",
			capabilities: ["front-door"],
		});
	});

	it("defaults to no capabilities and passes the note through", () => {
		withEntry("    tier: member\n    note: hi\n");
		expect(loadAccessConfig(paths).records.get(IDS.member)).toEqual({
			ids: [`discord:${IDS.member}`],
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
				`  - ids: ["discord:${IDS.member}"]\n    tier: member\n    capabilities:\n      - front-door\n`,
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
