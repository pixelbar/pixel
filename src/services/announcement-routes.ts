import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { SPACE_ANNOUNCE_STYLES, type SpaceAnnounceStyle } from "../core/announcement.ts";
import type { Logger } from "../core/logger.ts";

/**
 * Where the open/closed announcements go, as admins set it with `/admin
 * announcements`: a list of (style, channel) pairings, kept in a small file
 * (`data/announcement-routes.yaml`) so it survives a restart and a deploy. A channel
 * has at most one style. Channels from the environment (`DISCORD_ANNOUNCE_*`) are
 * not stored here: they are configuration, and this list adds to them.
 *
 * It only says what to post where; who may change it is decided by the dispatcher
 * (admins). If the file can't be read, announcements through it are simply off
 * until an admin sets them again, which rewrites it. That is logged.
 */

export const MAX_ROUTES = 25;

export type StoredRoute = { style: SpaceAnnounceStyle; channelId: string };

export type RouteSave = { saved: boolean };

// IDs are strings: as YAML numbers they'd silently lose precision.
const snowflake = z.string().regex(/^\d{17,20}$/);
const fileSchema = z.strictObject({
	routes: z
		.array(z.strictObject({ style: z.enum(SPACE_ANNOUNCE_STYLES), channelId: snowflake }))
		.max(MAX_ROUTES),
});

const HEADER =
	"# Where Pixel posts open/closed announcements (/admin announcements). Written by Pixel.\n";

export class AnnouncementRouteStore {
	readonly #file: string | undefined;
	readonly #logger: Logger;
	#routes: StoredRoute[] = [];

	constructor(options: { file?: string; logger: Logger }) {
		this.#file = options.file;
		this.#logger = options.logger.child({ component: "announcement-routes" });
		this.#load();
	}

	list(): readonly StoredRoute[] {
		return this.#routes;
	}

	/** Whether another channel fits (replacing a channel's style always does). */
	canAdd(channelId: string): boolean {
		return this.#routes.length < MAX_ROUTES || this.#routes.some((r) => r.channelId === channelId);
	}

	/** Gives a channel a style (replacing any it had). `saved: false` when it can't be written. */
	set(route: StoredRoute): RouteSave {
		const next = this.#routes.filter((r) => r.channelId !== route.channelId);
		next.push(route);
		return this.#write(next);
	}

	/** Takes a channel off the list. */
	remove(channelId: string): RouteSave {
		return this.#write(this.#routes.filter((r) => r.channelId !== channelId));
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
		try {
			const result = fileSchema.safeParse(parse(source));
			if (!result.success) {
				this.#unreadable("invalid");
				return;
			}
			this.#routes = result.data.routes;
		} catch {
			this.#unreadable("invalid");
		}
	}

	#unreadable(why: string): void {
		this.#logger.error(
			{ event: "announcements.routes_unreadable", why },
			"couldn't read the announcement routes file, so announcements through it are off until an admin sets them again",
		);
	}

	#write(next: StoredRoute[]): RouteSave {
		// Held in memory either way, so a failed save still works until a restart.
		this.#routes = next;
		if (!this.#file) return { saved: true };
		try {
			mkdirSync(dirname(this.#file), { recursive: true });
			// Write to a temp file and rename, so a crash can't leave a half-written file.
			const temp = `${this.#file}.tmp`;
			writeFileSync(temp, HEADER + stringify({ routes: next }));
			renameSync(temp, this.#file);
			return { saved: true };
		} catch (error) {
			this.#logger.error(
				{ event: "announcements.routes_save_failed", err: error },
				"couldn't save the announcement routes",
			);
			return { saved: false };
		}
	}
}
