import { type APIEmbed, MessageFlags } from "discord.js";
import type { Embed, Reply } from "../../core/reply.ts";

/** Discord's documented limits. */
const LIMITS = {
	content: 2000,
	embeds: 10,
	title: 256,
	description: 4096,
	fields: 25,
	fieldName: 256,
	fieldValue: 1024,
} as const;

const PIXEL_COLOR = 0xf5a623;

export type DiscordReplyPayload = {
	content?: string;
	embeds?: APIEmbed[];
	flags?: MessageFlags.Ephemeral;
	allowedMentions: { parse: [] };
};

/**
 * Renders a core Reply as a Discord message payload. Mentions are always
 * disabled so that no reply — whatever text it echoes — can ping @everyone,
 * roles or users.
 */
export function renderReply(reply: Reply, isPrivate: boolean): DiscordReplyPayload {
	const embeds = (reply.embeds ?? []).slice(0, LIMITS.embeds).map(renderEmbed);
	const content = reply.text ? truncate(reply.text, LIMITS.content) : undefined;
	return {
		...(content || embeds.length === 0 ? { content: content ?? "Done." } : {}),
		...(embeds.length > 0 ? { embeds } : {}),
		...(isPrivate ? { flags: MessageFlags.Ephemeral } : {}),
		allowedMentions: { parse: [] },
	};
}

function renderEmbed(embed: Embed): APIEmbed {
	return {
		color: PIXEL_COLOR,
		title: truncate(embed.title, LIMITS.title),
		...(embed.description ? { description: truncate(embed.description, LIMITS.description) } : {}),
		...(embed.url ? { url: embed.url } : {}),
		...(embed.fields
			? {
					fields: embed.fields.slice(0, LIMITS.fields).map((f) => ({
						name: truncate(f.name, LIMITS.fieldName),
						value: truncate(f.value, LIMITS.fieldValue),
						inline: f.inline ?? false,
					})),
				}
			: {}),
	};
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
