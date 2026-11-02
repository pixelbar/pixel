import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { UserFacingError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import { formatTimeOfDay, parseTimeOfDay } from "../core/when.ts";
import { type Clock, formatParkingDuration, parseDuration } from "./parking-time.ts";

/**
 * Pixelbar's parking spots and the parking settings, kept in
 * `data/parking-spots.yaml` and changed with `/admin parking`. They rarely change,
 * so they live apart from the daily opening times (`parking-windows.yaml`) and the
 * bookings. Not safe to delete.
 *
 * A **permanent** spot is Pixelbar's own: open every day until the reset unless an
 * admin closes it. Every other spot is borrowed, and is only open in a window an
 * admin sets.
 *
 * Written atomically (temp file and rename). If the file exists but is invalid,
 * parking is off and nothing can be changed until it's fixed, so a bad hand edit is
 * never silently overwritten.
 */

export const MAX_SPOTS = 25;
export const MAX_DESCRIPTION = 100;
/** Discord shows at most 25 suggestions. */
export const MAX_DURATIONS = 25;
export const MAX_REMIND_MINUTES = 120;
export const MAX_GRACE_MINUTES = 60;

/** Lowercase words joined by '-', up to 32 characters, like Home Assistant device names. */
export const SPOT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export type ParkingSpot = {
	name: string;
	description?: string;
	/** Pixelbar's own: open every day until the reset, with no window needed. */
	permanent: boolean;
};

export type ParkingSettings = {
	/** How long before someone's end Pixel reminds them. */
	remindMinutes: number;
	/** How long after someone's end Pixel ends their booking, if they haven't left or extended. */
	graceMinutes: number;
	/** When every booking ends and every window has closed, "HH:MM" in `PIXEL_TIMEZONE`. */
	resetAt: string;
	/** Suggestions for how long to park, e.g. "1h" or "rest of day". */
	durations: readonly string[];
};

export const DEFAULT_SETTINGS: ParkingSettings = {
	remindMinutes: 15,
	graceMinutes: 5,
	resetAt: "23:59",
	durations: ["30m", "1h", "2h", "4h", "rest of day"],
};

const spotSchema = z.strictObject({
	name: z.string().regex(SPOT_NAME, { error: "must be lowercase words joined by '-'" }),
	description: z.string().min(1).max(MAX_DESCRIPTION).optional(),
	permanent: z.boolean().default(false),
});

const durationSchema = z.string().refine((d) => parseDuration(d) !== undefined, {
	error: "must be like 30m, 2h30 or rest of day",
});

const settingsSchema = z.strictObject({
	remindMinutes: z.number().int().min(0).max(MAX_REMIND_MINUTES).optional(),
	graceMinutes: z.number().int().min(0).max(MAX_GRACE_MINUTES).optional(),
	resetAt: z
		.string()
		.refine((t) => parseTimeOfDay(t) !== undefined, { error: "must be a time like 23:59" })
		.optional(),
	durations: z.array(durationSchema).min(1).max(MAX_DURATIONS).optional(),
});

const fileSchema = z.strictObject({
	settings: settingsSchema.optional(),
	spots: z.array(spotSchema).max(MAX_SPOTS).optional(),
});

const HEADER =
	"# Pixel's parking spots and settings. Managed with /admin parking; NOT safe to delete.\n";

export class ParkingError extends UserFacingError {
	override name = "ParkingError";
}

/** The reset as a clock. Always valid: settings are checked on load and on change. */
export function resetClock(settings: Pick<ParkingSettings, "resetAt">): Clock {
	return parseTimeOfDay(settings.resetAt) ?? (parseTimeOfDay(DEFAULT_SETTINGS.resetAt) as Clock);
}

/** The reset written the usual way ("23:59"), whichever way it was typed ("11:59pm"). */
function normaliseReset(resetAt: string): string {
	return formatTimeOfDay(resetClock({ resetAt }));
}

/** Durations written the usual way, without repeats. Undefined if one doesn't parse. */
export function normaliseDurations(typed: readonly string[]): string[] | undefined {
	const out: string[] = [];
	for (const entry of typed) {
		const duration = parseDuration(entry);
		if (!duration) return undefined;
		const text = formatParkingDuration(duration);
		if (!out.includes(text)) out.push(text);
	}
	return out;
}

export class ParkingSpotStore {
	readonly #file: string | undefined;
	readonly #logger: Logger;
	#spots: ParkingSpot[] = [];
	#settings: ParkingSettings = DEFAULT_SETTINGS;
	/** Why the file can't be used, if it can't. Parking is off and nothing changes until it's fixed. */
	readonly problem: string | undefined;

	constructor(options: { file?: string; logger: Logger }) {
		this.#file = options.file;
		this.#logger = options.logger.child({ component: "parking" });
		this.problem = this.#load();
	}

	/** Every spot, in the order they're listed (which is also the order ties are broken in). */
	all(): readonly ParkingSpot[] {
		return this.#spots;
	}

	get(name: string): ParkingSpot | undefined {
		return this.#spots.find((s) => s.name === name);
	}

	settings(): ParkingSettings {
		return this.#settings;
	}

	add(spot: ParkingSpot): ParkingSpot {
		this.#writable();
		if (!SPOT_NAME.test(spot.name)) {
			throw new ParkingError(
				"A spot's name is lowercase letters, digits and '-', starting with a letter, up to 32 characters.",
			);
		}
		if (this.get(spot.name))
			throw new ParkingError(`There's already a spot called **${spot.name}**.`);
		if (this.#spots.length >= MAX_SPOTS) {
			throw new ParkingError(`There are already ${MAX_SPOTS} spots. Remove one first.`);
		}
		checkDescription(spot.description);
		const full = withDescription(spot, spot.description);
		this.#save([...this.#spots, full], this.#settings);
		return full;
	}

	/**
	 * Changes a spot. `description: null` removes it. Undefined if there's no such spot.
	 */
	update(
		name: string,
		change: { description?: string | null; permanent?: boolean },
	): { before: ParkingSpot; after: ParkingSpot } | undefined {
		this.#writable();
		const before = this.get(name);
		if (!before) return undefined;
		if (change.description !== null) checkDescription(change.description);
		const description =
			change.description === undefined ? before.description : (change.description ?? undefined);
		const after = withDescription(
			{ name, permanent: change.permanent ?? before.permanent },
			description,
		);
		this.#save(
			this.#spots.map((s) => (s.name === name ? after : s)),
			this.#settings,
		);
		return { before, after };
	}

	/** Removes a spot. Undefined if there's no such spot. */
	remove(name: string): ParkingSpot | undefined {
		this.#writable();
		const current = this.get(name);
		if (current) {
			this.#save(
				this.#spots.filter((s) => s.name !== name),
				this.#settings,
			);
		}
		return current;
	}

	/** Changes some settings. Values must already be valid; durations are normalised. */
	setSettings(change: Partial<ParkingSettings>): ParkingSettings {
		this.#writable();
		const next = { ...this.#settings, ...change };
		const parsed = settingsSchema.required().safeParse(next);
		const durations = parsed.success ? normaliseDurations(parsed.data.durations) : undefined;
		if (!durations) throw new ParkingError("Those settings aren't valid.");
		const settings = { ...next, resetAt: normaliseReset(next.resetAt), durations };
		this.#save(this.#spots, settings);
		return settings;
	}

	#writable(): void {
		if (this.problem) {
			throw new ParkingError(
				"The parking spots file is invalid, so parking is off and nothing can be changed until an admin fixes it. See the logs.",
			);
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
		// An empty file is no spots, the defaults.
		const result = fileSchema.safeParse(data ?? {});
		if (!result.success) {
			const where = result.error.issues
				.slice(0, 5)
				.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
				.join("; ");
			return this.#broken(`${this.#file} is invalid: ${where}`);
		}
		const spots = result.data.spots ?? [];
		const names = spots.map((s) => s.name);
		if (new Set(names).size !== names.length) {
			return this.#broken(`${this.#file} repeats a spot name`);
		}
		const settings = { ...DEFAULT_SETTINGS, ...result.data.settings };
		// Checked above, so this only writes them the usual way.
		settings.durations = normaliseDurations(settings.durations) ?? DEFAULT_SETTINGS.durations;
		settings.resetAt = normaliseReset(settings.resetAt);
		this.#spots = spots.map((s) => withDescription(s, s.description));
		this.#settings = settings;
		return undefined;
	}

	#broken(problem: string): string {
		this.#logger.error({ event: "parking.spots_unreadable" }, `${problem}; parking is off`);
		return problem;
	}

	#save(spots: ParkingSpot[], settings: ParkingSettings): void {
		if (this.#file) {
			try {
				mkdirSync(dirname(this.#file), { recursive: true });
				const temp = `${this.#file}.tmp`;
				writeFileSync(temp, HEADER + stringify({ settings, spots }));
				renameSync(temp, this.#file);
			} catch (error) {
				this.#logger.error(
					{ event: "parking.spots_save_failed", err: error },
					"couldn't save the parking spots",
				);
				throw new ParkingError("Couldn't save the parking spots, so nothing was changed.");
			}
		}
		this.#spots = spots;
		this.#settings = settings;
	}
}

function checkDescription(description: string | undefined): void {
	if (
		description !== undefined &&
		(description.trim() === "" || description.length > MAX_DESCRIPTION)
	) {
		throw new ParkingError(`A description is 1–${MAX_DESCRIPTION} characters.`);
	}
}

/** The spot with `description` set, or without the key when there's none (so YAML stays tidy). */
function withDescription(
	spot: Omit<ParkingSpot, "description">,
	description: string | undefined,
): ParkingSpot {
	const base = { name: spot.name, permanent: spot.permanent };
	return description === undefined ? base : { ...base, description };
}
