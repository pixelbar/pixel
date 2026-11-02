import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_COOKIE, type OpenrSession, REFRESH_COOKIE } from "./client.ts";
import { SessionFile } from "./session-file.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-openr-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const session: OpenrSession = {
	cookies: { [ACCESS_COOKIE]: "a", [REFRESH_COOKIE]: "r" },
	accessToken: undefined,
	refreshToken: undefined,
	accessUntil: new Date("2030-01-01T10:00:00.000Z"),
	refreshUntil: new Date("2030-02-01T10:00:00.000Z"),
};

describe("SessionFile", () => {
	it("saves a session owner-only and reads it back", () => {
		const file = new SessionFile(join(dir, "data", "openr-session.json"));
		const refreshedAt = new Date("2030-01-01T09:58:00.000Z");
		file.write({ session, refreshedAt });
		expect(statSync(join(dir, "data", "openr-session.json")).mode & 0o777).toBe(0o600);
		expect(file.read()).toEqual({ kind: "found", saved: { session, refreshedAt } });
	});

	it("keeps bearer tokens, and does without a refresh time", () => {
		const file = new SessionFile(join(dir, "s.json"));
		const withTokens = { ...session, accessToken: "a-token", refreshToken: "r-token" };
		file.write({ session: withTokens, refreshedAt: undefined });
		expect(file.read()).toEqual({
			kind: "found",
			saved: { session: withTokens, refreshedAt: undefined },
		});
	});

	it("says when there's no file", () => {
		expect(new SessionFile(join(dir, "missing.json")).read()).toEqual({ kind: "none" });
	});

	it.each([
		["not JSON", "{"],
		["the wrong shape", JSON.stringify({ version: 2 })],
		[
			"a cookie that isn't OpenR's",
			JSON.stringify({
				version: 1,
				cookies: { other: "x" },
				accessUntil: "2030-01-01T10:00:00.000Z",
				refreshUntil: "2030-01-01T10:00:00.000Z",
			}),
		],
	])("counts %s as invalid", (_, body) => {
		writeFileSync(join(dir, "s.json"), body);
		expect(new SessionFile(join(dir, "s.json")).read()).toEqual({ kind: "invalid" });
	});

	it("counts a file it can't read as invalid", () => {
		mkdirSync(join(dir, "a-directory"));
		expect(new SessionFile(join(dir, "a-directory")).read()).toEqual({ kind: "invalid" });
	});

	it("deletes the file, and doesn't mind when it's already gone", () => {
		const path = join(dir, "s.json");
		const file = new SessionFile(path);
		file.write({ session, refreshedAt: undefined });
		file.remove();
		expect(() => readFileSync(path)).toThrow();
		expect(() => file.remove()).not.toThrow();
	});
});
