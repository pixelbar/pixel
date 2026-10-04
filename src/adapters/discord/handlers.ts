import type { PlatformActor } from "../../core/access.ts";
import type { Dispatcher } from "../../core/dispatcher.ts";
import type { Logger } from "../../core/logger.ts";
import { type DiscordOption, parseAutocomplete, parseOptions } from "./args.ts";
import { renderReply } from "./render.ts";
import { type Respondable, respond } from "./respond.ts";

/**
 * Discord event handling, kept free of the discord.js Client so the security
 * decisions here (guild allow-list, actor construction) are unit-testable.
 */

/**
 * Who is behind an interaction, by their immutable Discord ID. The names are for
 * display and logs only, never for authorisation.
 */
export function discordActor(
	user: { id: string; displayName: string; username: string },
	displayName?: string,
): PlatformActor {
	return {
		platform: "discord",
		userId: user.id,
		displayName: displayName ?? user.displayName,
		handle: user.username,
		chat: "group",
	};
}

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
		const actor = discordActor(interaction.user, displayName);
		const { subgroup, subcommand, args, users } = parseOptions(interaction.options.data);
		await respond(interaction, {
			defaultPrivate: dispatcher.defaultPrivacy(interaction.commandName, subcommand, subgroup),
			deferAfterMs,
			work: (showPending) =>
				dispatcher.dispatch(
					{ actor, command: interaction.commandName, subgroup, subcommand, args, users },
					{ onPending: showPending },
				),
		});
	};
}

/** The parts of an AutocompleteInteraction the suggestion handler reads. */
export type IncomingAutocomplete = {
	guildId: string | null;
	commandName: string;
	user: { id: string; displayName: string; username: string };
	options: { data: readonly DiscordOption[] };
	respond(choices: { name: string; value: string | number }[]): Promise<unknown>;
};

export type AutocompleteHandlerDeps = {
	guildId: string;
	dispatcher: Pick<Dispatcher, "suggest">;
};

/**
 * Returns a handler for autocomplete requests. Like commands, requests from any
 * other guild are ignored before anything reaches the dispatcher. It always
 * answers, with an empty list when there is nothing to suggest, because Discord
 * shows a failure otherwise. Access is the dispatcher's job: it only ever returns
 * suggestions to someone who may run the command.
 */
export function createAutocompleteHandler({ guildId, dispatcher }: AutocompleteHandlerDeps) {
	return async (interaction: IncomingAutocomplete, displayName?: string): Promise<void> => {
		if (interaction.guildId !== guildId) {
			await interaction.respond([]);
			return;
		}
		const actor = discordActor(interaction.user, displayName);
		const { subgroup, subcommand, focused, args } = parseAutocomplete(interaction.options.data);
		const choices = focused
			? await dispatcher.suggest({
					actor,
					command: interaction.commandName,
					subgroup,
					subcommand,
					option: focused.name,
					typed: focused.typed,
					args,
				})
			: [];
		await interaction.respond(choices);
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
