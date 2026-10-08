import { describe, expect, it, vi } from "vitest";
import type { BotStatusAnnouncement, SpaceStatusAnnouncement } from "../../core/announcement.ts";
import { silentLogger } from "../../core/logger.ts";
import type { AnnouncementChannel, OwnPost } from "./announce-publishers.ts";
import { createLivePublisher, createTimelinePublisher } from "./announce-publishers.ts";
import type { AnnouncementPost } from "./announce-render.ts";
import {
	BOT_CRASHED_TITLE,
	BOT_OFFLINE_TITLE,
	BOT_ONLINE_FOOTER,
	BOT_ONLINE_TITLE,
	BOT_STATUS_PUBLISHER_ID,
	buildFields,
	crashedPost,
	createBotStatusPublisher,
	offlinePost,
	onlinePost,
} from "./bot-status.ts";

const started = new Date("2026-10-07T10:00:00Z");
const later = new Date("2026-10-07T13:05:00Z");
const up: BotStatusAnnouncement = {
	kind: "bot.status",
	phase: "up",
	build: {
		version: "0.1.0",
		commit: "abc1234",
		branch: "feature/doors",
		env: "dev",
		runtime: "cloud",
	},
	startedAt: started,
	at: started,
	checks: [
		{ name: "Discord", state: "ok", detail: "connected" },
		{ name: "Home Assistant", state: "warn", detail: "not connected yet" },
	],
	text: "x",
};
const down: BotStatusAnnouncement = {
	...up,
	phase: "down",
	at: later,
	checks: [],
	reason: "restarting",
};
const space: SpaceStatusAnnouncement = {
	kind: "space.status",
	state: "open",
	at: started,
	openedAt: null,
	text: "open",
};

const embed = (post: AnnouncementPost) => post.embeds[0];

describe("rendering", () => {
	it("shows version, commit, a branch that isn't main, environment when it isn't prod, and Where", () => {
		expect(buildFields(up.build)).toEqual([
			{ name: "Version", value: "`0.1.0`", inline: true },
			{ name: "Commit", value: "`abc1234`", inline: true },
			{ name: "Branch", value: "`feature/doors`", inline: true },
			{ name: "Environment", value: "dev", inline: true },
			{ name: "Where", value: "cloud", inline: true },
		]);
		expect(
			buildFields({
				version: "1.0.0",
				commit: undefined,
				branch: "main",
				env: "prod",
				runtime: "cloud",
			}),
		).toEqual([
			{ name: "Version", value: "`1.0.0`", inline: true },
			{ name: "Where", value: "cloud", inline: true },
		]);
		expect(
			buildFields({
				version: "1",
				commit: "a",
				branch: "master",
				env: "prod",
				runtime: "local",
			}).map((f) => f.name),
		).toEqual(["Version", "Commit", "Where"]);
	});

	it("keeps an odd branch name inert", () => {
		const fields = buildFields({ ...up.build, branch: "x`@everyone`[y](https://e.x)" });
		expect(fields.find((f) => f.name === "Branch")?.value).toMatch(/^`[^`]*`$/);
	});

	it("says online, since when, with the status lines and a footer to find it by", () => {
		const e = embed(onlinePost(up));
		expect(e?.title).toBe(BOT_ONLINE_TITLE);
		expect(e?.footer?.text).toBe(BOT_ONLINE_FOOTER);
		expect(e?.timestamp).toBe(started.toISOString());
		expect(e?.description).toContain(`<t:${started.getTime() / 1000}:f>`);
		expect(e?.fields?.at(-1)).toEqual({
			name: "Status",
			value: "✅ Discord: connected\n⚠️ Home Assistant: not connected yet",
		});
		expect(onlinePost(up).allowedMentions).toEqual({ parse: [] });
		expect(embed(onlinePost({ ...up, checks: [] }))?.fields?.some((f) => f.name === "Status")).toBe(
			false,
		);
	});

	it("says offline with how long it ran and why, with no footer", () => {
		const e = embed(offlinePost(down));
		expect(e?.title).toBe(BOT_OFFLINE_TITLE);
		expect(e?.description).toContain("(3h 5m)");
		expect(e?.description).toContain("Reason: restarting.");
		expect(e?.footer).toBeUndefined();
		expect(embed(offlinePost({ ...down, reason: undefined }))?.description).not.toContain("Reason");
	});

	it("says stopped unexpectedly, with when it started if known", () => {
		expect(embed(crashedPost(started))?.title).toBe(BOT_CRASHED_TITLE);
		expect(embed(crashedPost(started))?.description).toContain("Was online from");
		expect(embed(crashedPost(null))?.description).toBe(
			"It stopped without saying goodbye, so when isn't known.",
		);
	});
});

function fakeChannel(posts: OwnPost[] = []) {
	let next = 100;
	const sent: { id: string; post: AnnouncementPost }[] = [];
	const edits: { id: string; post: AnnouncementPost }[] = [];
	const channel: AnnouncementChannel = {
		send: vi.fn(async (post) => {
			const id = String(next++);
			sent.push({ id, post });
			return { id };
		}),
		edit: vi.fn(async (id, post) => {
			edits.push({ id, post });
		}),
		recentOwnPosts: vi.fn(async () => posts),
		findOwnPost: vi.fn(async (id) => posts.find((p) => p.id === id)),
	};
	return { channel, sent, edits };
}
const onlineOwn = (id: string, at: Date | null = started): OwnPost => ({
	id,
	title: BOT_ONLINE_TITLE,
	footer: BOT_ONLINE_FOOTER,
	timestamp: at,
});
function memoryStore(initial?: string) {
	let saved = initial;
	return {
		load: () => saved,
		save: vi.fn((id: string | undefined) => {
			saved = id;
		}),
		get: () => saved,
	};
}

describe("the bot status publisher", () => {
	it("posts a new message when Pixel comes online, and remembers it", async () => {
		const { channel, sent, edits } = fakeChannel();
		const store = memoryStore();
		const publisher = createBotStatusPublisher(channel, silentLogger, store);
		expect(publisher.id).toBe(BOT_STATUS_PUBLISHER_ID);
		await publisher.publish(up);
		expect(sent.map((s) => embed(s.post)?.title)).toEqual([BOT_ONLINE_TITLE]);
		expect(edits).toEqual([]);
		expect(store.get()).toBe("100");
	});

	it("edits that message when Pixel goes offline, and forgets it", async () => {
		const { channel, sent, edits } = fakeChannel([onlineOwn("100")]);
		const store = memoryStore("100");
		await createBotStatusPublisher(channel, silentLogger, store).publish(down);
		expect(edits.map((e) => [e.id, embed(e.post)?.title])).toEqual([["100", BOT_OFFLINE_TITLE]]);
		expect(sent).toEqual([]);
		expect(store.get()).toBeUndefined();
	});

	it("corrects a post left saying online by a run that crashed, before posting the new one", async () => {
		const { channel, sent, edits } = fakeChannel([onlineOwn("90"), onlineOwn("80", null)]);
		await createBotStatusPublisher(channel, silentLogger, memoryStore("90")).publish(up);
		expect(edits.map((e) => [e.id, embed(e.post)?.title])).toEqual([
			["90", BOT_CRASHED_TITLE],
			["80", BOT_CRASHED_TITLE],
		]);
		expect(sent.map((s) => embed(s.post)?.title)).toEqual([BOT_ONLINE_TITLE]);
	});

	it("updates the newest online post when going offline, and corrects older ones", async () => {
		const older = new Date("2026-10-06T10:00:00Z");
		const { channel, edits } = fakeChannel([onlineOwn("80", older), onlineOwn("90", started)]);
		await createBotStatusPublisher(channel, silentLogger).publish(down);
		expect(edits.map((e) => [e.id, embed(e.post)?.title])).toEqual([
			["90", BOT_OFFLINE_TITLE],
			["80", BOT_CRASHED_TITLE],
		]);
	});

	it("posts the offline message on its own when there's nothing to update", async () => {
		const { channel, sent } = fakeChannel();
		await createBotStatusPublisher(channel, silentLogger).publish(down);
		expect(sent.map((s) => embed(s.post)?.title)).toEqual([BOT_OFFLINE_TITLE]);
	});

	it("posts the offline message on its own when the edit fails", async () => {
		const { channel, sent } = fakeChannel([onlineOwn("100")]);
		vi.mocked(channel.edit).mockRejectedValueOnce(new Error("deleted"));
		await createBotStatusPublisher(channel, silentLogger).publish(down);
		expect(sent.map((s) => embed(s.post)?.title)).toEqual([BOT_OFFLINE_TITLE]);
	});

	it("ignores other people's and other kinds of posts", async () => {
		const { channel, edits } = fakeChannel([
			{ id: "1", title: BOT_ONLINE_TITLE, footer: undefined, timestamp: started },
			{ id: "2", title: "🟢 Pixelbar is open", footer: "x", timestamp: started },
		]);
		await createBotStatusPublisher(channel, silentLogger).publish(up);
		expect(edits).toEqual([]);
	});

	it("still works when the remembered post, history or store fail", async () => {
		const { channel, sent } = fakeChannel();
		vi.mocked(channel.findOwnPost).mockRejectedValueOnce(new Error("x"));
		vi.mocked(channel.recentOwnPosts).mockRejectedValueOnce(new Error("x"));
		const store = {
			load: () => "5",
			save: () => {
				throw new Error("disk full");
			},
		};
		await createBotStatusPublisher(channel, silentLogger, store).publish(up);
		expect(sent).toHaveLength(1);
	});

	it("ignores space announcements", async () => {
		const { channel, sent } = fakeChannel();
		await createBotStatusPublisher(channel, silentLogger).publish(space);
		expect(sent).toEqual([]);
	});
});

describe("the space publishers", () => {
	it("ignore bot status announcements", async () => {
		const { channel, sent } = fakeChannel();
		await createTimelinePublisher(channel).publish(up);
		await createLivePublisher(channel, silentLogger).publish(down);
		expect(sent).toEqual([]);
		expect(channel.recentOwnPosts).not.toHaveBeenCalled();
	});
});
