import { type Client, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
	createDiscordPoster,
	requiredPermissions,
} from "../../../src/adapters/discord/channel-poster.ts";
import type { ChannelPost } from "../../../src/core/channel-posts.ts";

const GUILD = "100000000000000001";
const CHANNEL = "100000000000000010";
const CREATOR = "100000000000000002";
const { ViewChannel, SendMessages, MentionEveryone } = PermissionFlagsBits;
const BOT = new PermissionsBitField([ViewChannel, SendMessages, MentionEveryone]);

/** A fake client with one channel, the bot's permissions there and maybe the creator's. */
function fakeClient(creator: PermissionsBitField | "gone", bot = BOT) {
	const send = vi.fn(async (_message: unknown) => ({
		url: "https://discord.example/m",
		id: "100000000000000099",
	}));
	const me = { id: "bot" };
	const member = { id: CREATOR };
	const channel = {
		guildId: GUILD,
		name: "general",
		isDMBased: () => false,
		isSendable: () => true,
		send,
		messages: { edit: vi.fn() },
		permissionsFor: (who: unknown) => (who === me ? bot : creator === "gone" ? null : creator),
		guild: {
			members: {
				fetchMe: async () => me,
				fetch: vi.fn(async (id: string) => {
					if (creator === "gone" || id !== CREATOR) throw new Error("Unknown Member");
					return member;
				}),
			},
		},
	};
	const client = { channels: { fetch: async () => channel } } as unknown as Client<true>;
	const sent = () => send.mock.calls[0]?.[0] as { content: string; allowedMentions: unknown };
	return { client, channel, sent };
}

const message = (text: string): ChannelPost => ({ kind: "message", text });
const PINGS_ALL = { parse: ["everyone", "roles", "users"], repliedUser: false };
const NOBODY = { parse: [], repliedUser: false };

describe("the Discord poster", () => {
	it("pings who a scheduled message mentions, when its creator could", async () => {
		const creator = new PermissionsBitField([ViewChannel, SendMessages, MentionEveryone]);
		const { client, sent } = fakeClient(creator);
		await createDiscordPoster(client, GUILD).post(
			CHANNEL,
			message("@everyone <@&100000000000000003> <@100000000000000004>"),
			{ createdBy: `discord:${CREATOR}` },
		);
		expect(sent().allowedMentions).toEqual(PINGS_ALL);
	});

	it("pings people but not everyone when the creator can't mention everyone", async () => {
		const { client, sent } = fakeClient(new PermissionsBitField([ViewChannel, SendMessages]));
		await createDiscordPoster(client, GUILD).post(CHANNEL, message("@here <@100000000000000004>"), {
			createdBy: `discord:${CREATOR}`,
		});
		expect(sent().allowedMentions).toEqual({ parse: ["users"], repliedUser: false });
	});

	it("pings nobody once the creator can't post there, or has left", async () => {
		for (const creator of [new PermissionsBitField([ViewChannel]), "gone" as const]) {
			const { client, sent } = fakeClient(creator);
			await createDiscordPoster(client, GUILD).post(CHANNEL, message("<@100000000000000004>"), {
				createdBy: `discord:${CREATOR}`,
			});
			expect(sent().allowedMentions).toEqual(NOBODY);
		}
	});

	it("never pings from Pixel's own posts, even with a mention in a name", async () => {
		const { client, channel, sent } = fakeClient(BOT);
		await createDiscordPoster(client, GUILD).post(
			CHANNEL,
			message("**@everyone <@100000000000000004>** has been reported out of stock"),
		);
		expect(sent().allowedMentions).toEqual(NOBODY);
		expect(channel.guild.members.fetch).not.toHaveBeenCalled();
	});

	it("doesn't need Mention Everyone for Pixel's own posts, only for scheduled ones", async () => {
		const bot = new PermissionsBitField([ViewChannel, SendMessages]);
		const own = fakeClient(new PermissionsBitField([ViewChannel, SendMessages]), bot);
		await createDiscordPoster(own.client, GUILD).post(CHANNEL, message("@everyone"));
		expect(own.sent().content).toBe("@everyone");

		const scheduled = fakeClient(new PermissionsBitField([ViewChannel, SendMessages]), bot);
		await expect(
			createDiscordPoster(scheduled.client, GUILD).post(CHANNEL, message("@everyone"), {
				createdBy: `discord:${CREATOR}`,
			}),
		).rejects.toThrow(/MentionEveryone/);
		expect(
			await createDiscordPoster(scheduled.client, GUILD).check(CHANNEL, message("@here")),
		).toMatchObject({ ok: false });
	});

	it("needs Mention Everyone only for a message that can ping everyone", () => {
		expect(requiredPermissions(message("@everyone"))).toContain(MentionEveryone);
		expect(requiredPermissions(message("@everyone"), false)).not.toContain(MentionEveryone);
	});
});
