import type { Access } from "../../core/access.ts";
import type {
	Args,
	CommandContext,
	CommandOption,
	SubcommandDefinition,
} from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import { escapeMarkdown } from "../../core/format.ts";
import type { Reply } from "../../core/reply.ts";
import type {
	ActionContext,
	ActionDefinition,
	ActionResult,
	Control,
	ControlRow,
	Form,
} from "../../core/ui.ts";
import { normaliseSpotName, resetClock } from "../../services/parking-spots.ts";
import { describeInstant, nextReset } from "../../services/parking-time.ts";
import { openUntil } from "../../services/parking-windows.ts";
import {
	describeSpot,
	EvictNeeded,
	type ParkingAdminDeps,
	type ParkingOperation,
	parkingOperations,
	splitSpots,
} from "./parking.ts";

/**
 * `/admin` → Parking: one subcommand that opens a private panel of every spot, when it's
 * open and who's in it (see docs/discord-components.md). Menus manage one spot, or open
 * and close several at once; buttons add a spot and change the settings. A spot's panel
 * opens, closes, edits, removes, frees and gives it to someone. A change that would end
 * someone's booking asks first. Every control runs an action with the admin floor,
 * through the dispatcher; the actions run the same operations the subcommands used to.
 */

const ACCESS: Access = { minTier: "admin" };

export const PARKING_ACTIONS = {
	home: "parking-admin.home",
	spot: "parking-admin.spot",
	openPick: "parking-admin.open-pick",
	openForm: "parking-admin.open-form",
	open: "parking-admin.open",
	closePick: "parking-admin.close-pick",
	closeForm: "parking-admin.close-form",
	close: "parking-admin.close",
	editForm: "parking-admin.edit-form",
	edit: "parking-admin.edit",
	removeAsk: "parking-admin.remove-ask",
	remove: "parking-admin.remove",
	freeAsk: "parking-admin.free-ask",
	free: "parking-admin.free",
	assignForm: "parking-admin.assign-form",
	assign: "parking-admin.assign",
	assignConfirm: "parking-admin.assign-confirm",
	addForm: "parking-admin.add-form",
	add: "parking-admin.add",
	settingsForm: "parking-admin.settings-form",
	settings: "parking-admin.settings",
} as const;

export function createParkingAdmin(deps: ParkingAdminDeps): {
	subcommand: SubcommandDefinition;
	actions: ActionDefinition[];
} {
	const ops = parkingOperations(deps);
	const now = deps.now ?? (() => new Date());
	const zone = deps.timezone;
	const resetAfter = (instant: Date) => nextReset(instant, resetClock(deps.spots.settings()), zone);

	/** Runs an operation and gives back what it said, line by line. */
	async function run(op: ParkingOperation, ctx: ActionContext, args: Args): Promise<string[]> {
		const reply = await ops[op].handler({ ...ctx, args, availableCommands: [] });
		return (reply.text ?? "").split("\n");
	}

	const button = (
		label: string,
		action: string,
		args: Record<string, string | boolean> = {},
		style: "primary" | "secondary" | "success" | "danger" = "secondary",
	): Control => ({ kind: "button", label, style, call: { action, args } });

	// ── Panels ───────────────────────────────────────────────────────────

	async function overview(ctx: ActionContext, notice: string[] = []): Promise<Reply> {
		const status = await run("status", ctx, {});
		const spots = deps.spots.all();
		const rows: ControlRow[] = [];
		if (spots.length > 0) {
			const options = spots.map((s) => ({
				label: s.name,
				value: s.name,
				description: `${s.permanent ? "Permanent" : "Borrowed"}${s.description ? ` · ${s.description}` : ""}`,
			}));
			rows.push(
				[
					{
						kind: "select",
						placeholder: "Manage a spot…",
						call: { action: PARKING_ACTIONS.spot },
						arg: "spot",
						options,
					},
				],
				[
					{
						kind: "select",
						placeholder: "Open spots…",
						call: { action: PARKING_ACTIONS.openPick },
						arg: "spots",
						min: 1,
						max: options.length,
						options,
					},
				],
				[
					{
						kind: "select",
						placeholder: "Close spots…",
						call: { action: PARKING_ACTIONS.closePick },
						arg: "spots",
						min: 1,
						max: options.length,
						options,
					},
				],
			);
		}
		rows.push([
			button(
				"Add a spot",
				PARKING_ACTIONS.addForm,
				{},
				spots.length === 0 ? "primary" : "secondary",
			),
			button("Settings", PARKING_ACTIONS.settingsForm),
			button("Refresh", PARKING_ACTIONS.home),
			// Back to the rest of `/admin`.
			button("← Admin", "admin.home"),
		]);
		return {
			embeds: [
				{
					title: "🅿️ Parking spots",
					description: [...notice, ...(notice.length > 0 ? [""] : []), ...status]
						.join("\n")
						.slice(0, 4000),
					accent: "brand",
				},
			],
			private: true,
			controls: rows,
		};
	}

	async function spotPanel(
		ctx: ActionContext,
		name: string,
		notice: string[] = [],
	): Promise<Reply> {
		const spot = deps.spots.get(name);
		if (!spot) return overview(ctx, [...notice, `There's no spot called **${name}** any more.`]);
		const at = now();
		const entries = deps.windows.entries(at);
		const booking = deps.bookings.all().find((b) => b.spot === spot.name);
		const closedNow = entries.blocks.some((b) => b.spot === spot.name && b.from <= at);
		const reset = resetAfter(at);
		const open = openUntil(spot, entries, at, reset);
		const status = describeSpot(spot, entries, at, reset, zone, booking).split("\n");
		const first: Control[] = spot.permanent
			? [
					...(closedNow
						? [button("Open again", PARKING_ACTIONS.open, { spots: spot.name }, "primary")]
						: []),
					button("Close…", PARKING_ACTIONS.closePick, { spots: spot.name }),
				]
			: [
					button(
						"Open…",
						PARKING_ACTIONS.openPick,
						{ spots: spot.name },
						open ? "secondary" : "primary",
					),
					...(open || closedNow
						? [button("Close for today", PARKING_ACTIONS.close, { spots: spot.name })]
						: []),
				];
		first.push(
			button("Edit…", PARKING_ACTIONS.editForm, { spot: spot.name }),
			button("Remove…", PARKING_ACTIONS.removeAsk, { spot: spot.name }, "danger"),
		);
		const second: Control[] = [
			...(booking
				? [button("Free the spot…", PARKING_ACTIONS.freeAsk, { spot: spot.name }, "danger")]
				: []),
			button("Give it to someone…", PARKING_ACTIONS.assignForm, { spot: spot.name }),
		];
		return {
			embeds: [
				{
					title: `🅿️ ${spot.name}`,
					description: [...notice, ...(notice.length > 0 ? [""] : []), ...status].join("\n"),
					accent: "brand",
				},
			],
			private: true,
			controls: [
				first,
				second,
				[
					button("← All spots", PARKING_ACTIONS.home),
					button("Refresh", PARKING_ACTIONS.spot, { spot: spot.name }),
				],
			],
		};
	}

	/** Back to the spot it was about, or the overview for several. */
	const after = (ctx: ActionContext, spots: string, notice: string[]) => {
		const names = splitSpots(deps.spots, spots);
		return names.length === 1 && names[0]
			? spotPanel(ctx, names[0], notice)
			: overview(ctx, notice);
	};

	/** Asks before doing something that can't be undone. */
	const confirm = (title: string, lines: string[], yes: Control, cancel: Control): Reply => ({
		embeds: [{ title, description: lines.join("\n"), accent: "warning" }],
		private: true,
		controls: [[yes, cancel]],
	});

	/**
	 * Runs an operation and shows the result. A problem is shown on the panel; one that
	 * would end someone's booking asks first, and Go ahead runs it again with `evict`.
	 */
	async function change(
		ctx: ActionContext,
		again: { action: string; args: Record<string, string | boolean> },
		op: ParkingOperation,
		args: Args,
		back: () => Promise<Reply>,
		show: (lines: string[]) => Promise<Reply>,
		users?: ActionContext["users"],
		fix?: { action: string; args: Record<string, string> },
	): Promise<ActionResult> {
		try {
			return { reply: await show(await run(op, users ? { ...ctx, users } : ctx, args)) };
		} catch (error) {
			if (error instanceof EvictNeeded) {
				return {
					reply: confirm(
						"End a booking?",
						[error.message],
						button("Go ahead and end it", again.action, { ...again.args, evict: true }, "danger"),
						button("Cancel", backAction(ctx), backArgs(ctx)),
					),
				};
			}
			if (error instanceof UserFacingError) {
				// A form can't open from a form, so offer to open it again with what they typed.
				if (fix) {
					return {
						reply: confirm(
							"That didn't work",
							[`⚠️ ${error.message}`],
							button("Fix it", fix.action, fix.args, "primary"),
							button("Cancel", backAction(ctx), backArgs(ctx)),
						),
					};
				}
				return { reply: withNotice(await back(), error.message) };
			}
			throw error;
		}
	}

	/** Runs this action again, with the same arguments, for Go ahead. */
	const same = (action: string, ctx: ActionContext) => ({
		action,
		args: Object.fromEntries(
			Object.entries(ctx.args).flatMap(([k, v]) =>
				typeof v === "string" || typeof v === "boolean" ? [[k, v]] : [],
			),
		),
	});
	/** Where Cancel goes: the spot it was about, if one. */
	const backAction = (ctx: ActionContext) =>
		single(ctx) ? PARKING_ACTIONS.spot : PARKING_ACTIONS.home;
	const backArgs = (ctx: ActionContext): Record<string, string> => {
		const spot = single(ctx);
		return spot ? { spot } : {};
	};
	const single = (ctx: ActionContext): string | undefined => {
		const names = splitSpots(deps.spots, String(ctx.args.spot ?? ctx.args.spots ?? ""));
		return names.length === 1 ? names[0] : undefined;
	};
	const withNotice = (reply: Reply, problem: string): Reply => {
		const [first, ...rest] = reply.embeds ?? [];
		return first
			? {
					...reply,
					embeds: [
						{ ...first, description: `⚠️ ${problem}\n\n${first.description ?? ""}`.trim() },
						...rest,
					],
				}
			: reply;
	};

	// ── Forms ────────────────────────────────────────────────────────────

	const optionalText = (
		name: string,
		label: string,
		description: string,
		placeholder: string,
		value?: string,
		maxLength = 30,
	) => ({
		kind: "text" as const,
		name,
		label,
		description,
		style: "short" as const,
		maxLength,
		placeholder,
		required: false,
		...(value ? { value } : {}),
	});

	/** What was typed on a form that didn't work, to fill it in again. */
	type Typed = Readonly<Record<string, string | undefined>>;

	const openForm = (spots: string, typed: Typed = {}): Form => ({
		title: `Open ${splitSpots(deps.spots, spots).join(", ")}`,
		submit: { action: PARKING_ACTIONS.open, args: { spots } },
		fields: [
			optionalText(
				"from",
				"From",
				`When it opens, in ${zone}. Empty: now.`,
				"now, 8:00, tomorrow 8",
				typed.from,
			),
			optionalText(
				"until",
				"Until",
				`When it closes. Empty: the reset (${deps.spots.settings().resetAt}).`,
				"17:00, now+2h",
				typed.until,
			),
		],
	});

	const closeForm = (spots: string, typed: Typed = {}): Form => ({
		title: `Close ${splitSpots(deps.spots, spots).join(", ")}`,
		submit: { action: PARKING_ACTIONS.close, args: { spots } },
		fields: [
			optionalText(
				"until",
				"Until",
				`For permanent spots: when it opens again. Empty: the reset (${deps.spots.settings().resetAt}).`,
				"17:00, now+2h",
				typed.until,
			),
		],
	});

	const kindField = (permanent: boolean) => ({
		kind: "radio" as const,
		name: "kind",
		label: "Kind",
		options: [
			{
				label: "Borrowed",
				value: "borrowed",
				description: "Only open when an admin opens it",
				...(permanent ? {} : { selected: true }),
			},
			{
				label: "Permanent",
				value: "permanent",
				description: "Pixelbar's own: open every day until the reset",
				...(permanent ? { selected: true } : {}),
			},
		],
	});

	const addForm = (typed: Typed = {}): Form => ({
		title: "Add a spot",
		submit: { action: PARKING_ACTIONS.add },
		fields: [
			{
				kind: "text",
				name: "name",
				label: "Name",
				description: "Lowercase words joined by - or spaces, such as neighbour-1.",
				style: "short",
				maxLength: 32,
				placeholder: "neighbour-1",
				...(typed.name ? { value: typed.name } : {}),
			},
			optionalText(
				"description",
				"Where it is",
				"Shown to people who park.",
				"By the bins",
				typed.description,
				100,
			),
			kindField(typed.kind === "permanent"),
		],
	});

	const settingsForm = (typed: Typed = {}): Form => {
		const s = deps.spots.settings();
		return {
			title: "Parking settings",
			submit: { action: PARKING_ACTIONS.settings },
			fields: [
				optionalText(
					"remind",
					"Remind",
					"Minutes before someone's end to DM them (0–120).",
					"15",
					typed.remind ?? String(s.remindMinutes),
				),
				optionalText(
					"grace",
					"End after",
					"Minutes after their end to end the booking (0–60).",
					"5",
					typed.grace ?? String(s.graceMinutes),
				),
				optionalText(
					"reset",
					"Reset",
					"When every booking ends each day.",
					"23:59",
					typed.reset ?? s.resetAt,
				),
				optionalText(
					"durations",
					"Durations offered",
					"Separated by commas, such as 30m, 1h, 2h30, rest of day.",
					"30m, 1h, rest of day",
					typed.durations ?? s.durations.join(", "),
					400,
				),
			],
		};
	};

	// ── Actions ──────────────────────────────────────────────────────────

	const text = (name: string, description: string, required = false): CommandOption => ({
		name,
		description,
		type: "string",
		...(required ? { required } : {}),
	});
	const spotArg = text("spot", "The spot", true);
	const spotsArg = text("spots", "The spots", true);
	const evictArg: CommandOption = {
		name: "evict",
		description: "End bookings it cuts into",
		type: "boolean",
	};
	const action = (
		name: string,
		options: readonly CommandOption[],
		handler: (ctx: ActionContext) => Promise<ActionResult> | ActionResult,
	): ActionDefinition => ({ name, access: ACCESS, options, handler: async (ctx) => handler(ctx) });
	const str = (ctx: ActionContext, name: string) =>
		typeof ctx.args[name] === "string" ? (ctx.args[name] as string) : undefined;
	/** Form fields left empty aren't sent, so they're left out. */
	const given = (ctx: ActionContext, ...names: string[]): Args =>
		Object.fromEntries(names.flatMap((n) => (str(ctx, n) === undefined ? [] : [[n, str(ctx, n)]])));
	/** The text arguments named, for Fix it. Empty ones are left out. */
	const typedArgs = (ctx: ActionContext, ...names: string[]): Record<string, string> =>
		given(ctx, ...names) as Record<string, string>;
	/** Fix it: open `action`'s form again, filled in with what was typed. */
	const fixWith = (ctx: ActionContext, action: string, ...names: string[]) => ({
		action,
		args: typedArgs(ctx, ...names),
	});
	const typedOf = (ctx: ActionContext, ...names: string[]): Typed =>
		Object.fromEntries(names.map((n) => [n, str(ctx, n)]));

	const actions: ActionDefinition[] = [
		action(PARKING_ACTIONS.home, [], async (ctx) => ({ reply: await overview(ctx) })),
		action(PARKING_ACTIONS.spot, [spotArg], async (ctx) => ({
			reply: await spotPanel(ctx, String(ctx.args.spot)),
		})),
		action(PARKING_ACTIONS.openPick, [spotsArg], async (ctx) => {
			const spots = String(ctx.args.spots);
			const names = splitSpots(deps.spots, spots);
			// Permanent spots only lift a closure, so there's nothing to ask.
			if (names.every((n) => deps.spots.get(n)?.permanent)) {
				return change(
					ctx,
					same(PARKING_ACTIONS.open, ctx),
					"open",
					{ spots },
					() => overview(ctx),
					(lines) => after(ctx, spots, lines),
				);
			}
			return { form: openForm(spots) };
		}),
		action(
			PARKING_ACTIONS.openForm,
			[spotsArg, text("from", "From"), text("until", "Until")],
			(ctx) => ({ form: openForm(String(ctx.args.spots), typedOf(ctx, "from", "until")) }),
		),
		action(
			PARKING_ACTIONS.open,
			[spotsArg, text("from", "From"), text("until", "Until"), evictArg],
			(ctx) =>
				change(
					ctx,
					same(PARKING_ACTIONS.open, ctx),
					"open",
					{
						...given(ctx, "spots", "from", "until"),
						...(ctx.args.evict === true ? { evict: true } : {}),
					},
					() => after(ctx, String(ctx.args.spots), []),
					(lines) => after(ctx, String(ctx.args.spots), lines),
					undefined,
					fixWith(ctx, PARKING_ACTIONS.openForm, "spots", "from", "until"),
				),
		),
		action(PARKING_ACTIONS.closePick, [spotsArg], async (ctx) => {
			const spots = String(ctx.args.spots);
			const names = splitSpots(deps.spots, spots);
			// Borrowed spots close for today, so there's nothing to ask.
			if (names.some((n) => deps.spots.get(n)?.permanent)) return { form: closeForm(spots) };
			return change(
				ctx,
				same(PARKING_ACTIONS.close, ctx),
				"close",
				{ spots },
				() => overview(ctx),
				(lines) => after(ctx, spots, lines),
			);
		}),
		action(PARKING_ACTIONS.closeForm, [spotsArg, text("until", "Until")], (ctx) => ({
			form: closeForm(String(ctx.args.spots), typedOf(ctx, "until")),
		})),
		action(PARKING_ACTIONS.close, [spotsArg, text("until", "Until"), evictArg], (ctx) =>
			change(
				ctx,
				same(PARKING_ACTIONS.close, ctx),
				"close",
				{ ...given(ctx, "spots", "until"), ...(ctx.args.evict === true ? { evict: true } : {}) },
				() => after(ctx, String(ctx.args.spots), []),
				(lines) => after(ctx, String(ctx.args.spots), lines),
				undefined,
				fixWith(ctx, PARKING_ACTIONS.closeForm, "spots", "until"),
			),
		),
		action(
			PARKING_ACTIONS.editForm,
			[spotArg, text("description", "Where it is"), text("kind", "Kind")],
			async (ctx) => {
				const spot = deps.spots.get(String(ctx.args.spot));
				if (!spot)
					return {
						reply: await overview(ctx, [
							`There's no spot called **${String(ctx.args.spot)}** any more.`,
						]),
					};
				// Kind is always sent, so it's there when this is Fix it.
				const again = str(ctx, "kind") !== undefined;
				return {
					form: {
						title: `Edit ${spot.name}`,
						submit: { action: PARKING_ACTIONS.edit, args: { spot: spot.name } },
						fields: [
							optionalText(
								"description",
								"Where it is",
								"Shown to people who park. Empty removes it.",
								"By the bins",
								again ? str(ctx, "description") : spot.description,
								100,
							),
							kindField(again ? ctx.args.kind === "permanent" : spot.permanent),
						],
					},
				};
			},
		),
		action(
			PARKING_ACTIONS.edit,
			[spotArg, text("description", "Where it is"), text("kind", "Kind", true), evictArg],
			(ctx) =>
				change(
					ctx,
					same(PARKING_ACTIONS.edit, ctx),
					"edit-spot",
					{
						spot: String(ctx.args.spot),
						// An empty description removes it.
						description: str(ctx, "description")?.trim() || "-",
						permanent: ctx.args.kind === "permanent",
						...(ctx.args.evict === true ? { evict: true } : {}),
					},
					() => spotPanel(ctx, String(ctx.args.spot)),
					(lines) => spotPanel(ctx, String(ctx.args.spot), lines),
					undefined,
					fixWith(ctx, PARKING_ACTIONS.editForm, "spot", "description", "kind"),
				),
		),
		action(PARKING_ACTIONS.removeAsk, [spotArg], async (ctx) => {
			const name = String(ctx.args.spot);
			const booking = deps.bookings.all().find((b) => b.spot === name);
			const at = now();
			return {
				reply: confirm(
					`Remove ${name}?`,
					[
						"Its opening times go too. This can't be undone.",
						...(booking
							? [
									`${escapeMarkdown(booking.by.name)} is parked there until about ${describeInstant(booking.until, at, zone)}: their booking ends.`,
								]
							: []),
					],
					button(
						`Remove ${name}`,
						PARKING_ACTIONS.remove,
						{ spot: name, ...(booking ? { evict: true } : {}) },
						"danger",
					),
					button("Cancel", PARKING_ACTIONS.spot, { spot: name }),
				),
			};
		}),
		action(PARKING_ACTIONS.remove, [spotArg, evictArg], (ctx) =>
			change(
				ctx,
				same(PARKING_ACTIONS.remove, ctx),
				"remove-spot",
				{ spot: String(ctx.args.spot), ...(ctx.args.evict === true ? { evict: true } : {}) },
				() => spotPanel(ctx, String(ctx.args.spot)),
				(lines) => overview(ctx, lines),
			),
		),
		action(PARKING_ACTIONS.freeAsk, [spotArg], async (ctx) => {
			const name = String(ctx.args.spot);
			const booking = deps.bookings.all().find((b) => b.spot === name);
			if (!booking)
				return { reply: await spotPanel(ctx, name, [`Nobody is parked in **${name}**.`]) };
			return {
				reply: confirm(
					`Free ${name}?`,
					[
						`This ends ${escapeMarkdown(booking.by.name)}'s booking, until about ${describeInstant(booking.until, now(), zone)}. Pixel DMs them that an admin ended it.`,
					],
					button("End the booking", PARKING_ACTIONS.free, { spot: name }, "danger"),
					button("Cancel", PARKING_ACTIONS.spot, { spot: name }),
				),
			};
		}),
		action(PARKING_ACTIONS.free, [spotArg], (ctx) =>
			change(
				ctx,
				same(PARKING_ACTIONS.free, ctx),
				"free",
				{ spot: String(ctx.args.spot) },
				() => spotPanel(ctx, String(ctx.args.spot)),
				(lines) => spotPanel(ctx, String(ctx.args.spot), lines),
			),
		),
		action(
			PARKING_ACTIONS.assignForm,
			// Fix it fills the form in again: the person picked (by ID) and how long.
			[spotArg, text("user-id", "Who"), text("for", "How long")],
			(ctx) => ({
				form: {
					title: `Give ${String(ctx.args.spot)} to someone`,
					submit: { action: PARKING_ACTIONS.assign, args: { spot: String(ctx.args.spot) } },
					fields: [
						{
							kind: "user",
							name: "user",
							label: "Who is parked there",
							description: "They get a DM. Their booking elsewhere, if any, ends.",
							...(str(ctx, "user-id") ? { value: str(ctx, "user-id") as string } : {}),
						},
						optionalText(
							"for",
							"How long",
							"Such as 2h or rest of day. Empty: until the spot closes.",
							"2h",
							str(ctx, "for"),
						),
					],
				},
			}),
		),
		action(
			PARKING_ACTIONS.assign,
			[
				spotArg,
				{ name: "user", description: "Who is parked there", type: "user", required: true },
				text("for", "How long"),
				evictArg,
			],
			(ctx) =>
				change(
					ctx,
					{
						action: PARKING_ACTIONS.assignConfirm,
						args: {
							spot: String(ctx.args.spot),
							"user-id": String(ctx.args.user),
							"user-name": ctx.users.user?.displayName ?? String(ctx.args.user),
							...(str(ctx, "for") ? { for: str(ctx, "for") as string } : {}),
						},
					},
					"assign",
					{
						...given(ctx, "spot", "user", "for"),
						...(ctx.args.evict === true ? { evict: true } : {}),
					},
					() => spotPanel(ctx, String(ctx.args.spot)),
					(lines) => spotPanel(ctx, String(ctx.args.spot), lines),
					undefined,
					{
						action: PARKING_ACTIONS.assignForm,
						args: { ...typedArgs(ctx, "spot", "for"), "user-id": String(ctx.args.user) },
					},
				),
		),
		// Go ahead after Give it to someone… would end another booking. A button can't carry
		// a picked person, so the one picked on the form is held here, by ID.
		action(
			PARKING_ACTIONS.assignConfirm,
			[
				spotArg,
				text("user-id", "Who", true),
				text("user-name", "Their name", true),
				text("for", "How long"),
				evictArg,
			],
			(ctx) =>
				change(
					ctx,
					same(PARKING_ACTIONS.assignConfirm, ctx),
					"assign",
					{
						...given(ctx, "spot", "for"),
						user: String(ctx.args["user-id"]),
						...(ctx.args.evict === true ? { evict: true } : {}),
					},
					() => spotPanel(ctx, String(ctx.args.spot)),
					(lines) => spotPanel(ctx, String(ctx.args.spot), lines),
					{
						user: {
							id: String(ctx.args["user-id"]),
							displayName: String(ctx.args["user-name"]),
							isBot: false,
						},
					},
					fixWith(ctx, PARKING_ACTIONS.assignForm, "spot", "user-id", "for"),
				),
		),
		action(
			PARKING_ACTIONS.addForm,
			[text("name", "Name"), text("description", "Where it is"), text("kind", "Kind")],
			(ctx) => ({ form: addForm(typedOf(ctx, "name", "description", "kind")) }),
		),
		action(
			PARKING_ACTIONS.add,
			[text("name", "Name", true), text("description", "Where it is"), text("kind", "Kind", true)],
			(ctx) =>
				change(
					ctx,
					same(PARKING_ACTIONS.add, ctx),
					"add-spot",
					{
						...given(ctx, "name", "description"),
						permanent: ctx.args.kind === "permanent",
					},
					() => overview(ctx),
					(lines) => spotPanel(ctx, normaliseSpotName(String(ctx.args.name)), lines),
					undefined,
					fixWith(ctx, PARKING_ACTIONS.addForm, "name", "description", "kind"),
				),
		),
		action(
			PARKING_ACTIONS.settingsForm,
			[
				text("remind", "Remind"),
				text("grace", "End after"),
				text("reset", "Reset"),
				text("durations", "Durations"),
			],
			(ctx) => ({ form: settingsForm(typedOf(ctx, "remind", "grace", "reset", "durations")) }),
		),
		action(
			PARKING_ACTIONS.settings,
			[
				text("remind", "Remind"),
				text("grace", "End after"),
				text("reset", "Reset"),
				text("durations", "Durations"),
			],
			(ctx) => {
				const number = (name: string) => {
					const typed = str(ctx, name)?.trim();
					return typed === undefined || typed === "" ? {} : { [name]: Number(typed) };
				};
				return change(
					ctx,
					same(PARKING_ACTIONS.settings, ctx),
					"settings",
					{ ...number("remind"), ...number("grace"), ...given(ctx, "reset", "durations") },
					() => overview(ctx),
					(lines) => overview(ctx, lines),
					undefined,
					fixWith(ctx, PARKING_ACTIONS.settingsForm, "remind", "grace", "reset", "durations"),
				);
			},
		),
	];

	const subcommand: SubcommandDefinition = {
		name: "parking",
		description: "Parking spots, when they're open, who's in them, and the settings",
		access: ACCESS,
		private: true,
		handler: async (ctx: CommandContext) => overview(ctx),
	};

	return { subcommand, actions };
}
