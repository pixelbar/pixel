import { ActivityType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { Announcement } from "../../core/announcement.ts";
import { createPresencePublisher, PRESENCE_PUBLISHER_ID, presenceFor } from "./presence.ts";

const at = new Date("2026-10-10T21:00:00Z");

function setup() {
	const setPresence = vi.fn();
	return { setPresence, publisher: createPresencePublisher({ setPresence }) };
}

describe("presenceFor", () => {
	it("is online and says open while the space is open", () => {
		expect(presenceFor("open")).toEqual({
			status: "online",
			activities: [{ type: ActivityType.Watching, name: "Pixelbar: open" }],
		});
	});

	it("is idle and says closed while the space is closed", () => {
		expect(presenceFor("closed")).toEqual({
			status: "idle",
			activities: [{ type: ActivityType.Watching, name: "Pixelbar: closed" }],
		});
	});
});

describe("presence publisher", () => {
	it("has its own id", () => {
		expect(setup().publisher.id).toBe(PRESENCE_PUBLISHER_ID);
	});

	it("sets the presence from the state it's told at startup", async () => {
		const { publisher, setPresence } = setup();
		await publisher.reconcile?.({ state: "open", since: null });
		expect(setPresence).toHaveBeenCalledExactlyOnceWith(presenceFor("open"));
	});

	it.each(["open", "closed"] as const)("follows a confirmed change to %s", async (state) => {
		const { publisher, setPresence } = setup();
		await publisher.publish({
			kind: "space.status",
			state,
			at,
			openedAt: null,
			text: state,
		});
		expect(setPresence).toHaveBeenCalledExactlyOnceWith(presenceFor(state));
	});

	it("re-sends the last presence after a new Discord session, and does nothing before one is set", async () => {
		const { publisher, setPresence } = setup();
		publisher.reapply();
		expect(setPresence).not.toHaveBeenCalled();

		await publisher.reconcile?.({ state: "open", since: null });
		publisher.reapply();
		expect(setPresence).toHaveBeenNthCalledWith(2, presenceFor("open"));

		await publisher.publish({
			kind: "space.status",
			state: "closed",
			at,
			openedAt: null,
			text: "closed",
		});
		publisher.reapply();
		expect(setPresence).toHaveBeenLastCalledWith(presenceFor("closed"));
		expect(setPresence).toHaveBeenCalledTimes(4);
	});

	it("ignores every other kind of announcement", async () => {
		const { publisher, setPresence } = setup();
		const others: Announcement[] = [
			{ kind: "closing.time", text: "t", body: "b", at },
			{
				kind: "bot.status",
				phase: "up",
				build: {
					version: "0",
					commit: undefined,
					branch: undefined,
					env: "local",
					runtime: "local",
				},
				startedAt: at,
				at,
				checks: [],
				text: "up",
			},
		];
		for (const announcement of others) await publisher.publish(announcement);
		expect(setPresence).not.toHaveBeenCalled();
	});
});
