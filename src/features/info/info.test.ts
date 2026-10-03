import { describe, expect, it } from "vitest";
import type { CommandDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { InfoTopic } from "../../services/info-content.ts";
import { context } from "../../testing/fixtures.ts";
import { createInfoFeature } from "./index.ts";

const TOPICS: InfoTopic[] = [
	{
		id: "membership",
		title: "Becoming a member",
		summary: "Member and Friend memberships",
		body: "**Member**: €32.50 per month",
	},
	{
		id: "contact",
		title: "Getting in touch",
		summary: "Email and Discord",
		body: "bestuur@pixelbar.nl",
	},
];

function infoCommand(topics: readonly InfoTopic[] = TOPICS): CommandDefinition {
	const command = createInfoFeature({ topics }).commands?.[0];
	if (!command) throw new Error("no info command");
	return command;
}

describe("/info", () => {
	it("is a public guest command", () => {
		const command = infoCommand();
		expect(command.name).toBe("info");
		expect(command.access.minTier).toBe("guest");
		expect(command.private).toBeFalsy();
		expect(command.placeholder).toBeUndefined();
	});

	it("takes an optional topic, with one choice for each topic", () => {
		expect(infoCommand().options).toEqual([
			{
				name: "topic",
				description: expect.any(String),
				type: "string",
				choices: ["membership", "contact"],
			},
		]);
	});

	it("lists every topic with its summary when no topic is given", async () => {
		const reply = await infoCommand().handler(context());
		expect(reply.embeds?.[0]).toEqual({
			title: "ℹ️ What would you like to know?",
			description:
				"**membership**: Member and Friend memberships\n**contact**: Email and Discord\n\nPick one with `/info topic:`, for example `/info topic:membership`.",
			accent: "brand",
		});
	});

	it("shows the topic's title and text as written", async () => {
		const reply = await infoCommand().handler(context({ args: { topic: "contact" } }));
		expect(reply.embeds).toEqual([
			{ title: "Getting in touch", description: "bestuur@pixelbar.nl", accent: "brand" },
		]);
	});

	it("doesn't escape the text, because it's our own reviewed content", async () => {
		const reply = await infoCommand().handler(context({ args: { topic: "membership" } }));
		expect(reply.embeds?.[0]?.description).toBe("**Member**: €32.50 per month");
	});

	it("tells people about a topic it doesn't have, without echoing formatting back", async () => {
		const attempt = infoCommand().handler(context({ args: { topic: "**wifi** <@123>" } }));
		await expect(attempt).rejects.toBeInstanceOf(UserFacingError);
		await expect(attempt).rejects.toThrow(
			'I don\'t have a topic called "\\*\\*wifi\\*\\* \\<@123\\>". Try /info to see the list.',
		);
	});

	it("still gives a usable example in the list if there are no topics", async () => {
		const reply = await infoCommand([]).handler(context());
		expect(reply.embeds?.[0]?.description).toContain("`/info topic:membership`");
	});
});
