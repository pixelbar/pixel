import type { Access, Principal } from "./access.ts";
import type { Args, ArgValue, CommandOption, ResolvedChannel, ResolvedUser } from "./command.ts";
import type { Logger } from "./logger.ts";
import type { Reply } from "./reply.ts";

/**
 * Buttons, select menus and forms, described without any platform. A feature puts
 * controls on a reply; the adapter draws them (buttons and select menus on Discord)
 * and, when someone uses one, dispatches the action it names through
 * `Dispatcher.act`, with the person who used it as the actor. See
 * docs/discord-components.md.
 */

/** Runs a registered action with these arguments. The arguments stay on the server. */
export type ActionCall = {
	action: string;
	args?: Readonly<Record<string, ArgValue>>;
};

export type ButtonStyle = "primary" | "secondary" | "success" | "danger";

export type ChoiceOption = {
	label: string;
	/** What's submitted. No whitespace when more than one can be chosen. */
	value: string;
	description?: string;
	/** Chosen to begin with. */
	selected?: boolean;
};

export type Control =
	| { kind: "button"; label: string; style?: ButtonStyle; call: ActionCall; disabled?: boolean }
	| { kind: "link"; label: string; url: string }
	| {
			kind: "select";
			placeholder: string;
			call: ActionCall;
			/** Which argument of `call` the chosen values fill in (space-separated if several). */
			arg: string;
			options: readonly ChoiceOption[];
			/** How many may be chosen. Both default to 1. */
			min?: number;
			max?: number;
	  };

/** One row of controls: up to 5 buttons and links, or exactly one select. */
export type ControlRow = readonly Control[];

/** Discord's limits, which every platform's controls fit in. */
export const UI_LIMITS = {
	rows: 5,
	buttonsPerRow: 5,
	options: 25,
	formFields: 5,
	formTitle: 45,
	fieldLabel: 45,
	fieldDescription: 100,
	choices: 10,
} as const;

type InputBase = {
	/** The argument it fills in. */
	name: string;
	label: string;
	description?: string;
	/** Defaults to true. */
	required?: boolean;
};

export type FormInput =
	| (InputBase & {
			kind: "text";
			style: "short" | "paragraph";
			maxLength: number;
			placeholder?: string;
			value?: string;
	  })
	/** Exactly one of 2 to 10 options. */
	| (InputBase & { kind: "radio"; options: readonly ChoiceOption[] })
	/** Any number of 1 to 10 options, submitted space-separated. */
	| (InputBase & { kind: "checkboxes"; options: readonly ChoiceOption[] })
	/** A channel. The argument is its ID, and `ctx.channels` says what the person may do there. */
	| (InputBase & { kind: "channel"; value?: string });

/** A form (a modal on Discord). Submitting it runs `submit` with the fields as extra arguments. */
export type Form = {
	title: string;
	submit: ActionCall;
	fields: readonly FormInput[];
};

/**
 * What an action does with the message its control is on: replace it (`reply`), or
 * open a form (`form`). A form must open quickly: Discord allows 3 seconds.
 */
export type ActionResult = { reply: Reply } | { form: Form };

export type ActionContext = {
	args: Args;
	users: Readonly<Record<string, ResolvedUser>>;
	channels: Readonly<Record<string, ResolvedChannel>>;
	principal: Principal;
	logger: Logger;
};

/**
 * Something a control can do. Registered by a feature like a command, with its own
 * access (required, like a command's) and declared options. It isn't a slash
 * command: people reach it only through controls Pixel showed them, and the
 * dispatcher checks access and arguments again on every use.
 */
export type ActionDefinition = {
	/** `feature.verb`: lowercase letters, digits and dashes, dot-separated, at most 64. */
	name: string;
	access: Access;
	options?: readonly CommandOption[];
	handler: (ctx: ActionContext) => Promise<ActionResult>;
};
