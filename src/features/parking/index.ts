import { type Access, actorLogFields, actorRef, type Principal } from "../../core/access.ts";
import type { CapabilityDefinition } from "../../core/capabilities.ts";
import type { CommandOption, PlainCommand, SubcommandDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown, formatDuration } from "../../core/format.ts";
import type { Logger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { Gate, GateResult } from "../../core/ports/gate.ts";
import {
	type FreeSpot,
	freeSpots,
	longestFree,
	pickSpot,
} from "../../services/parking-allocate.ts";
import type { ParkingBooking, ParkingBookingStore } from "../../services/parking-bookings.ts";
import { type ParkingSpotStore, resetClock } from "../../services/parking-spots.ts";
import {
	describeInstant,
	formatParkingDuration,
	nextReset,
	parseDuration,
} from "../../services/parking-time.ts";
import { openUntil, type ParkingWindowStore } from "../../services/parking-windows.ts";

/**
 * `/park` and `/parking`: a member with the `parking` capability asks for a spot at
 * the gate, for a while, and gets one only if it's free for that whole time. Pixel
 * saves the booking first, then asks the gate to open, then says where to park.
 * Everything is private: who is parked where is personal data.
 *
 * Every booking ends at the daily reset (23:59 by default). A background tick does
 * that every 30 seconds, and once at startup in case Pixel was down at the time.
 */

export const PARKING_CAPABILITY: CapabilityDefinition = {
	name: "parking",
	description: "Ask Pixel for a parking spot at the gate, and see who's parked",
};

/** How often the tick ends bookings that have reached the reset. */
export const TICK_MS = 30_000;

const ACCESS: Access = { minTier: "member", capability: PARKING_CAPABILITY.name };

export type ParkingDeps = {
	spots: Pick<ParkingSpotStore, "all" | "settings" | "problem">;
	windows: Pick<ParkingWindowStore, "entries">;
	bookings: Pick<ParkingBookingStore, "all" | "byPerson" | "bySpot" | "claim" | "end" | "problem">;
	gate: Gate;
	timezone: string;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground">;
	now?: () => Date;
};

/** What to say about the gate after `/park`. */
export function gateLine(result: GateResult): string {
	if (result.opened) return "The gate is opening.";
	return result.reason === "not-connected"
		? "Pixel can't open the gate yet, so open it the usual way."
		: "⚠️ The gate didn't open. Run `/park` again to try once more.";
}

/** `/park for:` with the longest stay a spot allows from `now`. */
function suggestion(openUntil: Date, now: Date): string {
	const minutes = Math.floor((openUntil.getTime() - now.getTime()) / 60_000);
	return `\`/park for:${formatParkingDuration({ kind: "minutes", minutes })}\``;
}

export function createParkingFeature(deps: ParkingDeps): Feature {
	const now = deps.now ?? (() => new Date());
	const zone = deps.timezone;
	const resetAfter = (instant: Date) => nextReset(instant, resetClock(deps.spots.settings()), zone);
	const at = (instant: Date, reference: Date) => describeInstant(instant, reference, zone);

	const usable = () => {
		if (deps.spots.problem) {
			throw new UserFacingError("Parking is off right now. Ask an admin to look at it.");
		}
	};

	const openGate = async (
		principal: Principal,
		booking: ParkingBooking,
		logger: Logger,
	): Promise<string> => {
		let result: GateResult;
		try {
			result = await deps.gate.open({ principal, spot: booking.spot });
		} catch (error) {
			// Never retried: a late opening is worse than none.
			deps.reporter.captureBackground(error, "parking");
			result = { opened: false, reason: "failed" };
		}
		logger.info(
			{
				event: result.opened ? "parking.gate_opened" : "parking.gate_failed",
				spot: booking.spot,
				...(result.opened ? {} : { reason: result.reason }),
				...actorLogFields(principal),
			},
			result.opened ? "opened the parking gate" : "the parking gate didn't open",
		);
		return gateLine(result);
	};

	const forOption: CommandOption = {
		name: "for",
		description: "How long, e.g. 30m, 2h, 2h30 or rest of day",
		type: "string",
		required: true,
		suggest: async ({ typed }) => {
			const needle = typed.trim().toLowerCase();
			return deps.spots
				.settings()
				.durations.filter((d) => d.includes(needle))
				.map((d) => ({ name: d, value: d }));
		},
	};

	const park: PlainCommand = {
		name: "park",
		description: "Get a parking spot at the gate, for as long as you need it",
		access: ACCESS,
		private: true,
		options: [forOption],
		handler: async ({ args, principal, logger }) => {
			usable();
			const duration = parseDuration(String(args.for ?? ""));
			if (!duration) {
				throw new UserFacingError(
					"I couldn't understand how long. Try something like `30m`, `2h`, `2h30` or `rest of day`.",
				);
			}
			const start = now();
			const reset = resetAfter(start);
			const end =
				duration.kind === "rest-of-day"
					? reset
					: new Date(start.getTime() + duration.minutes * 60_000);
			const ref = actorRef(principal);
			const existing = deps.bookings.byPerson(ref);
			if (!existing && end > reset) {
				throw new UserFacingError(
					`Parking ends at ${at(reset, start)} every day, so that's too long. Try \`/park for:rest of day\`.`,
				);
			}
			const entries = deps.windows.entries(start);
			let free: FreeSpot[] = [];
			const claim = deps.bookings.claim({ ref, name: principal.displayName }, start, (taken) => {
				free = freeSpots(deps.spots.all(), entries, taken, start, reset);
				const chosen = pickSpot(free, end);
				return chosen && { spot: chosen.spot.name, until: end };
			});
			if (claim.kind === "none") {
				const longest = longestFree(free);
				logger.info(
					{ event: "parking.none_free", ...actorLogFields(principal) },
					"no parking spot was free for that long",
				);
				return {
					text: longest
						? `Nothing is free for that long, so the gate stays shut. **${longest.spot.name}** is free until ${at(longest.openUntil, start)}: try ${suggestion(longest.openUntil, start)}.`
						: "Sorry, every spot is taken or closed right now, so the gate stays shut.",
					private: true,
				};
			}
			const { booking } = claim;
			const spot = deps.spots.all().find((s) => s.name === booking.spot);
			if (claim.kind === "booked") {
				logger.info(
					{
						event: "parking.booked",
						spot: booking.spot,
						until: booking.until.toISOString(),
						...actorLogFields(principal),
					},
					"booked a parking spot",
				);
			}
			const gate = await openGate(principal, booking, logger);
			const where = `**${booking.spot}**${spot?.description ? ` (${escapeMarkdown(spot.description)})` : ""}`;
			const head =
				claim.kind === "booked"
					? `Park in ${where}. It's yours until ${at(booking.until, start)}.`
					: `You're already parked in ${where}, until ${at(booking.until, start)}.`;
			return {
				text: [head, gate, "Run `/parking leave` when you go."].join("\n"),
				private: true,
			};
		},
	};

	const list: SubcommandDefinition = {
		name: "list",
		description: "Which spots are open, and who's parked in them",
		access: ACCESS,
		private: true,
		handler: async () => {
			const t = now();
			const reset = resetAfter(t);
			const entries = deps.windows.entries(t);
			const lines: string[] = [];
			if (deps.spots.problem) lines.push("⚠️ Parking is off right now.");
			if (deps.bookings.problem) lines.push("⚠️ Pixel can't read who's parked, so no one can park.");
			for (const spot of deps.spots.all()) {
				const booking = deps.bookings.bySpot(spot.name);
				const until = openUntil(spot, entries, t, reset);
				const name = `**${spot.name}**${spot.description ? ` (${escapeMarkdown(spot.description)})` : ""}`;
				if (!booking && !until) {
					const block = entries.blocks.find((b) => b.spot === spot.name && b.from <= t);
					if (block) lines.push(`${name}: closed until ${at(block.until, t)}`);
					continue;
				}
				const parts: string[] = [];
				if (booking) {
					const over = t.getTime() - booking.until.getTime();
					parts.push(
						`taken by ${escapeMarkdown(booking.by.name)} since ${at(booking.since, t)}, until about ${at(booking.until, t)}${over >= 60_000 ? ` (over by ${formatDuration(over)})` : ""}`,
					);
				} else {
					parts.push("free");
				}
				if (until) {
					parts.push(
						`open until ${at(until, t)} (${formatDuration(until.getTime() - t.getTime())} left)`,
					);
				}
				lines.push(`${name}: ${parts.join(" · ")}`);
			}
			if (deps.spots.all().length > 0 && lines.length === 0) {
				lines.push("No spot is open right now.");
			} else if (deps.spots.all().length === 0) {
				lines.push("There are no parking spots yet.");
			}
			return { text: lines.join("\n"), private: true };
		},
	};

	const leave: SubcommandDefinition = {
		name: "leave",
		description: "Free your parking spot",
		access: ACCESS,
		private: true,
		handler: async ({ principal, logger }) => {
			const ref = actorRef(principal);
			const [ended] = deps.bookings.end((b) => b.by.ref === ref);
			if (!ended) return { text: "You're not parked anywhere.", private: true };
			logger.info(
				{ event: "parking.left", spot: ended.spot, ...actorLogFields(principal) },
				"left a parking spot",
			);
			return { text: `Thanks, **${ended.spot}** is free again.`, private: true };
		},
	};

	/** Ends every booking that has reached the reset after it started. Never throws. */
	const endAtReset = () => {
		const t = now();
		if (deps.bookings.problem) return;
		try {
			const ended = deps.bookings.end((b) => resetAfter(b.since) <= t);
			for (const b of ended) {
				deps.logger.info(
					{ event: "parking.reset", spot: b.spot, user: b.by.ref, userName: b.by.name },
					"ended a parking booking at the daily reset",
				);
			}
		} catch (error) {
			deps.logger.error({ event: "parking.reset_failed", err: error }, "couldn't end bookings");
			deps.reporter.captureBackground(error, "parking");
		}
	};

	return {
		name: "parking",
		commands: [
			park,
			{
				name: "parking",
				description: "Who's parked where, and freeing your spot",
				access: ACCESS,
				subcommands: [list, leave],
			},
		],
		start: () => {
			endAtReset();
			const timer = setInterval(endAtReset, TICK_MS);
			return () => clearInterval(timer);
		},
	};
}
