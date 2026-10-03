import {
	type APIApplicationCommandBasicOption,
	type APIApplicationCommandSubcommandOption,
	ApplicationCommandOptionType,
	ApplicationIntegrationType,
	InteractionContextType,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import {
	type CommandDefinition,
	type CommandOption,
	isGroup,
	type SubcommandDefinition,
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
		options: isGroup(def) ? def.subcommands.map(toSubcommand) : (def.options ?? []).map(toOption),
		// "0" hides the command from everyone but server Administrators until the
		// server grants it (see docs/discord-command-visibility.md). This only
		// controls what people see: the dispatcher still decides who may run it.
		...(def.access.minTier === "admin" ? { default_member_permissions: "0" } : {}),
		contexts: [InteractionContextType.Guild],
		integration_types: [ApplicationIntegrationType.GuildInstall],
	};
}

function toSubcommand(sub: SubcommandDefinition): APIApplicationCommandSubcommandOption {
	return {
		type: ApplicationCommandOptionType.Subcommand,
		name: sub.name,
		description: sub.description,
		options: (sub.options ?? []).map(toOption),
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
			return {
				...base,
				type: ApplicationCommandOptionType.String,
				...(option.choices ? { choices: option.choices.map((c) => ({ name: c, value: c })) } : {}),
			};
		case "integer":
			return { ...base, type: ApplicationCommandOptionType.Integer };
		case "boolean":
			return { ...base, type: ApplicationCommandOptionType.Boolean };
		case "user":
			return { ...base, type: ApplicationCommandOptionType.User };
	}
}
