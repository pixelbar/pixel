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
	type CommandSummary,
	type GroupCommand,
	isGroup,
	isSubgroup,
	type ResolvedUser,
	type SubcommandDefinition,
	type SubgroupDefinition,
} from "./command.ts";
import { UserFacingError } from "./errors.ts";
import type { IdentityService } from "./identity.ts";
import type { Logger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";
import type { RateLimiter } from "./rate-limit.ts";
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
};

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

	constructor(deps: DispatcherDeps) {
		this.#deps = deps;
	}

	/** Lets adapters choose visibility before the reply exists (e.g. when deferring). */
	defaultPrivacy(command: string, subcommand?: string, subgroup?: string): boolean {
		return this.#lookup(command, subcommand, subgroup)?.runnable.private ?? false;
	}

	async dispatch(
		{ actor, command: commandName, subgroup, subcommand, args, users = {} }: DispatchRequest,
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
				},
				"command denied",
			);
			return privateText(decision.reason === "tier" ? MESSAGES.deniedTier : MESSAGES.deniedContext);
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
			const valid = validateArgs(definition, args, users);
			if (definition.placeholder && hooks.onPending) {
				const { placeholder } = definition;
				await hooks.onPending({
					reply: placeholder,
					private: placeholder.private ?? definition.private ?? false,
				});
			}
			const reply = await definition.handler({
				args: valid.args,
				users: valid.users,
				principal,
				logger: log,
				availableCommands: this.#available(principal),
			});
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

function privateText(text: string): DispatchResult {
	return { reply: { text, private: true }, private: true };
}

export type ValidInput = {
	args: Args;
	users: Readonly<Record<string, ResolvedUser>>;
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
): ValidInput {
	const result: Record<string, ArgValue> = {};
	const resolved: Record<string, ResolvedUser> = {};
	for (const option of definition.options ?? []) {
		const value = args[option.name];
		if (value === undefined) {
			if (option.required) throw new UserFacingError(`Missing required option "${option.name}".`);
			continue;
		}
		switch (option.type) {
			case "string":
				if (typeof value !== "string") throw invalid(option.name);
				if (option.choices && !option.choices.includes(value)) throw invalid(option.name);
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
		}
		result[option.name] = value;
	}
	return { args: result, users: resolved };
}

function invalid(name: string): UserFacingError {
	return new UserFacingError(`Invalid value for option "${name}".`);
}
