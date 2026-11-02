import { type Access, actorLogFields, actorRef, type Principal } from "../../core/access.ts";
import type { CapabilityDefinition } from "../../core/capabilities.ts";
import type { CommandOption, PlainCommand } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown, formatDuration } from "../../core/format.ts";
import type { Logger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { Gate, GateResult } from "../../core/ports/gate.ts";
import type { Reply } from "../../core/reply.ts";
import type {
	ActionContext,
	ActionDefinition,
	ActionResult,
	Control,
	ControlRow,
	Form,
} from "../../core/ui.ts";
import type { ParkingActivity } from "../../services/parking-activity.ts";
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
import {
	type ParkingSpot,
	type ParkingSpotStore,
	resetClock,
} from "../../services/parking-spots.ts";
import {
	describeInstant,
	formatParkingDuration,
	nextReset,
	type ParkingDuration,
	parseDuration,
} from "../../services/parking-time.ts";
import { openUntil, type ParkingWindowStore } from "../../services/parking-windows.ts";

/**
 * `/park`: a member with the `parking` capability gets a spot at the gate, for a
 * while, but only if one is free for that whole time. Pixel saves the booking first,
 * then asks the gate to open, then says where to park. Everything is private: who is
 * parked where is personal data.
 *
 * `/park` opens a private panel (see docs/discord-components.md): when you're not
 * parked, buttons for how long, and who's in which spot; when you are, your spot with
 * Open the gate, Leave, Someone's in my spot and ways to stay longer. `/park for:`
 * books straight away, for people who know what they want. Every button runs an
 * action with the command's access, through the dispatcher.
 *
 * A background tick (every 30 seconds, and once at startup in case Pixel was down)
 * DMs a reminder `remindMinutes` before someone's end, saying how much longer they
 * could stay; ends the booking `graceMinutes` after it if they haven't left or
 * extended; and ends every booking at the daily reset (23:59 by default). The
 * reminder is recorded before it's sent, so it's never sent twice.
 */

export const PARKING_CAPABILITY: CapabilityDefinition = {
	name: "parking",
	description: "Ask Pixel for a parking spot at the gate, and see who's parked",
};

/** How often the tick reminds people and ends bookings. */
export const TICK_MS = 30_000;

const ACCESS: Access = { minTier: "member", capability: PARKING_CAPABILITY.name };

/** The actions behind `/park`'s buttons and forms. */
export const ACTIONS = {
	home: "park.home",
	book: "park.book",
	other: "park.other",
	gate: "park.gate",
	extend: "park.extend",
	leave: "park.leave",
	taken: "park.taken",
	takenConfirm: "park.taken-confirm",
} as const;

export type ParkingDeps = {
	spots: Pick<ParkingSpotStore, "all" | "settings" | "problem">;
	windows: Pick<ParkingWindowStore, "entries" | "replace">;
	bookings: Pick<
		ParkingBookingStore,
		"all" | "byPerson" | "bySpot" | "claim" | "move" | "update" | "end" | "problem"
	>;
	/** Posts every change to the parking channel and counts it in Sentry. */
	activity: Pick<ParkingActivity, "record" | "posting">;
	gate: Gate;
	/** DMs reminders and endings. */
	notices: Pick<ParkingNotices, "send">;
	timezone: string;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground">;
	now?: () => Date;
};

/** What to say about the gate after booking, or Open the gate. */
export function gateLine(result: GateResult): string {
	if (result.opened) return "The gate is opening.";
	if (result.reason === "not-connected") {
		return "Pixel can't open the gate right now, so open it the usual way.";
	}
	if (result.reason === "off") {
		return "Opening doors from Pixel is switched off right now, so open the gate the usual way.";
	}
	return "⚠️ The gate didn't open. Press **Open the gate** to try once more.";
}

/** A spot as shown: its name in bold, and where it is. */
const where = (spot: Pick<ParkingSpot, "name" | "description"> | undefined, name: string) =>
	`**${name}**${spot?.description ? ` (${escapeMarkdown(spot.description)})` : ""}`;

const minutes = (n: number): ParkingDuration => ({ kind: "minutes", minutes: n });

export function createParkingFeature(deps: ParkingDeps): Feature {
	const now = deps.now ?? (() => new Date());
	const zone = deps.timezone;
	const resetAfter = (instant: Date) => nextReset(instant, resetClock(deps.spots.settings()), zone);
	const at = (instant: Date, reference: Date) => describeInstant(instant, reference, zone);
	const spotNamed = (name: string) => deps.spots.all().find((s) => s.name === name);

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

	// ── What people do ───────────────────────────────────────────────────

	/** Books a spot for `typed` and opens the gate. The lines to show. */
	async function book(
		principal: Principal,
		logger: Logger,
		typed: string,
	): Promise<{ lines: string[] }> {
		usable();
		const duration = parseDuration(typed);
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
				`Parking ends at ${at(reset, start)} every day, so that's too long. Pick a shorter time.`,
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
			void deps.activity.record({ kind: "none-free", who: principal.displayName }, start);
			throw new UserFacingError(
				longest
					? `Nothing is free for that long, so the gate stays shut. **${longest.spot.name}** is free until ${at(longest.openUntil, start)}.`
					: "Sorry, every spot is taken or closed right now, so the gate stays shut.",
			);
		}
		const { booking } = claim;
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
			void deps.activity.record(
				{ kind: "booked", spot: booking.spot, who: principal.displayName, until: booking.until },
				start,
			);
		}
		const gate = await openGate(principal, booking, logger);
		const lines =
			claim.kind === "booked"
				? [gate]
				: ["You're already parked here, so I didn't book another spot.", gate];
		const { remindMinutes } = deps.spots.settings();
		if (
			claim.kind === "booked" &&
			booking.until.getTime() - remindMinutes * 60_000 > start.getTime()
		) {
			lines.push(
				`I'll DM you ${remindMinutes} minutes before it ends (that needs DMs from server members on).`,
			);
		}
		return { lines };
	}

	/** How much longer `booking` could stay: until when its spot is open, never past the reset. */
	function extendLimit(
		booking: ParkingBooking,
		t: Date,
	): { limit: Date; base: number; reset: Date } {
		const reset = resetAfter(t);
		const spot = spotNamed(booking.spot);
		const limit = (spot && openUntil(spot, deps.windows.entries(t), t, reset)) ?? t;
		// From the end they had, or from now if that has already passed.
		return { limit, base: Math.max(booking.until.getTime(), t.getTime()), reset };
	}

	function extend(principal: Principal, logger: Logger, typed: string): string[] {
		usable();
		const t = now();
		const booking = deps.bookings.byPerson(actorRef(principal));
		if (!booking) throw new UserFacingError("You're not parked anywhere.");
		const duration = parseDuration(typed);
		if (!duration) {
			throw new UserFacingError(
				"I couldn't understand how long. Try something like `30m`, `1h` or `rest of day`.",
			);
		}
		const { limit, base, reset } = extendLimit(booking, t);
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
					? `**${booking.spot}** can only be extended by ${formatParkingDuration(minutes(spare))}: ${why}.`
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
		if (!updated) throw new UserFacingError("You're not parked anywhere any more.");
		logger.info(
			{
				event: "parking.extended",
				spot: updated.spot,
				until: until.toISOString(),
				...actorLogFields(principal),
			},
			"extended a parking booking",
		);
		void deps.activity.record(
			{ kind: "extended", spot: updated.spot, who: principal.displayName, until },
			t,
		);
		const lines = [
			duration.kind === "rest-of-day"
				? "✅ Extended until the end of the day."
				: `✅ Extended by ${formatParkingDuration(duration)}.`,
		];
		if (remindAt > t) lines.push(`I'll DM you ${remindMinutes} minutes before it ends.`);
		return lines;
	}

	function leave(principal: Principal, logger: Logger): string {
		const ref = actorRef(principal);
		const [ended] = deps.bookings.end((b) => b.by.ref === ref);
		if (!ended) return "You're not parked anywhere.";
		logger.info(
			{ event: "parking.left", spot: ended.spot, ...actorLogFields(principal) },
			"left a parking spot",
		);
		void deps.activity.record(
			{ kind: "left", spot: ended.spot, who: principal.displayName },
			now(),
		);
		return `Thanks, **${ended.spot}** is free again.`;
	}

	/** The spot someone whose spot is taken would be moved to, if any. */
	function takenOffer(booking: ParkingBooking, t: Date) {
		const reset = resetAfter(t);
		const entries = deps.windows.entries(t);
		// For the rest of their time, and at least a minute.
		const end = new Date(Math.max(booking.until.getTime(), t.getTime() + 60_000));
		const offer = (others: ReadonlySet<string>) =>
			pickSpot(
				freeSpots(deps.spots.all(), entries, new Set([...others, booking.spot]), t, reset),
				end,
			);
		const otherSpots = new Set(
			deps.bookings
				.all()
				.filter((b) => b.id !== booking.id)
				.map((b) => b.spot),
		);
		return { offer, candidate: offer(otherSpots), reset };
	}

	/**
	 * Someone is in their spot: move them if another is free, or end their booking and
	 * report it. Either way the spot closes until the reset. Returns the lines to show
	 * and whether they still hold a booking.
	 */
	async function taken(principal: Principal, logger: Logger): Promise<string[]> {
		usable();
		const t = now();
		const ref = actorRef(principal);
		const booking = deps.bookings.byPerson(ref);
		if (!booking) throw new UserFacingError("You're not parked anywhere.");
		const { offer, candidate, reset } = takenOffer(booking, t);
		/** Closes the reported spot until the reset, so nobody else is sent there. */
		const closeReported = () => {
			const current = deps.windows.entries(t);
			try {
				deps.windows.replace(
					{
						windows: current.windows,
						blocks: [
							...current.blocks.filter((b) => !(b.spot === booking.spot && b.reason === "taken")),
							{
								spot: booking.spot,
								from: t,
								until: reset,
								setBy: { ref, name: principal.displayName },
								reason: "taken",
							},
						],
					},
					t,
				);
			} catch (error) {
				// The report still stands; an admin can close it by hand.
				deps.logger.error(
					{ event: "parking.taken_close_failed", spot: booking.spot, err: error },
					"couldn't close a spot reported taken",
				);
			}
		};
		const moved = candidate
			? deps.bookings.move(booking.id, (others) => offer(others)?.spot.name)
			: undefined;
		if (moved) {
			closeReported();
			logger.warn(
				{
					event: "parking.moved",
					from: booking.spot,
					spot: moved.spot,
					...actorLogFields(principal),
				},
				"moved someone whose parking spot was taken",
			);
			const told = await deps.activity.record(
				{
					kind: "moved",
					from: booking.spot,
					to: moved.spot,
					who: principal.displayName,
					closedUntil: reset,
				},
				t,
			);
			return [
				told
					? `I've moved you here, closed **${booking.spot}** and told the admins.`
					: `I've moved you here and closed **${booking.spot}**, but I couldn't tell the admins, so please tell the board yourself.`,
			];
		}
		// Nothing else is free (or the one offered was taken meanwhile): they have to go.
		deps.bookings.end((b) => b.id === booking.id);
		closeReported();
		logger.warn(
			{ event: "parking.taken", spot: booking.spot, ...actorLogFields(principal) },
			"someone's parking spot was taken and nothing else was free",
		);
		const reported = await deps.activity.record(
			{ kind: "taken", spot: booking.spot, who: principal.displayName, closedUntil: reset },
			t,
		);
		return [
			`Sorry: someone else is in **${booking.spot}** and no other spot is free right now, so please leave. I've ended your booking.`,
			reported
				? "I've reported it to the board."
				: "I couldn't report it to the board, so please tell them yourself.",
		];
	}

	// ── What people see ──────────────────────────────────────────────────

	/** Who's in which spot, and until when each is open. */
	function spotLines(t: Date): string[] {
		const reset = resetAfter(t);
		const entries = deps.windows.entries(t);
		const lines: string[] = [];
		if (deps.spots.problem) lines.push("⚠️ Parking is off right now.");
		if (deps.bookings.problem) lines.push("⚠️ Pixel can't read who's parked, so no one can park.");
		for (const spot of deps.spots.all()) {
			const booking = deps.bookings.bySpot(spot.name);
			const until = openUntil(spot, entries, t, reset);
			const name = where(spot, spot.name);
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
		if (deps.spots.all().length === 0) lines.push("There are no parking spots yet.");
		else if (lines.length === 0) lines.push("No spot is open right now.");
		return lines;
	}

	const button = (
		label: string,
		action: string,
		args: Record<string, string> = {},
		style: "primary" | "secondary" | "success" | "danger" = "secondary",
		disabled = false,
	): Control => ({
		kind: "button",
		label,
		style,
		call: { action, args },
		...(disabled ? { disabled } : {}),
	});

	/** Up to five buttons in a row; more become a select. */
	function choices(
		options: { label: string; value: string; enabled: boolean }[],
		action: string,
		placeholder: string,
	): ControlRow | undefined {
		const usableOptions = options.filter((o) => o.enabled);
		if (usableOptions.length === 0) return undefined;
		if (options.length <= 5) {
			return options.map((o) => button(o.label, action, { for: o.value }, "secondary", !o.enabled));
		}
		return [
			{
				kind: "select",
				placeholder,
				call: { action },
				arg: "for",
				options: usableOptions.slice(0, 25).map((o) => ({ label: o.label, value: o.value })),
			},
		];
	}

	const panel = (description: string[], t: Date, controls: ControlRow[]): Reply => ({
		embeds: [
			{ title: "🅿️ Parking", description: description.join("\n"), accent: "brand" },
			{ title: "Spots", description: spotLines(t).join("\n").slice(0, 4000), accent: "neutral" },
		],
		private: true,
		controls,
	});

	/** Not parked: how long, and who's where. */
	function homePanel(notice: string[] = []): Reply {
		const t = now();
		const reset = resetAfter(t);
		const lines = [...notice, ...(notice.length > 0 ? [""] : [])];
		if (deps.spots.problem || deps.bookings.problem) {
			lines.push("Parking is off right now. Ask an admin to look at it.");
			return panel(lines, t, [[button("Refresh", ACTIONS.home)]]);
		}
		const free = freeSpots(
			deps.spots.all(),
			deps.windows.entries(t),
			new Set(deps.bookings.all().map((b) => b.spot)),
			t,
			reset,
		);
		const longest = longestFree(free);
		const rows: ControlRow[] = [];
		if (!longest) {
			lines.push("Every spot is taken or closed right now. Try again later.");
		} else {
			lines.push(
				"How long do you need? Pixel finds a spot that's free for that whole time, opens the gate and says where to park.",
			);
			const offered = deps.spots.settings().durations.flatMap((typed) => {
				const duration = parseDuration(typed);
				if (!duration) return [];
				const end =
					duration.kind === "rest-of-day"
						? reset
						: new Date(t.getTime() + duration.minutes * 60_000);
				return [
					{
						label:
							duration.kind === "rest-of-day"
								? `Park until ${at(reset, t)}`
								: `Park for ${formatParkingDuration(duration)}`,
						value: formatParkingDuration(duration),
						enabled: end <= reset && pickSpot(free, end) !== undefined,
					},
				];
			});
			const row = choices(offered, ACTIONS.book, "How long?");
			if (row) rows.push(row);
			const extra: Control[] = [];
			// The longest stay that fits, when none of the offered times reach it.
			if (longest.openUntil < reset && !offered.some((o) => o.enabled)) {
				const most = Math.floor((longest.openUntil.getTime() - t.getTime()) / 60_000);
				if (most >= 1) {
					extra.push(
						button(
							`Park until ${at(longest.openUntil, t)}`,
							ACTIONS.book,
							{ for: formatParkingDuration(minutes(most)) },
							"primary",
						),
					);
				}
			}
			extra.push(button("Another length…", ACTIONS.other));
			rows.push(extra);
		}
		rows.push([button("Refresh", ACTIONS.home)]);
		return panel(lines, t, rows);
	}

	/** Parked: your spot, the gate, staying longer, a taken spot and leaving. */
	function minePanel(booking: ParkingBooking, notice: string[] = []): Reply {
		const t = now();
		const lines = [
			`Park in ${where(spotNamed(booking.spot), booking.spot)}. It's yours until ${at(booking.until, t)}.`,
			...notice,
			"Press **Leave** when you go.",
		];
		const { limit, base, reset } = extendLimit(booking, t);
		const spare = Math.floor((limit.getTime() - base) / 60_000);
		const rows: ControlRow[] = [
			[
				button("Open the gate", ACTIONS.gate, {}, "primary"),
				button("Leave", ACTIONS.leave),
				button("Someone's in my spot", ACTIONS.taken),
			],
		];
		if (spare >= 1) {
			const offered = deps.spots.settings().durations.flatMap((typed) => {
				const duration = parseDuration(typed);
				if (!duration || duration.kind === "rest-of-day") return [];
				return duration.minutes <= spare
					? [
							{
								label: `Stay ${formatParkingDuration(duration)} longer`,
								value: formatParkingDuration(duration),
								enabled: true,
							},
						]
					: [];
			});
			const untilLimit = {
				label: `Stay until ${at(limit, t)}`,
				value:
					limit.getTime() === reset.getTime()
						? "rest of day"
						: formatParkingDuration(minutes(spare)),
				enabled: true,
			};
			// The longest stay is always offered; the rest fit before it.
			const row = choices(
				[...offered.filter((o) => o.value !== untilLimit.value).slice(0, 4), untilLimit],
				ACTIONS.extend,
				"Stay longer…",
			);
			if (row) rows.push(row);
		} else {
			lines.push(
				limit.getTime() === reset.getTime()
					? `It can't be extended: parking ends at ${deps.spots.settings().resetAt} every day.`
					: `It can't be extended: the spot closes at ${at(limit, t)}.`,
			);
		}
		rows.push([button("Refresh", ACTIONS.home)]);
		return panel(lines, t, rows);
	}

	/** The right panel for this person now. */
	function panelFor(principal: Principal, notice: string[] = []): Reply {
		const booking = deps.bookings.byPerson(actorRef(principal));
		return booking ? minePanel(booking, notice) : homePanel(notice);
	}

	/** What Someone's in my spot will do, and a button to do it. */
	function takenPanel(principal: Principal): Reply {
		usable();
		const t = now();
		const booking = deps.bookings.byPerson(actorRef(principal));
		if (!booking) return homePanel(["You're not parked anywhere."]);
		const { candidate, reset } = takenOffer(booking, t);
		const admins = deps.activity.posting ? " and tell the admins" : "";
		const lines = candidate
			? [
					`Sorry about that. ${where(candidate.spot, candidate.spot.name)} is free for the rest of your time, until ${at(booking.until, t)}.`,
					`Move there, and I'll close **${booking.spot}** until ${at(reset, t)}${admins}.`,
				]
			: [
					`Sorry about that. No other spot is free right now, so you'll have to leave.`,
					`I'll end your booking, close **${booking.spot}** until ${at(reset, t)} and report it to the board.`,
				];
		return panel(lines, t, [
			[
				candidate
					? button(`Move to ${candidate.spot.name}`, ACTIONS.takenConfirm, {}, "primary")
					: button("End my booking and report it", ACTIONS.takenConfirm, {}, "danger"),
				button("Cancel", ACTIONS.home),
			],
		]);
	}

	const otherForm: Form = {
		title: "How long?",
		submit: { action: ACTIONS.book },
		fields: [
			{
				kind: "text",
				name: "for",
				label: "How long",
				description: "Such as 45m, 2h30 or rest of day.",
				style: "short",
				maxLength: 30,
				placeholder: "2h30",
			},
		],
	};

	// ── Commands and actions ─────────────────────────────────────────────

	const forOption: CommandOption = {
		name: "for",
		description: "How long, e.g. 30m, 2h, 2h30 or rest of day (leave out to choose)",
		type: "string",
		suggest: async ({ typed }) => {
			const needle = typed.trim().toLowerCase();
			return deps.spots
				.settings()
				.durations.filter((d) => d.includes(needle))
				.map((d) => ({ name: d, value: d }));
		},
	};
	const forArg: CommandOption = {
		name: "for",
		description: "How long",
		type: "string",
		required: true,
	};

	/** Runs `work`, showing what it says, or a problem it explains, on the panel. */
	async function onPanel(
		principal: Principal,
		work: () => Promise<string[]> | string[],
	): Promise<Reply> {
		try {
			return panelFor(principal, await work());
		} catch (error) {
			if (error instanceof UserFacingError) return panelFor(principal, [`⚠️ ${error.message}`]);
			throw error;
		}
	}

	const park: PlainCommand = {
		name: "park",
		description: "Get a parking spot at the gate, and manage yours",
		access: ACCESS,
		private: true,
		options: [forOption],
		handler: async ({ args, principal, logger }) =>
			typeof args.for === "string"
				? onPanel(principal, async () => (await book(principal, logger, args.for as string)).lines)
				: panelFor(principal),
	};

	const action = (
		name: string,
		options: readonly CommandOption[],
		handler: (ctx: ActionContext) => Promise<ActionResult> | ActionResult,
	): ActionDefinition => ({ name, access: ACCESS, options, handler: async (ctx) => handler(ctx) });

	const actions: ActionDefinition[] = [
		action(ACTIONS.home, [], (ctx) => ({ reply: panelFor(ctx.principal) })),
		action(ACTIONS.book, [forArg], async (ctx) => ({
			reply: await onPanel(
				ctx.principal,
				async () => (await book(ctx.principal, ctx.logger, String(ctx.args.for))).lines,
			),
		})),
		action(ACTIONS.other, [], () => ({ form: otherForm })),
		action(ACTIONS.gate, [], async (ctx) => {
			const booking = deps.bookings.byPerson(actorRef(ctx.principal));
			if (!booking) return { reply: homePanel(["You're not parked anywhere."]) };
			usable();
			return { reply: minePanel(booking, [await openGate(ctx.principal, booking, ctx.logger)]) };
		}),
		action(ACTIONS.extend, [forArg], async (ctx) => ({
			reply: await onPanel(ctx.principal, () =>
				extend(ctx.principal, ctx.logger, String(ctx.args.for)),
			),
		})),
		action(ACTIONS.leave, [], (ctx) => ({
			reply: homePanel([leave(ctx.principal, ctx.logger)]),
		})),
		action(ACTIONS.taken, [], (ctx) => ({ reply: takenPanel(ctx.principal) })),
		action(ACTIONS.takenConfirm, [], async (ctx) => ({
			reply: await onPanel(ctx.principal, () => taken(ctx.principal, ctx.logger)),
		})),
	];

	const notifyEnded = async (
		ended: readonly ParkingBooking[],
		reason: Exclude<EndReason, "admin">,
		t: Date,
	) => {
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
			await deps.activity.record({ kind: "ended", spot: b.spot, who: b.by.name, reason }, t);
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
				// Not when the reminder time had come by the time they parked (a short stay):
				// `/park` and `extend` only promise a reminder that's still ahead.
				if (b.remindedAt !== null || t.getTime() < remindAt || remindAt <= b.since.getTime()) {
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
		commands: [park],
		actions,
		start: () => {
			void tick();
			const timer = setInterval(() => void tick(), TICK_MS);
			return () => clearInterval(timer);
		},
	};
}
