import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Logger } from "../core/logger.ts";

/**
 * Emergency switches for whole kinds of Home Assistant device: an admin can turn
 * control of, say, every door off at once with `/admin doors off`, without a deploy
 * or an edit to the devices file. Reading a device is unaffected.
 *
 * Everything starts switched on. What's switched off is remembered in a small file
 * (`data/home-switches.state`) so it survives a restart. If that file exists but
 * can't be read, every kind that has ever been switchable is treated as off (fail
 * closed) until an admin switches it on again, which rewrites the file.
 */

export type SwitchChange = { kind: string; on: boolean; by: string; at: Date };

export type KindSwitchSet = {
	changed: boolean;
	/** False when the change couldn't be saved: it holds until a restart. */
	saved: boolean;
};

const fileSchema = z.strictObject({
	off: z.array(z.string()).max(50),
	changedAt: z.iso.datetime().optional(),
	changedBy: z.string().optional(),
});

const HEADER =
	"# Which kinds of Home Assistant device are switched off (/admin doors). Written by Pixel.\n";

export class KindSwitch {
	readonly #file: string | undefined;
	readonly #logger: Logger;
	/** Kinds treated as off when the file is unreadable. */
	readonly #switchable: readonly string[];
	readonly #off = new Set<string>();

	constructor(options: { file?: string; logger: Logger; switchable: readonly string[] }) {
		this.#file = options.file;
		this.#logger = options.logger.child({ component: "kind-switch" });
		this.#switchable = options.switchable;
		this.#load();
	}

	isOn(kind: string): boolean {
		return !this.#off.has(kind);
	}

	/** Switches a kind on or off, records who did it, and saves it. Never throws. */
	set(kind: string, on: boolean, by: string): KindSwitchSet {
		const changed = this.isOn(kind) !== on;
		if (on) this.#off.delete(kind);
		else this.#off.add(kind);
		const saved = this.#save(by);
		this.#logger.warn(
			{ event: "home.kind_switched", kind, on, changed, saved, by },
			on ? `control of ${kind}s switched on` : `control of ${kind}s switched off`,
		);
		return { changed, saved };
	}

	#load(): void {
		if (!this.#file) return;
		let source: string;
		try {
			source = readFileSync(this.#file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#failClosed("unreadable");
			return;
		}
		try {
			const result = fileSchema.safeParse(parse(source));
			if (!result.success) {
				this.#failClosed("invalid");
				return;
			}
			for (const kind of result.data.off) this.#off.add(kind);
		} catch {
			this.#failClosed("invalid");
		}
	}

	#failClosed(why: string): void {
		for (const kind of this.#switchable) this.#off.add(kind);
		this.#logger.error(
			{ event: "home.kind_switch_unreadable", why, off: this.#switchable },
			"couldn't read the switch file, so those kinds are switched off until an admin switches them on",
		);
	}

	#save(by: string): boolean {
		if (!this.#file) return true;
		try {
			mkdirSync(dirname(this.#file), { recursive: true });
			const temp = `${this.#file}.tmp`;
			const body = stringify({
				off: [...this.#off].sort(),
				changedAt: new Date().toISOString(),
				changedBy: by,
			});
			writeFileSync(temp, HEADER + body);
			renameSync(temp, this.#file);
			return true;
		} catch (error) {
			this.#logger.error(
				{ event: "home.kind_switch_save_failed", err: error },
				"couldn't save the switch: it holds until Pixel restarts",
			);
			return false;
		}
	}
}
