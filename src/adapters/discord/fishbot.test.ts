import { ApplicationCommandOptionType, MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";
import { Dispatcher } from "../../core/dispatcher.ts";
import { IdentityService } from "../../core/identity.ts";
import { silentLogger } from "../../core/logger.ts";
import { nullErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import { createFishbotFeature } from "../../features/fishbot/index.ts";
import { actor, IDS } from "../../testing/fixtures.ts";
import { parseOptions } from "./args.ts";
import { toSlashCommand } from "./commands.ts";
import { renderReply } from "./render.ts";

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
