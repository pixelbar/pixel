import { actorLogFields } from "../../core/access.ts";
import type { SubcommandDefinition, SubgroupDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import { MAX_CLOSING_TIME_MESSAGE, writeClosingTimeMessage } from "../closing-time/index.ts";

/**
 * `/admin set closing-time`: a modal for the reminder text, written to the
 * persist file (`PIXEL_DATA_DIR/closing-time.md`, the Azure Files share on cloud).
 */
export function createSetSubgroup(deps: { closingTimeFile: string }): SubgroupDefinition {
	const closingTime: SubcommandDefinition = {
		name: "closing-time",
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
		name: "set",
		description: "Change settings (admins only)",
		access: { minTier: "admin" },
		subcommands: [closingTime],
	};
}
