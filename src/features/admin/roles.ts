import { TIER_LABELS } from "../../core/access.ts";
import type { ResolvedUser, SubcommandDefinition } from "../../core/command.ts";
import { escapeMarkdown, inlineCode } from "../../core/format.ts";
import type { AccessView } from "../../core/ports/access-store.ts";
import type {
	Inspection,
	MirrorResult,
	RoleMirror,
	TierMirrorState,
	TierOff,
	WantedLevel,
} from "../../core/role-mirror.ts";

/**
 * Role mirroring in the admin commands: `/admin sync`, plus the wording shared
 * with `level set`, `level get` and `status`. Discord moderators name roles, so
 * every role name is shown as a code span and never as formatting.
 */

export type RoleCommandDeps = Pick<RoleMirror, "apply" | "states">;

/** What Pixel's own data says someone should hold. Unlisted people are guests. */
export function wantedFor(view: Pick<AccessView, "records">, userId: string): WantedLevel {
	return view.records.get(userId)?.tier ?? "guest";
}

/** The audit-log reason Discord shows next to a role change. */
export function mirrorReason(
	verb: "Set to" | "Synced to",
	wanted: WantedLevel,
	by: { displayName: string; userId: string },
): string {
	return `${verb} ${wanted} by ${by.displayName} (${by.userId}) via Pixel`;
}

function offNote(off: readonly TierOff[]): string {
	return off.length === 0
		? ""
		: ` Not mirrored: ${off.map((tier) => `${tier.tier} (${tier.reason})`).join("; ")}.`;
}

const codes = (names: readonly string[]) => names.map((name) => inlineCode(name)).join(", ");

/**
 * One line about what happened to someone's Discord roles, or undefined when
 * nothing is mapped (so replies stay as they were).
 */
export function mirrorLine(result: MirrorResult, context: "change" | "sync"): string | undefined {
	switch (result.kind) {
		case "unconfigured":
			return undefined;
		case "in-sync":
			return `Discord roles already match.${offNote(result.off)}`;
		case "updated": {
			const parts = [
				...(result.added.length > 0 ? [`added ${codes(result.added)}`] : []),
				...(result.removed.length > 0 ? [`removed ${codes(result.removed)}`] : []),
			];
			return `Discord roles: ${parts.join(", ")}.${offNote(result.off)}`;
		}
		case "failed":
			return context === "change"
				? `Pixel is updated, but the Discord roles weren't changed: ${result.reason}. Run /admin sync once that's fixed.`
				: `The Discord roles weren't changed: ${result.reason}.`;
	}
}

/** The "Discord roles" field of `/admin level get`, or undefined when nothing is mapped. */
export function inspectionField(
	inspection: Inspection,
	wanted: WantedLevel,
): { name: string; value: string } | undefined {
	const field = (value: string) => ({ name: "Discord roles", value });
	switch (inspection.kind) {
		case "unconfigured":
			return undefined;
		case "not-in-server":
			return field("They aren't in the Discord server.");
		case "failed":
			return field(`Couldn't check: ${inspection.reason}.`);
		case "ok": {
			const held = inspection.holdings
				.map((h) => `${inlineCode(h.role)} ${h.has ? "yes" : "no"}`)
				.join(" · ");
			const matches = inspection.holdings.every((h) => h.has === (h.tier === wanted));
			return field(
				`${held}\n${matches ? "Matches their Pixel level." : "⚠ Doesn't match their Pixel level. Run /admin sync."}`,
			);
		}
	}
}

/** The "Discord roles" lines of `/admin status`. */
export function describeStates(states: readonly TierMirrorState[]): string {
	if (states.every((state) => state.status === "unconfigured")) return "Not configured";
	return states
		.map((state) => {
			if (state.status === "unconfigured") return `${state.tier}: not mirrored`;
			if (state.status === "on") return `${state.tier}: on (${inlineCode(state.role)})`;
			return `${state.tier}: off, ${state.reason}`;
		})
		.join("\n");
}

function describe(user: ResolvedUser): string {
	return `${escapeMarkdown(user.displayName)} (${user.id})`;
}

export function createRoleSubcommands(
	access: Pick<{ view: AccessView }, "view">,
	roles: RoleCommandDeps,
): SubcommandDefinition[] {
	return [
		{
			name: "sync",
			description: "Set Discord roles to match Pixel's lists, for one person or everyone listed",
			access: { minTier: "admin" },
			private: true,
			placeholder: { text: "Syncing Discord roles…", private: true },
			options: [
				{
					name: "user",
					description: "Just this person. Leave out to sync everyone in Pixel's lists",
					type: "user",
				},
			],
			handler: async ({ users, principal, logger }) => {
				const states = await roles.states();
				if (states.every((state) => state.status === "unconfigured")) {
					return { text: "Role mirroring isn't configured, so there is nothing to sync." };
				}
				const view = access.view;
				const syncOne = (userId: string) => {
					const wanted = wantedFor(view, userId);
					return roles.apply(userId, wanted, mirrorReason("Synced to", wanted, principal));
				};

				const target = users.user;
				if (target) {
					logger.info({ event: "admin.sync", target: `discord:${target.id}` }, "synced one person");
					const result = await syncOne(target.id);
					return {
						embeds: [
							{
								title: "Discord roles synced",
								accent: result.kind === "failed" ? "negative" : "positive",
								fields: [
									{ name: "Person", value: describe(target) },
									{
										name: "Pixel level",
										value: TIER_LABELS[view.discord.get(target.id) ?? "guest"],
										inline: true,
									},
									{ name: "Result", value: mirrorLine(result, "sync") ?? "Nothing to do." },
								],
							},
						],
					};
				}

				// Everyone in Pixel's lists. People who hold a role but aren't listed can't be
				// found without a privileged Discord intent, so they're left alone.
				const ids = [...view.records.keys()];
				let updated = 0;
				let inSync = 0;
				const failures = new Map<string, number>();
				let off: TierOff[] = [];
				for (const id of ids) {
					const result = await syncOne(id);
					if (result.kind === "updated") updated++;
					else if (result.kind === "in-sync") inSync++;
					else if (result.kind === "failed") {
						failures.set(result.reason, (failures.get(result.reason) ?? 0) + 1);
					}
					if (result.kind === "updated" || result.kind === "in-sync") off = result.off;
				}
				const failed = [...failures.values()].reduce((sum, count) => sum + count, 0);
				logger.info(
					{ event: "admin.sync", people: ids.length, updated, inSync, failed },
					"synced everyone",
				);
				return {
					embeds: [
						{
							title: "Discord roles synced",
							accent: failed > 0 ? "warning" : "positive",
							description: `${ids.length} ${ids.length === 1 ? "person" : "people"} in Pixel's lists. People who hold a role but aren't listed aren't touched.${offNote(off)}`,
							fields: [
								{ name: "Updated", value: String(updated), inline: true },
								{ name: "Already matched", value: String(inSync), inline: true },
								{ name: "Failed", value: String(failed), inline: true },
								...(failed > 0
									? [
											{
												name: "Why",
												value: [...failures]
													.map(([reason, count]) => `${count} × ${reason}`)
													.join("\n"),
											},
										]
									: []),
							],
						},
					],
				};
			},
		},
	];
}
