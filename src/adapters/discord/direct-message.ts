import { Routes } from "discord.js";
import type { DirectMessenger } from "../../core/ports/direct-message.ts";

/**
 * Discord DMs for capability changes. Decisions live in the functions below so
 * they can be tested without a live client. Mentions stay off.
 */

/** The parts of discord.js's REST client this uses. */
export type DmRest = {
	post(route: `/${string}`, options?: { body: unknown }): Promise<unknown>;
};

const SNOWFLAKE = /^\d{17,20}$/;

/** The DM channel ID Discord returned, or a throw if the body isn't one. */
export function dmChannelId(body: unknown): string {
	if (typeof body === "object" && body !== null && "id" in body) {
		const id = (body as { id: unknown }).id;
		if (typeof id === "string" && SNOWFLAKE.test(id)) return id;
	}
	throw new Error("Discord didn't return a DM channel");
}

/**
 * A safe sentence for a Discord API error we know how to explain. Logged, never
 * shown to the person we tried to DM.
 */
export function describeDmFailure(error: unknown): string | undefined {
	const code =
		typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	switch (code) {
		case 50007: // Cannot send messages to this user
			return "they have DMs from server members closed";
		case 10007: // Unknown Member
		case 10013: // Unknown User
			return "they aren't in the Discord server";
		default:
			return undefined;
	}
}

export async function sendDirectMessage(rest: DmRest, userId: string, text: string): Promise<void> {
	const opened = await rest.post(Routes.userChannels(), { body: { recipient_id: userId } });
	const channelId = dmChannelId(opened);
	await rest.post(Routes.channelMessages(channelId), {
		body: { content: text, allowedMentions: { parse: [] } },
	});
}

export class DiscordDirectMessenger implements DirectMessenger {
	readonly #rest: DmRest;

	constructor(rest: DmRest) {
		this.#rest = rest;
	}

	async send(userId: string, text: string): Promise<void> {
		try {
			await sendDirectMessage(this.#rest, userId, text);
		} catch (error) {
			const known = describeDmFailure(error);
			throw known ? new Error(known) : error;
		}
	}
}
