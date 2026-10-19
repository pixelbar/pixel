import { actorLogFields, type PlatformActor } from "../../core/access.ts";
import type { Logger } from "../../core/logger.ts";

/**
 * Why Discord wouldn't take an answer to an interaction.
 *
 * - `duplicate` (40060, already acknowledged): something else answered first.
 *   Typical when two Pixels share one bot token.
 * - `expired` (10062, unknown interaction): nobody acknowledged it within
 *   Discord's 3 s. That's Pixel (or the network) being too slow, not a second
 *   instance: a second instance answering first gives 40060.
 * - `other`: anything else.
 */
export type InteractionFailure = "duplicate" | "expired" | "other";

export function classifyInteractionError(error: unknown): InteractionFailure {
	if (error === null || typeof error !== "object" || !("code" in error)) return "other";
	const code = error.code;
	if (code === 40060 || code === "40060") return "duplicate";
	if (code === 10062 || code === "10062") return "expired";
	return "other";
}

/**
 * Reported when Discord expired an interaction before Pixel acknowledged it.
 * The message names the command so Sentry groups slow commands apart.
 */
export class SlowAcknowledgementError extends Error {
	constructor(what: string, cause: unknown) {
		super(`Discord expired ${what} before Pixel acknowledged it`, { cause });
		this.name = "SlowAcknowledgementError";
	}
}

export type InteractionFailureDeps = {
	logger: Logger;
	reportError: (error: unknown, actor?: PlatformActor) => void;
};

/**
 * Logs and reports an error that escaped a command (`command` set) or form
 * handler. Never logs what was typed: only the command and who ran it.
 */
export function handleInteractionFailure(
	error: unknown,
	{ logger, reportError }: InteractionFailureDeps,
	{ actor, command }: { actor: PlatformActor; command?: string },
): void {
	const fields = {
		err: error,
		...(command === undefined ? {} : { command }),
		...actorLogFields(actor),
	};
	switch (classifyInteractionError(error)) {
		case "duplicate":
			logger.warn(
				{ ...fields, event: "discord.duplicate_handler" },
				command === undefined
					? "another Pixel already answered this form; is a second instance on this token?"
					: "another Pixel already answered this interaction; is a second instance on this token?",
			);
			return;
		case "expired":
			logger.error(
				{ ...fields, event: "discord.slow_ack" },
				"Discord expired the interaction before Pixel acknowledged it",
			);
			reportError(
				new SlowAcknowledgementError(command === undefined ? "a form" : `/${command}`, error),
				actor,
			);
			return;
		case "other":
			logger.error(
				fields,
				command === undefined ? "failed to handle a form" : "failed to handle interaction",
			);
			// Name who it happened to, by ID, so the report can be traced.
			reportError(error, actor);
	}
}
