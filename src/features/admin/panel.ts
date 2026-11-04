import { TIER_LABELS, type Tier } from "../../core/access.ts";
import { SPACE_ANNOUNCE_STYLES } from "../../core/announcement.ts";
import type { AnnouncementRoutes } from "../../core/announcement-routes.ts";
import { type CapabilityRegistry, heldCapabilities } from "../../core/capabilities.ts";
import type {
	Args,
	CommandContext,
	CommandOption,
	PlainCommand,
	ResolvedUser,
	SubcommandDefinition,
} from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import { escapeMarkdown } from "../../core/format.ts";
import type { AccessStore, GrantTier, MemberTier } from "../../core/ports/access-store.ts";
import { MAX_REASON_LENGTH } from "../../core/ports/access-store.ts";
import type { Embed, Reply } from "../../core/reply.ts";
import type { RoleMirror } from "../../core/role-mirror.ts";
import type {
	ActionContext,
	ActionDefinition,
	ActionResult,
	ChoiceOption,
	Control,
	ControlRow,
	Form,
	FormInput,
} from "../../core/ui.ts";
import { MAX_CLOSING_TIME_MESSAGE, savedClosingTimeMessage } from "../closing-time/index.ts";
import { describeDoors } from "./doors.ts";
import { describeStates } from "./roles.ts";

/**
 * `/admin`: one command that opens a private panel (see docs/discord-components.md).
 * The home panel is Pixel's status, with a menu of sections: people, capabilities,
 * Discord roles, announcements, closing time, doors, OpenR and parking. Each section
 * shows what's set and has buttons, menus and forms to change it.
 *
 * Every change is an action with the admin floor, through the dispatcher, and runs
 * the same operation the subcommand it replaces ran (`operations`, which are not
 * commands). The operation's own reply goes above the refreshed panel; a problem it
 * throws is a private reply that leaves the panel alone. A person is picked on a form
 * (immutable ID, bots refused where they were); after that, their panel holds their ID
 * and name for its buttons, the way a held control always does.
 */

const ACCESS = { minTier: "admin" } as const;

export const ADMIN_ACTIONS = {
	home: "admin.home",
	reload: "admin.reload",
	section: "admin.section",
	lookupForm: "admin.lookup-form",
	person: "admin.person",
	personAgain: "admin.person-again",
	levelForm: "admin.level-form",
	levelSet: "admin.level-set",
	grantAsk: "admin.grant-ask",
	grant: "admin.grant",
	revokeAsk: "admin.revoke-ask",
	revoke: "admin.revoke",
	grantAllForm: "admin.grant-all-form",
	grantAll: "admin.grant-all",
	syncPerson: "admin.sync-person",
	syncAll: "admin.sync-all",
	levelCapabilities: "admin.level-capabilities",
	levelGrantAsk: "admin.level-grant-ask",
	levelGrant: "admin.level-grant",
	levelRevokeAsk: "admin.level-revoke-ask",
	levelRevoke: "admin.level-revoke",
	personCapabilities: "admin.person-capabilities",
	announceForm: "admin.announce-form",
	announceSet: "admin.announce-set",
	announceRemove: "admin.announce-remove",
	closingTimeForm: "admin.closing-time-form",
	closingTimeSet: "admin.closing-time-set",
	doorsAsk: "admin.doors-ask",
	doors: "admin.doors",
	openrLogin: "admin.openr-login",
	openrCodeForm: "admin.openr-code-form",
	openrCode: "admin.openr-code",
	openrLogoutAsk: "admin.openr-logout-ask",
	openrLogout: "admin.openr-logout",
} as const;

export const SECTIONS = [
	{ value: "people", label: "People", description: "Levels, capabilities and roles of one person" },
	{
		value: "capabilities",
		label: "Capabilities",
		description: "Who holds what, and what a level gets",
	},
	{ value: "roles", label: "Discord roles", description: "Syncing Pixel's levels to Discord" },
	{ value: "announcements", label: "Announcements", description: "Where open/closed goes" },
	{ value: "closing-time", label: "Closing time", description: "The reminder posted at closing" },
	{ value: "doors", label: "Doors", description: "Door control from Pixel, on or off" },
	{ value: "openr", label: "OpenR", description: "Pixel's OpenR login and the doors" },
	{ value: "parking", label: "Parking", description: "Spots, opening times and settings" },
] as const;
type Section = (typeof SECTIONS)[number]["value"];

/** The subcommands this panel replaces, run as plain operations. */
export type AdminOperations = {
	status: SubcommandDefinition;
	reload: SubcommandDefinition;
	level: { set: SubcommandDefinition; get: SubcommandDefinition };
	sync: SubcommandDefinition;
	capabilities: Record<
		"grant" | "grant-all" | "revoke" | "grant-level" | "revoke-level" | "list",
		SubcommandDefinition
	>;
	announcements: Record<"set" | "remove" | "list", SubcommandDefinition>;
	closingTime: SubcommandDefinition;
	doors: Record<"on" | "off", SubcommandDefinition>;
	openr: Record<"status" | "login" | "code" | "logout", SubcommandDefinition>;
};

export type AdminPanelDeps = {
	operations: AdminOperations;
	access: Pick<AccessStore, "view">;
	capabilities: Pick<CapabilityRegistry, "all" | "has">;
	roles: Pick<RoleMirror, "states">;
	routes: Pick<AnnouncementRoutes, "list">;
	closingTimeFile: string;
	switches: Parameters<typeof describeDoors>[0];
	/** Whether OpenR is configured here. */
	openr: boolean;
	/** The parking panel's overview (its own actions handle the rest). */
	parking: SubcommandDefinition;
};

const LEVELS: readonly MemberTier[] = ["member", "friend", "guest"];
const GRANT_LEVELS: readonly GrantTier[] = ["friend", "member"];

export function createAdminPanel(deps: AdminPanelDeps): {
	command: PlainCommand;
	actions: ActionDefinition[];
} {
	const ops = deps.operations;

	/** Runs an operation the way its subcommand ran. Problems are thrown. */
	const run = (op: SubcommandDefinition, ctx: ActionContext, args: Args, users = ctx.users) =>
		op.handler({ ...ctx, args, users, channels: ctx.channels, availableCommands: [] });

	const button = (
		label: string,
		action: string,
		args: Record<string, string | boolean> = {},
		style: "primary" | "secondary" | "success" | "danger" = "secondary",
	): Control => ({ kind: "button", label, style, call: { action, args } });
	const back = (label: string, action: string, args: Record<string, string> = {}) =>
		button(label, action, args);

	/** Puts what an operation said above a panel. */
	const above = (said: Reply, panel: Reply): Reply => ({
		...panel,
		...(said.text ? { text: said.text } : {}),
		embeds: [...(said.embeds ?? []), ...(panel.embeds ?? [])].slice(0, 10),
	});

	const panel = (
		title: string,
		lines: string[],
		rows: ControlRow[],
		more: Embed[] = [],
	): Reply => ({
		embeds: [{ title, description: lines.join("\n").slice(0, 4000), accent: "brand" }, ...more],
		private: true,
		controls: rows,
	});

	// ── People ───────────────────────────────────────────────────────────

	/** Who a panel is about, held for its buttons. Picked by ID on a form first. */
	const personArgs = (user: ResolvedUser): Record<string, string> => ({
		"user-id": user.id,
		"user-name": user.displayName,
		...(user.handle ? { "user-handle": user.handle } : {}),
	});
	const heldPerson = (ctx: ActionContext): ResolvedUser => ({
		id: String(ctx.args["user-id"]),
		displayName: String(ctx.args["user-name"]),
		...(typeof ctx.args["user-handle"] === "string" ? { handle: ctx.args["user-handle"] } : {}),
		isBot: false,
	});
	const personOptions: CommandOption[] = [
		{ name: "user-id", description: "Who", type: "string", required: true },
		{ name: "user-name", description: "Their name", type: "string", required: true },
		{ name: "user-handle", description: "Their handle", type: "string" },
	];

	async function personPanel(ctx: ActionContext, user: ResolvedUser): Promise<Reply> {
		const looked = await run(ops.level.get, ctx, { user: user.id }, { user });
		const view = deps.access.view;
		const tier: Tier = view.discord.get(user.id) ?? "guest";
		// What they actually hold, their level's grants included and revocations taken off, so
		// the revoke menu offers a level grant (revoked for them alone) and the grant menu lifts one.
		const record = view.records.get(user.id);
		const held = record ? heldCapabilities(record, view.tierCapabilities) : [];
		const rows: ControlRow[] = [];
		if (!user.isBot) {
			const who = personArgs(user);
			rows.push([
				...(tier === "admin"
					? []
					: [button("Change level…", ADMIN_ACTIONS.levelForm, who, "primary")]),
				...(tier === "guest"
					? []
					: [button("Grant every capability…", ADMIN_ACTIONS.grantAllForm, who)]),
				button("Sync their Discord roles", ADMIN_ACTIONS.syncPerson, who),
				button("Capabilities in detail", ADMIN_ACTIONS.personCapabilities, who),
			]);
			const all = deps.capabilities.all();
			const toGrant = all.filter((c) => !held.includes(c.name));
			const toRevoke = held.filter((name) => deps.capabilities.has(name));
			if (tier !== "guest" && toGrant.length > 0) {
				rows.push([capabilitySelect("Grant capabilities…", ADMIN_ACTIONS.grantAsk, who, toGrant)]);
			}
			if (toRevoke.length > 0) {
				rows.push([
					capabilitySelect(
						"Revoke capabilities…",
						ADMIN_ACTIONS.revokeAsk,
						who,
						all.filter((c) => toRevoke.includes(c.name)),
					),
				]);
			}
		}
		rows.push([
			back("← People", ADMIN_ACTIONS.section, { section: "people" }),
			...(user.isBot ? [] : [button("Refresh", ADMIN_ACTIONS.personAgain, personArgs(user))]),
		]);
		return { embeds: looked.embeds ?? [], private: true, controls: rows };
	}

	const capabilitySelect = (
		placeholder: string,
		action: string,
		args: Record<string, string>,
		options: readonly { name: string; description: string }[],
	): Control => ({
		kind: "select",
		placeholder,
		call: { action, args },
		arg: "capability",
		min: 1,
		max: Math.min(options.length, 25),
		options: options.slice(0, 25).map(
			(c): ChoiceOption => ({
				label: c.name,
				value: c.name,
				description: c.description.slice(0, 100),
			}),
		),
	});

	const reasonField = (): FormInput => ({
		kind: "text",
		name: "reason",
		label: "Reason (optional)",
		description: `Why, for the audit log. At most ${MAX_REASON_LENGTH} characters.`,
		style: "short",
		maxLength: MAX_REASON_LENGTH,
		required: false,
	});

	/** Runs a capability operation for each one picked, and shows what each said. */
	async function eachCapability(
		ctx: ActionContext,
		op: SubcommandDefinition,
		base: Args,
		users: ActionContext["users"],
	): Promise<Reply> {
		const names = String(ctx.args.capability)
			.split(/[\s,]+/)
			.filter(Boolean);
		const replies: Reply[] = [];
		for (const capability of names)
			replies.push(await run(op, ctx, { ...base, capability }, users));
		const text = replies.flatMap((r) => (r.text ? [r.text] : [])).join("\n");
		return {
			...(text ? { text } : {}),
			embeds: replies.flatMap((r) => r.embeds ?? []),
		};
	}
	const reasonArg = (ctx: ActionContext): Args =>
		typeof ctx.args.reason === "string" && ctx.args.reason.trim() !== ""
			? { reason: ctx.args.reason }
			: {};

	// ── Sections ─────────────────────────────────────────────────────────

	async function home(ctx: ActionContext): Promise<Reply> {
		const status = await run(ops.status, ctx, {});
		return {
			embeds: status.embeds ?? [],
			private: true,
			controls: [
				[
					{
						kind: "select",
						placeholder: "Go to…",
						call: { action: ADMIN_ACTIONS.section },
						arg: "section",
						options: SECTIONS.filter((s) => s.value !== "openr" || deps.openr).map((s) => ({
							label: s.label,
							value: s.value,
							description: s.description,
						})),
					},
				],
				[
					button("Reload the access lists", ADMIN_ACTIONS.reload),
					button("Refresh", ADMIN_ACTIONS.home),
				],
			],
		};
	}

	const toAdmin = () => back("← Admin", ADMIN_ACTIONS.home);

	async function section(ctx: ActionContext, which: Section): Promise<Reply> {
		switch (which) {
			case "people":
				return panel(
					"People",
					[
						"Look someone up to see their level, where it comes from, their capabilities and their Discord roles, and to change them.",
						"Admins are managed in admins.yaml only.",
					],
					[[button("Look someone up…", ADMIN_ACTIONS.lookupForm, {}, "primary")], [toAdmin()]],
				);
			case "capabilities": {
				const list = await run(ops.capabilities.list, ctx, {});
				return {
					...(list.text ? { text: list.text } : {}),
					embeds: list.embeds ?? [],
					private: true,
					controls: [
						GRANT_LEVELS.map((level) =>
							button(
								`What ${level === "friend" ? "friends" : "members"} get`,
								ADMIN_ACTIONS.levelCapabilities,
								{ level },
							),
						),
						[toAdmin()],
					],
				};
			}
			case "roles":
				return panel(
					"Discord roles",
					[
						describeStates(await deps.roles.states()),
						"",
						"Sync everyone sets Discord roles to match Pixel's lists for everyone in them. People who hold a role but aren't listed aren't touched.",
					],
					[[button("Sync everyone", ADMIN_ACTIONS.syncAll, {}, "primary")], [toAdmin()]],
				);
			case "announcements": {
				const routes = deps.routes.list();
				const list = await run(ops.announcements.list, ctx, {});
				return panel(
					"Announcements",
					[list.text ?? ""],
					[
						[button("Add a channel…", ADMIN_ACTIONS.announceForm, {}, "primary")],
						...(routes.length > 0
							? [
									[
										{
											kind: "select" as const,
											placeholder: "Stop announcing in…",
											call: { action: ADMIN_ACTIONS.announceRemove },
											arg: "channel-id",
											options: routes.slice(0, 25).map((r) => ({
												label: `Channel ${r.channelId}`,
												value: r.channelId,
												description: `${r.style}${r.problem ? ": not posting" : ""}`,
											})),
										},
									],
								]
							: []),
						[toAdmin()],
					],
				);
			}
			case "closing-time": {
				const saved = savedClosingTimeMessage(deps.closingTimeFile);
				return panel(
					"Closing time",
					saved === undefined
						? ["No message is set, so Pixel posts its own."]
						: ["Pixel posts this when the space closes:", "", saved],
					[
						[button("Change the message…", ADMIN_ACTIONS.closingTimeForm, {}, "primary")],
						[toAdmin()],
					],
				);
			}
			case "doors": {
				const on = deps.switches.isOn("door");
				return panel(
					"Doors",
					[
						describeDoors(deps.switches),
						"",
						"Off stops every door action from Pixel at once, for everyone: Home Assistant's doors, OpenR's doors and the parking gate.",
					],
					[
						[
							on
								? button("Switch door control off…", ADMIN_ACTIONS.doorsAsk, {}, "danger")
								: button("Switch door control on", ADMIN_ACTIONS.doors, { on: true }, "primary"),
						],
						[toAdmin()],
					],
				);
			}
			case "openr": {
				const status = await run(ops.openr.status, ctx, {});
				return panel(
					"OpenR",
					[status.text ?? ""],
					[
						...(deps.openr
							? [
									[
										button("Log in", ADMIN_ACTIONS.openrLogin, {}, "primary"),
										button("Enter the code…", ADMIN_ACTIONS.openrCodeForm),
										button("Log out…", ADMIN_ACTIONS.openrLogoutAsk, {}, "danger"),
									],
								]
							: []),
						[toAdmin(), button("Refresh", ADMIN_ACTIONS.section, { section: "openr" })],
					],
				);
			}
			default:
				// Parking has a panel of its own, with its own actions; the menu opens it.
				return run(deps.parking, ctx, {});
		}
	}

	function levelCapabilities(level: GrantTier): Reply {
		const view = deps.access.view;
		const granted = view.tierCapabilities[level];
		const all = deps.capabilities.all();
		const reach = level === "friend" ? "every friend and member" : "every member";
		const rows: ControlRow[] = [];
		const toGrant = all.filter((c) => !granted.includes(c.name));
		const toRevoke = all.filter((c) => granted.includes(c.name));
		if (toGrant.length > 0) {
			rows.push([
				capabilitySelect(`Grant to ${reach}…`, ADMIN_ACTIONS.levelGrantAsk, { level }, toGrant),
			]);
		}
		if (toRevoke.length > 0) {
			rows.push([
				capabilitySelect(
					`Revoke from ${reach}…`,
					ADMIN_ACTIONS.levelRevokeAsk,
					{ level },
					toRevoke,
				),
			]);
		}
		rows.push([back("← Capabilities", ADMIN_ACTIONS.section, { section: "capabilities" })]);
		return panel(
			`What ${level === "friend" ? "friends" : "members"} get`,
			[
				granted.length === 0
					? `No capabilities are granted to the ${level} level.`
					: `Granted to ${reach}: ${granted.map((n) => `**${escapeMarkdown(n)}**`).join(", ")}.`,
				...(level === "member" && view.tierCapabilities.friend.length > 0
					? [
							`Members also get what friends get: ${view.tierCapabilities.friend.map((n) => `**${escapeMarkdown(n)}**`).join(", ")}.`,
						]
					: []),
			],
			rows,
		);
	}

	// ── Forms ────────────────────────────────────────────────────────────

	const lookupForm: Form = {
		title: "Look someone up",
		submit: { action: ADMIN_ACTIONS.person },
		fields: [
			{ kind: "user", name: "user", label: "Who", description: "Pick them from the server." },
		],
	};

	const levelForm = (user: ResolvedUser): Form => {
		const current = deps.access.view.records.get(user.id)?.tier ?? "guest";
		return {
			title: `Change ${user.displayName}'s level`.slice(0, 45),
			submit: { action: ADMIN_ACTIONS.levelSet, args: personArgs(user) },
			fields: [
				{
					kind: "radio",
					name: "level",
					label: "Level",
					options: LEVELS.map((level) => ({
						label: TIER_LABELS[level],
						value: level,
						description:
							level === "guest"
								? "Keeps their entry, but gives no access"
								: `A ${level} of Pixelbar`,
						...(level === current ? { selected: true } : {}),
					})),
				},
				reasonField(),
			],
		};
	};

	const reasonForm = (title: string, action: string, args: Record<string, string>): Form => ({
		title: title.slice(0, 45),
		submit: { action, args },
		fields: [reasonField()],
	});

	// ── Actions ──────────────────────────────────────────────────────────

	const action = (
		name: string,
		options: readonly CommandOption[],
		handler: (ctx: ActionContext) => Promise<ActionResult> | ActionResult,
	): ActionDefinition => ({ name, access: ACCESS, options, handler: async (ctx) => handler(ctx) });
	const text = (name: string, description: string, required = false): CommandOption => ({
		name,
		description,
		type: "string",
		...(required ? { required } : {}),
	});
	const choice = (
		name: string,
		description: string,
		choices: readonly string[],
	): CommandOption => ({
		name,
		description,
		type: "string",
		required: true,
		choices,
	});
	const capabilityArg = text("capability", "Which capabilities", true);
	const reasonOpt = text("reason", "Why");

	const actions: ActionDefinition[] = [
		action(ADMIN_ACTIONS.home, [], async (ctx) => ({ reply: await home(ctx) })),
		action(ADMIN_ACTIONS.reload, [], async (ctx) => ({
			reply: above(await run(ops.reload, ctx, {}), await home(ctx)),
		})),
		action(
			ADMIN_ACTIONS.section,
			[
				choice(
					"section",
					"Which section",
					SECTIONS.map((s) => s.value),
				),
			],
			async (ctx) => ({ reply: await section(ctx, ctx.args.section as Section) }),
		),

		// People
		action(ADMIN_ACTIONS.lookupForm, [], () => ({ form: lookupForm })),
		action(
			ADMIN_ACTIONS.person,
			[{ name: "user", description: "Who", type: "user", required: true, allowBots: true }],
			async (ctx) => ({ reply: await personPanel(ctx, ctx.users.user as ResolvedUser) }),
		),
		action(ADMIN_ACTIONS.personAgain, personOptions, async (ctx) => ({
			reply: await personPanel(ctx, heldPerson(ctx)),
		})),
		action(ADMIN_ACTIONS.levelForm, personOptions, (ctx) => ({ form: levelForm(heldPerson(ctx)) })),
		action(
			ADMIN_ACTIONS.levelSet,
			[...personOptions, choice("level", "Their level", LEVELS), reasonOpt],
			async (ctx) => {
				const user = heldPerson(ctx);
				const said = await run(
					ops.level.set,
					ctx,
					{ user: user.id, level: String(ctx.args.level), ...reasonArg(ctx) },
					{ user },
				);
				return { reply: above(said, await personPanel(ctx, user)) };
			},
		),
		action(ADMIN_ACTIONS.grantAsk, [...personOptions, capabilityArg], (ctx) => {
			const user = heldPerson(ctx);
			const names = String(ctx.args.capability)
				.split(/[\s,]+/)
				.join(", ");
			return {
				form: reasonForm(`Grant ${names}`, ADMIN_ACTIONS.grant, {
					...personArgs(user),
					capability: String(ctx.args.capability),
				}),
			};
		}),
		action(ADMIN_ACTIONS.grant, [...personOptions, capabilityArg, reasonOpt], async (ctx) => {
			const user = heldPerson(ctx);
			const said = await eachCapability(
				ctx,
				ops.capabilities.grant,
				{ user: user.id, ...reasonArg(ctx) },
				{ user },
			);
			return { reply: above(said, await personPanel(ctx, user)) };
		}),
		action(ADMIN_ACTIONS.revokeAsk, [...personOptions, capabilityArg], (ctx) => {
			const user = heldPerson(ctx);
			const names = String(ctx.args.capability)
				.split(/[\s,]+/)
				.join(", ");
			return {
				form: reasonForm(`Revoke ${names}`, ADMIN_ACTIONS.revoke, {
					...personArgs(user),
					capability: String(ctx.args.capability),
				}),
			};
		}),
		action(ADMIN_ACTIONS.revoke, [...personOptions, capabilityArg, reasonOpt], async (ctx) => {
			const user = heldPerson(ctx);
			const said = await eachCapability(
				ctx,
				ops.capabilities.revoke,
				{ user: user.id, ...reasonArg(ctx) },
				{ user },
			);
			return { reply: above(said, await personPanel(ctx, user)) };
		}),
		action(ADMIN_ACTIONS.grantAllForm, personOptions, (ctx) => {
			const user = heldPerson(ctx);
			return {
				form: reasonForm(
					`Grant ${user.displayName} everything`,
					ADMIN_ACTIONS.grantAll,
					personArgs(user),
				),
			};
		}),
		action(ADMIN_ACTIONS.grantAll, [...personOptions, reasonOpt], async (ctx) => {
			const user = heldPerson(ctx);
			const said = await run(
				ops.capabilities["grant-all"],
				ctx,
				{ user: user.id, ...reasonArg(ctx) },
				{ user },
			);
			return { reply: above(said, await personPanel(ctx, user)) };
		}),
		action(ADMIN_ACTIONS.syncPerson, personOptions, async (ctx) => {
			const user = heldPerson(ctx);
			const said = await run(ops.sync, ctx, { user: user.id }, { user });
			return { reply: above(said, await personPanel(ctx, user)) };
		}),
		action(ADMIN_ACTIONS.personCapabilities, personOptions, async (ctx) => {
			const user = heldPerson(ctx);
			const said = await run(ops.capabilities.list, ctx, { user: user.id }, { user });
			return { reply: above(said, await personPanel(ctx, user)) };
		}),

		// Capabilities and levels
		action(
			ADMIN_ACTIONS.levelCapabilities,
			[choice("level", "Which level", GRANT_LEVELS)],
			(ctx) => ({ reply: levelCapabilities(ctx.args.level as GrantTier) }),
		),
		...(["Grant", "Revoke"] as const).flatMap((verb) => {
			const ask = verb === "Grant" ? ADMIN_ACTIONS.levelGrantAsk : ADMIN_ACTIONS.levelRevokeAsk;
			const go = verb === "Grant" ? ADMIN_ACTIONS.levelGrant : ADMIN_ACTIONS.levelRevoke;
			const op =
				verb === "Grant" ? ops.capabilities["grant-level"] : ops.capabilities["revoke-level"];
			const levelArg = choice("level", "Which level", GRANT_LEVELS);
			return [
				action(ask, [levelArg, capabilityArg], (ctx) => ({
					form: reasonForm(
						`${verb} ${String(ctx.args.capability)
							.split(/[\s,]+/)
							.join(", ")}`,
						go,
						{
							level: String(ctx.args.level),
							capability: String(ctx.args.capability),
						},
					),
				})),
				action(go, [levelArg, capabilityArg, reasonOpt], async (ctx) => {
					const said = await eachCapability(
						ctx,
						op,
						{ level: String(ctx.args.level), ...reasonArg(ctx) },
						ctx.users,
					);
					return {
						reply: above(said, levelCapabilities(ctx.args.level as GrantTier)),
					};
				}),
			];
		}),
		action(ADMIN_ACTIONS.syncAll, [], async (ctx) => ({
			reply: above(await run(ops.sync, ctx, {}), await section(ctx, "roles")),
		})),

		// Announcements
		action(ADMIN_ACTIONS.announceForm, [], () => ({
			form: {
				title: "Announce open and closed",
				submit: { action: ADMIN_ACTIONS.announceSet },
				fields: [
					{
						kind: "channel",
						name: "channel",
						label: "Where",
						description: "A channel you can post in yourself.",
					},
					{
						kind: "radio",
						name: "style",
						label: "Style",
						options: [
							{
								label: "Live",
								value: "live",
								description: "One post per opening, edited when it closes",
								selected: true,
							},
							{
								label: "Timeline",
								value: "timeline",
								description: "A new post for every open and close",
							},
							{
								label: "Single",
								value: "single",
								description: "Only the latest: the old post is deleted",
							},
						],
					},
				],
			},
		})),
		action(
			ADMIN_ACTIONS.announceSet,
			[
				{ name: "channel", description: "Where", type: "channel", required: true },
				choice("style", "Style", SPACE_ANNOUNCE_STYLES),
			],
			async (ctx) => {
				const said = await run(ops.announcements.set, ctx, ctx.args);
				return { reply: above(said, await section(ctx, "announcements")) };
			},
		),
		action(
			ADMIN_ACTIONS.announceRemove,
			[text("channel-id", "Which channel", true)],
			async (ctx) => {
				const id = String(ctx.args["channel-id"]);
				if (!deps.routes.list().some((r) => r.channelId === id)) {
					throw new UserFacingError("That channel isn't set up for announcements any more.");
				}
				// Removing needs no permission in the channel: the channel is one already set.
				const channel = {
					id,
					name: id,
					caller: { canPost: true, canMentionEveryone: false, canCreatePolls: false },
				};
				const said = await run(
					ops.announcements.remove,
					{ ...ctx, channels: { channel } },
					{ channel: id },
				);
				return { reply: above(said, await section(ctx, "announcements")) };
			},
		),

		// Closing time
		action(ADMIN_ACTIONS.closingTimeForm, [], () => {
			const saved = savedClosingTimeMessage(deps.closingTimeFile);
			return {
				form: {
					title: "Closing-time message",
					submit: { action: ADMIN_ACTIONS.closingTimeSet },
					fields: [
						{
							kind: "text",
							name: "message",
							label: "Message",
							description: "Posted when the space closes. Markdown, {{date}}. No secrets.",
							style: "paragraph",
							maxLength: MAX_CLOSING_TIME_MESSAGE,
							placeholder: "Please tidy up, and the last one out locks the door.",
							...(saved ? { value: saved } : {}),
						},
					],
				},
			};
		}),
		action(ADMIN_ACTIONS.closingTimeSet, [text("message", "The message", true)], async (ctx) => {
			const said = await run(ops.closingTime, ctx, { message: String(ctx.args.message) });
			return { reply: above(said, await section(ctx, "closing-time")) };
		}),

		// Doors
		action(ADMIN_ACTIONS.doorsAsk, [], () => ({
			reply: panel(
				"Switch door control off?",
				[
					"Nobody will be able to lock or unlock a door, or open the parking gate, from Pixel until an admin switches it back on.",
				],
				[
					[
						button("Switch it off", ADMIN_ACTIONS.doors, { on: false }, "danger"),
						button("Cancel", ADMIN_ACTIONS.section, { section: "doors" }),
					],
				],
			),
		})),
		action(
			ADMIN_ACTIONS.doors,
			[{ name: "on", description: "On or off", type: "boolean", required: true }],
			async (ctx) => {
				const said = await run(ctx.args.on === true ? ops.doors.on : ops.doors.off, ctx, {});
				return { reply: above(said, await section(ctx, "doors")) };
			},
		),

		// OpenR
		action(ADMIN_ACTIONS.openrLogin, [], async (ctx) => ({
			reply: above(await run(ops.openr.login, ctx, {}), await section(ctx, "openr")),
		})),
		action(ADMIN_ACTIONS.openrCodeForm, [], () => ({
			form: {
				title: "OpenR's code",
				submit: { action: ADMIN_ACTIONS.openrCode },
				fields: [
					{
						kind: "text",
						name: "code",
						label: "The code OpenR emailed",
						description: "Digits only. It's never logged.",
						style: "short",
						maxLength: 20,
					},
				],
			},
		})),
		action(ADMIN_ACTIONS.openrCode, [text("code", "The code", true)], async (ctx) => ({
			reply: above(
				await run(ops.openr.code, ctx, { code: String(ctx.args.code) }),
				await section(ctx, "openr"),
			),
		})),
		action(ADMIN_ACTIONS.openrLogoutAsk, [], () => ({
			reply: panel(
				"Log Pixel out of OpenR?",
				["Pixel won't be able to open any door through OpenR until an admin logs in again."],
				[
					[
						button("Log out", ADMIN_ACTIONS.openrLogout, {}, "danger"),
						button("Cancel", ADMIN_ACTIONS.section, { section: "openr" }),
					],
				],
			),
		})),
		action(ADMIN_ACTIONS.openrLogout, [], async (ctx) => ({
			reply: above(await run(ops.openr.logout, ctx, {}), await section(ctx, "openr")),
		})),
	];

	return {
		command: {
			name: "admin",
			description: "Administration (admins only)",
			access: ACCESS,
			private: true,
			handler: async (ctx: CommandContext) => home(ctx),
		},
		actions,
	};
}
