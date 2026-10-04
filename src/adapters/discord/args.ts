import { ApplicationCommandOptionType } from "discord.js";
import type { Args, ArgValue, ResolvedUser } from "../../core/command.ts";

/** The shape of discord.js's CommandInteractionOption that we read. */
export type DiscordOption = {
	name: string;
	type: ApplicationCommandOptionType;
	value?: string | number | boolean;
	/** Set on the option being typed, in an autocomplete request. */
	focused?: boolean;
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
	subgroup?: string;
	subcommand?: string;
	args: Args;
	users: Record<string, ResolvedUser>;
};

/**
 * Flattens a slash command's options: unwraps a leading subgroup and subcommand, reads
 * primitive values, and turns User options into the immutable ID plus a
 * resolved description. The dispatcher validates the result.
 */
export function parseOptions(options: readonly DiscordOption[]): ParsedOptions {
	const first = options[0];
	if (first?.type === ApplicationCommandOptionType.SubcommandGroup) {
		const inner = first.options?.[0];
		if (inner?.type !== ApplicationCommandOptionType.Subcommand)
			return { subgroup: first.name, args: {}, users: {} };
		return { subgroup: first.name, subcommand: inner.name, ...collect(inner.options ?? []) };
	}
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

export type ParsedAutocomplete = {
	subgroup?: string;
	subcommand?: string;
	/** The option being typed, and what's been typed in it. Absent if Discord sent none. */
	focused?: { name: string; typed: string };
	/** The other options filled in so far. Unchecked: Discord only validates in its own client. */
	args: Args;
};

/**
 * Reads an autocomplete request. The option being typed is `focused`; the rest
 * are whatever has been filled in so far (required ones may be missing).
 */
export function parseAutocomplete(options: readonly DiscordOption[]): ParsedAutocomplete {
	let level = options;
	let subgroup: string | undefined;
	let subcommand: string | undefined;
	const first = level[0];
	if (first?.type === ApplicationCommandOptionType.SubcommandGroup) {
		subgroup = first.name;
		level = first.options ?? [];
	}
	const next = level[0];
	if (next?.type === ApplicationCommandOptionType.Subcommand) {
		subcommand = next.name;
		level = next.options ?? [];
	}

	const args: Record<string, ArgValue> = {};
	let focused: ParsedAutocomplete["focused"];
	for (const option of level) {
		if (option.value === undefined) continue;
		if (option.focused) focused = { name: option.name, typed: String(option.value) };
		else if (
			PRIMITIVE_TYPES.has(option.type) ||
			option.type === ApplicationCommandOptionType.User
		) {
			args[option.name] = option.value;
		}
	}
	return {
		...(subgroup !== undefined ? { subgroup } : {}),
		...(subcommand !== undefined ? { subcommand } : {}),
		...(focused ? { focused } : {}),
		args,
	};
}
