import {
	type APIApplicationCommandBasicOption,
	type APIApplicationCommandSubcommandGroupOption,
	type APIApplicationCommandSubcommandOption,
	ApplicationCommandOptionType,
	ApplicationIntegrationType,
	ChannelType,
	InteractionContextType,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import {
	type CommandDefinition,
	type CommandOption,
	isGroup,
	isSubgroup,
	type SubcommandDefinition,
	type SubgroupDefinition,
} from "../../core/command.ts";

/**
 * Maps core command definitions to Discord slash command JSON. Commands are
 * guild-only: Pixel serves a single guild.
 */
export function toSlashCommand(
	def: CommandDefinition,
): RESTPostAPIChatInputApplicationCommandsJSONBody {
	return {
		name: def.name,
		description: def.description,
		options: isGroup(def)
			? def.subcommands.map((child) =>
					isSubgroup(child) ? toSubgroup(child) : toSubcommand(child),
				)
			: typed(def.options).map(toOption),
		// "0" hides the command from everyone but server Administrators until the
		// server grants it (see docs/discord-command-visibility.md). This only
		// controls what people see: the dispatcher still decides who may run it.
		...(def.access.minTier === "admin" ? { default_member_permissions: "0" } : {}),
		contexts: [InteractionContextType.Guild],
		integration_types: [ApplicationIntegrationType.GuildInstall],
	};
}

function toSubgroup(group: SubgroupDefinition): APIApplicationCommandSubcommandGroupOption {
	return {
		type: ApplicationCommandOptionType.SubcommandGroup,
		name: group.name,
		description: group.description,
		options: group.subcommands.map(toSubcommand),
	};
}

function toSubcommand(sub: SubcommandDefinition): APIApplicationCommandSubcommandOption {
	return {
		type: ApplicationCommandOptionType.Subcommand,
		name: sub.name,
		description: sub.description,
		options: typed(sub.options).map(toOption),
	};
}

function toOption(option: CommandOption): APIApplicationCommandBasicOption {
	const base = {
		name: option.name,
		description: option.description,
		required: option.required ?? false,
	};
	switch (option.type) {
		case "string":
			// With suggestions, Discord asks the bot as the person types. It never goes with
			// fixed choices (the registry rejects that).
			if (option.suggest) {
				return { ...base, type: ApplicationCommandOptionType.String, autocomplete: true };
			}
			return {
				...base,
				type: ApplicationCommandOptionType.String,
				...(option.choices ? { choices: option.choices.map((c) => ({ name: c, value: c })) } : {}),
			};
		case "integer":
			return {
				...base,
				type: ApplicationCommandOptionType.Integer,
				...(option.suggest ? { autocomplete: true } : {}),
			};
		case "boolean":
			return { ...base, type: ApplicationCommandOptionType.Boolean };
		case "user":
			return { ...base, type: ApplicationCommandOptionType.User };
		case "channel":
			// Text and announcement channels: the ones a message or poll can be posted in.
			return {
				...base,
				type: ApplicationCommandOptionType.Channel,
				channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
			};
	}
}

/** Form fields are shown in a modal, not typed with the command, so Discord doesn't list them. */
const typed = (options: readonly CommandOption[] | undefined) =>
	(options ?? []).filter((o) => !(o.type === "string" && o.form));
