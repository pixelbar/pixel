import { type Client, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
	describeChannelFetchError,
	LIVE_PERMISSIONS,
	missingPermissions,
	openAnnouncementChannel,
	TIMELINE_PERMISSIONS,
	toOwnPost,
} from "./announce-channel.ts";

const ME = "100000000000000010";
const SOMEONE = "100000000000000099";

describe("required permissions", () => {
	it("a live channel also needs to read history, to find the open post", () => {
		expect(TIMELINE_PERMISSIONS).not.toContain(PermissionFlagsBits.ReadMessageHistory);
		expect(LIVE_PERMISSIONS).toContain(PermissionFlagsBits.ReadMessageHistory);
		for (const permission of TIMELINE_PERMISSIONS) expect(LIVE_PERMISSIONS).toContain(permission);
	});
});

describe("missingPermissions", () => {
	const granted = (...bits: bigint[]) => new PermissionsBitField(bits);

	it("names what's missing", () => {
		expect(
			missingPermissions(
				granted(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages),
				LIVE_PERMISSIONS,
			),
		).toEqual(["EmbedLinks", "ReadMessageHistory"]);
	});

	it("is empty when everything needed is granted", () => {
		expect(missingPermissions(granted(...LIVE_PERMISSIONS), LIVE_PERMISSIONS)).toEqual([]);
	});

	it("treats administrators as having everything", () => {
		expect(
			missingPermissions(granted(PermissionFlagsBits.Administrator), LIVE_PERMISSIONS),
		).toEqual([]);
	});

	it("treats unknown permissions as all missing", () => {
		expect(missingPermissions(null, TIMELINE_PERMISSIONS)).toEqual([
			"ViewChannel",
			"SendMessages",
			"EmbedLinks",
		]);
	});
});

describe("describeChannelFetchError", () => {
	it("copes with things that aren't Discord errors", () => {
		expect(describeChannelFetchError(null)).toBe(
			"couldn't ask Discord about the channel, try again",
		);
		expect(describeChannelFetchError("nope")).toBe(
			"couldn't ask Discord about the channel, try again",
		);
	});
});

describe("toOwnPost", () => {
	const message = (authorId: string, embeds: Parameters<typeof toOwnPost>[0]["embeds"]) => ({
		id: "200000000000000001",
		author: { id: authorId },
		embeds,
	});

	it("describes the bot's own post by its first embed", () => {
		expect(
			toOwnPost(
				message(ME, [
					{
						title: "🟢 Pixelbar is open",
						timestamp: "2026-10-03T14:10:00.000Z",
						footer: { text: "This post updates when Pixelbar closes" },
					},
				]),
				ME,
			),
		).toEqual({
			id: "200000000000000001",
			title: "🟢 Pixelbar is open",
			footer: "This post updates when Pixelbar closes",
			timestamp: new Date("2026-10-03T14:10:00.000Z"),
		});
	});

	it("ignores everyone else's messages", () => {
		expect(
			toOwnPost(
				message(SOMEONE, [{ title: "🟢 Pixelbar is open", timestamp: null, footer: null }]),
				ME,
			),
		).toBeUndefined();
	});

	it("copes with own messages that have no embed or missing parts", () => {
		expect(toOwnPost(message(ME, []), ME)).toEqual({
			id: "200000000000000001",
			title: undefined,
			footer: undefined,
			timestamp: null,
		});
		expect(toOwnPost(message(ME, [{ title: null, timestamp: null, footer: null }]), ME)).toEqual({
			id: "200000000000000001",
			title: undefined,
			footer: undefined,
			timestamp: null,
		});
	});
});

describe("openAnnouncementChannel", () => {
	const GUILD = "100000000000000001";
	const CHANNEL = "100000000000000002";

	/** Just enough of a discord.js client for opening one channel. */
	function client(
		fetchMe: (options?: { force?: boolean }) => Promise<unknown>,
		granted = new PermissionsBitField(LIVE_PERMISSIONS),
	) {
		const channel = {
			guildId: GUILD,
			isDMBased: () => false,
			isSendable: () => true,
			guild: { members: { fetchMe } },
			permissionsFor: () => granted,
		};
		return { channels: { fetch: async () => channel } } as unknown as Client<true>;
	}

	/** A client whose channel fetch fails, or finds nothing. */
	const fetching = (fetch: () => Promise<unknown>) =>
		({ channels: { fetch } }) as unknown as Client<true>;
	const discordError = (code: number) => Object.assign(new Error("Discord said no"), { code });

	const open = (c: Client<true>) =>
		openAnnouncementChannel(c, { channelId: CHANNEL, guildId: GUILD, required: LIVE_PERMISSIONS });

	it("opens a channel the bot can use", async () => {
		expect((await open(client(async () => ({})))).ok).toBe(true);
	});

	it("asks Discord for the bot's roles instead of trusting the cache", async () => {
		const fetchMe = vi.fn(async () => ({}));
		await open(client(fetchMe));
		expect(fetchMe).toHaveBeenCalledWith({ force: true });
	});

	it("tells a channel that doesn't exist from one the bot can't see", async () => {
		await expect(
			open(
				fetching(async () => {
					throw discordError(10003);
				}),
			),
		).resolves.toEqual({ ok: false, problem: "there's no channel with that ID" });
		await expect(open(fetching(async () => null))).resolves.toEqual({
			ok: false,
			problem: "there's no channel with that ID",
		});
		await expect(
			open(
				fetching(async () => {
					throw discordError(50001);
				}),
			),
		).resolves.toEqual({
			ok: false,
			problem:
				"the bot can't see the channel (it needs View Channel there, or isn't in that server)",
		});
	});

	it("says to try again when Discord fails some other way", async () => {
		await expect(
			open(
				fetching(async () => {
					throw new Error("503 Service Unavailable");
				}),
			),
		).resolves.toEqual({ ok: false, problem: "couldn't ask Discord about the channel, try again" });
	});

	it("says it couldn't check, instead of throwing, when Discord won't say who the bot is", async () => {
		const failing = client(async () => {
			throw new Error("503 Service Unavailable");
		});
		await expect(open(failing)).resolves.toEqual({
			ok: false,
			problem: "couldn't check the bot's permissions there, try again",
		});
	});

	it("names the permissions the bot is missing", async () => {
		const result = await open(
			client(async () => ({}), new PermissionsBitField(TIMELINE_PERMISSIONS)),
		);
		expect(result).toEqual({
			ok: false,
			problem: "the bot lacks these permissions there: ReadMessageHistory",
		});
	});
});
