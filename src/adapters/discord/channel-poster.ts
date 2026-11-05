import { type Client, PermissionFlagsBits } from "discord.js";
import type {
	AttendanceMessage,
	ChannelCheck,
	ChannelPost,
	ChannelPoster,
	PostOptions,
} from "../../core/channel-posts.ts";
import { missingPermissions } from "./announce-channel.ts";
import { attendanceComponents } from "./attendance-buttons.ts";

/**
 * Scheduled posts on Discord: a plain message, a native Discord poll, which
 * Discord counts and closes itself (and announces the result), or an attendance
 * poll, a message with Pixel's buttons that Pixel counts and edits itself. Pings only
 * fire when the schedule allows them; an attendance poll never pings.
 */

/** What a post needs from the bot in the channel. */
export function requiredPermissions(post: ChannelPost): bigint[] {
	const base = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
	if (post.kind === "poll") return [...base, PermissionFlagsBits.SendPolls];
	if (post.kind === "attendance") return base;
	return post.mentions ? [...base, PermissionFlagsBits.MentionEveryone] : base;
}

/** The message Discord is sent for a post (the API's shape), as a reply if asked. */
export function toDiscordMessage(post: ChannelPost, options: PostOptions = {}) {
	return { ...messageBody(post), ...replyTo(options) };
}

/**
 * A reply to a message in the same channel. It never pings that message's author, and
 * still posts if the message has gone.
 */
function replyTo({ replyTo }: PostOptions) {
	return replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {};
}

function messageBody(post: ChannelPost) {
	if (post.kind === "attendance") {
		// Its message needs a poll ID for the buttons: that's `toAttendanceMessage`.
		throw new Error("an attendance poll is posted with postAttendance");
	}
	if (post.kind === "message") {
		return {
			content: post.text,
			allowedMentions: post.mentions
				? {
						parse: ["everyone" as const, "roles" as const, "users" as const],
						repliedUser: false,
					}
				: { parse: [], repliedUser: false },
		};
	}
	return {
		poll: {
			question: { text: post.question },
			answers: post.answers.map((text) => ({ text })),
			duration: post.durationHours,
			allowMultiselect: post.multiple,
		},
		allowedMentions: { parse: [], repliedUser: false },
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

/** What an attendance poll's message needs (only the kind matters). */
const ATTENDANCE_CHECK: ChannelPost = {
	kind: "attendance",
	question: ".",
	answers: [],
	durationHours: 1,
};

export function createDiscordPoster(client: Client<true>, guildId: string): ChannelPoster {
	async function open(channelId: string, post: ChannelPost) {
		const channel = await client.channels.fetch(channelId).catch(() => null);
		if (!channel)
			return { ok: false as const, problem: "the channel doesn't exist or I can't see it" };
		if (channel.isDMBased() || !channel.isSendable() || !("guildId" in channel)) {
			return { ok: false as const, problem: "it isn't a server channel I can post in" };
		}
		if (channel.guildId !== guildId)
			return { ok: false as const, problem: "it's in a different server" };
		const me = await channel.guild.members.fetchMe();
		const missing = missingPermissions(channel.permissionsFor(me), requiredPermissions(post));
		if (missing.length > 0) {
			return {
				ok: false as const,
				problem: `I'm missing these permissions there: ${missing.join(", ")}`,
			};
		}
		return { ok: true as const, channel };
	}

	return {
		async check(channelId, post): Promise<ChannelCheck> {
			const opened = await open(channelId, post);
			return opened.ok
				? { ok: true, name: "name" in opened.channel ? String(opened.channel.name) : channelId }
				: opened;
		},
		async post(channelId, post, options) {
			const opened = await open(channelId, post);
			if (!opened.ok) throw new Error(`Can't post a scheduled post: ${opened.problem}`);
			const sent = await opened.channel.send(toDiscordMessage(post, options));
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
	};
}
