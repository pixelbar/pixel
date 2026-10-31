import { splitRef } from "../core/access.ts";
import type { Logger } from "../core/logger.ts";
import type { DirectMessenger } from "../core/ports/direct-message.ts";
import type { ParkingBooking } from "./parking-bookings.ts";
import type { ParkingSettings } from "./parking-spots.ts";
import { describeInstant, formatParkingDuration } from "./parking-time.ts";

/**
 * The DMs parking sends: a reminder before someone's time is up, and a note when a
 * booking ends without them leaving. The text is Pixel's own; spot names are
 * validated names, and DMs are sent with mentions off. Sending never throws, and
 * the text is never logged.
 */

/** Why a booking ended without the person leaving. */
export type EndReason = "over" | "reset" | "admin";

type Context = {
	now: Date;
	zone: string;
	settings: Pick<ParkingSettings, "graceMinutes" | "resetAt">;
};

/** The DM sent when Pixel (or an admin) ends someone's booking. */
export function endedText(booking: ParkingBooking, reason: EndReason, context: Context): string {
	const spot = `**${booking.spot}**`;
	switch (reason) {
		case "over":
			return `I've ended your parking in ${spot}: your time was up at ${describeInstant(booking.until, context.now, context.zone)}.`;
		case "reset":
			return `I've ended your parking in ${spot}: parking ends at ${context.settings.resetAt} every day.`;
		case "admin":
			return `An admin ended your parking in ${spot}.`;
	}
}

/** The DM sent when an admin gives someone a spot (they were found parked there). */
export function assignedText(booking: ParkingBooking, context: Context): string {
	return `An admin gave you **${booking.spot}**, until ${describeInstant(booking.until, context.now, context.zone)}. Run \`/parking leave\` when you go.`;
}

/**
 * The reminder before someone's end. `openUntil` is until when their spot stays open
 * (never past the reset), which says whether they can extend.
 */
export function reminderText(
	booking: ParkingBooking,
	openUntil: Date | undefined,
	reset: Date,
	context: Context,
): string {
	const at = (d: Date) => describeInstant(d, context.now, context.zone);
	const lines = [`Your parking in **${booking.spot}** ends at ${at(booking.until)}.`];
	const spare = openUntil
		? Math.floor((openUntil.getTime() - booking.until.getTime()) / 60_000)
		: 0;
	if (openUntil && spare >= 1) {
		const example = formatParkingDuration({ kind: "minutes", minutes: Math.min(60, spare) });
		const most = formatParkingDuration({ kind: "minutes", minutes: spare });
		lines.push(
			`The spot is open until ${at(openUntil)}, so you can stay longer: \`/parking extend for:${example}\` (up to ${most}).`,
		);
	} else if (booking.until.getTime() >= reset.getTime()) {
		lines.push(`Parking ends at ${context.settings.resetAt} every day, so it can't be extended.`);
	} else {
		lines.push("The spot closes then, so it can't be extended.");
	}
	const grace = context.settings.graceMinutes;
	const endsAt = new Date(booking.until.getTime() + grace * 60_000);
	lines.push(
		grace > 0
			? `If you haven't left or extended by ${at(endsAt)}, I'll end it. Leaving? \`/parking leave\`.`
			: "If you haven't left or extended by then, I'll end it. Leaving? `/parking leave`.",
	);
	return lines.join("\n");
}

export class ParkingNotices {
	readonly #messages: Pick<DirectMessenger, "send">;
	readonly #logger: Logger;

	constructor(options: { messages: Pick<DirectMessenger, "send">; logger: Logger }) {
		this.#messages = options.messages;
		this.#logger = options.logger.child({ component: "parking" });
	}

	/** DMs the person who holds `booking`. Logs a failure (never the text); never throws. */
	async send(
		booking: ParkingBooking,
		kind: "reminder" | "assigned" | EndReason,
		text: string,
	): Promise<void> {
		const fields = { kind, spot: booking.spot, user: booking.by.ref, userName: booking.by.name };
		const { platform, userId } = splitRef(booking.by.ref);
		if (platform !== "discord") return;
		try {
			await this.#messages.send(userId, text);
			this.#logger.info({ event: "parking.dm_sent", ...fields }, "sent a parking DM");
		} catch (error) {
			this.#logger.warn(
				{
					event: "parking.dm_failed",
					...fields,
					reason: error instanceof Error ? error.message : "unknown",
				},
				"couldn't DM someone about their parking",
			);
		}
	}
}
