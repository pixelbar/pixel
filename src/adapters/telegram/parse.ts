import type { ArgValue, Args, CommandOption } from "../../core/command.ts";
import type { TelegramCommand } from "./commands.ts";

/**
 * Turns "/ha_set lamp on" into a command and its arguments. Arguments are given in
 * the order of the command's options, separated by spaces, and the last one takes
 * the rest of the line (so `/feedback` gets the whole message). Values are only
 * shaped here (a number for an integer option); the core validates them, as it
 * does for Discord.
 */

export type ParsedCommand =
	| { kind: "command"; command: TelegramCommand; args: Args }
	| { kind: "unknown"; name: string }
	/** Addressed to another bot in a group: not ours to answer. */
	| { kind: "not-for-us" }
	| { kind: "not-a-command" };

const COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/;

export function parseCommand(
	text: string,
	commands: ReadonlyMap<string, TelegramCommand>,
	botUsername: string,
): ParsedCommand {
	const match = COMMAND.exec(text.trim());
	if (!match) return { kind: "not-a-command" };
	const [, rawName, mention, rest] = match;
	if (mention && mention.toLowerCase() !== botUsername.toLowerCase()) return { kind: "not-for-us" };
	const name = (rawName as string).toLowerCase();
	const command = commands.get(name);
	if (!command) return { kind: "unknown", name };
	return { kind: "command", command, args: parseArgs(command.options, rest ?? "") };
}

function parseArgs(options: readonly CommandOption[], text: string): Args {
	// A person can't be picked by typing on Telegram, so those options are never filled from text.
	const typed = options.filter((o) => o.type !== "user");
	const args: Record<string, ArgValue> = {};
	let rest = text.trim();
	typed.forEach((option, index) => {
		if (rest === "") return;
		const last = index === typed.length - 1;
		let raw: string;
		if (last) {
			raw = rest;
			rest = "";
		} else {
			const space = rest.search(/\s/);
			raw = space === -1 ? rest : rest.slice(0, space);
			rest = space === -1 ? "" : rest.slice(space).trim();
		}
		args[option.name] = shape(option, raw);
	});
	return args;
}

/** A number for an integer option and true/false for a boolean one, when it reads as one; otherwise the text. */
function shape(option: CommandOption, raw: string): ArgValue {
	if (option.type === "integer" && /^-?\d{1,15}$/.test(raw)) return Number(raw);
	if (option.type === "boolean") {
		const lower = raw.toLowerCase();
		if (["true", "yes", "on"].includes(lower)) return true;
		if (["false", "no", "off"].includes(lower)) return false;
	}
	return raw;
}
