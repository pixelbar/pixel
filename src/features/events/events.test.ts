import { describe, expect, it } from "vitest";
import { type CalendarEvent, CalendarUnavailableError } from "../../core/calendar.ts";
import type { PlainCommand } from "../../core/command.ts";
import { context, plain } from "../../testing/fixtures.ts";
import { createEventsFeature, MAX_EVENTS } from "./index.ts";

// Saturday 3 October 2026, 14:00 in Amsterdam (summer time, UTC+2).
const NOW = new Date("2026-10-03T12:00:00Z");

const at = (iso: string) => new Date(iso);

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		id: "1",
		title: "Soldering workshop",
		startsAt: at("2026-10-04T18:00:00Z"), // Sunday 20:00 CEST
		endsAt: null,
		location: null,
		url: "https://discord.com/events/1/1",
		repeats: null,
		...overrides,
	};
}

function eventsCommand(
	calendar: { events: () => Promise<CalendarEvent[]> },
	options: { now?: Date; timezone?: string } = {},
): PlainCommand {
	const command = createEventsFeature({
		calendar,
		timezone: options.timezone ?? "Europe/Amsterdam",
		now: () => options.now ?? NOW,
	}).commands?.[0];
	return plain(command);
}

/** Runs /events against a calendar holding `events` and returns the embed. */
async function show(events: CalendarEvent[], options: { now?: Date; timezone?: string } = {}) {
	const reply = await eventsCommand({ events: async () => events }, options).handler(context());
	const embed = reply.embeds?.[0];
	if (!embed) throw new Error("no embed in the reply");
	return embed;
}

describe("/events", () => {
	it("is a public guest command and needs no 'Checking…' box", () => {
		const command = eventsCommand({ events: async () => [] });
		expect(command.name).toBe("events");
		expect(command.access.minTier).toBe("guest");
		expect(command.private).toBeFalsy();
		expect(command.placeholder).toBeUndefined();
	});

	it("says so when there's nothing coming up", async () => {
		expect(await show([])).toEqual({
			title: "📅 Nothing scheduled right now",
			description: "No upcoming events. Check back soon!",
			accent: "neutral",
		});
	});

	describe("an upcoming event", () => {
		it("shows a linked title, when, how soon, and nothing else it doesn't know", async () => {
			const embed = await show([event()]);
			expect(embed).toEqual({
				title: "📅 Upcoming at Pixelbar",
				description:
					"**[Soldering workshop](https://discord.com/events/1/1)**\nSun 4 Oct, 20:00 CEST · in 1 day",
				accent: "brand",
			});
		});

		it("shows the end time when it ends the same day", async () => {
			const embed = await show([event({ endsAt: at("2026-10-04T21:00:00Z") })]);
			expect(embed.description).toContain("Sun 4 Oct, 20:00–23:00 CEST · in 1 day");
		});

		it("shows only the start when it ends on a later day", async () => {
			const embed = await show([event({ endsAt: at("2026-10-05T00:30:00Z") })]);
			expect(embed.description).toContain("Sun 4 Oct, 20:00 CEST · in 1 day");
			expect(embed.description).not.toContain("–");
		});

		it("says how soon in the right units", async () => {
			const soon = await show([event({ startsAt: at("2026-10-03T12:25:00Z") })]);
			expect(soon.description).toContain("Sat 3 Oct, 14:25 CEST · in 25m");
			const today = await show([event({ startsAt: at("2026-10-03T15:20:00Z") })]);
			expect(today.description).toContain("Sat 3 Oct, 17:20 CEST · in 3h 20m");
		});

		it("uses winter time when it's winter", async () => {
			const embed = await show([event({ startsAt: at("2026-12-05T19:00:00Z") })], {
				now: at("2026-12-03T12:00:00Z"),
			});
			expect(embed.description).toContain("Sat 5 Dec, 20:00 CET · in 2 days");
		});

		it("shows times in the configured time zone", async () => {
			const embed = await show([event({ startsAt: at("2026-10-04T18:00:00Z") })], {
				timezone: "UTC",
			});
			expect(embed.description).toContain("Sun 4 Oct, 18:00 UTC");
		});

		it("rolls past midnight correctly", async () => {
			// 22:30 UTC is 00:30 the next day in Amsterdam.
			const embed = await show([event({ startsAt: at("2026-10-04T22:30:00Z") })]);
			expect(embed.description).toContain("Mon 5 Oct, 00:30 CEST");
		});

		it("shows where it is, and how often it repeats", async () => {
			const embed = await show([
				event({ location: "Pixelbar, Schiemond 20", repeats: "weekly on Tuesday" }),
			]);
			expect(embed.description).toContain(
				"Sun 4 Oct, 20:00 CEST · in 1 day · 🔁 weekly on Tuesday\n📍 Pixelbar, Schiemond 20",
			);
		});
	});

	describe("an event that's on now", () => {
		it("shows when it ends", async () => {
			const embed = await show([
				event({
					title: "Open evening",
					startsAt: at("2026-10-03T10:00:00Z"),
					endsAt: at("2026-10-03T16:00:00Z"),
				}),
			]);
			expect(embed.description).toBe(
				"🟢 **[Open evening](https://discord.com/events/1/1)**\nHappening now · until 18:00 CEST",
			);
		});

		it("shows the day too if it ends on a later day", async () => {
			const embed = await show([
				event({
					startsAt: at("2026-10-03T10:00:00Z"),
					endsAt: at("2026-10-04T00:30:00Z"),
				}),
			]);
			expect(embed.description).toContain("Happening now · until Sun 4 Oct, 02:30 CEST");
		});

		it("shows how long it's been going when there's no end time", async () => {
			const embed = await show([event({ startsAt: at("2026-10-03T10:30:00Z") })]);
			expect(embed.description).toContain("Happening now · started 1h 30m ago");
		});

		it("also shows where and how often", async () => {
			const embed = await show([
				event({
					startsAt: at("2026-10-03T10:00:00Z"),
					endsAt: at("2026-10-03T16:00:00Z"),
					location: "🔊 General",
					repeats: "weekly",
				}),
			]);
			expect(embed.description).toContain("until 18:00 CEST · 🔁 weekly\n📍 🔊 General");
		});
	});

	describe("which events are shown, and in what order", () => {
		it("lists what's on now first, then what's coming up, soonest first", async () => {
			const embed = await show([
				event({ id: "c", title: "Later", startsAt: at("2026-10-10T18:00:00Z") }),
				event({ id: "a", title: "Running", startsAt: at("2026-10-03T10:00:00Z") }),
				event({ id: "b", title: "Soon", startsAt: at("2026-10-04T18:00:00Z") }),
			]);
			const order = [...(embed.description ?? "").matchAll(/\[(Running|Soon|Later)\]/g)].map(
				(match) => match[1],
			);
			expect(order).toEqual(["Running", "Soon", "Later"]);
		});

		it("leaves out events that have already ended, even from an older cached list", async () => {
			const embed = await show([
				event({
					title: "Over",
					startsAt: at("2026-10-03T08:00:00Z"),
					endsAt: at("2026-10-03T11:00:00Z"),
				}),
				event({
					title: "Ending right now",
					startsAt: at("2026-10-03T08:00:00Z"),
					endsAt: at("2026-10-03T12:00:00Z"),
				}),
				event({ title: "Still to come" }),
			]);
			expect(embed.description).toContain("Still to come");
			expect(embed.description).not.toContain("Over");
			expect(embed.description).not.toContain("Ending right now");
		});

		it("shows an empty message if everything has ended", async () => {
			const embed = await show([
				event({ startsAt: at("2026-10-03T08:00:00Z"), endsAt: at("2026-10-03T11:00:00Z") }),
			]);
			expect(embed.title).toBe("📅 Nothing scheduled right now");
		});

		it("doesn't change the list it was given", async () => {
			const events = [
				event({ id: "b", startsAt: at("2026-10-10T18:00:00Z") }),
				event({ id: "a", startsAt: at("2026-10-04T18:00:00Z") }),
			];
			await show(events);
			expect(events.map((e) => e.id)).toEqual(["b", "a"]);
		});

		it(`shows at most ${MAX_EVENTS} and says how many more there are`, async () => {
			const events = Array.from({ length: 7 }, (_, i) =>
				event({
					id: String(i),
					title: `Event ${i}`,
					startsAt: new Date(at("2026-10-04T18:00:00Z").getTime() + i * 86_400_000),
				}),
			);
			const embed = await show(events);
			const shown = (embed.description ?? "").match(/\*\*\[Event \d\]/g) ?? [];
			expect(shown).toHaveLength(MAX_EVENTS);
			expect(embed.description).toContain("[Event 4]");
			expect(embed.description).not.toContain("[Event 5]");
			expect(embed.description?.endsWith("…and 2 more.")).toBe(true);
		});

		it("doesn't mention more when everything fits", async () => {
			const embed = await show([event()]);
			expect(embed.description).not.toContain("more");
		});
	});

	describe("text written by whoever created the event", () => {
		it("can't break the layout, fake a link or add formatting", async () => {
			const embed = await show([
				event({
					title: "**Free** [pizza](https://evil.example) <@123>\nsecond line",
					location: "Room _1_ <#456>",
					repeats: "`weekly`",
				}),
			]);
			expect(embed.description).toContain(
				"**[\\*\\*Free\\*\\* \\[pizza\\](https://evil.example) \\<@123\\> second line](https://discord.com/events/1/1)**",
			);
			expect(embed.description).toContain("📍 Room \\_1\\_ \\<#456\\>");
			expect(embed.description).toContain("🔁 \\`weekly\\`");
		});
	});

	describe("when the calendar can't be read", () => {
		it("explains, without details", async () => {
			const command = eventsCommand({
				events: async () => {
					throw new CalendarUnavailableError("The calendar couldn't be loaded", {
						cause: new Error("Discord API 500 with secrets"),
					});
				},
			});
			const reply = await command.handler(context());
			expect(reply.embeds?.[0]).toEqual({
				title: "⚠️ Couldn't load the calendar",
				description: "I can't reach the events right now. Try again in a bit.",
				accent: "warning",
			});
			expect(JSON.stringify(reply)).not.toContain("secrets");
		});

		it("lets unexpected errors through, so they're reported", async () => {
			const boom = new Error("a bug");
			const command = eventsCommand({
				events: async () => {
					throw boom;
				},
			});
			await expect(command.handler(context())).rejects.toBe(boom);
		});
	});
});
