import {
	type Calendar,
	type CalendarEvent,
	CalendarUnavailableError,
} from "../../core/calendar.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown, formatDuration, formatUntil } from "../../core/format.ts";
import type { Embed, Reply } from "../../core/reply.ts";

export type EventsDeps = {
	calendar: Pick<Calendar, "events">;
	/** The time zone times are shown in, e.g. "Europe/Amsterdam". */
	timezone: string;
	now?: () => Date;
};

/** How many events `/events` lists. */
export const MAX_EVENTS = 5;

/** `/events`: what's coming up at Pixelbar, and what's on right now. */
export function createEventsFeature(deps: EventsDeps): Feature {
	const now = deps.now ?? (() => new Date());
	return {
		name: "events",
		commands: [
			{
				name: "events",
				description: "See what's coming up at Pixelbar",
				access: { minTier: "guest" },
				handler: async (): Promise<Reply> => {
					let events: CalendarEvent[];
					try {
						events = await deps.calendar.events();
					} catch (error) {
						if (error instanceof CalendarUnavailableError) return { embeds: [unavailable()] };
						throw error;
					}
					return { embeds: [describe(events, now(), deps.timezone)] };
				},
			},
		],
	};
}

function describe(events: readonly CalendarEvent[], now: Date, zone: string): Embed {
	// Drop anything that has already ended (a cached list can be a minute or two old),
	// then show what's on now first, followed by what's coming up, soonest first.
	const sorted = events
		.filter((event) => !(event.endsAt && event.endsAt <= now))
		.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
	const running = sorted.filter((event) => event.startsAt <= now);
	const upcoming = sorted.filter((event) => event.startsAt > now);
	const shown = [...running, ...upcoming];

	if (shown.length === 0) {
		return {
			title: "📅 Nothing scheduled right now",
			description: "No upcoming events. Check back soon!",
			accent: "neutral",
		};
	}

	const entries = shown.slice(0, MAX_EVENTS).map((event) => entry(event, now, zone));
	const more = shown.length - MAX_EVENTS;
	if (more > 0) entries.push(`…and ${more} more.`);
	return { title: "📅 Upcoming at Pixelbar", description: entries.join("\n\n"), accent: "brand" };
}

function entry(event: CalendarEvent, now: Date, zone: string): string {
	const title = `[${escapeMarkdown(event.title)}](${event.url})`;
	const repeats = event.repeats ? ` · 🔁 ${escapeMarkdown(event.repeats)}` : "";
	const location = event.location ? `\n📍 ${escapeMarkdown(event.location)}` : "";

	if (event.startsAt <= now) {
		const until = event.endsAt
			? `until ${sameDay(now, event.endsAt, zone) ? time(event.endsAt, zone) : dateTime(event.endsAt, zone)}`
			: `started ${formatDuration(now.getTime() - event.startsAt.getTime())} ago`;
		return `🟢 **${title}**\nHappening now · ${until}${repeats}${location}`;
	}

	const when =
		event.endsAt && sameDay(event.startsAt, event.endsAt, zone)
			? `${date(event.startsAt, zone)}, ${time(event.startsAt, zone, false)}–${time(event.endsAt, zone)}`
			: dateTime(event.startsAt, zone);
	const until = formatUntil(event.startsAt.getTime() - now.getTime());
	return `**${title}**\n${when} · ${until}${repeats}${location}`;
}

function unavailable(): Embed {
	return {
		title: "⚠️ Couldn't load the calendar",
		description: "I can't reach the events right now. Try again in a bit.",
		accent: "warning",
	};
}

/** Pieces of a date as people in `zone` would read them, e.g. weekday "Sat", day "4", month "Oct". */
function parts(date: Date, zone: string) {
	const found = new Intl.DateTimeFormat("en-GB", {
		timeZone: zone,
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	}).formatToParts(date);
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		found.find((part) => part.type === type)?.value ?? "";
	return {
		date: `${get("weekday")} ${get("day")} ${get("month")}`,
		time: `${get("hour")}:${get("minute")}`,
		zone: get("timeZoneName"),
	};
}

/** "Sat 4 Oct" */
const date = (when: Date, zone: string): string => parts(when, zone).date;

/** "20:00 CEST", or just "20:00" when the zone is shown elsewhere in the same line. */
const time = (when: Date, zone: string, withZone = true): string => {
	const p = parts(when, zone);
	return withZone ? `${p.time} ${p.zone}` : p.time;
};

/** "Sat 4 Oct, 20:00 CEST" */
const dateTime = (when: Date, zone: string): string => `${date(when, zone)}, ${time(when, zone)}`;

/** Whether two moments fall on the same calendar day in `zone`. */
function sameDay(a: Date, b: Date, zone: string): boolean {
	const day = (when: Date) =>
		new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(when);
	return day(a) === day(b);
}
