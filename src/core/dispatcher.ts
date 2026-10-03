import { checkAccess, type PlatformActor, type Principal } from "./access.ts";
import type { Args, ArgValue, CommandDefinition, CommandSummary } from "./command.ts";
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
	args: Args;
};

export type DispatchResult = {
	reply: Reply;
	/** Final visibility, already resolved from the reply and command defaults. */
	private: boolean;
};

export type DispatcherDeps = {
	registry: CommandRegistry;
	identity: IdentityService;
	rateLimiter: RateLimiter;
	logger: Logger;
	reporter: ErrorReporter;
	/** Stable, non-reversible user identifier for logs. Never log raw platform IDs. */
	pseudonymize: (actor: PlatformActor) => string;
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
 * Order: rate limit → resolve identity → check access → validate args → run.
 */
export class Dispatcher {
	readonly #deps: DispatcherDeps;

	constructor(deps: DispatcherDeps) {
		this.#deps = deps;
	}

	/** Lets adapters choose visibility before the reply exists (e.g. when deferring). */
	defaultPrivacy(command: string): boolean {
		return this.#deps.registry.get(command)?.definition.private ?? false;
	}

	async dispatch({ actor, command, args }: DispatchRequest): Promise<DispatchResult> {
		const { registry, identity, rateLimiter, reporter } = this.#deps;
		const user = this.#deps.pseudonymize(actor);
		const log = this.#deps.logger.child({ command, platform: actor.platform, user });

		const registered = registry.get(command);
		if (!registered) return privateText(MESSAGES.unknownCommand);
		const { definition, feature } = registered;

		if (!rateLimiter.tryTake(`${actor.platform}:${actor.userId}`)) {
			log.warn({ event: "command.rate_limited" }, "rate limited");
			return privateText(MESSAGES.rateLimited);
		}

		const principal = await identity.resolve(actor);
		const decision = checkAccess(definition.access, principal);
		if (!decision.allowed) {
			log.warn(
				{
					event: "command.denied",
					reason: decision.reason,
					tier: principal.tier,
					required: definition.access.minTier,
				},
				"command denied",
			);
			return privateText(decision.reason === "tier" ? MESSAGES.deniedTier : MESSAGES.deniedContext);
		}

		if (definition.access.minTier === "admin") {
			log.info({ event: "command.admin", tier: principal.tier }, "admin command");
		}

		try {
			const validArgs = validateArgs(definition, args);
			const reply = await definition.handler({
				args: validArgs,
				principal,
				logger: log,
				availableCommands: this.#available(principal),
			});
			return { reply, private: reply.private ?? definition.private ?? false };
		} catch (error) {
			if (error instanceof UserFacingError) return privateText(error.message);
			log.error({ event: "command.failed", err: error }, "command failed");
			reporter.capture(error, { command, feature, principal });
			return privateText(MESSAGES.internalError);
		}
	}

	#available(principal: Principal): CommandSummary[] {
		return this.#deps.registry
			.all()
			.filter(({ definition }) => checkAccess(definition.access, principal).allowed)
			.map(({ definition }) => ({ name: definition.name, description: definition.description }));
	}
}

function privateText(text: string): DispatchResult {
	return { reply: { text, private: true }, private: true };
}

/**
 * Checks args against the command's declared options. Platforms like Discord
 * already enforce this, but adapters are untrusted input boundaries, so the
 * core checks again. Unknown args are dropped.
 */
export function validateArgs(definition: CommandDefinition, args: Args): Args {
	const result: Record<string, ArgValue> = {};
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
		}
		result[option.name] = value;
	}
	return result;
}

function invalid(name: string): UserFacingError {
	return new UserFacingError(`Invalid value for option "${name}".`);
}
