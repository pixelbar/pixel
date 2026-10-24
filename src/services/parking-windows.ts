import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Logger } from "../core/logger.ts";
import { ParkingError, type ParkingSpot, SPOT_NAME } from "./parking-spots.ts";

/**
 * When parking spots are open, kept in `data/parking-windows.yaml` and changed with
 * `/admin parking open|close`. These change daily, so they live apart from the
 * spots themselves.
 *
 * - **windows:** a borrowed spot is open from `from` to `until`.
 * - **blocks:** a permanent spot is closed from `from` to `until`.
 *
 * Nothing here runs past the reset on the day it starts (the commands make sure),
 * and an entry is pruned once its `until` has passed, so the file only ever holds
 * today's and later entries.
 *
 * If the file exists but can't be read, every borrowed spot counts as closed
 * (permanent spots still work) until an admin next opens or closes a spot. That
 * write moves the broken file aside to `parking-windows.yaml.broken` and starts a
 * new one: what's in it would have expired by the end of the day anyway.
 */

export const MAX_ENTRIES = 200;

export type ParkingEntry = {
	spot: string;
	from: Date;
	until: Date;
	/** Who set it: their platform ID, and a name for humans. */
	setBy: { ref: string; name: string };
};

export type ParkingEntries = {
	/** When borrowed spots are open. */
	windows: readonly ParkingEntry[];
	/** When permanent spots are closed. */
	blocks: readonly ParkingEntry[];
};

const entrySchema = z
	.strictObject({
		spot: z.string().regex(SPOT_NAME),
		from: z.iso.datetime(),
		until: z.iso.datetime(),
		setBy: z.strictObject({ ref: z.string().min(1).max(64), name: z.string().max(100) }),
	})
	.refine((e) => Date.parse(e.until) > Date.parse(e.from), { error: "until must be after from" });

const fileSchema = z.strictObject({
	windows: z.array(entrySchema).max(MAX_ENTRIES).optional(),
	blocks: z.array(entrySchema).max(MAX_ENTRIES).optional(),
});

const HEADER =
	"# When Pixel's parking spots are open (borrowed) or closed (permanent). Managed with /admin parking.\n";

const EMPTY: ParkingEntries = { windows: [], blocks: [] };

export class ParkingWindowStore {
	readonly #file: string | undefined;
	readonly #logger: Logger;
	#entries: ParkingEntries = EMPTY;
	#problem: string | undefined;

	constructor(options: { file?: string; logger: Logger }) {
		this.#file = options.file;
		this.#logger = options.logger.child({ component: "parking" });
		this.#problem = this.#load();
	}

	/** Why the file couldn't be read, until an admin's next change replaces it. */
	get problem(): string | undefined {
		return this.#problem;
	}

	/** Every entry that hasn't ended by `now`. */
	entries(now: Date): ParkingEntries {
		return prune(this.#entries, now);
	}

	/**
	 * Replaces every entry (ended ones are dropped). Throws `ParkingError` and changes
	 * nothing if it can't be saved.
	 */
	replace(next: ParkingEntries, now: Date): void {
		const pruned = prune(next, now);
		if (this.#file) {
			try {
				mkdirSync(dirname(this.#file), { recursive: true });
				if (this.#problem) this.#moveAside(this.#file);
				const temp = `${this.#file}.tmp`;
				writeFileSync(temp, HEADER + stringify(serialise(pruned)));
				renameSync(temp, this.#file);
			} catch (error) {
				this.#logger.error(
					{ event: "parking.windows_save_failed", err: error },
					"couldn't save the parking windows",
				);
				throw new ParkingError("Couldn't save the opening times, so nothing was changed.");
			}
		}
		this.#entries = pruned;
		this.#problem = undefined;
	}

	/**
	 * Drops windows for spots that don't exist or are permanent, and closures for spots
	 * that don't exist or are borrowed: after a spot is removed or changed, and at
	 * startup in case the files were edited by hand. Returns how many were dropped.
	 * Never throws: if the result can't be saved it still holds until a restart.
	 */
	reconcile(spots: readonly ParkingSpot[], now: Date): number {
		const current = this.entries(now);
		const next = fitEntries(current, spots);
		const dropped =
			current.windows.length + current.blocks.length - next.windows.length - next.blocks.length;
		if (dropped === 0) return 0;
		this.#logger.warn(
			{ event: "parking.windows_dropped", dropped },
			"dropped opening times for spots that no longer exist or changed kind",
		);
		try {
			this.replace(next, now);
		} catch {
			// Logged by replace; hold the result in memory so it still applies.
			this.#entries = next;
		}
		return dropped;
	}

	#moveAside(file: string): void {
		try {
			renameSync(file, `${file}.broken`);
			this.#logger.warn(
				{ event: "parking.windows_replaced" },
				"moved the unreadable parking windows file aside and started a new one",
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	#load(): string | undefined {
		if (!this.#file) return undefined;
		let source: string;
		try {
			source = readFileSync(this.#file, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return undefined;
			return this.#broken(`cannot read ${this.#file} (${code ?? "unknown error"})`);
		}
		let data: unknown;
		try {
			data = parse(source);
		} catch {
			return this.#broken(`${this.#file} is not valid YAML`);
		}
		const result = fileSchema.safeParse(data ?? {});
		if (!result.success) {
			const where = result.error.issues
				.slice(0, 5)
				.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
				.join("; ");
			return this.#broken(`${this.#file} is invalid: ${where}`);
		}
		const read = (list: z.infer<typeof entrySchema>[] = []): ParkingEntry[] =>
			list.map((e) => ({ ...e, from: new Date(e.from), until: new Date(e.until) }));
		this.#entries = { windows: read(result.data.windows), blocks: read(result.data.blocks) };
		return undefined;
	}

	#broken(problem: string): string {
		this.#logger.error(
			{ event: "parking.windows_unreadable" },
			`${problem}; borrowed spots are closed until an admin opens one`,
		);
		return problem;
	}
}

/**
 * The entries that still apply to `spots`: windows only for borrowed spots that exist,
 * closures only for permanent ones.
 */
export function fitEntries(entries: ParkingEntries, spots: readonly ParkingSpot[]): ParkingEntries {
	const kind = new Map(spots.map((s) => [s.name, s.permanent]));
	return {
		windows: entries.windows.filter((w) => kind.get(w.spot) === false),
		blocks: entries.blocks.filter((b) => kind.get(b.spot) === true),
	};
}

function prune(entries: ParkingEntries, now: Date): ParkingEntries {
	const live = (e: ParkingEntry) => e.until > now;
	return { windows: entries.windows.filter(live), blocks: entries.blocks.filter(live) };
}

function serialise(entries: ParkingEntries) {
	const write = (e: ParkingEntry) => ({
		spot: e.spot,
		from: e.from.toISOString(),
		until: e.until.toISOString(),
		setBy: e.setBy,
	});
	return { windows: entries.windows.map(write), blocks: entries.blocks.map(write) };
}

/**
 * Until when `spot` stays open, if it's open at `at`: the end of its window (a
 * borrowed spot) or the start of its next closure (a permanent one), and never
 * later than `reset`. Undefined when it's closed at `at`.
 */
export function openUntil(
	spot: ParkingSpot,
	entries: ParkingEntries,
	at: Date,
	reset: Date,
): Date | undefined {
	const covers = (e: ParkingEntry) => e.spot === spot.name && e.from <= at && at < e.until;
	const earliest = (dates: Date[]) =>
		new Date(Math.min(reset.getTime(), ...dates.map((d) => d.getTime())));
	if (spot.permanent) {
		if (entries.blocks.some(covers)) return undefined;
		const later = entries.blocks.filter((b) => b.spot === spot.name && b.from > at);
		return earliest(later.map((b) => b.from));
	}
	const window = entries.windows.find(covers);
	return window ? earliest([window.until]) : undefined;
}
