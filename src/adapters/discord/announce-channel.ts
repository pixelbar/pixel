import { type Client, PermissionFlagsBits, type PermissionsBitField } from "discord.js";
import type { AnnouncementChannel, OwnPost } from "./announce-publishers.ts";

/** What the bot needs in a timeline channel. */
export const TIMELINE_PERMISSIONS = [
	PermissionFlagsBits.ViewChannel,
	PermissionFlagsBits.SendMessages,
	PermissionFlagsBits.EmbedLinks,
] as const;

/** A live channel also needs to read history, to find the open post to update. */
export const LIVE_PERMISSIONS = [
	...TIMELINE_PERMISSIONS,
	PermissionFlagsBits.ReadMessageHistory,
] as const;

/** Names of the required permissions that `granted` lacks (all of them if unknown). */
export function missingPermissions(
	granted: Readonly<PermissionsBitField> | null,
	required: readonly bigint[],
): string[] {
	const names = new Map(Object.entries(PermissionFlagsBits).map(([name, bit]) => [bit, name]));
	return required.filter((bit) => !granted?.has(bit)).map((bit) => names.get(bit) ?? String(bit));
}

/** The parts of a discord.js Message that `toOwnPost` reads. */
export type MessageLike = {
	id: string;
	author: { id: string };
	embeds: readonly {
		title: string | null;
		timestamp: string | null;
		footer: { text: string } | null;
	}[];
};

/** Describes a message if the bot wrote it, otherwise undefined. */
export function toOwnPost(message: MessageLike, selfId: string): OwnPost | undefined {
	if (message.author.id !== selfId) return undefined;
	const embed = message.embeds[0];
	return {
		id: message.id,
		title: embed?.title ?? undefined,
		footer: embed?.footer?.text,
		timestamp: embed?.timestamp ? new Date(embed.timestamp) : null,
	};
}

export type OpenedChannel =
	| { ok: true; channel: AnnouncementChannel }
	| { ok: false; problem: string };

const NO_SUCH_CHANNEL = "there's no channel with that ID";

/** Why Discord wouldn't give the bot a channel, from its error code. */
export function describeChannelFetchError(error: unknown): string {
	const code =
		typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	switch (code) {
		case 10003: // Unknown Channel
			return NO_SUCH_CHANNEL;
		case 50001: // Missing Access
			return "the bot can't see the channel (it needs View Channel there, or isn't in that server)";
		default:
			return "couldn't ask Discord about the channel, try again";
	}
}

/**
 * Opens a channel for announcements and checks it's usable: it exists, is a
 * text channel in the Pixelbar server, and the bot has the permissions it
 * needs. Returns what's wrong instead of throwing, so one bad channel setting
 * turns that publisher off rather than breaking the bot.
 */
export async function openAnnouncementChannel(
	client: Client<true>,
	options: { channelId: string; guildId: string; required: readonly bigint[] },
): Promise<OpenedChannel> {
	let channel: Awaited<ReturnType<typeof client.channels.fetch>>;
	try {
		channel = await client.channels.fetch(options.channelId);
	} catch (error) {
		return { ok: false, problem: describeChannelFetchError(error) };
	}
	if (!channel) return { ok: false, problem: NO_SUCH_CHANNEL };
	if (channel.isDMBased() || !channel.isSendable()) {
		return { ok: false, problem: "it isn't a server text channel the bot can post in" };
	}
	if (channel.guildId !== options.guildId) {
		return { ok: false, problem: "the channel is in a different server" };
	}

	// Discord can fail this (a network blip, a rate limit). Say so rather than throw, so one
	// channel never stops the others or the rest of startup.
	// Always ask Discord: without the GuildMembers intent the cached member can miss a role given since.
	const me = await channel.guild.members.fetchMe({ force: true }).catch(() => null);
	if (!me) return { ok: false, problem: "couldn't check the bot's permissions there, try again" };
	const missing = missingPermissions(channel.permissionsFor(me), options.required);
	if (missing.length > 0) {
		return { ok: false, problem: `the bot lacks these permissions there: ${missing.join(", ")}` };
	}

	return {
		ok: true,
		channel: {
			async send(post) {
				const message = await channel.send(post);
				return { id: message.id };
			},
			async edit(id, post) {
				await channel.messages.edit(id, post);
			},
			async delete(id) {
				// Only ever the bot's own messages: Discord lets a bot delete those without any extra permission.
				await channel.messages.delete(id);
			},
			async recentOwnPosts(limit) {
				const messages = await channel.messages.fetch({ limit });
				return [...messages.values()]
					.sort((a, b) => b.createdTimestamp - a.createdTimestamp)
					.flatMap((message) => toOwnPost(message, client.user.id) ?? []);
			},
			async findOwnPost(id) {
				// A deleted message is an error from Discord; treat any failure as "not found".
				const message = await channel.messages.fetch(id).catch(() => null);
				return message ? toOwnPost(message, client.user.id) : undefined;
			},
		},
	};
}
