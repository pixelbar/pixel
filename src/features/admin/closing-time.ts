import { actorLogFields } from "../../core/access.ts";
import type { SubcommandDefinition, SubgroupDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import {
	MAX_CLOSING_TIME_MESSAGE,
	savedClosingTimeMessage,
	writeClosingTimeMessage,
} from "../closing-time/index.ts";

/**
 * `/admin closing-time set`: a modal for the reminder text, written to the
 * persist file (`PIXEL_DATA_DIR/closing-time.md`, the Azure Files share on cloud).
 * Opens with the saved message when one is already set.
 */
export function createClosingTimeSubgroup(deps: { closingTimeFile: string }): SubgroupDefinition {
	const set: SubcommandDefinition = {
		name: "set",
		description: "Set the closing-time reminder",
		access: { minTier: "admin" },
		private: true,
		options: [
			{
				name: "message",
				description: "Closing-time reminder",
				type: "string",
				required: true,
				form: {
					style: "paragraph",
					maxLength: MAX_CLOSING_TIME_MESSAGE,
					placeholder: "Posted when the space closes. Markdown works. No secrets.",
				},
			},
		],
		beforeForm: async () => {
			const saved = savedClosingTimeMessage(deps.closingTimeFile);
			return saved === undefined ? undefined : { values: { message: saved } };
		},
		handler: async ({ args, principal, logger }) => {
			const message = String(args.message ?? "");
			try {
				writeClosingTimeMessage(deps.closingTimeFile, message);
			} catch (error) {
				if (error instanceof UserFacingError) throw error;
				logger.error(
					{ event: "closing_time.save_failed", err: error },
					"couldn't save the closing-time message",
				);
				throw new UserFacingError("Couldn't save the closing-time message. Try again in a bit.");
			}
			logger.info(
				{ event: "closing_time.updated", ...actorLogFields(principal) },
				"updated the closing-time message",
			);
			return { text: "Saved the closing-time message.", private: true };
		},
	};
	return {
		name: "closing-time",
		description: "Closing-time reminder (admins only)",
		access: { minTier: "admin" },
		subcommands: [set],
	};
}
