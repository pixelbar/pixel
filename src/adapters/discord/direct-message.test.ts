import { Routes } from "discord.js";
import { describe, expect, it } from "vitest";
import { IDS } from "../../testing/fixtures.ts";
import {
	DiscordDirectMessenger,
	type DmRest,
	describeDmFailure,
	dmChannelId,
	sendDirectMessage,
} from "./direct-message.ts";

const CHANNEL = "100000000000000200";
const TEXT = "Pixel granted you the **front-door** capability.";

function fakeRest(options: { channel?: unknown; failOn?: "open" | "send"; code?: number } = {}) {
	const calls: { route: string; body: unknown }[] = [];
	const rest: DmRest = {
		async post(route, opts) {
			calls.push({ route, body: opts?.body });
			if (options.failOn === "open" && route === Routes.userChannels()) {
				throw { code: options.code ?? 50007 };
			}
			if (options.failOn === "send" && route === Routes.channelMessages(CHANNEL)) {
				throw { code: options.code ?? 50007 };
			}
			if (route === Routes.userChannels()) {
				return options.channel === undefined ? { id: CHANNEL } : options.channel;
			}
			return { id: "100000000000000300" };
		},
	};
	return { rest, calls };
}

describe("dmChannelId", () => {
	it("reads a snowflake id", () => {
		expect(dmChannelId({ id: CHANNEL })).toBe(CHANNEL);
	});

	it.each([null, {}, { id: 1 }, { id: "short" }, { id: "not-a-snowflake" }])(
		"rejects %j",
		(body) => {
			expect(() => dmChannelId(body)).toThrow(/didn't return a DM channel/);
		},
	);
});

describe("describeDmFailure", () => {
	it.each([
		[50007, /DMs from server members closed/],
		[10013, /aren't in the Discord server/],
		[10007, /aren't in the Discord server/],
	])("explains Discord code %s", (code, message) => {
		expect(describeDmFailure({ code })).toMatch(message);
	});

	it("leaves unknown errors to the caller", () => {
		expect(describeDmFailure({ code: 99999 })).toBeUndefined();
		expect(describeDmFailure(new Error("x"))).toBeUndefined();
		expect(describeDmFailure(null)).toBeUndefined();
	});
});

describe("sendDirectMessage", () => {
	it("opens a DM and posts with mentions disabled", async () => {
		const { rest, calls } = fakeRest();
		await sendDirectMessage(rest, IDS.member, TEXT);
		expect(calls).toEqual([
			{ route: Routes.userChannels(), body: { recipient_id: IDS.member } },
			{
				route: Routes.channelMessages(CHANNEL),
				body: { content: TEXT, allowedMentions: { parse: [] } },
			},
		]);
	});

	it("refuses a body that isn't a channel", async () => {
		const { rest } = fakeRest({ channel: { id: "nope" } });
		await expect(sendDirectMessage(rest, IDS.member, TEXT)).rejects.toThrow(
			/didn't return a DM channel/,
		);
	});
});

describe("DiscordDirectMessenger", () => {
	it("sends through REST", async () => {
		const { rest, calls } = fakeRest();
		await new DiscordDirectMessenger(rest).send(IDS.member, TEXT);
		expect(calls[0]?.body).toEqual({ recipient_id: IDS.member });
	});

	it("turns a closed inbox into a plain error, and rethrows unknowns", async () => {
		const closed = fakeRest({ failOn: "open", code: 50007 });
		await expect(new DiscordDirectMessenger(closed.rest).send(IDS.member, TEXT)).rejects.toThrow(
			/DMs from server members closed/,
		);

		const unknown = fakeRest({ failOn: "send", code: 500 });
		await expect(new DiscordDirectMessenger(unknown.rest).send(IDS.member, TEXT)).rejects.toEqual({
			code: 500,
		});
	});
});
