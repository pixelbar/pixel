import {
	GuildScheduledEventEntityType,
	GuildScheduledEventRecurrenceRuleFrequency,
	GuildScheduledEventRecurrenceRuleWeekday,
	GuildScheduledEventStatus,
} from "discord.js";
import { describe, expect, it } from "vitest";
import { describeRecurrence, type ScheduledEventLike, toCalendarEvent } from "./calendar-map.ts";

const START = Date.parse("2026-10-04T18:00:00Z");

function scheduled(overrides: Partial<ScheduledEventLike> = {}): ScheduledEventLike {
	return {
		id: "200000000000000001",
		name: "Soldering workshop",
		url: "https://discord.com/events/100000000000000020/200000000000000001",
		status: GuildScheduledEventStatus.Scheduled,
		entityType: GuildScheduledEventEntityType.External,
		scheduledStartTimestamp: START,
		scheduledEndTimestamp: START + 3 * 3_600_000,
		channelId: null,
		entityMetadata: { location: "Pixelbar, Schiemond 20" },
		recurrenceRule: null,
		...overrides,
	};
}

const names = new Map([["300000000000000001", "General"]]);
const channelName = (id: string) => names.get(id);

describe("toCalendarEvent", () => {
	it("maps an external event, with its location and a link", () => {
		expect(toCalendarEvent(scheduled(), channelName)).toEqual({
			id: "200000000000000001",
			title: "Soldering workshop",
			startsAt: new Date(START),
			endsAt: new Date(START + 3 * 3_600_000),
			location: "Pixelbar, Schiemond 20",
			url: "https://discord.com/events/100000000000000020/200000000000000001",
			repeats: null,
		});
	});

	it("keeps events that are running now", () => {
		expect(
			toCalendarEvent(scheduled({ status: GuildScheduledEventStatus.Active }), channelName),
		).toBeDefined();
	});

	it.each([
		["completed", GuildScheduledEventStatus.Completed],
		["cancelled", GuildScheduledEventStatus.Canceled],
	])("drops %s events", (_label, status) => {
		expect(toCalendarEvent(scheduled({ status }), channelName)).toBeUndefined();
	});

	it("drops an event without a start time", () => {
		expect(
			toCalendarEvent(scheduled({ scheduledStartTimestamp: null }), channelName),
		).toBeUndefined();
	});

	it("allows an event with no end time", () => {
		expect(
			toCalendarEvent(scheduled({ scheduledEndTimestamp: null }), channelName)?.endsAt,
		).toBeNull();
	});

	describe("location", () => {
		it("trims an external location, and treats a blank one as none", () => {
			expect(
				toCalendarEvent(scheduled({ entityMetadata: { location: "  Pixelbar  " } }), channelName)
					?.location,
			).toBe("Pixelbar");
			expect(
				toCalendarEvent(scheduled({ entityMetadata: { location: "   " } }), channelName)?.location,
			).toBeNull();
			expect(
				toCalendarEvent(scheduled({ entityMetadata: { location: null } }), channelName)?.location,
			).toBeNull();
			expect(
				toCalendarEvent(scheduled({ entityMetadata: null }), channelName)?.location,
			).toBeNull();
		});

		it("uses the channel's name for a voice event", () => {
			expect(
				toCalendarEvent(
					scheduled({
						entityType: GuildScheduledEventEntityType.Voice,
						channelId: "300000000000000001",
						entityMetadata: null,
					}),
					channelName,
				)?.location,
			).toBe("🔊 General");
		});

		it("uses the channel's name for a stage event", () => {
			expect(
				toCalendarEvent(
					scheduled({
						entityType: GuildScheduledEventEntityType.StageInstance,
						channelId: "300000000000000001",
						entityMetadata: null,
					}),
					channelName,
				)?.location,
			).toBe("🎙️ General");
		});

		it("has no location if the channel can't be found", () => {
			for (const channelId of ["300000000000000999", null]) {
				expect(
					toCalendarEvent(
						scheduled({
							entityType: GuildScheduledEventEntityType.Voice,
							channelId,
							entityMetadata: null,
						}),
						channelName,
					)?.location,
				).toBeNull();
			}
		});
	});

	it("describes how a recurring event repeats", () => {
		const event = toCalendarEvent(
			scheduled({
				recurrenceRule: {
					frequency: GuildScheduledEventRecurrenceRuleFrequency.Weekly,
					interval: 1,
					byWeekday: [GuildScheduledEventRecurrenceRuleWeekday.Tuesday],
				},
			}),
			channelName,
		);
		expect(event?.repeats).toBe("weekly on Tuesday");
	});
});

describe("describeRecurrence", () => {
	const rule = (
		frequency: GuildScheduledEventRecurrenceRuleFrequency,
		interval = 1,
		byWeekday: readonly GuildScheduledEventRecurrenceRuleWeekday[] | null = null,
	) => ({ frequency, interval, byWeekday });
	const { Daily, Weekly, Monthly, Yearly } = GuildScheduledEventRecurrenceRuleFrequency;
	const { Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday } =
		GuildScheduledEventRecurrenceRuleWeekday;

	it.each([
		[rule(Daily), "daily"],
		[rule(Weekly), "weekly"],
		[rule(Monthly), "monthly"],
		[rule(Yearly), "yearly"],
		[rule(Daily, 3), "every 3 days"],
		[rule(Weekly, 2), "every 2 weeks"],
		[rule(Monthly, 6), "every 6 months"],
		[rule(Yearly, 2), "every 2 years"],
		[rule(Weekly, 1, [Tuesday]), "weekly on Tuesday"],
		[rule(Weekly, 1, [Tuesday, Thursday]), "weekly on Tuesday and Thursday"],
		[rule(Weekly, 1, [Monday, Wednesday, Friday]), "weekly on Monday, Wednesday and Friday"],
		[rule(Weekly, 2, [Saturday, Sunday]), "every 2 weeks on Saturday and Sunday"],
		[rule(Weekly, 1, []), "weekly"],
		[rule(Daily, 1, [Tuesday]), "daily"],
	])("%j → %s", (input, expected) => {
		expect(describeRecurrence(input)).toBe(expected);
	});

	it("copes with a weekday it doesn't know", () => {
		expect(
			describeRecurrence(rule(Weekly, 1, [99 as GuildScheduledEventRecurrenceRuleWeekday])),
		).toBe("weekly on ?");
	});
});
