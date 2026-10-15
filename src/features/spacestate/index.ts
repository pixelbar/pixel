import { type Access, actorLogFields, actorRef } from "../../core/access.ts";
import type { CommandContext } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { Reply } from "../../core/reply.ts";
import {
	type SettableSpaceState,
	type SpaceStateApi,
	SpaceStateApiError,
} from "../../services/space-state-api.ts";

/** Lets a member set the space open or closed. Granted with `/admin capabilities`. */
export const SPACESTATE_CAPABILITY = {
	name: "spacestate",
	description: "Set the space open or closed with /spacestate",
};

/** Members holding the capability. The dispatcher is the only place this is checked. */
const ACCESS: Access = { minTier: "member", capability: SPACESTATE_CAPABILITY.name };

/**
 * What people pick, and what is sent to the API. The option says `close`; the API
 * wants `closed`. Anything not listed here is refused, whatever the platform let through.
 */
const STATES: Readonly<Record<string, SettableSpaceState>> = {
	open: "open",
	close: "closed",
};
const CHOICES = Object.keys(STATES);

export const SPACESTATE_MESSAGES = {
	notSetUp: "Setting the space state from Pixel isn't set up here.",
	badState: "The state must be `open` or `close`.",
	failed:
		"⚠️ I couldn't set the space state, so nothing has changed. Try again in a moment, or use the switch at the space.",
} as const;

export type SpaceStateFeatureDeps = {
	/** Undefined when it isn't configured: the command then says so and does nothing. */
	api: SpaceStateApi | undefined;
	reporter: Pick<ErrorReporter, "captureBackground" | "breadcrumb">;
};

/**
 * `/spacestate set state:open|close`: tells the space's state API that Pixelbar is
 * open or closed. Members holding the `spacestate` capability only; a tier, a role
 * or being an admin never grants it.
 *
 * It only asks the API to change the state. `/status` and the open/closed
 * announcements still read the state back from SpaceAPI, so they follow once the
 * change shows up there, and nothing is announced from here.
 */
export function createSpaceStateFeature(deps: SpaceStateFeatureDeps): Feature {
	const set = async ({ args, principal, logger }: CommandContext): Promise<Reply> => {
		// Whatever was suggested, the value is checked again here.
		const raw = args.state;
		const state = typeof raw === "string" && Object.hasOwn(STATES, raw) ? STATES[raw] : undefined;
		if (state === undefined) throw new UserFacingError(SPACESTATE_MESSAGES.badState);

		if (!deps.api) return { text: SPACESTATE_MESSAGES.notSetUp, private: true };

		const by = actorRef(principal);
		try {
			await deps.api.set(state);
		} catch (error) {
			if (!(error instanceof SpaceStateApiError)) throw error;
			// The error message never holds the URL, the token or what the API said.
			logger.warn(
				{ event: "spacestate.failed", state, ...actorLogFields(principal), err: error },
				"couldn't set the space state",
			);
			deps.reporter.captureBackground(error, "spacestate", principal);
			return { text: SPACESTATE_MESSAGES.failed, private: true };
		}

		logger.info(
			{ event: "spacestate.set", state, ...actorLogFields(principal) },
			"set the space state",
		);
		deps.reporter.breadcrumb("spacestate.set", `space ${state}`, { user: by });
		return {
			text: `Told the space API that Pixelbar is **${state}**. \`/status\` follows once it shows up there.`,
			private: true,
		};
	};

	return {
		name: "spacestate",
		commands: [
			{
				name: "spacestate",
				description: "Set whether Pixelbar is open or closed",
				access: ACCESS,
				subcommands: [
					{
						name: "set",
						description: "Set the space open or closed",
						access: ACCESS,
						private: true,
						options: [
							{
								name: "state",
								description: "Is the space open or closed?",
								type: "string",
								required: true,
								choices: CHOICES,
							},
						],
						handler: set,
					},
				],
			},
		],
	};
}
