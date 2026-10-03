import { type Client, GuildScheduledEventEntityType, GuildScheduledEventStatus } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { ScheduledEventLike } from "./calendar-map.ts";
import { createDiscordCalendarSource } from "./calendar-source.ts";

const GUILD = "100000000000000020";
const VOICE_CHANNEL = "300000000000000001";
const START = Date.parse("2026-10-04T18:00:00Z");

const discordEvent = (overrides: Partial<ScheduledEventLike> = {}): ScheduledEventLike => ({
	id: "200000000000000001",
	name: "Soldering workshop",
	url: `https://discord.com/events/${GUILD}/200000000000000001`,
	status: GuildScheduledEventStatus.Scheduled,
	entityType: GuildScheduledEventEntityType.Voice,
	scheduledStartTimestamp: START,
	scheduledEndTimestamp: null,
	channelId: VOICE_CHANNEL,
	entityMetadata: null,
	recurrenceRule: null,
	...overrides,
});

/** A stand-in for what Discord currently says, which the test can change between calls. */
function fakeDiscord() {
	const state = {
		events: [discordEvent()],
		channelNames: new Map([[VOICE_CHANNEL, "General"]]),
		error: undefined as Error | undefined,
	};
	const fetchEvents = vi.fn(async (..._args: unknown[]) => {
		if (state.error) throw state.error;
		return new Map(state.events.map((event) => [event.id, event]));
	});
	const guild = {
		scheduledEvents: { fetch: fetchEvents },
		channels: { cache: { get: (id: string) => ({ name: state.channelNames.get(id) }) } },
	};
	const fetchGuild = vi.fn(async (_id: string) => guild);
	const client = { guilds: { fetch: fetchGuild } } as unknown as Client<true>;
	return { state, fetchEvents, fetchGuild, source: createDiscordCalendarSource(client, GUILD) };
}

describe("createDiscordCalendarSource", () => {
	it("reads the server's scheduled events and maps them", async () => {
		const { source, fetchGuild } = fakeDiscord();
		const events = await source.upcoming();
		expect(fetchGuild).toHaveBeenCalledWith(GUILD);
		expect(events).toEqual([
			{
				id: "200000000000000001",
				title: "Soldering workshop",
				startsAt: new Date(START),
				endsAt: null,
				location: "🔊 General",
				url: `https://discord.com/events/${GUILD}/200000000000000001`,
				repeats: null,
			},
		]);
	});

	it("drops cancelled and finished events", async () => {
		const { source, state } = fakeDiscord();
		state.events = [
			discordEvent({ id: "1", status: GuildScheduledEventStatus.Canceled }),
			discordEvent({ id: "2", status: GuildScheduledEventStatus.Completed }),
			discordEvent({ id: "3" }),
		];
		expect((await source.upcoming()).map((event) => event.id)).toEqual(["3"]);
	});

	describe("is always live", () => {
		it("asks Discord for the whole list every time, never for one remembered event", async () => {
			const { source, fetchEvents } = fakeDiscord();
			await source.upcoming();
			await source.upcoming();
			expect(fetchEvents).toHaveBeenCalledTimes(2);
			// No ID or options: discord.js only skips the request when asked for one event by ID.
			expect(fetchEvents.mock.calls).toEqual([[], []]);
		});

		it("shows a renamed event on the very next call", async () => {
			const { source, state } = fakeDiscord();
			expect((await source.upcoming())[0]?.title).toBe("Soldering workshop");
			state.events = [discordEvent({ name: "Soldering night" })];
			expect((await source.upcoming())[0]?.title).toBe("Soldering night");
		});

		it("shows a rescheduled event on the very next call", async () => {
			const { source, state } = fakeDiscord();
			state.events = [discordEvent({ scheduledStartTimestamp: START + 86_400_000 })];
			expect((await source.upcoming())[0]?.startsAt).toEqual(new Date(START + 86_400_000));
		});

		it("shows a renamed voice channel on the very next call", async () => {
			const { source, state } = fakeDiscord();
			expect((await source.upcoming())[0]?.location).toBe("🔊 General");
			state.channelNames.set(VOICE_CHANNEL, "Workshop");
			expect((await source.upcoming())[0]?.location).toBe("🔊 Workshop");
		});

		it("doesn't keep an event that was deleted", async () => {
			const { source, state } = fakeDiscord();
			await source.upcoming();
			state.events = [];
			expect(await source.upcoming()).toEqual([]);
		});
	});

	it("lets a Discord failure through, so the calendar can report it as unavailable", async () => {
		const { source, state } = fakeDiscord();
		state.error = new Error("Discord API 500");
		await expect(source.upcoming()).rejects.toThrow("Discord API 500");
	});
});
