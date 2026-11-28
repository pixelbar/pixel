import { type Client, PermissionFlagsBits } from "discord.js";
import type {
	AttendanceMessage,
	ChannelCheck,
	ChannelPost,
	ChannelPoster,
	PostOptions,
} from "../../core/channel-posts.ts";
import type { DoorbellMessage } from "../../core/doorbell.ts";
import { allowedMentionsFor, detectPostMentions } from "../../core/mentions.ts";
import { missingPermissions } from "./announce-channel.ts";
import { attendanceComponents } from "./attendance-buttons.ts";
import { doorbellComponents } from "./doorbell-buttons.ts";

/**
 * Scheduled posts on Discord: a plain message, a native Discord poll, which
 * Discord counts and closes itself (and announces the result), or an attendance
 * poll, a message with Pixel's buttons that Pixel counts and edits itself. Only a
 * post someone scheduled (`PostOptions.createdBy`) can ping, and only what its
 * creator could ping themselves when it goes out; Pixel's own posts and an
 * attendance poll never ping.
 */

/**
 * What a post needs from the bot in the channel. A message that would ping
 * @everyone or @here needs Mention Everyone; one that can't ping (Pixel's own) doesn't.
 */
export function requiredPermissions(post: ChannelPost, pings = true): bigint[] {
	const base = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
	if (post.kind === "poll") return [...base, PermissionFlagsBits.SendPolls];
	if (post.kind === "attendance") return base;
	return pings && detectPostMentions(post).everyone
		? [...base, PermissionFlagsBits.MentionEveryone]
		: base;
}

/** What someone may ping in a channel: nobody, unless we found them and they can post there. */
export const NO_PINGS = { canMentionEveryone: false, canPost: false } as const;

/** The message Discord is sent for a post (the API's shape), as a reply if asked. */
export function toDiscordMessage(
	post: ChannelPost,
	callerPermissions: { canMentionEveryone: boolean; canPost: boolean },
	options: PostOptions = {},
) {
	return { ...messageBody(post, callerPermissions), ...replyTo(options) };
}

/**
 * A reply to a message in the same channel. It never pings that message's author, and
 * still posts if the message has gone.
 */
function replyTo({ replyTo }: PostOptions) {
	return replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {};
}

function messageBody(
	post: ChannelPost,
	callerPermissions: { canMentionEveryone: boolean; canPost: boolean },
) {
	if (post.kind === "attendance") {
		// Its message needs a poll ID for the buttons: that's `toAttendanceMessage`.
		throw new Error("an attendance poll is posted with postAttendance");
	}
	const detected = detectPostMentions(post);
	const allowedMentions = allowedMentionsFor(detected, callerPermissions);

	if (post.kind === "message") {
		return {
			content: post.text,
			allowedMentions,
		};
	}
	return {
		poll: {
			question: { text: post.question },
			answers: post.answers.map((text) => ({ text })),
			duration: post.durationHours,
			allowMultiselect: post.multiple,
		},
		allowedMentions,
	};
}

/** An attendance poll's message: its text, and a button per answer while it's open. */
export function toAttendanceMessage(message: AttendanceMessage) {
	return {
		content: message.text,
		// Always set, so closing it removes the buttons.
		components: attendanceComponents(message),
		allowedMentions: { parse: [] },
	};
}

/** A doorbell post: its text, and the Answer button while the call can be answered. */
export function toDoorbellMessage(message: DoorbellMessage) {
	return {
		content: message.text,
		// Always set, so settling it removes the button.
		components: doorbellComponents(message),
		allowedMentions: { parse: [] },
	};
}

/** What an attendance poll's message needs (only the kind matters). */
const ATTENDANCE_CHECK: ChannelPost = {
	kind: "attendance",
	question: ".",
	answers: [],
	durationHours: 1,
};

export function createDiscordPoster(client: Client<true>, guildId: string): ChannelPoster {
	async function open(
		channelId: string,
		post: ChannelPost,
		createdBy?: string,
		/** False for a post that can't ping, so it doesn't need Mention Everyone. */
		pings = true,
	): Promise<
		| { ok: false; problem: string }
		| {
				ok: true;
				channel: Extract<
					Exclude<Awaited<ReturnType<typeof client.channels.fetch>>, null>,
					{ send: unknown; messages: unknown }
				>;
				callerPermissions: { canMentionEveryone: boolean; canPost: boolean };
		  }
	> {
		const channel = await client.channels.fetch(channelId).catch(() => null);
		if (!channel)
			return { ok: false as const, problem: "the channel doesn't exist or I can't see it" };
		if (channel.isDMBased() || !channel.isSendable() || !("guildId" in channel)) {
			return { ok: false as const, problem: "it isn't a server channel I can post in" };
		}
		if (channel.guildId !== guildId)
			return { ok: false as const, problem: "it's in a different server" };
		const me = await channel.guild.members.fetchMe();
		const missing = missingPermissions(
			channel.permissionsFor(me),
			requiredPermissions(post, pings),
		);
		if (missing.length > 0) {
			return {
				ok: false as const,
				problem: `I'm missing these permissions there: ${missing.join(", ")}`,
			};
		}

		// Re-check the creator's permissions for mentions at post time. Without a creator
		// (Pixel's own posts) nothing pings, so a name with `<@…>` in it can't ping anyone.
		let callerPermissions: { canMentionEveryone: boolean; canPost: boolean } = NO_PINGS;
		if (createdBy?.startsWith("discord:")) {
			const userId = createdBy.slice("discord:".length);
			try {
				const member = await channel.guild.members.fetch(userId).catch(() => null);
				if (member) {
					const permissions = channel.permissionsFor(member);
					if (permissions) {
						const hasViewChannel = permissions.has(PermissionFlagsBits.ViewChannel);
						const hasSendMessages = permissions.has(PermissionFlagsBits.SendMessages);
						const isAdmin = permissions.has(PermissionFlagsBits.Administrator);
						callerPermissions = {
							canPost: (hasViewChannel && hasSendMessages) || isAdmin,
							canMentionEveryone:
								((hasViewChannel && hasSendMessages) || isAdmin) &&
								(permissions.has(PermissionFlagsBits.MentionEveryone) || isAdmin),
						};
					}
				}
			} catch {
				// If we can't fetch the member, assume no mention permissions
			}
		}

		return { ok: true as const, channel, callerPermissions };
	}

	return {
		async check(channelId, post): Promise<ChannelCheck> {
			const opened = await open(channelId, post);
			return opened.ok
				? { ok: true, name: "name" in opened.channel ? String(opened.channel.name) : channelId }
				: opened;
		},
		async post(channelId, post, options) {
			const createdBy = options?.createdBy;
			const opened = await open(channelId, post, createdBy, createdBy !== undefined);
			if (!opened.ok) throw new Error(`Can't post a scheduled post: ${opened.problem}`);
			const sent = await opened.channel.send(
				toDiscordMessage(post, opened.callerPermissions, options),
			);
			return { url: sent.url, messageId: sent.id };
		},
		async postAttendance(channelId, message) {
			const opened = await open(channelId, ATTENDANCE_CHECK);
			if (!opened.ok) throw new Error(`Can't post an attendance poll: ${opened.problem}`);
			const sent = await opened.channel.send(toAttendanceMessage(message));
			return { url: sent.url, messageId: sent.id };
		},
		async editAttendance(channelId, messageId, message) {
			const opened = await open(channelId, ATTENDANCE_CHECK);
			if (!opened.ok) throw new Error(`Can't update an attendance poll: ${opened.problem}`);
			await opened.channel.messages.edit(messageId, toAttendanceMessage(message));
		},
		// A doorbell post needs what an attendance poll does: to see the channel and post there.
		async postDoorbell(channelId, message) {
			const opened = await open(channelId, ATTENDANCE_CHECK);
			if (!opened.ok) throw new Error(`Can't post the doorbell: ${opened.problem}`);
			const sent = await opened.channel.send(toDoorbellMessage(message));
			return { url: sent.url, messageId: sent.id };
		},
		async editDoorbell(channelId, messageId, message) {
			const opened = await open(channelId, ATTENDANCE_CHECK);
			if (!opened.ok) throw new Error(`Can't update the doorbell: ${opened.problem}`);
			await opened.channel.messages.edit(messageId, toDoorbellMessage(message));
		},
	};
}
