import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Announcement } from "../../core/announcement.ts";
import { UserFacingError } from "../../core/errors.ts";
import { createInterpolator } from "../../core/interpolate.ts";
import type { Logger } from "../../core/logger.ts";
import { silentLogger } from "../../core/logger.ts";
import { context, plain } from "../../testing/fixtures.ts";
import {
	closingTimeMessage,
	createClosingTimeFeature,
	DEFAULT_CLOSING_TIME_MESSAGE,
	MAX_CLOSING_TIME_MESSAGE,
	savedClosingTimeMessage,
	writeClosingTimeMessage,
} from "./index.ts";

const AT = new Date("2026-10-10T21:00:00Z");

function setup(
	overrides: { enabled?: boolean; message?: string; announce?: () => Promise<void> } = {},
) {
	const announced: Announcement[] = [];
	const announce = vi.fn(async (a: Announcement) => {
		if (overrides.announce) await overrides.announce();
		announced.push(a);
	});
	const feature = createClosingTimeFeature({
		announcer: { announce },
		enabled: overrides.enabled ?? true,
		message: () => overrides.message ?? DEFAULT_CLOSING_TIME_MESSAGE,
		interpolator: createInterpolator({ timezone: "Europe/Amsterdam", now: () => AT }),
		logger: silentLogger,
		now: () => AT,
	});
	return { feature, command: plain(feature.commands?.[0]), announced, announce };
}

describe("/closing-time", () => {
	it("is a private member command", () => {
		const { command } = setup();
		expect(command.name).toBe("closing-time");
		expect(command.access).toEqual({ minTier: "member" });
		expect(command.private).toBe(true);
	});

	it("posts through the announcer and confirms privately", async () => {
		const { command, announced } = setup({
			message: "Please **tidy** the kitchen\nLast out locks up",
		});
		const reply = await command.handler(context());
		expect(reply).toEqual({ text: "Posted the closing-time message.", private: true });
		expect(announced).toEqual([
			{
				kind: "closing.time",
				body: "Please **tidy** the kitchen\nLast out locks up",
				text: "Please \\*\\*tidy\\*\\* the kitchen Last out locks up",
				at: AT,
			},
		]);
	});

	it("lets a failed announce through on the command path", async () => {
		const { command } = setup({
			announce: async () => {
				throw new Error("discord down");
			},
		});
		await expect(command.handler(context())).rejects.toThrow("discord down");
	});

	it("tells the invoker privately when posting is off, and does not announce", async () => {
		const { command, announce } = setup({ enabled: false });
		const reply = await command.handler(context());
		expect(reply).toEqual({ text: "Closing-time posts are turned off.", private: true });
		expect(announce).not.toHaveBeenCalled();
	});

	it("clips an over-long body to the stored-message limit", async () => {
		const { command, announced } = setup({ message: "x".repeat(MAX_CLOSING_TIME_MESSAGE + 50) });
		await command.handler(context());
		const body = announced[0] && announced[0].kind === "closing.time" ? announced[0].body : "";
		expect(body.length).toBe(MAX_CLOSING_TIME_MESSAGE);
		expect(body.endsWith("…")).toBe(true);
	});

	it("fills tokens at post time, then escapes the portable field once", async () => {
		const { command, announced } = setup({
			message: "Lock up **now** — {{day}} {{date}}. See {{unknown}}.",
		});
		await command.handler(context());
		expect(announced).toEqual([
			{
				kind: "closing.time",
				body: "Lock up **now** — Saturday 10 October 2026. See {{unknown}}.",
				text: "Lock up \\*\\*now\\*\\* — Saturday 10 October 2026. See {{unknown}}.",
				at: AT,
			},
		]);
	});

	it("escapes operator text in the portable field, including mention markers", async () => {
		const { command, announced } = setup({ message: "Ping <@123> and [x](https://evil.example)" });
		await command.handler(context());
		expect(announced[0]).toMatchObject({
			kind: "closing.time",
			body: "Ping <@123> and [x](https://evil.example)",
			text: "Ping \\<@123\\> and \\[x\\](https://evil.example)",
		});
	});
});

describe("onSpaceClosed", () => {
	it("uses the same send path as the command", async () => {
		const { feature, command, announced } = setup({ message: "Lock up." });
		await feature.onSpaceClosed();
		await command.handler(context());
		expect(announced).toHaveLength(2);
		expect(announced[0]).toEqual(announced[1]);
		expect(announced[0]?.kind).toBe("closing.time");
	});

	it("logs and does not announce when posting is off", async () => {
		const { feature, announce } = setup({ enabled: false });
		await feature.onSpaceClosed();
		expect(announce).not.toHaveBeenCalled();
	});

	it("swallows announcer failures so space-close is not failed", async () => {
		const { feature } = setup({
			announce: async () => {
				throw new Error("discord down");
			},
		});
		await expect(feature.onSpaceClosed()).resolves.toBeUndefined();
	});
});

describe("closingTimeMessage", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	const file = () => {
		dir = mkdtempSync(join(tmpdir(), "pixel-closing-"));
		return join(dir, "closing-time.md");
	};

	it("uses the built-in default when the file is missing", () => {
		expect(closingTimeMessage(join(file(), "nope.md"), silentLogger)()).toBe(
			DEFAULT_CLOSING_TIME_MESSAGE,
		);
	});

	it("reads the file, and treats an empty file as the default", () => {
		const path = file();
		writeFileSync(path, "  Take out the trash.\nLeave the lights.\n");
		expect(closingTimeMessage(path, silentLogger)()).toBe("Take out the trash.\nLeave the lights.");
		writeFileSync(path, "   \n");
		expect(closingTimeMessage(path, silentLogger)()).toBe(DEFAULT_CLOSING_TIME_MESSAGE);
	});

	it("falls back to the default when the path is a directory, and logs", () => {
		const path = file();
		mkdirSync(path);
		const warn = vi.fn();
		const logger: Logger = { ...silentLogger, warn };
		expect(closingTimeMessage(path, logger)()).toBe(DEFAULT_CLOSING_TIME_MESSAGE);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "closing_time.message_unreadable" }),
			expect.stringMatching(/default/),
		);
	});
});

describe("savedClosingTimeMessage", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("returns the saved text, and nothing when missing, empty, or unreadable", () => {
		dir = mkdtempSync(join(tmpdir(), "pixel-closing-saved-"));
		const path = join(dir, "closing-time.md");
		expect(savedClosingTimeMessage(path)).toBeUndefined();
		writeFileSync(path, "  Please tidy up.\n");
		expect(savedClosingTimeMessage(path)).toBe("Please tidy up.");
		writeFileSync(path, "  \n");
		expect(savedClosingTimeMessage(path)).toBeUndefined();
		expect(savedClosingTimeMessage(dir)).toBeUndefined();
	});
});

describe("writeClosingTimeMessage", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	const file = () => {
		dir = mkdtempSync(join(tmpdir(), "pixel-closing-write-"));
		return join(dir, "data", "closing-time.md");
	};

	it("writes the trimmed message atomically and creates the directory", () => {
		const path = file();
		expect(writeClosingTimeMessage(path, "  Take out the trash.\nLast out locks up.  ")).toBe(
			"Take out the trash.\nLast out locks up.",
		);
		expect(readFileSync(path, "utf8")).toBe("Take out the trash.\nLast out locks up.\n");
		expect(closingTimeMessage(path, silentLogger)()).toBe(
			"Take out the trash.\nLast out locks up.",
		);
	});

	it("refuses an empty message", () => {
		const path = file();
		expect(() => writeClosingTimeMessage(path, "   \n")).toThrow(UserFacingError);
		expect(() => writeClosingTimeMessage(path, "   \n")).toThrow(/empty/);
	});

	it("refuses a message over the form limit", () => {
		expect(() => writeClosingTimeMessage(file(), "x".repeat(MAX_CLOSING_TIME_MESSAGE + 1))).toThrow(
			/at most 4000/,
		);
	});
});
