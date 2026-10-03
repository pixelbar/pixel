import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it } from "vitest";
import {
	LIVE_PERMISSIONS,
	missingPermissions,
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
