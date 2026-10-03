import { Client, Events, GatewayIntentBits } from "discord.js";
import type { Dispatcher } from "../../core/dispatcher.ts";
import type { Logger } from "../../core/logger.ts";
import { createCommandHandler, createGuildGuard } from "./handlers.ts";

export type DiscordAdapterDeps = {
	token: string;
	guildId: string;
	dispatcher: Dispatcher;
	logger: Logger;
	/** Reports errors that escape the dispatcher (e.g. Discord API failures). */
	reportError: (error: unknown) => void;
};

export type DiscordAdapter = {
	start(): Promise<void>;
	stop(): Promise<void>;
	isReady(): boolean;
};

const DEFER_AFTER_MS = 1500;

/**
 * Thin wiring between the discord.js Client and the handlers in handlers.ts,
 * which hold all the logic and are unit-tested.
 */
export function createDiscordAdapter(deps: DiscordAdapterDeps): DiscordAdapter {
	const { guildId, dispatcher, reportError } = deps;
	const logger = deps.logger.child({ adapter: "discord" });
	const handleCommand = createCommandHandler({ guildId, dispatcher, deferAfterMs: DEFER_AFTER_MS });
	const leaveIfForeign = createGuildGuard({ guildId, logger, reportError });

	const client = new Client({
		// Non-privileged only. See AGENTS.md before adding intents.
		intents: [GatewayIntentBits.Guilds],
		allowedMentions: { parse: [] },
	});

	client.once(Events.ClientReady, async (ready) => {
		logger.info(
			{ event: "discord.ready", guilds: ready.guilds.cache.size },
			"connected to Discord",
		);
		await Promise.all(ready.guilds.cache.map(leaveIfForeign));
	});
	client.on(Events.GuildCreate, leaveIfForeign);
	client.on(Events.Error, (error) => {
		logger.error({ err: error }, "discord client error");
		reportError(error);
	});

	client.on(Events.InteractionCreate, (interaction) => {
		if (!interaction.isChatInputCommand()) return;
		const displayName = interaction.inCachedGuild() ? interaction.member.displayName : undefined;
		handleCommand(interaction, displayName).catch((error: unknown) => {
			logger.error(
				{ err: error, command: interaction.commandName },
				"failed to handle interaction",
			);
			reportError(error);
		});
	});

	return {
		async start() {
			await client.login(deps.token);
		},
		async stop() {
			await client.destroy();
		},
		isReady() {
			return client.isReady();
		},
	};
}
