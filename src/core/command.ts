import type { Access, Principal } from "./access.ts";
import type { Logger } from "./logger.ts";
import type { Reply } from "./reply.ts";

type OptionBase = {
	name: string;
	description: string;
	required?: boolean;
};

/** One suggestion for an option: what's shown, and the value that's submitted if it's picked. */
export type Suggestion = { name: string; value: string | number };

export type SuggestContext = {
	/** What the person has typed for this option so far. May be empty. */
	typed: string;
	/**
	 * The other options already filled in, so suggestions can depend on them (the
	 * actions a device allows, say). **Unchecked and possibly partial:** required
	 * options may be missing, and nothing has been validated.
	 */
	args: Args;
	principal: Principal;
	logger: Logger;
};

/**
 * Live suggestions for an option, shown as someone types (autocomplete). They
 * are a convenience, **never validation**: the platform doesn't check that what
 * is submitted came from the suggestions, so the handler must validate the value
 * as usual. The dispatcher only calls this for someone who may run the command.
 */
export type SuggestFn = (context: SuggestContext) => Promise<readonly Suggestion[]>;

/**
 * A string option that is filled in on a form (a modal on Discord) instead of being
 * typed with the command: for long or multi-line text. The form opens once access
 * has been checked and `beforeForm` (if any) has passed, so slash options such as a
 * free-form time can be refused before anyone types a long body. What's entered
 * arrives as an ordinary argument.
 */
export type FormField = {
	style: "short" | "paragraph";
	/** At most this many characters. */
	maxLength: number;
	placeholder?: string;
};

export type CommandOption =
	| (OptionBase & {
			type: "string";
			choices?: readonly string[];
			/** Live suggestions. Can't be combined with `choices`. */
			suggest?: SuggestFn;
			/** Collected on a form rather than typed. Can't have choices or suggestions. */
			form?: FormField;
	  })
	| (OptionBase & { type: "integer"; suggest?: SuggestFn })
	| (OptionBase & { type: "boolean" })
	/**
	 * A person picked by the caller. The handler receives their immutable
	 * platform ID as the arg value, plus a `ResolvedUser` in `ctx.users`.
	 * Bots are refused unless `allowBots` is set.
	 */
	| (OptionBase & { type: "user"; allowBots?: boolean })
	/**
	 * A channel picked by the caller. The handler receives its platform ID as the arg
	 * value, plus a `ResolvedChannel` in `ctx.channels` saying what the caller may do there.
	 */
	| (OptionBase & { type: "channel" });

export type ArgValue = string | number | boolean;
export type Args = Readonly<Record<string, ArgValue | undefined>>;

/** A user picked through a `user` option, as resolved by the platform adapter. */
export type ResolvedUser = {
	/** Immutable platform ID. The only field to identify or act on. */
	id: string;
	/** For display and logs only. */
	displayName: string;
	handle?: string;
	isBot: boolean;
};

/** A channel picked through a `channel` option, as resolved by the platform adapter. */
export type ResolvedChannel = {
	/** Platform ID. The only field to act on. */
	id: string;
	/** For display only. */
	name: string;
	/** What the person running the command may do there, as the platform reports it. */
	caller: { canPost: boolean; canMentionEveryone: boolean; canCreatePolls: boolean };
};

/** What a command looks like to callers, without its handler. */
export type CommandSummary = {
	/** Full name; subcommands are "group sub", e.g. "admin status". */
	name: string;
	description: string;
};

export type CommandContext = {
	args: Args;
	/** Users picked through `user` options, by option name. */
	users: Readonly<Record<string, ResolvedUser>>;
	/** Channels picked through `channel` options, by option name. */
	channels: Readonly<Record<string, ResolvedChannel>>;
	principal: Principal;
	logger: Logger;
	/** Commands this principal is allowed to run, for /help. */
	availableCommands: readonly CommandSummary[];
};

type Named = {
	/** Lowercase, 1–32 chars of a-z, 0-9, '-' or '_' (Discord's rules). */
	name: string;
	/** 1–100 chars. */
	description: string;
	access: Access;
};

/**
 * Slash-option context for `beforeForm`. Form fields are still empty; the rest
 * has been type-checked the same way as `dispatch`.
 */
export type BeforeFormContext = {
	args: Args;
	users: Readonly<Record<string, ResolvedUser>>;
	channels: Readonly<Record<string, ResolvedChannel>>;
	principal: Principal;
	logger: Logger;
};

/**
 * Extra form chrome from `beforeForm`. `title` is the heading (the time Pixel
 * understood, say). `values` prefills fields by option name, so an edit can
 * open with the text that's already saved. `fields` names the declared form
 * fields to show (a message's text, or a poll's question and answers). An empty
 * list skips the form so the handler can reply instead (a list of the caller's
 * schedules, say). Omitted `fields` means every declared form field.
 */
export type BeforeFormResult = {
	title?: string;
	values?: Readonly<Record<string, string>>;
	fields?: readonly string[];
};

type Runnable = {
	options?: readonly CommandOption[];
	/** Default reply visibility. Replies can override it with `Reply.private`. */
	private?: boolean;
	/**
	 * Shown straight away while the handler runs (e.g. "Checking…"), then
	 * replaced by the handler's reply. Only sent once access checks pass.
	 */
	placeholder?: Reply;
	/**
	 * Extra checks after access, before a form is shown. Form fields are still
	 * empty. Throw `UserFacingError` to refuse without opening the form, so a
	 * long body isn't typed against a bad option (a time Pixel can't parse, say).
	 * The returned title, if any, is shown on the form; `values` prefills fields.
	 */
	beforeForm?: (ctx: BeforeFormContext) => Promise<BeforeFormResult | undefined>;
	handler: (ctx: CommandContext) => Promise<Reply>;
};

export type PlainCommand = Named & Runnable & { subcommands?: undefined };

export type SubcommandDefinition = Named & Runnable;

/**
 * A named set of subcommands inside a group, e.g. `capabilities` in
 * `/admin capabilities grant`. Its access is a floor for the subcommands in it.
 */
export type SubgroupDefinition = Named & {
	subcommands: readonly SubcommandDefinition[];
};

/**
 * A command with subcommands, e.g. `/admin status`, and optionally subgroups of
 * them, e.g. `/admin capabilities grant`. Access is a floor at every level: a
 * subcommand or subgroup may tighten it but never loosen it, and the dispatcher
 * checks every level.
 */
export type GroupCommand = Named & {
	subcommands: readonly (SubcommandDefinition | SubgroupDefinition)[];
	options?: undefined;
	handler?: undefined;
	private?: undefined;
	placeholder?: undefined;
	beforeForm?: undefined;
};

export type CommandDefinition = PlainCommand | GroupCommand;

export function isGroup(def: CommandDefinition): def is GroupCommand {
	return def.subcommands !== undefined;
}

export function isSubgroup(
	entry: SubcommandDefinition | SubgroupDefinition,
): entry is SubgroupDefinition {
	return (entry as SubgroupDefinition).subcommands !== undefined;
}
