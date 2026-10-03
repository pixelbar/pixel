import type { PlatformActor } from "../../core/access.ts";
import type { Dispatcher } from "../../core/dispatcher.ts";
import type { Logger } from "../../core/logger.ts";
import { type DiscordOption, optionsToArgs } from "./args.ts";
import { renderReply } from "./render.ts";
import { type Respondable, respond } from "./respond.ts";

/**
 * Discord event handling, kept free of the discord.js Client so the security
 * decisions here (guild allow-list, actor construction) are unit-testable.
 */

export const WRONG_GUILD_MESSAGE = "Pixel only works in the Pixelbar Discord server.";

/** The parts of a ChatInputCommandInteraction the command handler reads. */
export type IncomingCommand = Respondable & {
	guildId: string | null;
	commandName: string;
	user: { id: string; displayName: string; username: string };
	options: { data: readonly DiscordOption[] };
};

export type CommandHandlerDeps = {
	guildId: string;
	dispatcher: Pick<Dispatcher, "dispatch" | "defaultPrivacy">;
	deferAfterMs: number;
};

/**
 * Returns a handler for slash command interactions. Interactions from any
 * guild other than the configured one — or from outside a guild — are refused
 * before anything reaches the dispatcher.
 *
 * `displayName` is the caller's server nickname when known. It and the
 * username (handle) are for display and logs only, never for authorisation.
 */
export function createCommandHandler({ guildId, dispatcher, deferAfterMs }: CommandHandlerDeps) {
	return async (interaction: IncomingCommand, displayName?: string): Promise<void> => {
		if (interaction.guildId !== guildId) {
			await interaction.reply(renderReply({ text: WRONG_GUILD_MESSAGE }, true));
			return;
		}
		const actor: PlatformActor = {
			platform: "discord",
			userId: interaction.user.id,
			displayName: displayName ?? interaction.user.displayName,
			handle: interaction.user.username,
			chat: "group",
		};
		await respond(interaction, {
			defaultPrivate: dispatcher.defaultPrivacy(interaction.commandName),
			deferAfterMs,
			work: () =>
				dispatcher.dispatch({
					actor,
					command: interaction.commandName,
					args: optionsToArgs(interaction.options.data),
				}),
		});
	};
}

export type GuildLike = { id: string; leave(): Promise<unknown> };

export type GuildGuardDeps = {
	guildId: string;
	logger: Logger;
	reportError: (error: unknown) => void;
};

/** Returns a function that makes the bot leave any guild but the configured one. */
export function createGuildGuard({ guildId, logger, reportError }: GuildGuardDeps) {
	return async (guild: GuildLike): Promise<void> => {
		if (guild.id === guildId) return;
		logger.warn(
			{ event: "discord.foreign_guild" },
			"leaving a guild that isn't the configured one",
		);
		try {
			await guild.leave();
		} catch (error) {
			logger.error({ err: error }, "failed to leave foreign guild");
			reportError(error);
		}
	};
}
