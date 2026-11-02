import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Logger } from "../core/logger.ts";
import { MAX_SPOTS, ParkingError, SPOT_NAME } from "./parking-spots.ts";

/**
 * Who is parked where, kept in `data/parking-bookings.yaml` and changed on every
 * `/park`, `/parking leave` and admin `free`. A booking is deleted when it ends, so
 * there's no parking history. Not safe to delete: that frees spots that have cars in
 * them.
 *
 * A person holds at most one booking and a spot has at most one. `claim` picks a
 * spot and saves the booking in one synchronous call, so two people at the gate can
 * never be given the same spot (there is one replica).
 *
 * If the file exists but is invalid, no new bookings are made (a spot could be given
 * out twice) and it's never overwritten until someone fixes it.
 */

export type ParkingBooking = {
	/** Short and typeable: six lowercase letters and digits. */
	id: string;
	spot: string;
	/** Who parked: their platform ID, and a name for humans. */
	by: { ref: string; name: string };
	since: Date;
	/** The end they asked for. An estimate: the spot's window is the exact one. */
	until: Date;
	/** When they were reminded that their time is nearly up, if they have been. */
	remindedAt: Date | null;
};

const bookingSchema = z
	.strictObject({
		id: z.string().regex(/^[a-z0-9]{6}$/),
		spot: z.string().regex(SPOT_NAME),
		by: z.strictObject({ ref: z.string().min(1).max(64), name: z.string().max(100) }),
		since: z.iso.datetime(),
		until: z.iso.datetime(),
		remindedAt: z.iso.datetime().nullable(),
	})
	.refine((b) => Date.parse(b.until) > Date.parse(b.since), { error: "until must be after since" });

const fileSchema = z.strictObject({ bookings: z.array(bookingSchema).max(MAX_SPOTS).optional() });

const HEADER =
	"# Who is parked in Pixel's parking spots. Managed with /park; NOT safe to delete.\n";

/** What `claim` did. */
export type Claim =
	| { kind: "booked"; booking: ParkingBooking }
	/** They already hold a booking: nothing new was made. */
	| { kind: "already"; booking: ParkingBooking }
	/** No spot fits. */
	| { kind: "none" };

export class ParkingBookingStore {
	readonly #file: string | undefined;
	readonly #logger: Logger;
	#bookings: ParkingBooking[] = [];
	/** Why the file can't be used, if it can't. No bookings are made or changed until it's fixed. */
	readonly problem: string | undefined;

	constructor(options: { file?: string; logger: Logger }) {
		this.#file = options.file;
		this.#logger = options.logger.child({ component: "parking" });
		this.problem = this.#load();
	}

	all(): readonly ParkingBooking[] {
		return this.#bookings;
	}

	/** The booking someone holds, by their platform ref ("discord:<id>"). */
	byPerson(ref: string): ParkingBooking | undefined {
		return this.#bookings.find((b) => b.by.ref === ref);
	}

	bySpot(spot: string): ParkingBooking | undefined {
		return this.#bookings.find((b) => b.spot === spot);
	}

	/**
	 * Books a spot for someone, in one go: `pick` gets the spots already taken and
	 * returns the spot and end to book, or undefined when none fits.
	 */
	claim(
		by: ParkingBooking["by"],
		now: Date,
		pick: (taken: ReadonlySet<string>) => { spot: string; until: Date } | undefined,
	): Claim {
		this.#writable();
		const existing = this.byPerson(by.ref);
		if (existing) return { kind: "already", booking: existing };
		const choice = pick(new Set(this.#bookings.map((b) => b.spot)));
		if (!choice) return { kind: "none" };
		if (this.bySpot(choice.spot)) throw new Error(`spot ${choice.spot} is already taken`);
		const booking: ParkingBooking = {
			id: this.#newId(),
			spot: choice.spot,
			by,
			since: now,
			until: choice.until,
			remindedAt: null,
		};
		this.#save([...this.#bookings, booking]);
		return { kind: "booked", booking };
	}

	/** Changes a booking. Undefined if it has ended meanwhile. */
	update(
		id: string,
		change: Partial<Pick<ParkingBooking, "until" | "remindedAt">>,
	): ParkingBooking | undefined {
		this.#writable();
		const current = this.#bookings.find((b) => b.id === id);
		if (!current) return undefined;
		const next = { ...current, ...change };
		this.#save(this.#bookings.map((b) => (b.id === id ? next : b)));
		return next;
	}

	/** Ends every booking that `ends` says to, and returns them. */
	end(ends: (booking: ParkingBooking) => boolean): ParkingBooking[] {
		this.#writable();
		const ended = this.#bookings.filter(ends);
		if (ended.length > 0) this.#save(this.#bookings.filter((b) => !ended.includes(b)));
		return ended;
	}

	#writable(): void {
		if (this.problem) {
			throw new ParkingError(
				"The parking bookings file is invalid, so no one can park until an admin fixes it. See the logs.",
			);
		}
	}

	#newId(): string {
		const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
		for (;;) {
			const id = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("");
			if (!this.#bookings.some((b) => b.id === id)) return id;
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
		const bookings = result.data.bookings ?? [];
		const unique = (values: string[]) => new Set(values).size === values.length;
		if (
			!unique(bookings.map((b) => b.id)) ||
			!unique(bookings.map((b) => b.spot)) ||
			!unique(bookings.map((b) => b.by.ref))
		) {
			return this.#broken(`${this.#file} repeats a booking, a spot or a person`);
		}
		this.#bookings = bookings.map((b) => ({
			...b,
			since: new Date(b.since),
			until: new Date(b.until),
			remindedAt: b.remindedAt === null ? null : new Date(b.remindedAt),
		}));
		return undefined;
	}

	#broken(problem: string): string {
		this.#logger.error(
			{ event: "parking.bookings_unreadable" },
			`${problem}; no one can park until it's fixed`,
		);
		return problem;
	}

	#save(next: ParkingBooking[]): void {
		if (this.#file) {
			try {
				mkdirSync(dirname(this.#file), { recursive: true });
				const temp = `${this.#file}.tmp`;
				const bookings = next.map((b) => ({
					...b,
					since: b.since.toISOString(),
					until: b.until.toISOString(),
					remindedAt: b.remindedAt?.toISOString() ?? null,
				}));
				writeFileSync(temp, HEADER + stringify({ bookings }));
				renameSync(temp, this.#file);
			} catch (error) {
				this.#logger.error(
					{ event: "parking.bookings_save_failed", err: error },
					"couldn't save the parking bookings",
				);
				throw new ParkingError("Couldn't save the parking bookings, so nothing was changed.");
			}
		}
		this.#bookings = next;
	}
}
