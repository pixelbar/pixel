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
import {
	type EndReason,
	endedText,
	type ParkingNotices,
	reminderText,
} from "../../services/parking-notices.ts";
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
 * A background tick (every 30 seconds, and once at startup in case Pixel was down)
 * DMs a reminder `remindMinutes` before someone's end, offering `/parking extend` if
 * the spot has more time; ends the booking `graceMinutes` after it if they haven't
 * left or extended; and ends every booking at the daily reset (23:59 by default).
 * The reminder is recorded before it's sent, so it's never sent twice.
 */

export const PARKING_CAPABILITY: CapabilityDefinition = {
	name: "parking",
	description: "Ask Pixel for a parking spot at the gate, and see who's parked",
};

/** How often the tick reminds people and ends bookings. */
export const TICK_MS = 30_000;

const ACCESS: Access = { minTier: "member", capability: PARKING_CAPABILITY.name };

export type ParkingDeps = {
	spots: Pick<ParkingSpotStore, "all" | "settings" | "problem">;
	windows: Pick<ParkingWindowStore, "entries">;
	bookings: Pick<
		ParkingBookingStore,
		"all" | "byPerson" | "bySpot" | "claim" | "update" | "end" | "problem"
	>;
	gate: Gate;
	/** DMs reminders and endings. */
	notices: Pick<ParkingNotices, "send">;
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
			const { remindMinutes } = deps.spots.settings();
			const remindAt = booking.until.getTime() - remindMinutes * 60_000;
			const lines = [head, gate];
			if (claim.kind === "booked" && remindAt > start.getTime()) {
				lines.push(
					`I'll DM you ${remindMinutes} minutes before it ends (that needs DMs from server members on).`,
				);
			}
			lines.push("Run `/parking leave` when you go.");
			return { text: lines.join("\n"), private: true };
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

	const extend: SubcommandDefinition = {
		name: "extend",
		description: "Stay longer in your spot, if it's open for longer",
		access: ACCESS,
		private: true,
		options: [{ ...forOption, description: "How much longer, e.g. 30m, 1h or rest of day" }],
		handler: async ({ args, principal, logger }) => {
			usable();
			const t = now();
			const booking = deps.bookings.byPerson(actorRef(principal));
			if (!booking) {
				return { text: "You're not parked anywhere. `/park` gets you a spot.", private: true };
			}
			const duration = parseDuration(String(args.for ?? ""));
			if (!duration) {
				throw new UserFacingError(
					"I couldn't understand how long. Try something like `30m`, `1h` or `rest of day`.",
				);
			}
			const reset = resetAfter(t);
			const spot = deps.spots.all().find((s) => s.name === booking.spot);
			const limit = (spot && openUntil(spot, deps.windows.entries(t), t, reset)) ?? t;
			// From the end they had, or from now if that has already passed.
			const base = Math.max(booking.until.getTime(), t.getTime());
			const until =
				duration.kind === "rest-of-day" ? reset : new Date(base + duration.minutes * 60_000);
			const spare = Math.floor((limit.getTime() - base) / 60_000);
			if (until > limit) {
				const why =
					limit.getTime() === reset.getTime()
						? `parking ends at ${deps.spots.settings().resetAt} every day`
						: `it closes at ${at(limit, t)}`;
				throw new UserFacingError(
					spare >= 1
						? `**${booking.spot}** can only be extended by ${formatParkingDuration({ kind: "minutes", minutes: spare })}: ${why}. Try \`/parking extend for:${formatParkingDuration({ kind: "minutes", minutes: spare })}\`.`
						: `**${booking.spot}** can't be extended: ${why}.`,
				);
			}
			const { remindMinutes } = deps.spots.settings();
			const remindAt = new Date(until.getTime() - remindMinutes * 60_000);
			// A reminder that's already due would only repeat what they just did.
			const updated = deps.bookings.update(booking.id, {
				until,
				remindedAt: remindAt > t ? null : t,
			});
			if (!updated) return { text: "You're not parked anywhere any more.", private: true };
			logger.info(
				{
					event: "parking.extended",
					spot: updated.spot,
					until: until.toISOString(),
					...actorLogFields(principal),
				},
				"extended a parking booking",
			);
			const lines = [`**${updated.spot}** is yours until ${at(until, t)} now.`];
			if (remindAt > t) lines.push(`I'll DM you ${remindMinutes} minutes before it ends.`);
			return { text: lines.join("\n"), private: true };
		},
	};

	const notifyEnded = async (ended: readonly ParkingBooking[], reason: EndReason, t: Date) => {
		const settings = deps.spots.settings();
		for (const b of ended) {
			deps.logger.info(
				{
					event: reason === "reset" ? "parking.reset" : "parking.auto_ended",
					spot: b.spot,
					user: b.by.ref,
					userName: b.by.name,
				},
				reason === "reset"
					? "ended a parking booking at the daily reset"
					: "ended a parking booking whose time was up",
			);
			await deps.notices.send(b, reason, endedText(b, reason, { now: t, zone, settings }));
		}
	};

	/**
	 * Ends bookings at the reset and after their grace period, and sends the reminders
	 * that are due. Never throws.
	 */
	let running = false;
	const tick = async () => {
		if (running || deps.bookings.problem) return;
		running = true;
		const t = now();
		try {
			const settings = deps.spots.settings();
			const grace = settings.graceMinutes * 60_000;
			const atReset = deps.bookings.end((b) => resetAfter(b.since) <= t);
			const over = deps.bookings.end((b) => t.getTime() >= b.until.getTime() + grace);
			await notifyEnded(atReset, "reset", t);
			await notifyEnded(over, "over", t);

			const reset = resetAfter(t);
			const entries = deps.windows.entries(t);
			for (const b of deps.bookings.all()) {
				const remindAt = b.until.getTime() - settings.remindMinutes * 60_000;
				// Not when the reminder time had already passed when they parked (a short stay).
				if (b.remindedAt !== null || t.getTime() < remindAt || remindAt < b.since.getTime()) {
					continue;
				}
				// Recorded first: a missed reminder is better than a repeated one.
				const reminded = deps.bookings.update(b.id, { remindedAt: t });
				if (!reminded) continue;
				const spot = deps.spots.all().find((s) => s.name === b.spot);
				const until = spot ? openUntil(spot, entries, t, reset) : undefined;
				deps.logger.info(
					{ event: "parking.reminded", spot: b.spot, user: b.by.ref, userName: b.by.name },
					"reminded someone their parking is nearly up",
				);
				await deps.notices.send(
					reminded,
					"reminder",
					reminderText(reminded, until, reset, { now: t, zone, settings }),
				);
			}
		} catch (error) {
			deps.logger.error(
				{ event: "parking.tick_failed", err: error },
				"couldn't run the parking tick",
			);
			deps.reporter.captureBackground(error, "parking");
		} finally {
			running = false;
		}
	};

	return {
		name: "parking",
		commands: [
			park,
			{
				name: "parking",
				description: "Who's parked where, staying longer, and freeing your spot",
				access: ACCESS,
				subcommands: [list, extend, leave],
			},
		],
		start: () => {
			void tick();
			const timer = setInterval(() => void tick(), TICK_MS);
			return () => clearInterval(timer);
		},
	};
}
