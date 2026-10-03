import { describe, expect, it } from "vitest";
import type { SpaceStatusAnnouncement } from "../../core/announcement.ts";
import {
	LIVE_CLOSED_TITLE,
	LIVE_OPEN_FOOTER,
	LIVE_OPEN_TITLE,
	liveClosedPost,
	liveOpenPost,
	liveStandaloneClosedPost,
	timelinePost,
} from "./announce-render.ts";
import { accentColor } from "./render.ts";

const at = new Date("2026-10-03T17:30:00Z");
const openedAt = new Date("2026-10-03T14:10:00Z"); // 3h 20m earlier
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

const announcement = (overrides: Partial<SpaceStatusAnnouncement>): SpaceStatusAnnouncement => ({
	kind: "space.status",
	state: "open",
	at,
	openedAt: null,
	text: "",
	...overrides,
});

describe("timeline style", () => {
	it("posts an opening as its own post with the time", () => {
		expect(timelinePost(announcement({ state: "open" }))).toEqual({
			embeds: [
				{
					title: "🟢 Pixelbar opened",
					description: `<t:${unix(at)}:f>`,
					color: accentColor("positive"),
					timestamp: at.toISOString(),
				},
			],
			allowedMentions: { parse: [] },
		});
	});

	it("posts a closing with how long the space was open", () => {
		const { embeds } = timelinePost(announcement({ state: "closed", openedAt }));
		expect(embeds[0]).toEqual({
			title: "🔴 Pixelbar closed",
			description: `<t:${unix(at)}:f>\nWas open for 3h 20m.`,
			color: accentColor("negative"),
			timestamp: at.toISOString(),
		});
	});

	it("posts a closing without a duration when it isn't known", () => {
		const { embeds } = timelinePost(announcement({ state: "closed", openedAt: null }));
		expect(embeds[0]?.description).toBe(`<t:${unix(at)}:f>`);
	});
});

describe("live style", () => {
	it("opens with a post that says it will update, and is recognisable later", () => {
		const { embeds, allowedMentions } = liveOpenPost(openedAt);
		expect(allowedMentions).toEqual({ parse: [] });
		expect(embeds[0]).toEqual({
			title: LIVE_OPEN_TITLE,
			description: `Open since <t:${unix(openedAt)}:t> (<t:${unix(openedAt)}:R>)`,
			color: accentColor("positive"),
			timestamp: openedAt.toISOString(),
			footer: { text: LIVE_OPEN_FOOTER },
		});
	});

	it("turns into a closed post showing when it was open", () => {
		const { embeds } = liveClosedPost(openedAt, at);
		expect(embeds[0]).toEqual({
			title: LIVE_CLOSED_TITLE,
			description: `Was open from <t:${unix(openedAt)}:f> to <t:${unix(at)}:t> (3h 20m).`,
			color: accentColor("negative"),
			timestamp: at.toISOString(),
		});
		expect(embeds[0]?.footer).toBeUndefined();
	});

	it("doesn't invent a closing time Pixel didn't see", () => {
		const { embeds } = liveClosedPost(openedAt, null);
		expect(embeds[0]?.description).toBe(
			`Was open from <t:${unix(openedAt)}:f>. The closing time wasn't seen.`,
		);
		expect(embeds[0]?.timestamp).toBeUndefined();
	});

	it("copes with only a closing time, or neither", () => {
		expect(liveClosedPost(null, at).embeds[0]?.description).toBe(`Closed <t:${unix(at)}:f>.`);
		const bare = liveClosedPost(null, null).embeds[0];
		expect(bare?.title).toBe(LIVE_CLOSED_TITLE);
		expect(bare?.description).toBeUndefined();
		expect(bare?.timestamp).toBeUndefined();
	});

	it("stands alone as a closed post when there was no open post to update", () => {
		expect(liveStandaloneClosedPost(announcement({ state: "closed", openedAt })).embeds[0]).toEqual(
			{
				title: LIVE_CLOSED_TITLE,
				description: `Closed <t:${unix(at)}:f>. Was open for 3h 20m.`,
				color: accentColor("negative"),
				timestamp: at.toISOString(),
			},
		);
		expect(
			liveStandaloneClosedPost(announcement({ state: "closed", openedAt: null })).embeds[0]
				?.description,
		).toBe(`Closed <t:${unix(at)}:f>.`);
	});
});

describe("every post", () => {
	it("is embeds only and can never mention anyone", () => {
		const posts = [
			timelinePost(announcement({ state: "open" })),
			timelinePost(announcement({ state: "closed", openedAt })),
			liveOpenPost(at),
			liveClosedPost(openedAt, at),
			liveStandaloneClosedPost(announcement({ state: "closed" })),
		];
		for (const post of posts) {
			expect(post.allowedMentions).toEqual({ parse: [] });
			expect(Object.keys(post).sort()).toEqual(["allowedMentions", "embeds"]);
		}
	});
});
