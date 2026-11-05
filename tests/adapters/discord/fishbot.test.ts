import { ApplicationCommandOptionType, MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";
import { parseOptions } from "../../../src/adapters/discord/args.ts";
import { toSlashCommand } from "../../../src/adapters/discord/commands.ts";
import { renderReply } from "../../../src/adapters/discord/render.ts";
import { Dispatcher } from "../../../src/core/dispatcher.ts";
import { IdentityService } from "../../../src/core/identity.ts";
import { silentLogger } from "../../../src/core/logger.ts";
import { nullErrorReporter } from "../../../src/core/ports/error-reporter.ts";
import { RateLimiter } from "../../../src/core/rate-limit.ts";
import { CommandRegistry } from "../../../src/core/registry.ts";
import { createFishbotFeature } from "../../../src/features/fishbot/index.ts";
import { actor, IDS } from "../../../src/testing/fixtures.ts";

it("registers Fishbot's autocomplete and real Discord user picker", () => {
	const definition = createFishbotFeature().commands?.[0];
	if (!definition) throw new Error("Missing Fishbot command");
	const slash = toSlashCommand(definition);
	expect(slash.name).toBe("fishbot");
	expect(slash.default_member_permissions).toBeUndefined();
	expect(slash.options).toContainEqual(
		expect.objectContaining({
			name: "say",
			type: ApplicationCommandOptionType.Subcommand,
			options: [
				expect.objectContaining({
					name: "phrase",
					type: ApplicationCommandOptionType.String,
					required: false,
					autocomplete: true,
				}),
			],
		}),
	);
	expect(slash.options).toContainEqual(
		expect.objectContaining({
			name: "trout",
			type: ApplicationCommandOptionType.Subcommand,
			options: [
				expect.objectContaining({
					name: "user",
					type: ApplicationCommandOptionType.User,
					required: true,
				}),
			],
		}),
	);
});

describe("Fishbot in Discord", () => {
	it("parses a nickname, dispatches a trout and renders with pings disabled", async () => {
		const registry = new CommandRegistry();
		registry.register(createFishbotFeature());
		const dispatcher = new Dispatcher({
			registry,
			identity: new IdentityService([]),
			rateLimiter: new RateLimiter({ capacity: 10, refillPerSecond: 0 }),
			logger: silentLogger,
			reporter: nullErrorReporter,
		});
		const parsed = parseOptions([
			{
				name: "trout",
				type: ApplicationCommandOptionType.Subcommand,
				options: [
					{
						name: "user",
						type: ApplicationCommandOptionType.User,
						user: { id: IDS.friend, displayName: "Global name", username: "handle", bot: false },
						member: { nick: "@everyone `fish`" },
					},
				],
			},
		]);
		const result = await dispatcher.dispatch({ ...parsed, actor: actor(), command: "fishbot" });
		const payload = renderReply(result.reply, result.private);
		expect(payload.content).toContain("`@everyone 'fish'`");
		expect(payload.allowedMentions).toEqual({ parse: [] });
		expect(payload.flags).toBeUndefined();
		const help = await dispatcher.dispatch({
			actor: actor(),
			command: "fishbot",
			subcommand: "say",
			args: {},
		});
		expect(renderReply(help.reply, help.private).flags).toBe(MessageFlags.Ephemeral);
	});
});
