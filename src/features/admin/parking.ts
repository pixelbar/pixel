import { actorLogFields, actorRef } from "../../core/access.ts";
import type {
	Args,
	SubcommandDefinition,
	SubgroupDefinition,
	Suggestion,
} from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import { escapeMarkdown, inlineCode } from "../../core/format.ts";
import { toInstant } from "../../core/recurrence.ts";
import { formatTimeOfDay, parseTimeOfDay, parseWhen } from "../../core/when.ts";
import {
	MAX_DURATIONS,
	MAX_GRACE_MINUTES,
	MAX_REMIND_MINUTES,
	normaliseDurations,
	type ParkingSettings,
	type ParkingSpot,
	type ParkingSpotStore,
	resetClock,
} from "../../services/parking-spots.ts";
import { describeInstant, nextReset } from "../../services/parking-time.ts";
import {
	openUntil,
	type ParkingEntries,
	type ParkingEntry,
	type ParkingWindowStore,
} from "../../services/parking-windows.ts";

/**
 * `/admin parking`: the spots, when they're open, and the parking settings. Admins
 * only, private. Spots rarely change and live in `data/parking-spots.yaml`; opening
 * times change daily and live in `data/parking-windows.yaml`.
 *
 * A **permanent** spot (Pixelbar's own) is open every day until the reset; `close`
 * shuts it for a while and `open` lifts that. A **borrowed** spot is only open in a
 * window: `open` sets one (replacing any it has that day) and `close` ends it. No
 * window or closure runs past the reset on the day it starts.
 */

export type ParkingAdminDeps = {
	spots: Pick<
		ParkingSpotStore,
		"all" | "get" | "settings" | "add" | "update" | "remove" | "setSettings" | "problem"
	>;
	windows: Pick<ParkingWindowStore, "entries" | "replace" | "reconcile" | "problem">;
	timezone: string;
	now?: () => Date;
};

const SPOTS_HELP = "One spot, or several separated by spaces";

/** Spot names for a `spot` option: the ones that contain what's typed. */
export function suggestSpot(names: readonly string[], typed: string): Suggestion[] {
	const needle = typed.trim().toLowerCase();
	return names
		.filter((n) => n.includes(needle))
		.slice(0, 25)
		.map((n) => ({ name: n, value: n }));
}

/** Completes the last name in a `spots` option, keeping the ones already typed. */
export function suggestSpots(names: readonly string[], typed: string): Suggestion[] {
	const words = typed.toLowerCase().split(/[\s,]+/);
	const last = words.pop() ?? "";
	const before = words.filter((w) => w !== "");
	const prefix = before.length > 0 ? `${before.join(" ")} ` : "";
	return names
		.filter((n) => !before.includes(n) && n.includes(last))
		.map((n) => `${prefix}${n}`)
		.filter((v) => v.length <= 100)
		.slice(0, 25)
		.map((v) => ({ name: v, value: v }));
}

/** The spots named in `typed`, in the order given. Throws if any doesn't exist. */
export function resolveSpots(
	spots: Pick<ParkingSpotStore, "get">,
	typed: string,
): readonly ParkingSpot[] {
	const names = [
		...new Set(
			typed
				.toLowerCase()
				.split(/[\s,]+/)
				.filter(Boolean),
		),
	];
	if (names.length === 0) throw new UserFacingError("Name at least one spot.");
	const found = names.map((n) => ({ name: n, spot: spots.get(n) }));
	const unknown = found.filter((f) => !f.spot).map((f) => inlineCode(f.name, 32));
	if (unknown.length > 0) {
		throw new UserFacingError(
			`There's no spot called ${unknown.join(", ")}. \`/admin parking status\` lists them.`,
		);
	}
	return found.map((f) => f.spot as ParkingSpot);
}

const bold = (names: readonly string[]) => names.map((n) => `**${n}**`).join(", ");

/** One spot for `/admin parking status`: what it is, and when it's open. */
export function describeSpot(
	spot: ParkingSpot,
	entries: ParkingEntries,
	now: Date,
	reset: Date,
	zone: string,
): string {
	const at = (d: Date) => describeInstant(d, now, zone);
	const head = `**${spot.name}** (${spot.permanent ? "permanent" : "borrowed"})${
		spot.description ? `: ${escapeMarkdown(spot.description)}` : ""
	}`;
	const mine = (list: readonly ParkingEntry[]) =>
		list.filter((e) => e.spot === spot.name).sort((a, b) => a.from.getTime() - b.from.getTime());
	const until = openUntil(spot, entries, now, reset);
	const parts: string[] = [];
	if (spot.permanent) {
		const blocks = mine(entries.blocks);
		const current = blocks.find((b) => b.from <= now);
		parts.push(current ? `closed until ${at(current.until)}` : `open until ${at(until ?? reset)}`);
		for (const b of blocks.filter((b) => b.from > now)) {
			parts.push(`closed ${at(b.from)} to ${at(b.until)}`);
		}
	} else {
		parts.push(until ? `open until ${at(until)}` : "closed");
		for (const w of mine(entries.windows).filter((w) => w.from > now)) {
			parts.push(`open ${at(w.from)} to ${at(w.until)}`);
		}
	}
	return `${head}\n  ${parts.join(" · ")}`;
}

export function describeSettings(settings: ParkingSettings): string {
	return [
		`Reminder: ${settings.remindMinutes}m before someone's end`,
		`Ended automatically: ${settings.graceMinutes}m after it`,
		`Reset: ${settings.resetAt} every day`,
		`Durations offered: ${settings.durations.join(", ")}`,
	].join("\n");
}

export function createParkingSubgroup(deps: ParkingAdminDeps): SubgroupDefinition {
	const now = deps.now ?? (() => new Date());
	const zone = deps.timezone;
	const names = () => deps.spots.all().map((s) => s.name);
	const resetAfter = (instant: Date) => nextReset(instant, resetClock(deps.spots.settings()), zone);
	/** Whether an entry belongs to the day that ends at `reset`. */
	const onDayEnding = (entry: ParkingEntry, reset: Date) =>
		resetAfter(entry.from).getTime() === reset.getTime();

	const usable = () => {
		if (deps.spots.problem) {
			throw new UserFacingError(
				"The parking spots file is invalid, so parking is off until an admin fixes it. See the logs.",
			);
		}
	};

	/** A typed time as an instant, read relative to `after`; throws if it isn't understood. */
	const timeArg = (args: Args, name: string, after: Date): Date | undefined => {
		const typed = args[name];
		if (typeof typed !== "string") return undefined;
		const local = parseWhen(typed, after, zone);
		if (!local) {
			throw new UserFacingError(
				`I couldn't understand \`${name}\`, or it's in the past. Type a time in ${zone}, for example \`17:00\`, \`5pm\` or \`tomorrow 8\`.`,
			);
		}
		return toInstant(local, zone);
	};

	const spotOption = {
		name: "spot",
		description: "The spot",
		type: "string" as const,
		required: true,
		suggest: async ({ typed }: { typed: string }) => suggestSpot(names(), typed),
	};
	const spotsOption = {
		name: "spots",
		description: SPOTS_HELP,
		type: "string" as const,
		required: true,
		suggest: async ({ typed }: { typed: string }) => suggestSpots(names(), typed),
	};

	const status: SubcommandDefinition = {
		name: "status",
		description: "The parking spots, when they're open, and the settings",
		access: { minTier: "admin" },
		private: true,
		handler: async () => {
			const at = now();
			const lines: string[] = [];
			if (deps.spots.problem) {
				lines.push(`⚠️ Parking is off: the spots file is invalid (${deps.spots.problem}).`);
			}
			if (deps.windows.problem) {
				lines.push(
					`⚠️ The opening times file couldn't be read, so borrowed spots are closed. The next \`open\` or \`close\` starts a new one (${deps.windows.problem}).`,
				);
			}
			const spots = deps.spots.all();
			if (spots.length === 0) {
				lines.push("There are no parking spots yet. Add one with `/admin parking add-spot`.");
			} else {
				const entries = deps.windows.entries(at);
				const reset = resetAfter(at);
				lines.push(...spots.map((s) => describeSpot(s, entries, at, reset, zone)));
			}
			lines.push("", describeSettings(deps.spots.settings()));
			return { text: lines.join("\n"), private: true };
		},
	};

	const addSpot: SubcommandDefinition = {
		name: "add-spot",
		description: "Add a parking spot",
		access: { minTier: "admin" },
		private: true,
		options: [
			{
				name: "name",
				description: "Lowercase words joined by '-', e.g. neighbour-1",
				type: "string",
				required: true,
			},
			{ name: "description", description: "Where it is (shown to people)", type: "string" },
			{
				name: "permanent",
				description: "Pixelbar's own spot: open every day, no window needed (default: no)",
				type: "boolean",
			},
		],
		handler: async ({ args, principal, logger }) => {
			usable();
			const spot = deps.spots.add({
				name: String(args.name ?? "").trim(),
				permanent: args.permanent === true,
				...(typeof args.description === "string" ? { description: args.description.trim() } : {}),
			});
			logger.info(
				{
					event: "parking.spot_added",
					spot: spot.name,
					permanent: spot.permanent,
					...actorLogFields(principal),
				},
				"added a parking spot",
			);
			const reset = deps.spots.settings().resetAt;
			return {
				text: spot.permanent
					? `Added **${spot.name}**, a permanent spot: it's open every day until ${reset}. \`/admin parking close\` shuts it for a while.`
					: `Added **${spot.name}**, a borrowed spot. It's closed until you open it with \`/admin parking open\`.`,
				private: true,
			};
		},
	};

	const editSpot: SubcommandDefinition = {
		name: "edit-spot",
		description: "Change a parking spot's description, or whether it's permanent",
		access: { minTier: "admin" },
		private: true,
		options: [
			spotOption,
			{ name: "description", description: "Where it is; '-' removes it", type: "string" },
			{ name: "permanent", description: "Pixelbar's own spot (open every day)", type: "boolean" },
		],
		handler: async ({ args, principal, logger }) => {
			usable();
			const [target] = resolveSpots(deps.spots, String(args.spot ?? ""));
			const description =
				typeof args.description === "string"
					? args.description.trim() === "-"
						? null
						: args.description.trim()
					: undefined;
			const permanent = typeof args.permanent === "boolean" ? args.permanent : undefined;
			if (!target || (description === undefined && permanent === undefined)) {
				throw new UserFacingError("Give a new `description`, or say whether it's `permanent`.");
			}
			const changed = deps.spots.update(target.name, {
				...(description !== undefined ? { description } : {}),
				...(permanent !== undefined ? { permanent } : {}),
			});
			if (!changed) throw new UserFacingError("That spot no longer exists.");
			const lines = [`Changed **${target.name}**.`];
			if (changed.before.permanent !== changed.after.permanent) {
				const dropped = deps.windows.reconcile(deps.spots.all(), now());
				lines.push(
					changed.after.permanent
						? "It's now permanent: open every day until the reset."
						: "It's now borrowed: closed until you open it with `/admin parking open`.",
				);
				if (dropped > 0) lines.push(`Its ${dropped} earlier opening time(s) no longer apply.`);
			}
			logger.info(
				{
					event: "parking.spot_edited",
					spot: target.name,
					permanent: changed.after.permanent,
					...actorLogFields(principal),
				},
				"changed a parking spot",
			);
			return { text: lines.join("\n"), private: true };
		},
	};

	const removeSpot: SubcommandDefinition = {
		name: "remove-spot",
		description: "Remove a parking spot, and its opening times",
		access: { minTier: "admin" },
		private: true,
		options: [spotOption],
		handler: async ({ args, principal, logger }) => {
			usable();
			const [target] = resolveSpots(deps.spots, String(args.spot ?? ""));
			const removed = target ? deps.spots.remove(target.name) : undefined;
			if (!removed) throw new UserFacingError("That spot no longer exists.");
			deps.windows.reconcile(deps.spots.all(), now());
			logger.info(
				{ event: "parking.spot_removed", spot: removed.name, ...actorLogFields(principal) },
				"removed a parking spot",
			);
			return { text: `Removed **${removed.name}**.`, private: true };
		},
	};

	const open: SubcommandDefinition = {
		name: "open",
		description: "Open borrowed spots for a while, or lift a permanent spot's closure",
		access: { minTier: "admin" },
		private: true,
		options: [
			spotsOption,
			{
				name: "from",
				description: "Borrowed spots: when it opens (default: now), e.g. 8:00 or tomorrow 8",
				type: "string",
			},
			{
				name: "until",
				description: "Borrowed spots: when it closes (default: the reset), e.g. 17:00",
				type: "string",
			},
		],
		handler: async ({ args, principal, logger }) => {
			usable();
			const at = now();
			const targets = resolveSpots(deps.spots, String(args.spots ?? ""));
			const permanent = targets.filter((s) => s.permanent).map((s) => s.name);
			const borrowed = targets.filter((s) => !s.permanent).map((s) => s.name);
			if ((args.from !== undefined || args.until !== undefined) && permanent.length > 0) {
				throw new UserFacingError(
					`\`from\` and \`until\` only apply to borrowed spots. ${bold(permanent)} ${permanent.length === 1 ? "is" : "are"} permanent, so \`open\` just lifts a closure.`,
				);
			}
			const from = timeArg(args, "from", at) ?? at;
			const cap = resetAfter(from);
			const until = timeArg(args, "until", from) ?? cap;
			if (until > cap) {
				throw new UserFacingError(
					`Opening times can't run past the reset (${describeInstant(cap, at, zone)}). Leave out \`until\` to open until then.`,
				);
			}
			const entries = deps.windows.entries(at);
			const setBy = { ref: actorRef(principal), name: principal.displayName };
			const lifted = entries.blocks.filter((b) => permanent.includes(b.spot));
			deps.windows.replace(
				{
					windows: [
						...entries.windows.filter((w) => !(borrowed.includes(w.spot) && onDayEnding(w, cap))),
						...borrowed.map((spot) => ({ spot, from, until, setBy })),
					],
					blocks: entries.blocks.filter((b) => !permanent.includes(b.spot)),
				},
				at,
			);
			logger.info(
				{
					event: "parking.opened",
					spots: targets.map((s) => s.name),
					from: from.toISOString(),
					until: until.toISOString(),
					...actorLogFields(principal),
				},
				"opened parking spots",
			);
			const lines: string[] = [];
			if (borrowed.length > 0) {
				const start = from.getTime() === at.getTime() ? "now" : describeInstant(from, at, zone);
				lines.push(
					`${bold(borrowed)} open from ${start} until ${describeInstant(until, at, zone)}.`,
				);
			}
			const liftedNames = permanent.filter((n) => lifted.some((b) => b.spot === n));
			const alreadyOpen = permanent.filter((n) => !liftedNames.includes(n));
			if (liftedNames.length > 0) lines.push(`${bold(liftedNames)} open again.`);
			if (alreadyOpen.length > 0) lines.push(`${bold(alreadyOpen)} wasn't closed.`);
			return { text: lines.join("\n"), private: true };
		},
	};

	const close: SubcommandDefinition = {
		name: "close",
		description:
			"Close spots: a borrowed spot until it's opened again, a permanent one for a while",
		access: { minTier: "admin" },
		private: true,
		options: [
			spotsOption,
			{
				name: "until",
				description: "Permanent spots: when it opens again (default: the reset), e.g. 17:00",
				type: "string",
			},
		],
		handler: async ({ args, principal, logger }) => {
			usable();
			const at = now();
			const targets = resolveSpots(deps.spots, String(args.spots ?? ""));
			const permanent = targets.filter((s) => s.permanent).map((s) => s.name);
			const borrowed = targets.filter((s) => !s.permanent).map((s) => s.name);
			if (args.until !== undefined && borrowed.length > 0) {
				throw new UserFacingError(
					`\`until\` only applies to permanent spots. ${bold(borrowed)} ${borrowed.length === 1 ? "is" : "are"} borrowed: closing ends today's opening, and \`open\` sets a new one.`,
				);
			}
			const cap = resetAfter(at);
			const until = timeArg(args, "until", at) ?? cap;
			if (until > cap) {
				throw new UserFacingError(
					`A closure can't run past the reset (${describeInstant(cap, at, zone)}). Leave out \`until\` to close until then.`,
				);
			}
			const entries = deps.windows.entries(at);
			const today = (e: ParkingEntry, names: readonly string[]) =>
				names.includes(e.spot) && onDayEnding(e, cap);
			const ended = borrowed.filter((n) =>
				entries.windows.some((w) => w.spot === n && onDayEnding(w, cap)),
			);
			const setBy = { ref: actorRef(principal), name: principal.displayName };
			deps.windows.replace(
				{
					windows: entries.windows.filter((w) => !today(w, borrowed)),
					blocks: [
						...entries.blocks.filter((b) => !today(b, permanent)),
						...permanent.map((spot) => ({ spot, from: at, until, setBy })),
					],
				},
				at,
			);
			logger.info(
				{
					event: "parking.closed",
					spots: targets.map((s) => s.name),
					until: until.toISOString(),
					...actorLogFields(principal),
				},
				"closed parking spots",
			);
			const lines: string[] = [];
			if (ended.length > 0) lines.push(`${bold(ended)} closed for today.`);
			const notOpen = borrowed.filter((n) => !ended.includes(n));
			if (notOpen.length > 0) lines.push(`${bold(notOpen)} wasn't open today.`);
			if (permanent.length > 0) {
				lines.push(`${bold(permanent)} closed until ${describeInstant(until, at, zone)}.`);
			}
			return { text: lines.join("\n"), private: true };
		},
	};

	const settings: SubcommandDefinition = {
		name: "settings",
		description: "See or change the reminder, the grace period, the reset and the durations",
		access: { minTier: "admin" },
		private: true,
		options: [
			{
				name: "remind",
				description: `Minutes before someone's end to remind them (0–${MAX_REMIND_MINUTES})`,
				type: "integer",
			},
			{
				name: "grace",
				description: `Minutes after it to end their booking (0–${MAX_GRACE_MINUTES})`,
				type: "integer",
			},
			{
				name: "reset",
				description: "When every booking ends each day, e.g. 23:59",
				type: "string",
			},
			{
				name: "durations",
				description: "Durations to offer, separated by commas, e.g. 30m, 1h, 2h30, rest of day",
				type: "string",
			},
		],
		handler: async ({ args, principal, logger }) => {
			const change: Partial<ParkingSettings> = {};
			const minutes = (name: string, max: number): number | undefined => {
				const value = args[name];
				if (value === undefined) return undefined;
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
					throw new UserFacingError(`\`${name}\` is a whole number of minutes from 0 to ${max}.`);
				}
				return value;
			};
			const remind = minutes("remind", MAX_REMIND_MINUTES);
			if (remind !== undefined) change.remindMinutes = remind;
			const grace = minutes("grace", MAX_GRACE_MINUTES);
			if (grace !== undefined) change.graceMinutes = grace;
			if (typeof args.reset === "string") {
				const clock = parseTimeOfDay(args.reset);
				if (!clock) throw new UserFacingError("`reset` is a time like `23:59` or `11:59pm`.");
				change.resetAt = formatTimeOfDay(clock);
			}
			if (typeof args.durations === "string") {
				const typed = args.durations
					.split(",")
					.map((d) => d.trim())
					.filter(Boolean);
				const durations = normaliseDurations(typed);
				if (!durations || durations.length === 0) {
					throw new UserFacingError(
						"I couldn't understand those durations. Separate them with commas, like `30m, 1h, 2h30, rest of day`.",
					);
				}
				if (durations.length > MAX_DURATIONS) {
					throw new UserFacingError(`Offer at most ${MAX_DURATIONS} durations.`);
				}
				change.durations = durations;
			}
			if (Object.keys(change).length === 0) {
				return { text: describeSettings(deps.spots.settings()), private: true };
			}
			usable();
			const next = deps.spots.setSettings(change);
			logger.info(
				{
					event: "parking.settings_changed",
					changed: Object.keys(change),
					...actorLogFields(principal),
				},
				"changed the parking settings",
			);
			return { text: `Saved.\n${describeSettings(next)}`, private: true };
		},
	};

	return {
		name: "parking",
		description: "Parking spots and when they're open (admins only)",
		access: { minTier: "admin" },
		subcommands: [status, open, close, addSpot, editSpot, removeSpot, settings],
	};
}
