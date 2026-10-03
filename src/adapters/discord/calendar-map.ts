import {
	GuildScheduledEventEntityType,
	GuildScheduledEventRecurrenceRuleFrequency,
	type GuildScheduledEventRecurrenceRuleWeekday,
	GuildScheduledEventStatus,
} from "discord.js";
import type { CalendarEvent } from "../../core/calendar.ts";

/** The parts of a discord.js GuildScheduledEvent that the mapping reads. */
export type ScheduledEventLike = {
	id: string;
	name: string;
	url: string;
	status: GuildScheduledEventStatus;
	entityType: GuildScheduledEventEntityType;
	scheduledStartTimestamp: number | null;
	scheduledEndTimestamp: number | null;
	channelId: string | null;
	entityMetadata: { location: string | null } | null;
	recurrenceRule: {
		frequency: GuildScheduledEventRecurrenceRuleFrequency;
		interval: number;
		byWeekday: readonly GuildScheduledEventRecurrenceRuleWeekday[] | null;
	} | null;
};

/**
 * Turns a Discord scheduled event into a neutral calendar event. Returns
 * undefined for events that are over or cancelled, or that have no start time.
 * `channelName` looks up a channel's name for voice and stage events.
 */
export function toCalendarEvent(
	event: ScheduledEventLike,
	channelName: (channelId: string) => string | undefined,
): CalendarEvent | undefined {
	if (
		event.status !== GuildScheduledEventStatus.Scheduled &&
		event.status !== GuildScheduledEventStatus.Active
	) {
		return undefined;
	}
	if (event.scheduledStartTimestamp === null) return undefined;

	return {
		id: event.id,
		title: event.name,
		startsAt: new Date(event.scheduledStartTimestamp),
		endsAt: event.scheduledEndTimestamp === null ? null : new Date(event.scheduledEndTimestamp),
		location: locationOf(event, channelName),
		url: event.url,
		repeats: event.recurrenceRule ? describeRecurrence(event.recurrenceRule) : null,
	};
}

function locationOf(
	event: ScheduledEventLike,
	channelName: (channelId: string) => string | undefined,
): string | null {
	if (event.entityType === GuildScheduledEventEntityType.External) {
		return event.entityMetadata?.location?.trim() || null;
	}
	const name = event.channelId ? channelName(event.channelId) : undefined;
	if (!name) return null;
	return event.entityType === GuildScheduledEventEntityType.StageInstance
		? `🎙️ ${name}`
		: `🔊 ${name}`;
}

const UNITS = {
	[GuildScheduledEventRecurrenceRuleFrequency.Daily]: { every: "daily", unit: "day" },
	[GuildScheduledEventRecurrenceRuleFrequency.Weekly]: { every: "weekly", unit: "week" },
	[GuildScheduledEventRecurrenceRuleFrequency.Monthly]: { every: "monthly", unit: "month" },
	[GuildScheduledEventRecurrenceRuleFrequency.Yearly]: { every: "yearly", unit: "year" },
} as const;

/** Monday is 0, as Discord numbers them. */
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Describes how an event repeats in plain words, e.g. "weekly on Tuesday" or
 * "every 2 weeks".
 */
export function describeRecurrence(
	rule: NonNullable<ScheduledEventLike["recurrenceRule"]>,
): string {
	const { every, unit } = UNITS[rule.frequency];
	const base = rule.interval <= 1 ? every : `every ${rule.interval} ${unit}s`;
	const days =
		rule.frequency === GuildScheduledEventRecurrenceRuleFrequency.Weekly && rule.byWeekday?.length
			? ` on ${listOf(rule.byWeekday.map((day) => WEEKDAYS[day] ?? "?"))}`
			: "";
	return `${base}${days}`;
}

/** "Tuesday", "Tuesday and Thursday", "Monday, Wednesday and Friday" */
function listOf(items: readonly string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
