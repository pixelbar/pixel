import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor } from "../core/access.ts";
import type { Logger } from "../core/logger.ts";
import type { ErrorReporter } from "../core/ports/error-reporter.ts";
import { actor, IDS } from "../testing/fixtures.ts";
import { AccessConfigError } from "./access-config.ts";
import { AccessStoreError, FileAccessStore, type FileOps, nodeFileOps } from "./access-store.ts";

const NEW_ID = "100000000000000050";

const ADMINS = `admins:\n  - name: Ada\n    discordId: "${IDS.admin}"\n`;
const MEMBERS = `# Paying members. Edited by Pixel and by hand.
members:
  # Ada's friend
  - discordId: "${IDS.member}"
    tier: member
    note: paid yearly # keep this
    capabilities:
      - front-door

  - discordId: "${IDS.friend}"
    tier: friend
`;

const by: PlatformActor = actor({
	userId: IDS.admin,
	displayName: "Ada Lovelace",
	handle: "ada_l",
});

let dir: string;
let membersFile: string;
let logs: { level: string; obj: Record<string, unknown> }[];
let reporter: {
	capture: ReturnType<typeof vi.fn<ErrorReporter["capture"]>>;
	captureBackground: ReturnType<typeof vi.fn<ErrorReporter["captureBackground"]>>;
	breadcrumb: ReturnType<typeof vi.fn<ErrorReporter["breadcrumb"]>>;
};

function logger(): Logger {
	const make = (bindings: Record<string, unknown>): Logger => ({
		debug: (obj) => logs.push({ level: "debug", obj: { ...bindings, ...obj } }),
		info: (obj) => logs.push({ level: "info", obj: { ...bindings, ...obj } }),
		warn: (obj) => logs.push({ level: "warn", obj: { ...bindings, ...obj } }),
		error: (obj) => logs.push({ level: "error", obj: { ...bindings, ...obj } }),
		child: (more) => make({ ...bindings, ...more }),
	});
	return make({});
}

function open(ops?: FileOps) {
	return FileAccessStore.open({
		paths: { adminsFile: join(dir, "admins.yaml"), membersFile },
		logger: logger(),
		reporter,
		...(ops ? { ops } : {}),
	});
}

const read = () => readFileSync(membersFile, "utf8");
const entries = (type: string) => logs.filter((l) => l.obj.event === type);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-store-"));
	membersFile = join(dir, "members.yaml");
	writeFileSync(join(dir, "admins.yaml"), ADMINS);
	writeFileSync(membersFile, MEMBERS);
	logs = [];
	reporter = {
		capture: vi.fn<ErrorReporter["capture"]>(),
		captureBackground: vi.fn<ErrorReporter["captureBackground"]>(),
		breadcrumb: vi.fn<ErrorReporter["breadcrumb"]>(),
	};
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("opening", () => {
	it("loads both files", () => {
		const store = open();
		expect(store.view.discord.get(IDS.member)).toBe("member");
		expect(store.view.discord.get(IDS.admin)).toBe("admin");
		expect(store.view.records.get(IDS.member)).toEqual({
			discordId: IDS.member,
			tier: "member",
			note: "paid yearly",
			capabilities: ["front-door"],
		});
	});

	it("fails closed when the members file is missing, rather than treating everyone as a guest", () => {
		rmSync(membersFile);
		expect(() => open()).toThrow(AccessConfigError);
	});

	it("accepts an empty members list", () => {
		writeFileSync(membersFile, "members: []\n");
		expect(open().view.counts).toEqual({ admins: 1, members: 0, friends: 0 });
	});
});

describe("changing a tier", () => {
	it("adds a new person as a quoted ID, leaving comments and other entries alone", async () => {
		const store = open();
		const result = await store.apply({ kind: "set-tier", id: NEW_ID, tier: "friend" }, by);

		expect(result.before).toBeNull();
		expect(result.after).toEqual({ discordId: NEW_ID, tier: "friend", capabilities: [] });
		const text = read();
		expect(text.startsWith(MEMBERS)).toBe(true);
		expect(text).toContain(`- discordId: "${NEW_ID}"\n    tier: friend`);
		expect(store.view.discord.get(NEW_ID)).toBe("friend");
		expect(store.view.counts).toEqual({ admins: 1, members: 1, friends: 2 });
	});

	it("adds the first person to an empty flow-style list", async () => {
		writeFileSync(membersFile, "members: []\n");
		const store = open();
		await store.apply({ kind: "set-tier", id: NEW_ID, tier: "member", note: "new" }, by);
		expect(read()).toBe(`members:\n  - discordId: "${NEW_ID}"\n    tier: member\n    note: new\n`);
		expect(open().view.discord.get(NEW_ID)).toBe("member");
	});

	it("changes only the tier of an existing entry, keeping its note, comments and capabilities", async () => {
		const store = open();
		const result = await store.apply({ kind: "set-tier", id: IDS.member, tier: "friend" }, by);
		expect(result.before?.tier).toBe("member");
		expect(result.after).toMatchObject({ tier: "friend", note: "paid yearly" });
		expect(read()).toBe(MEMBERS.replace("tier: member", "tier: friend"));
		expect(store.view.records.get(IDS.member)?.capabilities).toEqual(["front-door"]);
	});

	it("updates the note when one is given", async () => {
		const store = open();
		await store.apply(
			{ kind: "set-tier", id: IDS.member, tier: "member", note: "paid monthly" },
			by,
		);
		expect(read()).toContain("note: paid monthly");
		expect(read()).not.toContain("paid yearly");
	});

	it("marks someone as a guest without deleting their entry or capabilities", async () => {
		const store = open();
		await store.apply({ kind: "set-tier", id: IDS.member, tier: "guest" }, by);
		expect(store.view.discord.has(IDS.member)).toBe(false);
		expect(store.view.records.get(IDS.member)).toMatchObject({
			tier: "guest",
			capabilities: ["front-door"],
		});
		expect(store.view.counts).toEqual({ admins: 1, members: 0, friends: 1 });
		expect(open().view.discord.has(IDS.member)).toBe(false);
	});

	it("does nothing, and doesn't write, when nothing would change", async () => {
		const store = open();
		const result = await store.apply({ kind: "set-tier", id: IDS.member, tier: "member" }, by);
		expect(result.before).toEqual(result.after);
		expect(existsSync(`${membersFile}.bak`)).toBe(false);
		expect(entries("access.changed")).toHaveLength(0);
	});

	it("refuses to touch an admin: admins come only from admins.yaml", async () => {
		const store = open();
		await expect(
			store.apply({ kind: "set-tier", id: IDS.admin, tier: "friend" }, by),
		).rejects.toThrow(/admins\.yaml/);
		expect(read()).toBe(MEMBERS);
	});

	it.each(["abc", "", "123", "1000000000000000010000"])("refuses the invalid ID %j", async (id) => {
		await expect(open().apply({ kind: "set-tier", id, tier: "member" }, by)).rejects.toThrow(
			/valid user ID/,
		);
	});
});

describe("changing capabilities", () => {
	it("replaces the list, keeping everything else", async () => {
		const store = open();
		const result = await store.apply(
			{ kind: "set-capabilities", id: IDS.friend, capabilities: ["front-door", "workshop"] },
			by,
		);
		expect(result.after.capabilities).toEqual(["front-door", "workshop"]);
		expect(read()).toContain(
			`tier: friend\n    capabilities:\n      - front-door\n      - workshop\n`,
		);
		expect(store.view.records.get(IDS.friend)?.capabilities).toEqual(["front-door", "workshop"]);
	});

	it("removes the key when the list is emptied", async () => {
		const store = open();
		await store.apply({ kind: "set-capabilities", id: IDS.member, capabilities: [] }, by);
		expect(read()).not.toContain("capabilities");
		expect(read()).toContain("note: paid yearly # keep this");
	});

	it("needs an existing entry: a person must have a tier first", async () => {
		await expect(
			open().apply({ kind: "set-capabilities", id: NEW_ID, capabilities: ["front-door"] }, by),
		).rejects.toThrow(/Set their tier first/);
	});

	it.each([
		[["Bad Name"], /lowercase words/],
		[["x".repeat(40)], /lowercase words/],
		[["a", "a"], /valid list/],
		[Array.from({ length: 51 }, (_, i) => `c${i}`), /valid list/],
	])("refuses invalid capabilities %j", async (capabilities, message) => {
		await expect(
			open().apply({ kind: "set-capabilities", id: IDS.member, capabilities }, by),
		).rejects.toThrow(message);
		expect(read()).toBe(MEMBERS);
	});
});

describe("safe writes", () => {
	it("keeps the previous version as .bak on every write", async () => {
		const store = open();
		await store.apply({ kind: "set-tier", id: NEW_ID, tier: "friend" }, by);
		expect(readFileSync(`${membersFile}.bak`, "utf8")).toBe(MEMBERS);
		const afterFirst = read();
		await store.apply({ kind: "set-tier", id: NEW_ID, tier: "member" }, by);
		expect(readFileSync(`${membersFile}.bak`, "utf8")).toBe(afterFirst);
	});

	it("leaves no temp files behind", async () => {
		await open().apply({ kind: "set-tier", id: NEW_ID, tier: "friend" }, by);
		expect(readdirSync(dir).sort()).toEqual(["admins.yaml", "members.yaml", "members.yaml.bak"]);
	});

	it("keeps the file's permissions", async () => {
		chmodSync(membersFile, 0o600);
		await open().apply({ kind: "set-tier", id: NEW_ID, tier: "friend" }, by);
		expect(statSync(membersFile).mode & 0o777).toBe(0o600);
	});

	it("keeps a hand edit made while the bot runs", async () => {
		const store = open();
		const edited = `${MEMBERS}\n  - discordId: "${IDS.guest}"\n    tier: friend\n    note: added by hand\n`;
		writeFileSync(membersFile, edited);
		await store.apply({ kind: "set-tier", id: NEW_ID, tier: "member" }, by);
		expect(read()).toContain("added by hand");
		expect(store.view.discord.get(IDS.guest)).toBe("friend");
		expect(store.view.discord.get(NEW_ID)).toBe("member");
	});

	it("can't lose an update when changes are made at the same time", async () => {
		const store = open();
		const ids = Array.from(
			{ length: 10 },
			(_, i) => `1000000000000001${String(i).padStart(2, "0")}`,
		);
		await Promise.all(ids.map((id) => store.apply({ kind: "set-tier", id, tier: "friend" }, by)));
		for (const id of ids) expect(store.view.discord.get(id)).toBe("friend");
		expect(open().view.counts.friends).toBe(11);
	});

	it("refuses a file that was broken by hand, and changes nothing", async () => {
		const store = open();
		const broken = `members:\n  - discordId: "${IDS.member}"\n    tier: nonsense\n`;
		writeFileSync(membersFile, broken);
		const before = store.view;
		await expect(store.apply({ kind: "set-tier", id: NEW_ID, tier: "friend" }, by)).rejects.toThrow(
			/\/admin reload/,
		);
		expect(read()).toBe(broken);
		expect(store.view).toBe(before);
		expect(existsSync(`${membersFile}.bak`)).toBe(false);
	});

	it("reports an unreadable file clearly, without its path", async () => {
		const store = open();
		rmSync(membersFile);
		const error = await store
			.apply({ kind: "set-tier", id: NEW_ID, tier: "friend" }, by)
			.catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(AccessStoreError);
		expect((error as Error).message).not.toContain(dir);
	});

	describe("when saving fails", () => {
		const boom = new Error(`disk full for ${IDS.member}`);

		it.each([
			[
				"writing the temp file",
				{
					writeTemp: () => {
						throw boom;
					},
				},
			],
			[
				"backing up",
				{
					copy: () => {
						throw boom;
					},
				},
			],
			[
				"renaming",
				{
					rename: () => {
						throw boom;
					},
				},
			],
		])("leaves the file and the view unchanged when %s fails", async (_label, failing) => {
			const store = open({ ...nodeFileOps, ...failing });
			const before = store.view;
			const error = await store
				.apply({ kind: "set-tier", id: NEW_ID, tier: "friend" }, by)
				.catch((e: unknown) => e as Error);

			expect(error).toBeInstanceOf(AccessStoreError);
			expect((error as Error).message).toBe("Couldn't save the change, so nothing was changed.");
			expect((error as Error).message).not.toContain(IDS.member);
			expect(read()).toBe(MEMBERS);
			expect(store.view).toBe(before);
			expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
			expect(reporter.captureBackground).toHaveBeenCalledWith(boom, "access-store");
			expect(entries("access.changed")).toHaveLength(0);
			expect(reporter.breadcrumb).not.toHaveBeenCalled();
		});

		it("still reports the failure when the temp file can't be removed either", async () => {
			const store = open({
				...nodeFileOps,
				rename: () => {
					throw boom;
				},
				remove: () => {
					throw new Error("gone");
				},
			});
			await expect(
				store.apply({ kind: "set-tier", id: NEW_ID, tier: "friend" }, by),
			).rejects.toThrow(/nothing was changed/);
		});

		it("refuses to overwrite a hand edit made just before the rename", async () => {
			const handEdit = `${MEMBERS}# edited meanwhile\n`;
			const store = open({
				...nodeFileOps,
				writeTemp(path, data, mode) {
					nodeFileOps.writeTemp(path, data, mode);
					writeFileSync(membersFile, handEdit);
				},
			});
			await expect(
				store.apply({ kind: "set-tier", id: NEW_ID, tier: "friend" }, by),
			).rejects.toThrow(/changed while I was saving/);
			expect(read()).toBe(handEdit);
			expect(store.view.discord.has(NEW_ID)).toBe(false);
			expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
			expect(reporter.captureBackground).not.toHaveBeenCalled();
		});
	});
});

describe("audit", () => {
	it("logs who did it, to whom, and before and after, but never the note", async () => {
		const store = open();
		await store.apply(
			{ kind: "set-tier", id: IDS.member, tier: "friend", note: "secret note" },
			by,
		);

		const [entry] = entries("access.changed");
		expect(entry?.level).toBe("info");
		expect(entry?.obj).toMatchObject({
			kind: "set-tier",
			user: `discord:${IDS.admin}`,
			userName: "Ada Lovelace",
			userHandle: "ada_l",
			target: `discord:${IDS.member}`,
			before: { tier: "member", capabilities: ["front-door"] },
			after: { tier: "friend", capabilities: ["front-door"] },
		});
		expect(JSON.stringify(logs)).not.toContain("secret note");
		expect(JSON.stringify(logs)).not.toContain("paid yearly");
	});

	it("logs a new person's before as null", async () => {
		await open().apply({ kind: "set-tier", id: NEW_ID, tier: "member" }, by);
		expect(entries("access.changed")[0]?.obj).toMatchObject({ before: null });
	});

	it("leaves a Sentry breadcrumb with IDs and tiers", async () => {
		await open().apply({ kind: "set-capabilities", id: IDS.member, capabilities: ["a", "b"] }, by);
		expect(reporter.breadcrumb).toHaveBeenCalledWith("access", "set-capabilities", {
			actor: `discord:${IDS.admin}`,
			target: `discord:${IDS.member}`,
			before: "member",
			after: "member",
			capabilities: "a,b",
		});
	});

	it("logs the reason when one is given, and refuses one that is too long", async () => {
		const store = open();
		await store.apply({ kind: "set-tier", id: NEW_ID, tier: "member", reason: "paid cash" }, by);
		expect(entries("access.changed")[0]?.obj).toMatchObject({ reason: "paid cash" });
		await expect(
			store.apply({ kind: "set-tier", id: IDS.friend, tier: "member", reason: "x".repeat(201) }, by),
		).rejects.toThrow(/at most 200 characters/);
		expect(store.view.discord.get(IDS.friend)).toBe("friend");
	});

	it("doesn't audit a change that was refused", async () => {
		await open()
			.apply({ kind: "set-tier", id: IDS.admin, tier: "friend" }, by)
			.catch(() => {});
		expect(entries("access.changed")).toHaveLength(0);
	});
});

describe("reload", () => {
	it("picks up hand edits, including new admins, and reports the counts", async () => {
		const store = open();
		writeFileSync(
			join(dir, "admins.yaml"),
			`${ADMINS}  - name: Grace\n    discordId: "${IDS.guest}"\n`,
		);
		writeFileSync(membersFile, "members: []\n");

		const result = await store.reload(by);

		expect(result.before).toEqual({ admins: 1, members: 1, friends: 1 });
		expect(result.after).toEqual({ admins: 2, members: 0, friends: 0 });
		expect(store.view.discord.get(IDS.guest)).toBe("admin");
		expect(store.view.discord.has(IDS.member)).toBe(false);
		expect(entries("access.reloaded")[0]?.obj).toMatchObject({
			user: `discord:${IDS.admin}`,
			after: { admins: 2 },
		});
		expect(reporter.breadcrumb).toHaveBeenCalledWith("access", "reloaded", {
			actor: `discord:${IDS.admin}`,
		});
	});

	it("logs the warnings of the new data", async () => {
		const store = open();
		writeFileSync(membersFile, `members:\n  - discordId: "${IDS.admin}"\n    tier: friend\n`);
		await store.reload(by);
		expect(entries("access_config.warning")).toHaveLength(1);
	});

	it("keeps the current data when the files are now invalid, and says why", async () => {
		const store = open();
		const before = store.view;
		writeFileSync(membersFile, `members:\n  - discordId: "${IDS.member}"\n    tier: nonsense\n`);

		const error = await store.reload(by).catch((e: unknown) => e as Error);

		expect(error).toBeInstanceOf(AccessStoreError);
		expect((error as Error).message).toMatch(/keeping the current data/);
		expect((error as Error).message).toMatch(/members\[0\]\.tier/);
		expect((error as Error).message).not.toContain(IDS.member);
		expect(store.view).toBe(before);
		expect(entries("access.reload_failed")).toHaveLength(1);
	});

	it("keeps the current data when a file is missing", async () => {
		const store = open();
		rmSync(membersFile);
		await expect(store.reload(by)).rejects.toThrow(/keeping the current data/);
		expect(store.view.discord.get(IDS.member)).toBe("member");
	});

	it("lets the next change use an admin added by reload", async () => {
		const store = open();
		writeFileSync(
			join(dir, "admins.yaml"),
			`${ADMINS}  - name: Grace\n    discordId: "${IDS.guest}"\n`,
		);
		await store.reload(by);
		await expect(
			store.apply({ kind: "set-tier", id: IDS.guest, tier: "friend" }, by),
		).rejects.toThrow(/admins\.yaml/);
	});
});
