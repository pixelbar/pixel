import { describe, expect, it } from "vitest";
import type {
	BotStatusAnnouncement,
	ClosingTimeAnnouncement,
	SpaceStatusAnnouncement,
} from "../../core/announcement.ts";
import { clipToot, neutralizeMentions, tootFromAnnouncement } from "./toots.ts";

const kinds = new Set(["space.status"] as const);
const visibility = "public" as const;

const open: SpaceStatusAnnouncement = {
	kind: "space.status",
	state: "open",
	at: new Date("2026-10-11T18:00:00Z"),
	openedAt: null,
	text: "🟢 Pixelbar is now open",
};

const closed: SpaceStatusAnnouncement = {
	kind: "space.status",
	state: "closed",
	at: new Date("2026-10-11T22:00:00Z"),
	openedAt: new Date("2026-10-11T18:00:00Z"),
	text: "🔴 Pixelbar is now closed after being open for 4h 0m",
};

const closing: ClosingTimeAnnouncement = {
	kind: "closing.time",
	text: "The space is closing. Please tidy up.",
	body: "**Closing time** <@123456789012345678> check the door",
	at: new Date("2026-10-11T22:00:00Z"),
};

const botUp: BotStatusAnnouncement = {
	kind: "bot.status",
	phase: "up",
	build: {
		version: "0.6.0",
		commit: "abc1234",
		branch: "main",
		env: "prod",
		runtime: "cloud",
	},
	startedAt: new Date("2026-10-11T17:00:00Z"),
	at: new Date("2026-10-11T17:00:00Z"),
	checks: [],
	text: "🟢 Pixel 0.6.0 abc1234 is online",
};

describe("tootFromAnnouncement", () => {
	it("toots space.status with the portable text", () => {
		expect(tootFromAnnouncement(open, { kinds, visibility })).toEqual({
			status: "🟢 Pixelbar is now open",
			visibility: "public",
		});
		expect(tootFromAnnouncement(closed, { kinds, visibility })).toEqual({
			status: "🔴 Pixelbar is now closed after being open for 4h 0m",
			visibility: "public",
		});
	});

	it("uses unlisted when configured", () => {
		expect(tootFromAnnouncement(open, { kinds, visibility: "unlisted" })?.visibility).toBe(
			"unlisted",
		);
	});

	it("skips kinds that are not routed", () => {
		expect(tootFromAnnouncement(closing, { kinds, visibility })).toBeUndefined();
		expect(tootFromAnnouncement(botUp, { kinds, visibility })).toBeUndefined();
	});

	it("toots closing.time from the portable text, never the Discord body", () => {
		const toot = tootFromAnnouncement(closing, {
			kinds: new Set(["closing.time"]),
			visibility,
		});
		expect(toot?.status).toBe("The space is closing. Please tidy up.");
		expect(toot?.status).not.toContain("**");
		expect(toot?.status).not.toContain("<@");
	});

	it("toots bot.status from the portable text", () => {
		expect(
			tootFromAnnouncement(botUp, { kinds: new Set(["bot.status"]), visibility })?.status,
		).toBe("🟢 Pixel 0.6.0 abc1234 is online");
	});

	it("breaks @handles so they cannot mention anyone", () => {
		const announcement: SpaceStatusAnnouncement = {
			...open,
			text: "Ask @alice@example.social or <@100000000000000010>",
		};
		const status = tootFromAnnouncement(announcement, { kinds, visibility })?.status;
		expect(status).toContain("@\u200balice@\u200bexample.social");
		expect(status).toContain("[mention]");
		expect(status).not.toContain("@alice");
		expect(status).not.toContain("<@");
	});

	it("clips to Mastodon's 500-character default", () => {
		const announcement: SpaceStatusAnnouncement = {
			...open,
			text: "🟢 ".repeat(300),
		};
		const status = tootFromAnnouncement(announcement, { kinds, visibility })?.status ?? "";
		expect([...status].length).toBe(500);
		expect(status.endsWith("…")).toBe(true);
	});

	it("skips an empty status", () => {
		expect(tootFromAnnouncement({ ...open, text: "" }, { kinds, visibility })).toBeUndefined();
	});
});

describe("neutralizeMentions", () => {
	it("leaves text without @ unchanged", () => {
		expect(neutralizeMentions("Pixelbar is open")).toBe("Pixelbar is open");
	});
});

describe("clipToot", () => {
	it("returns the text when it already fits", () => {
		expect(clipToot("hello", 10)).toBe("hello");
	});

	it("is just an ellipsis when the limit is 1", () => {
		expect(clipToot("hello", 1)).toBe("…");
	});
});
