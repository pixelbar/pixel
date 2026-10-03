import {
	type ChatInputCommandInteraction,
	Client,
	Events,
	GatewayIntentBits,
	type Guild,
	MessageFlags,
} from "discord.js";
import type { PlatformActor } from "../../core/access.ts";
import type { Dispatcher } from "../../core/dispatcher.ts";
import type { Logger } from "../../core/logger.ts";
import { optionsToArgs } from "./args.ts";
import { respond } from "./respond.ts";

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

export const WRONG_GUILD_MESSAGE = "Pixel only works in the Pixelbar Discord server.";

export function createDiscordAdapter(deps: DiscordAdapterDeps): DiscordAdapter {
	const { guildId, dispatcher, reportError } = deps;
	const logger = deps.logger.child({ adapter: "discord" });

	const client = new Client({
		// Non-privileged only. See AGENTS.md before adding intents.
		intents: [GatewayIntentBits.Guilds],
		allowedMentions: { parse: [] },
	});

	const leaveIfForeign = async (guild: Guild) => {
		if (guild.id === guildId) return;
		logger.warn(
			{ event: "discord.foreign_guild" },
			"leaving a guild that isn't the configured one",
		);
		await guild.leave().catch((error: unknown) => {
			logger.error({ err: error }, "failed to leave foreign guild");
			reportError(error);
		});
	};

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
		handleCommand(interaction).catch((error: unknown) => {
			logger.error(
				{ err: error, command: interaction.commandName },
				"failed to handle interaction",
			);
			reportError(error);
		});
	});

	async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		if (interaction.guildId !== guildId) {
			await interaction.reply({ content: WRONG_GUILD_MESSAGE, flags: MessageFlags.Ephemeral });
			return;
		}
		const actor: PlatformActor = {
			platform: "discord",
			userId: interaction.user.id,
			displayName: interaction.inCachedGuild()
				? interaction.member.displayName
				: interaction.user.displayName,
			chat: "group",
		};
		await respond(interaction, {
			defaultPrivate: dispatcher.defaultPrivacy(interaction.commandName),
			deferAfterMs: DEFER_AFTER_MS,
			work: () =>
				dispatcher.dispatch({
					actor,
					command: interaction.commandName,
					args: optionsToArgs(interaction.options.data),
				}),
		});
	}

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
