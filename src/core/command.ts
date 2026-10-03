import type { Access, Principal } from "./access.ts";
import type { Logger } from "./logger.ts";
import type { Reply } from "./reply.ts";

type OptionBase = {
	name: string;
	description: string;
	required?: boolean;
};

export type CommandOption =
	| (OptionBase & { type: "string"; choices?: readonly string[] })
	| (OptionBase & { type: "integer" })
	| (OptionBase & { type: "boolean" });

export type ArgValue = string | number | boolean;
export type Args = Readonly<Record<string, ArgValue | undefined>>;

/** What a command looks like to callers, without its handler. */
export type CommandSummary = {
	name: string;
	description: string;
};

export type CommandContext = {
	args: Args;
	principal: Principal;
	logger: Logger;
	/** Commands this principal is allowed to run, for /help. */
	availableCommands: readonly CommandSummary[];
};

export type CommandDefinition = {
	/** Lowercase, 1–32 chars of a-z, 0-9, '-' or '_' (Discord's rules). */
	name: string;
	/** 1–100 chars. */
	description: string;
	access: Access;
	options?: readonly CommandOption[];
	/** Default reply visibility. Replies can override it with `Reply.private`. */
	private?: boolean;
	/**
	 * Shown straight away while the handler runs (e.g. "Checking…"), then
	 * replaced by the handler's reply. Only sent once access checks pass.
	 */
	placeholder?: Reply;
	handler: (ctx: CommandContext) => Promise<Reply>;
};
