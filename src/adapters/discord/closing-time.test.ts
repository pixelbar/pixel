import { describe, expect, it, vi } from "vitest";
import type { BotStatusAnnouncement, ClosingTimeAnnouncement } from "../../core/announcement.ts";
import type { AnnouncementChannel } from "./announce-publishers.ts";
import {
	CLOSING_TIME_PUBLISHER_ID,
	CLOSING_TIME_TITLE,
	closingTimePost,
	createClosingTimePublisher,
} from "./closing-time.ts";
import { accentColor } from "./render.ts";

const at = new Date("2026-10-10T21:00:00Z");

const closing = (overrides: Partial<ClosingTimeAnnouncement> = {}): ClosingTimeAnnouncement => ({
	kind: "closing.time",
	text: "The space is closing.",
	body: "Please tidy up.",
	at,
	...overrides,
});

const bot: BotStatusAnnouncement = {
	kind: "bot.status",
	phase: "up",
	build: { version: "0", commit: undefined, branch: undefined, env: "local", runtime: "local" },
	startedAt: at,
	at,
	checks: [],
	text: "up",
};

function fakeChannel() {
	const sent: unknown[] = [];
	const channel: AnnouncementChannel = {
		send: vi.fn(async (post) => {
			sent.push(post);
			return { id: String(sent.length) };
		}),
		edit: vi.fn(async () => {}),
		recentOwnPosts: vi.fn(async () => []),
		findOwnPost: vi.fn(async () => undefined),
	};
	return { channel, sent };
}

describe("closingTimePost", () => {
	it("posts an embed with mentions disabled", () => {
		expect(closingTimePost(closing())).toEqual({
			embeds: [
				{
					title: CLOSING_TIME_TITLE,
					description: "Please tidy up.",
					color: accentColor("warning"),
					timestamp: at.toISOString(),
				},
			],
			allowedMentions: { parse: [] },
		});
	});
});

describe("createClosingTimePublisher", () => {
	it("has a stable id and posts closing.time", async () => {
		const { channel, sent } = fakeChannel();
		const publisher = createClosingTimePublisher(channel);
		expect(publisher.id).toBe(CLOSING_TIME_PUBLISHER_ID);
		await publisher.publish(closing({ body: "Last out locks the door." }));
		expect(sent).toEqual([closingTimePost(closing({ body: "Last out locks the door." }))]);
	});

	it("ignores other announcement kinds", async () => {
		const { channel, sent } = fakeChannel();
		const publisher = createClosingTimePublisher(channel);
		await publisher.publish({
			kind: "space.status",
			state: "closed",
			at,
			openedAt: null,
			text: "closed",
		});
		await publisher.publish(bot);
		expect(sent).toEqual([]);
		expect(channel.send).not.toHaveBeenCalled();
	});
});
