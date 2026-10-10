import {
	type Access,
	actorLogFields,
	actorRef,
	checkAccess,
	type PlatformActor,
	type Principal,
} from "./access.ts";
import {
	type Args,
	type ArgValue,
	type CommandOption,
	type CommandSummary,
	type FormField,
	type GroupCommand,
	isGroup,
	isSubgroup,
	type ResolvedChannel,
	type ResolvedUser,
	type SubcommandDefinition,
	type SubgroupDefinition,
	type SuggestFn,
	type Suggestion,
} from "./command.ts";
import { UserFacingError } from "./errors.ts";
import type { IdentityService } from "./identity.ts";
import type { Logger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";
import { RateLimiter } from "./rate-limit.ts";
import type { CommandRegistry } from "./registry.ts";
import type { Reply } from "./reply.ts";

export type DispatchRequest = {
	actor: PlatformActor;
	command: string;
	/** Set when `command` is a group and the subcommand sits in a subgroup, e.g. `capabilities` in `/admin capabilities grant`. */
	subgroup?: string;
	/** Set when `command` is a group, e.g. `status` for `/admin status`. */
	subcommand?: string;
	args: Args;
	/** Users picked through `user` options, by option name, as resolved by the adapter. */
	users?: Readonly<Record<string, ResolvedUser>>;
	/** Channels picked through `channel` options, by option name, as resolved by the adapter. */
	channels?: Readonly<Record<string, ResolvedChannel>>;
};

/** Someone is typing in an option that has live suggestions. */
export type SuggestRequest = {
	actor: PlatformActor;
	command: string;
	subgroup?: string;
	subcommand?: string;
	/** The option being typed. */
	option: string;
	/** What has been typed in it so far. */
	typed: string;
	/** The other options filled in so far. Unchecked and possibly partial. */
	args: Args;
};

/** Discord's limits: 25 suggestions, each name and value at most 100 characters. */
export const MAX_SUGGESTIONS = 25;
export const MAX_SUGGESTION_LENGTH = 100;

/** Discord waits 3 seconds for suggestions, so give up a little before that. */
const DEFAULT_SUGGEST_TIMEOUT_MS = 2500;

export type DispatchResult = {
	reply: Reply;
	/** Final visibility, already resolved from the reply and command defaults. */
	private: boolean;
};

export type DispatchHooks = {
	/**
	 * Called with the command's placeholder after access and argument checks
	 * pass, before the handler runs. Adapters show it immediately and later
	 * replace it with the result.
	 */
	onPending?: (pending: DispatchResult) => Promise<void>;
};

export type DispatcherDeps = {
	registry: CommandRegistry;
	identity: IdentityService;
	rateLimiter: RateLimiter;
	/**
	 * Suggestions fire on every keystroke, so they get their own, more generous
	 * limit and can't use up the budget for real commands.
	 */
	suggestRateLimiter?: RateLimiter;
	suggestTimeoutMs?: number;
	logger: Logger;
	reporter: ErrorReporter;
};

export const MESSAGES = {
	unknownCommand: "I don't know that command. Try /help.",
	rateLimited: "Slow down a little — try again in a few seconds.",
	deniedTier: "You don't have access to this command.",
	deniedContext: "This command can't be used here.",
	internalError: "Something went wrong on my end. Please try again later.",
} as const;

/**
 * The single place where commands are authorised and run. Every adapter goes
 * through `dispatch`; nothing else may call a command handler.
 *
 * Order: rate limit → resolve identity → check access → validate args →
 * placeholder (if any) → run.
 */
export class Dispatcher {
	readonly #deps: DispatcherDeps;
	readonly #suggestLimiter: RateLimiter;

	constructor(deps: DispatcherDeps) {
		this.#deps = deps;
		this.#suggestLimiter =
			deps.suggestRateLimiter ?? new RateLimiter({ capacity: 20, refillPerSecond: 5 });
	}

	/**
	 * The options of a command that are filled in on a form, in order. Empty when it has
	 * none. Adapters show the form first and pass what's entered as arguments.
	 */
	formFields(command: string, subcommand?: string, subgroup?: string): FormOption[] {
		const options = this.#lookup(command, subcommand, subgroup)?.runnable.options ?? [];
		return options.filter((o): o is FormOption => o.type === "string" && o.form !== undefined);
	}

	/**
	 * Whether to open a command's form. Access first, then non-form args, then
	 * `beforeForm`. Returns a refusal instead of opening the form, so a long body
	 * isn't typed against a bad option. `dispatch` checks everything again.
	 */
	async prepareForm(request: DispatchRequest): Promise<FormPrep> {
		const found = this.#lookup(request.command, request.subcommand, request.subgroup);
		if (!found) return { ready: false, refuse: privateText(MESSAGES.unknownCommand) };
		const refused = await this.precheck(request);
		if (refused) return { ready: false, refuse: refused };
		const { actor } = request;
		const command = [request.command, request.subgroup, request.subcommand]
			.filter((part) => part !== undefined)
			.join(" ");
		const log = this.#deps.logger.child({
			command,
			platform: actor.platform,
			...actorLogFields(actor),
		});
		try {
			const valid = validateArgs(found.runnable, request.args, request.users, request.channels, {
				skipMissingFormFields: true,
			});
			const beforeForm = found.runnable.beforeForm;
			if (!beforeForm) return { ready: true };
			const principal = await this.#deps.identity.resolve(actor);
			const extra = await beforeForm({
				args: valid.args,
				users: valid.users,
				channels: valid.channels,
				principal,
				logger: log,
			});
			return { ready: true, ...extra };
		} catch (error) {
			if (error instanceof UserFacingError) {
				log.info({ event: "command.form_refused" }, "form not opened");
				return { ready: false, refuse: privateText(error.message) };
			}
			log.error({ event: "command.form_failed", err: error }, "form checks failed");
			const principal = await this.#deps.identity.resolve(actor);
			this.#deps.reporter.capture(error, { command, feature: found.feature, principal });
			return { ready: false, refuse: privateText(MESSAGES.internalError) };
		}
	}

	/**
	 * Checks whether this person may run a command, without running it, so an adapter
	 * doesn't open a form for someone who'd be refused. Returns the refusal to show,
	 * or undefined. `dispatch` checks everything again, so this is only a courtesy.
	 * Denials are logged the same way as `dispatch`.
	 */
	async precheck(
		request: Pick<DispatchRequest, "actor" | "command" | "subgroup" | "subcommand">,
	): Promise<DispatchResult | undefined> {
		const found = this.#lookup(request.command, request.subcommand, request.subgroup);
		if (!found) return privateText(MESSAGES.unknownCommand);
		const { actor } = request;
		const command = [request.command, request.subgroup, request.subcommand]
			.filter((part) => part !== undefined)
			.join(" ");
		const log = this.#deps.logger.child({
			command,
			platform: actor.platform,
			...actorLogFields(actor),
		});
		const principal = await this.#deps.identity.resolve(actor);
		for (const access of found.gates) {
			const decision = checkAccess(access, principal);
			if (decision.allowed) continue;
			log.warn(
				{
					event: "command.denied",
					reason: decision.reason,
					tier: principal.tier,
					required: access.minTier,
					...(access.capability === undefined ? {} : { capability: access.capability }),
				},
				"command denied",
			);
			return privateText(
				decision.reason === "context" ? MESSAGES.deniedContext : MESSAGES.deniedTier,
			);
		}
		return undefined;
	}

	/** Lets adapters choose visibility before the reply exists (e.g. when deferring). */
	defaultPrivacy(command: string, subcommand?: string, subgroup?: string): boolean {
		return this.#lookup(command, subcommand, subgroup)?.runnable.private ?? false;
	}

	async dispatch(
		{
			actor,
			command: commandName,
			subgroup,
			subcommand,
			args,
			users = {},
			channels = {},
		}: DispatchRequest,
		hooks: DispatchHooks = {},
	): Promise<DispatchResult> {
		const { identity, rateLimiter, reporter } = this.#deps;
		const user = actorRef(actor);
		// Logged and tagged by full name, e.g. "admin status".
		const command = [commandName, subgroup, subcommand]
			.filter((part) => part !== undefined)
			.join(" ");
		const log = this.#deps.logger.child({
			command,
			platform: actor.platform,
			...actorLogFields(actor),
		});

		const found = this.#lookup(commandName, subcommand, subgroup);
		if (!found) return privateText(MESSAGES.unknownCommand);
		const { runnable: definition, gates, feature } = found;

		if (!rateLimiter.tryTake(user)) {
			log.warn({ event: "command.rate_limited" }, "rate limited");
			return privateText(MESSAGES.rateLimited);
		}

		const principal = await identity.resolve(actor);
		// A subcommand sits behind its group, so every gate must pass.
		for (const access of gates) {
			const decision = checkAccess(access, principal);
			if (decision.allowed) continue;
			log.warn(
				{
					event: "command.denied",
					reason: decision.reason,
					tier: principal.tier,
					required: access.minTier,
					// The reply is generic, so the log is where "no capability" is visible.
					...(access.capability === undefined ? {} : { capability: access.capability }),
				},
				"command denied",
			);
			return privateText(
				decision.reason === "context" ? MESSAGES.deniedContext : MESSAGES.deniedTier,
			);
		}

		// Every executed command is logged as an action, so abuse can be traced to a user.
		const started = performance.now();
		const executed = (outcome: "ok" | "user_error" | "error") =>
			log.info(
				{
					event: "command.executed",
					outcome,
					tier: principal.tier,
					durationMs: Math.round(performance.now() - started),
				},
				"command executed",
			);

		try {
			const valid = validateArgs(definition, args, users, channels);
			if (definition.placeholder && hooks.onPending) {
				const { placeholder } = definition;
				await hooks.onPending({
					reply: placeholder,
					private: placeholder.private ?? definition.private ?? false,
				});
			}
			const run = () =>
				definition.handler({
					args: valid.args,
					users: valid.users,
					channels: valid.channels,
					principal,
					logger: log,
					availableCommands: this.#available(principal),
				});
			// Whatever is reported while the command runs is traced to the person who ran it.
			const reply = await (reporter.withContext
				? reporter.withContext({ command, feature, principal }, run)
				: run());
			executed("ok");
			return { reply, private: reply.private ?? definition.private ?? false };
		} catch (error) {
			if (error instanceof UserFacingError) {
				executed("user_error");
				return privateText(error.message);
			}
			executed("error");
			log.error({ event: "command.failed", err: error }, "command failed");
			reporter.capture(error, { command, feature, principal });
			return privateText(MESSAGES.internalError);
		}
	}

	/**
	 * Live suggestions for an option, for someone who is typing in it. Goes through
	 * the same access gates as running the command, so suggestions never reveal
	 * anything to someone who couldn't run it: they get an empty list and the
	 * denial is logged. A slow or failing suggestion function also gives an empty
	 * list. What was typed is never logged.
	 *
	 * Suggestions are only a convenience. The platform doesn't check that a value
	 * came from them, so the command must still validate what it receives.
	 */
	async suggest(request: SuggestRequest): Promise<Suggestion[]> {
		const { identity, reporter } = this.#deps;
		const { actor, subgroup, subcommand } = request;
		const found = this.#lookup(request.command, subcommand, subgroup);
		const option = found?.runnable.options?.find((o) => o.name === request.option);
		const suggest = (option as { suggest?: SuggestFn } | undefined)?.suggest;
		if (!found || !option || !suggest) return [];

		const command = [request.command, subgroup, subcommand]
			.filter((part) => part !== undefined)
			.join(" ");
		const log = this.#deps.logger.child({
			command,
			option: option.name,
			platform: actor.platform,
			...actorLogFields(actor),
		});
		if (!this.#suggestLimiter.tryTake(actorRef(actor))) {
			log.debug({ event: "command.suggest_rate_limited" }, "suggestions rate limited");
			return [];
		}

		const principal = await identity.resolve(actor);
		for (const access of found.gates) {
			const decision = checkAccess(access, principal);
			if (decision.allowed) continue;
			log.warn(
				{
					event: "command.suggest_denied",
					reason: decision.reason,
					tier: principal.tier,
					required: access.minTier,
					...(access.capability === undefined ? {} : { capability: access.capability }),
				},
				"suggestions denied",
			);
			return [];
		}

		try {
			const timeoutMs = this.#deps.suggestTimeoutMs ?? DEFAULT_SUGGEST_TIMEOUT_MS;
			const run = () =>
				suggest({ typed: request.typed, args: request.args, principal, logger: log });
			const suggestions = await withTimeout(
				reporter.withContext
					? reporter.withContext({ command, feature: found.feature, principal }, run)
					: run(),
				timeoutMs,
			);
			return cleanSuggestions(suggestions, option.type === "integer");
		} catch (error) {
			if (error instanceof SuggestTimeout) {
				log.warn({ event: "command.suggest_timeout" }, "suggestions timed out");
			} else if (!(error instanceof UserFacingError)) {
				log.error({ event: "command.suggest_failed", err: error }, "suggestions failed");
				reporter.capture(error, { command, feature: found.feature, principal });
			}
			return [];
		}
	}

	/** Finds what to run, plus every access gate on the way (group first). */
	#lookup(command: string, subcommand?: string, subgroup?: string) {
		const registered = this.#deps.registry.get(command);
		if (!registered) return undefined;
		const { definition, feature } = registered;
		if (!isGroup(definition)) {
			if (subcommand !== undefined || subgroup !== undefined) return undefined;
			return { runnable: definition, gates: [definition.access], feature };
		}
		let parent: GroupCommand | SubgroupDefinition = definition;
		const gates = [definition.access];
		if (subgroup !== undefined) {
			const nested = definition.subcommands.find((s) => isSubgroup(s) && s.name === subgroup);
			if (!nested || !isSubgroup(nested)) return undefined;
			parent = nested;
			gates.push(nested.access);
		}
		const sub = parent.subcommands.find((s) => !isSubgroup(s) && s.name === subcommand);
		if (!sub || isSubgroup(sub)) return undefined;
		return { runnable: sub, gates: [...gates, sub.access], feature };
	}

	#available(principal: Principal): CommandSummary[] {
		const allowed = (...gates: Access[]) => gates.every((a) => checkAccess(a, principal).allowed);
		return this.#deps.registry.all().flatMap(({ definition }): CommandSummary[] => {
			if (!isGroup(definition)) {
				if (!allowed(definition.access)) return [];
				return [{ name: definition.name, description: definition.description }];
			}
			return definition.subcommands.flatMap((child): CommandSummary[] => {
				if (!isSubgroup(child)) {
					if (!allowed(definition.access, child.access)) return [];
					return [{ name: `${definition.name} ${child.name}`, description: child.description }];
				}
				return child.subcommands
					.filter((sub) => allowed(definition.access, child.access, sub.access))
					.map((sub) => ({
						name: `${definition.name} ${child.name} ${sub.name}`,
						description: sub.description,
					}));
			});
		});
	}
}

class SuggestTimeout extends Error {
	override name = "SuggestTimeout";
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new SuggestTimeout()), ms);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Keeps what the platform can show: at most 25, with sensible names and values.
 * A value can't be shortened without changing what it means, so one that is too
 * long (or the wrong type for the option) is dropped rather than cut.
 */
function cleanSuggestions(list: readonly Suggestion[], integer: boolean): Suggestion[] {
	const out: Suggestion[] = [];
	for (const { name, value } of list) {
		if (out.length >= MAX_SUGGESTIONS) break;
		const shown = [
			...String(name)
				.replace(/[\p{Cc}\p{Cf}]/gu, " ")
				.replace(/\s+/g, " ")
				.trim(),
		]
			.slice(0, MAX_SUGGESTION_LENGTH)
			.join("");
		if (shown === "") continue;
		if (integer) {
			if (typeof value !== "number" || !Number.isSafeInteger(value)) continue;
		} else if (
			typeof value !== "string" ||
			value === "" ||
			[...value].length > MAX_SUGGESTION_LENGTH
		) {
			continue;
		}
		out.push({ name: shown, value });
	}
	return out;
}

function privateText(text: string): DispatchResult {
	return { reply: { text, private: true }, private: true };
}

export type ValidInput = {
	args: Args;
	users: Readonly<Record<string, ResolvedUser>>;
	channels: Readonly<Record<string, ResolvedChannel>>;
};

/** A string option filled in on a form. */
export type FormOption = Extract<CommandOption, { type: "string" }> & { form: FormField };

/**
 * Whether an adapter should open a form. `title` and `values` come from
 * `beforeForm` (the time Pixel understood, or text already saved, say).
 */
export type FormPrep =
	| { ready: false; refuse: DispatchResult }
	| { ready: true; title?: string; values?: Readonly<Record<string, string>> };

export type ValidateArgsFlags = {
	/**
	 * Required form fields may be missing: they haven't been typed yet. Other
	 * options are still checked, so a bad time can be refused before the form.
	 */
	skipMissingFormFields?: boolean;
};

/**
 * Checks args against the command's declared options. Platforms like Discord
 * already enforce this, but adapters are untrusted input boundaries, so the
 * core checks again. Unknown args are dropped. `user` options must carry the
 * ID of a user the adapter resolved, and bots are refused unless allowed.
 */
export function validateArgs(
	definition: Pick<SubcommandDefinition, "options">,
	args: Args,
	users: Readonly<Record<string, ResolvedUser>> = {},
	channels: Readonly<Record<string, ResolvedChannel>> = {},
	flags: ValidateArgsFlags = {},
): ValidInput {
	const result: Record<string, ArgValue> = {};
	const resolved: Record<string, ResolvedUser> = {};
	const resolvedChannels: Record<string, ResolvedChannel> = {};
	for (const option of definition.options ?? []) {
		const value = args[option.name];
		if (value === undefined) {
			const formPending =
				flags.skipMissingFormFields === true &&
				option.type === "string" &&
				option.form !== undefined;
			if (option.required && !formPending) {
				throw new UserFacingError(`Missing required option "${option.name}".`);
			}
			continue;
		}
		switch (option.type) {
			case "string":
				if (typeof value !== "string") throw invalid(option.name);
				if (option.choices && !option.choices.includes(value)) throw invalid(option.name);
				if (option.form && [...value].length > option.form.maxLength) {
					throw new UserFacingError(
						`"${option.name}" can be at most ${option.form.maxLength} characters.`,
					);
				}
				break;
			case "integer":
				if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid(option.name);
				break;
			case "boolean":
				if (typeof value !== "boolean") throw invalid(option.name);
				break;
			case "user": {
				const user = users[option.name];
				if (typeof value !== "string" || user?.id !== value) throw invalid(option.name);
				if (user.isBot && !option.allowBots) {
					throw new UserFacingError(`"${option.name}" can't be a bot.`);
				}
				resolved[option.name] = user;
				break;
			}
			case "channel": {
				const channel = channels[option.name];
				if (typeof value !== "string" || channel?.id !== value) throw invalid(option.name);
				resolvedChannels[option.name] = channel;
				break;
			}
		}
		result[option.name] = value;
	}
	return { args: result, users: resolved, channels: resolvedChannels };
}

function invalid(name: string): UserFacingError {
	return new UserFacingError(`Invalid value for option "${name}".`);
}
