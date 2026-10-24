import type { ParkingBooking } from "./parking-bookings.ts";
import type { ParkingSpot } from "./parking-spots.ts";
import { openUntil, type ParkingEntries } from "./parking-windows.ts";

/**
 * Which spot someone gets, as plain functions over the spots, their opening times and
 * the bookings, so every rule can be tested without a clock or a file. Shared by
 * `/park` and `/admin parking`.
 */

/** A spot that's free now, and until when it stays open (never past the reset). */
export type FreeSpot = { spot: ParkingSpot; openUntil: Date };

/** Every spot nobody is in that's open now. */
export function freeSpots(
	spots: readonly ParkingSpot[],
	entries: ParkingEntries,
	taken: ReadonlySet<string>,
	now: Date,
	reset: Date,
): FreeSpot[] {
	return spots.flatMap((spot) => {
		if (taken.has(spot.name)) return [];
		const until = openUntil(spot, entries, now, reset);
		return until && until > now ? [{ spot, openUntil: until }] : [];
	});
}

/**
 * The spot to give someone who wants to park until `end`, or undefined when none is
 * free for that whole time. Permanent spots first (in file order), then borrowed ones
 * by tightest fit (the one closing soonest after `end`), then file order.
 */
export function pickSpot(free: readonly FreeSpot[], end: Date): FreeSpot | undefined {
	const fits = free.filter((f) => f.openUntil >= end);
	const permanent = fits.find((f) => f.spot.permanent);
	if (permanent) return permanent;
	// `sort` is stable, so equal closing times keep the file's order.
	return fits.filter((f) => !f.spot.permanent).sort(byClosing)[0];
}

/** The free spot that stays open longest: what to suggest when nothing fits. */
export function longestFree(free: readonly FreeSpot[]): FreeSpot | undefined {
	return [...free].sort(byClosing).at(-1);
}

const byClosing = (a: FreeSpot, b: FreeSpot) => a.openUntil.getTime() - b.openUntil.getTime();

/**
 * The bookings that wouldn't fit any more if the spots and opening times became
 * `spots` and `entries`: their spot is gone, or no longer open until their end.
 */
export function cutBookings(
	bookings: readonly ParkingBooking[],
	spots: readonly ParkingSpot[],
	entries: ParkingEntries,
	now: Date,
	reset: Date,
): ParkingBooking[] {
	return bookings.filter((booking) => {
		const spot = spots.find((s) => s.name === booking.spot);
		if (!spot) return true;
		const until = openUntil(spot, entries, now, reset);
		return !until || until < booking.until;
	});
}
