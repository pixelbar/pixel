import { ApplicationCommandOptionType } from "discord.js";
import type { Args, ArgValue, ResolvedUser } from "../../core/command.ts";

/** The shape of discord.js's CommandInteractionOption that we read. */
export type DiscordOption = {
	name: string;
	type: ApplicationCommandOptionType;
	value?: string | number | boolean;
	options?: readonly DiscordOption[];
	/** Set on User options: the resolved account. */
	user?: { id: string; displayName: string; username: string; bot: boolean };
	/** Set on User options for guild members: carries the server nickname (`nick` when uncached). */
	member?: { displayName?: string; nick?: string | null } | null;
};

const PRIMITIVE_TYPES = new Set([
	ApplicationCommandOptionType.String,
	ApplicationCommandOptionType.Integer,
	ApplicationCommandOptionType.Boolean,
]);

export type ParsedOptions = {
	subcommand?: string;
	args: Args;
	users: Record<string, ResolvedUser>;
};

/**
 * Flattens a slash command's options: unwraps a leading subcommand, reads
 * primitive values, and turns User options into the immutable ID plus a
 * resolved description. The dispatcher validates the result.
 */
export function parseOptions(options: readonly DiscordOption[]): ParsedOptions {
	const first = options[0];
	if (first?.type === ApplicationCommandOptionType.Subcommand) {
		return { subcommand: first.name, ...collect(first.options ?? []) };
	}
	return collect(options);
}

function collect(options: readonly DiscordOption[]): Omit<ParsedOptions, "subcommand"> {
	const args: Record<string, ArgValue> = {};
	const users: Record<string, ResolvedUser> = {};
	for (const option of options) {
		if (PRIMITIVE_TYPES.has(option.type) && option.value !== undefined) {
			args[option.name] = option.value;
		} else if (option.type === ApplicationCommandOptionType.User && option.user) {
			const { user, member } = option;
			args[option.name] = user.id;
			users[option.name] = {
				id: user.id,
				displayName: member?.displayName ?? member?.nick ?? user.displayName,
				handle: user.username,
				isBot: user.bot,
			};
		}
	}
	return { args, users };
}
