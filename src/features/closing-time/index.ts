import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Announcement } from "../../core/announcement.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown } from "../../core/format.ts";
import type { Logger } from "../../core/logger.ts";
import type { Reply } from "../../core/reply.ts";

/** Used when the operator file is missing or empty. Pixel-written, English. */
export const DEFAULT_CLOSING_TIME_MESSAGE =
	"The space is closing. Please tidy up, take your belongings, and make sure the last person out locks the door.";

/** Discord modal / stored-message limit. Embeds allow 4096; the form is 4000. */
export const MAX_CLOSING_TIME_MESSAGE = 4000;

export type ClosingTimeDeps = {
	announcer: { announce(announcement: Announcement): Promise<void> };
	/** False when no destination channel is configured (off / none / unset). */
	enabled: boolean;
	/** Read fresh each send so an operator can edit the file without a restart. */
	message: () => string;
	logger: Logger;
	now?: () => Date;
};

export type ClosingTimeFeature = Feature & {
	/**
	 * Same send path as `/closing-time`. The space-closed hook calls this.
	 * Never throws: a failure is logged and space-close is unaffected.
	 */
	onSpaceClosed: () => Promise<void>;
};

/**
 * `/closing-time`: post the closing-time reminder. The same send path runs
 * automatically after a confirmed space-closed announcement.
 *
 * Destination is the configured Discord channel (env). Unset, `off` or `none`
 * disables both paths. The body lives in a file under `data/` (not env) because
 * it is typically a multi-line checklist — awkward in Azure / `.env` — and is
 * not a secret. Never put door codes or passwords in it.
 */
export function createClosingTimeFeature(deps: ClosingTimeDeps): ClosingTimeFeature {
	const now = deps.now ?? (() => new Date());
	const log = deps.logger.child({ component: "closing-time" });

	const post = async (source: "command" | "auto"): Promise<"sent" | "disabled"> => {
		if (!deps.enabled) {
			log.info({ event: "closing_time.disabled", source }, "closing-time posts are off");
			return "disabled";
		}
		const body = clip(deps.message(), MAX_CLOSING_TIME_MESSAGE);
		await deps.announcer.announce({
			kind: "closing.time",
			text: escapeMarkdown(body),
			body,
			at: now(),
		});
		log.info({ event: "closing_time.posted", source }, "posted the closing-time message");
		return "sent";
	};

	const onSpaceClosed = async (): Promise<void> => {
		try {
			await post("auto");
		} catch (error) {
			log.error(
				{ event: "closing_time.failed", source: "auto", err: error },
				"couldn't post the closing-time message",
			);
		}
	};

	return {
		name: "closing-time",
		onSpaceClosed,
		commands: [
			{
				name: "closing-time",
				description: "Post the closing-time reminder",
				access: { minTier: "member" },
				private: true,
				handler: async (): Promise<Reply> => {
					const result = await post("command");
					if (result === "disabled") {
						return { text: "Closing-time posts are turned off.", private: true };
					}
					return { text: "Posted the closing-time message.", private: true };
				},
			},
		],
	};
}

/** Reads the operator file. Missing or empty → the built-in default. Other errors are logged. */
export function closingTimeMessage(file: string, logger: Logger): () => string {
	return () => {
		try {
			return readSavedMessage(file) ?? DEFAULT_CLOSING_TIME_MESSAGE;
		} catch (error) {
			logger.warn(
				{ event: "closing_time.message_unreadable", err: error },
				"couldn't read the closing-time message; using the default",
			);
			return DEFAULT_CLOSING_TIME_MESSAGE;
		}
	};
}

/**
 * The saved operator text, if any. Missing, empty or unreadable → undefined,
 * so a form can stay blank (placeholder only) instead of showing the default.
 */
export function savedClosingTimeMessage(file: string): string | undefined {
	try {
		return readSavedMessage(file);
	} catch {
		return undefined;
	}
}

function readSavedMessage(file: string): string | undefined {
	try {
		const text = readFileSync(file, "utf8")
			.replace(/^\uFEFF/, "")
			.trim();
		return text || undefined;
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

/**
 * Writes the operator file atomically (temp + rename) so Azure Files / the
 * persist share keeps a complete message. The file *is* the persist: on Azure,
 * `PIXEL_DATA_DIR` is the file share. Never put secrets in it.
 */
export function writeClosingTimeMessage(file: string, body: string): string {
	const text = body
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.trim();
	if (text === "") throw new UserFacingError("The closing-time message can't be empty.");
	if (text.length > MAX_CLOSING_TIME_MESSAGE) {
		throw new UserFacingError(
			`The closing-time message can be at most ${MAX_CLOSING_TIME_MESSAGE} characters.`,
		);
	}
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.tmp`;
	writeFileSync(temp, `${text}\n`);
	renameSync(temp, file);
	return text;
}

function clip(body: string, max: number): string {
	if (body.length <= max) return body;
	return `${body.slice(0, max - 1)}…`;
}
