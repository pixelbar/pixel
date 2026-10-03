import type { Client } from "discord.js";
import type { CalendarSource } from "../../core/calendar.ts";
import { toCalendarEvent } from "./calendar-map.ts";

/**
 * Pixelbar's calendar from the server's Discord scheduled events. Needs no
 * privileged intents or extra permissions: it reads them over REST.
 */
export function createDiscordCalendarSource(client: Client<true>, guildId: string): CalendarSource {
	return {
		async upcoming() {
			const guild = await client.guilds.fetch(guildId);
			const events = await guild.scheduledEvents.fetch();
			const channelName = (channelId: string) => guild.channels.cache.get(channelId)?.name;
			return [...events.values()].flatMap((event) => toCalendarEvent(event, channelName) ?? []);
		},
	};
}
