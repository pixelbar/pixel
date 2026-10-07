import type { Access } from "../../core/access.ts";
import {
	type CommandDefinition,
	type CommandOption,
	isGroup,
	isSubgroup,
} from "../../core/command.ts";

/**
 * Telegram has flat command names (`[a-z0-9_]`, at most 32 characters) and no
 * subcommands, so `/ha set` becomes `/ha_set` and `/admin doors off` becomes
 * `/admin_doors_off`. This builds that list from the registry, leaving out
 * anything that doesn't run on Telegram (`access.platforms`).
 */

export type CommandPath = { command: string; subgroup?: string; subcommand?: string };

export type TelegramCommand = {
	/** What people type, without the slash: "ha_set". */
	name: string;
	/** The core's name for it: "ha set". */
	coreName: string;
	path: CommandPath;
	description: string;
	options: readonly CommandOption[];
};

const NAME = /^[a-z0-9_]{1,32}$/;
const runsOnTelegram = (access: Access) => !access.platforms || access.platforms.includes("telegram");

/** Every command Telegram can run, flattened, in registry order. */
export function telegramCommands(definitions: readonly CommandDefinition[]): TelegramCommand[] {
	const out: TelegramCommand[] = [];
	const add = (parts: string[], path: CommandPath, description: string, options?: readonly CommandOption[]) => {
		const name = parts.join("_").replace(/-/g, "_");
		// A name Telegram can't take is left out rather than mangled into something misleading.
		if (!NAME.test(name)) return;
		out.push({ name, coreName: parts.join(" "), path, description, options: options ?? [] });
	};
	for (const definition of definitions) {
		if (!runsOnTelegram(definition.access)) continue;
		if (!isGroup(definition)) {
			add([definition.name], { command: definition.name }, definition.description, definition.options);
			continue;
		}
		for (const entry of definition.subcommands) {
			if (!runsOnTelegram(entry.access)) continue;
			if (!isSubgroup(entry)) {
				add(
					[definition.name, entry.name],
					{ command: definition.name, subcommand: entry.name },
					entry.description,
					entry.options,
				);
				continue;
			}
			for (const sub of entry.subcommands) {
				if (!runsOnTelegram(sub.access)) continue;
				add(
					[definition.name, entry.name, sub.name],
					{ command: definition.name, subgroup: entry.name, subcommand: sub.name },
					sub.description,
					sub.options,
				);
			}
		}
	}
	return out;
}

/** "Usage: /ha_set <device> <state>", with optional options in brackets. */
export function usage(command: TelegramCommand): string {
	const parts = command.options.map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`));
	return [`/${command.name}`, ...parts].join(" ");
}
