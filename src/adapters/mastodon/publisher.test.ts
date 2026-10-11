import { describe, expect, it, vi } from "vitest";
import type {
	BotStatusAnnouncement,
	ClosingTimeAnnouncement,
	SpaceStatusAnnouncement,
} from "../../core/announcement.ts";
import { silentLogger } from "../../core/logger.ts";
import type { MastodonStatusClient } from "./client.ts";
import { createMastodonPublisher, MASTODON_PUBLISHER_ID } from "./publisher.ts";
import type { Toot } from "./toots.ts";

const open: SpaceStatusAnnouncement = {
	kind: "space.status",
	state: "open",
	at: new Date("2026-10-11T18:00:00Z"),
	openedAt: null,
	text: "🟢 Pixelbar is now open",
};

const closing: ClosingTimeAnnouncement = {
	kind: "closing.time",
	text: "The space is closing.",
	body: "Discord **markdown**",
	at: new Date("2026-10-11T22:00:00Z"),
};

const botDown: BotStatusAnnouncement = {
	kind: "bot.status",
	phase: "down",
	build: {
		version: "0.6.0",
		commit: undefined,
		branch: undefined,
		env: "dev",
		runtime: "local",
	},
	startedAt: new Date("2026-10-11T17:00:00Z"),
	at: new Date("2026-10-11T18:00:00Z"),
	checks: [],
	reason: "restarting",
	text: "🔴 Pixel 0.6.0 is going offline: restarting",
};

function setup(
	kinds: ReadonlySet<"space.status" | "closing.time" | "bot.status"> = new Set(["space.status"]),
) {
	const posted: Toot[] = [];
	const client: MastodonStatusClient = {
		postStatus: vi.fn(async (toot) => {
			posted.push(toot);
		}),
	};
	const publisher = createMastodonPublisher({
		client,
		kinds,
		visibility: "public",
		logger: silentLogger,
		account: "pixel@mastodon.example",
		instanceHost: "mastodon.example",
	});
	return { publisher, client, posted };
}

describe("createMastodonPublisher", () => {
	it("has a stable id", () => {
		expect(setup().publisher.id).toBe(MASTODON_PUBLISHER_ID);
	});

	it("toots routed space.status announcements", async () => {
		const { publisher, posted } = setup();
		await publisher.publish(open);
		expect(posted).toEqual([{ status: "🟢 Pixelbar is now open", visibility: "public" }]);
	});

	it("ignores kinds that are not routed", async () => {
		const { publisher, client } = setup();
		await publisher.publish(closing);
		await publisher.publish(botDown);
		expect(client.postStatus).not.toHaveBeenCalled();
	});

	it("toots closing.time and bot.status when those kinds are routed", async () => {
		const { publisher, posted } = setup(new Set(["closing.time", "bot.status"]));
		await publisher.publish(closing);
		await publisher.publish(botDown);
		await publisher.publish(open);
		expect(posted).toEqual([
			{ status: "The space is closing.", visibility: "public" },
			{ status: "🔴 Pixel 0.6.0 is going offline: restarting", visibility: "public" },
		]);
	});

	it("does not post on reconcile", async () => {
		const { publisher, client } = setup();
		await publisher.reconcile?.({ state: "open", since: null });
		expect(client.postStatus).not.toHaveBeenCalled();
	});

	it("lets a client failure propagate so the announcer can report it", async () => {
		const { publisher, client } = setup();
		vi.mocked(client.postStatus).mockRejectedValueOnce(
			new Error("Mastodon responded with HTTP 503"),
		);
		await expect(publisher.publish(open)).rejects.toThrow(/HTTP 503/);
	});
});
