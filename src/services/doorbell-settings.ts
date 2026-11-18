import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Logger } from "../core/logger.ts";

/**
 * Where the doorbell is posted: the channel admins pick with `/admin` → Doorbell, saved in
 * `data/doorbell.yaml` so it survives a restart. Unset means nothing is posted.
 *
 * A file that exists but can't be read leaves the channel unset (nothing is posted, which
 * is the safe side) and says so in `problem`, until an admin sets a channel again, which
 * rewrites it.
 */

const fileSchema = z.strictObject({
	channelId: z
		.string()
		.regex(/^\d{17,20}$/)
		.optional(),
	changedAt: z.iso.datetime().optional(),
	changedBy: z.string().max(100).optional(),
});

const HEADER = "# Where Pixel posts the doorbell (/admin → Doorbell). Written by Pixel.\n";

export class DoorbellSettings {
	readonly #file: string | undefined;
	readonly #logger: Logger;
	#channelId: string | undefined;
	#problem: string | undefined;

	/** Without a file, the channel holds until a restart (tests). */
	constructor(options: { file?: string; logger: Logger }) {
		this.#file = options.file;
		this.#logger = options.logger.child({ component: "doorbell-settings" });
		this.#load();
	}

	/** The channel the doorbell is posted in, if one is set. */
	get channelId(): string | undefined {
		return this.#channelId;
	}

	/** Why the file couldn't be read, if it couldn't. */
	get problem(): string | undefined {
		return this.#problem;
	}

	/**
	 * Sets the channel (or clears it, with undefined) and saves it. Never throws: `saved`
	 * is false when the change holds only until a restart. The caller logs who did it.
	 */
	set(channelId: string | undefined, by: string): { changed: boolean; saved: boolean } {
		const changed = this.#channelId !== channelId;
		this.#channelId = channelId;
		this.#problem = undefined;
		return { changed, saved: this.#save(by) };
	}

	#load(): void {
		if (!this.#file) return;
		let source: string;
		try {
			source = readFileSync(this.#file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#unreadable("unreadable");
			return;
		}
		let raw: unknown;
		try {
			raw = parse(source);
		} catch {
			this.#unreadable("not YAML");
			return;
		}
		const result = fileSchema.safeParse(raw ?? {});
		if (!result.success) {
			this.#unreadable("invalid");
			return;
		}
		this.#channelId = result.data.channelId;
	}

	#unreadable(why: string): void {
		this.#problem = `data/doorbell.yaml is ${why}, so the doorbell isn't posted until an admin sets a channel`;
		this.#logger.error(
			{ event: "doorbell.settings_unreadable", why },
			"couldn't read the doorbell settings, so the doorbell isn't posted",
		);
	}

	#save(by: string): boolean {
		if (!this.#file) return true;
		try {
			mkdirSync(dirname(this.#file), { recursive: true });
			const temp = `${this.#file}.tmp`;
			const body = stringify({
				...(this.#channelId ? { channelId: this.#channelId } : {}),
				changedAt: new Date().toISOString(),
				changedBy: by,
			});
			writeFileSync(temp, HEADER + body);
			renameSync(temp, this.#file);
			return true;
		} catch (error) {
			this.#logger.error(
				{ event: "doorbell.settings_save_failed", err: error },
				"couldn't save the doorbell settings: they hold until Pixel restarts",
			);
			return false;
		}
	}
}
