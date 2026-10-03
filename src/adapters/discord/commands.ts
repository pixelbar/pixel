import {
	type APIApplicationCommandBasicOption,
	ApplicationCommandOptionType,
	ApplicationIntegrationType,
	InteractionContextType,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { CommandDefinition, CommandOption } from "../../core/command.ts";

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
		options: (def.options ?? []).map(toOption),
		contexts: [InteractionContextType.Guild],
		integration_types: [ApplicationIntegrationType.GuildInstall],
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
	}
}
