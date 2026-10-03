import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

/**
 * Remembers which Discord message is the live "open" post, so Pixel can find it
 * again even if it has been buried in a busy channel. This is only a hint: if
 * it's missing or wrong, Pixel falls back to looking through the channel's
 * recent messages.
 */
export type LivePostStore = {
	/** The open post's message ID, or undefined if none is remembered. Throws if the saved data is unusable. */
	load(): string | undefined;
	/** Remembers the open post, or forgets it when given undefined. */
	save(messageId: string | undefined): void;
};

export class LivePostStateError extends Error {
	override name = "LivePostStateError";
}

// IDs are strings: as YAML numbers they'd silently lose precision.
const snowflake = z.string().regex(/^\d{17,20}$/);
const fileSchema = z.strictObject({ channelId: snowflake, messageId: snowflake });

const HEADER = "# Pixel's record of its live Discord status post. Safe to delete or edit.\n";

/** Keeps the hint in a small YAML file (`announcements.state`). */
export class FileLivePostStore implements LivePostStore {
	readonly #path: string;
	readonly #channelId: string;

	constructor(path: string, channelId: string) {
		this.#path = path;
		this.#channelId = channelId;
	}

	load(): string | undefined {
		let source: string;
		try {
			source = readFileSync(this.#path, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return undefined;
			throw new LivePostStateError(`cannot read ${this.#path} (${code ?? "unknown error"})`);
		}

		let data: unknown;
		try {
			data = parse(source);
		} catch {
			throw new LivePostStateError(`${this.#path} is not valid YAML`);
		}
		const result = fileSchema.safeParse(data);
		if (!result.success) throw new LivePostStateError(`${this.#path} has an unexpected shape`);

		// A post in a channel that's no longer the live channel isn't ours to update.
		return result.data.channelId === this.#channelId ? result.data.messageId : undefined;
	}

	save(messageId: string | undefined): void {
		if (messageId === undefined) {
			rmSync(this.#path, { force: true });
			return;
		}
		mkdirSync(dirname(this.#path), { recursive: true });
		// Write to a temp file and rename, so a crash can't leave a half-written file.
		const temp = `${this.#path}.tmp`;
		writeFileSync(temp, HEADER + stringify({ channelId: this.#channelId, messageId }));
		renameSync(temp, this.#path);
	}
}
