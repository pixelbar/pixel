import { ApplicationCommandOptionType } from "discord.js";
import type { Args, ArgValue } from "../../core/command.ts";

/** The shape of discord.js's CommandInteractionOption that we read. */
export type DiscordOption = {
	name: string;
	type: ApplicationCommandOptionType;
	value?: string | number | boolean;
};

const PRIMITIVE_TYPES = new Set([
	ApplicationCommandOptionType.String,
	ApplicationCommandOptionType.Integer,
	ApplicationCommandOptionType.Boolean,
]);

/** Extracts top-level primitive option values. The dispatcher validates them. */
export function optionsToArgs(options: readonly DiscordOption[]): Args {
	const args: Record<string, ArgValue> = {};
	for (const option of options) {
		if (PRIMITIVE_TYPES.has(option.type) && option.value !== undefined) {
			args[option.name] = option.value;
		}
	}
	return args;
}
