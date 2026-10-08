import { type CapabilityRegistry, reportUnknownCapabilities } from "../../core/capabilities.ts";
import type { Feature } from "../../core/feature.ts";
import { formatDuration } from "../../core/format.ts";
import type { Home } from "../../core/home.ts";
import type { AccessStore } from "../../core/ports/access-store.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { RoleMirror } from "../../core/role-mirror.ts";
import type { HomeDeviceStore } from "../../services/home-devices.ts";
import type { HomeInventory } from "../../services/home-inventory.ts";
import type { KindSwitch } from "../../services/kind-switch.ts";
import { createCapabilitySubgroup } from "./capabilities.ts";
import { createDoorsSubgroup, describeDoors } from "./doors.ts";
import { describeHome, homeLines, inventoryLines, reloadDevices } from "./home.ts";
import { createLevelSubgroup } from "./members.ts";
import { createRoleSubcommands, describeStates } from "./roles.ts";

export type AdminDeps = {
	version: string;
	/** `cloud` on Azure Container Apps, `local` on a laptop. Shown on `/admin status`. */
	runtime?: "local" | "cloud";
	startedAt: Date;
	access: Pick<AccessStore, "view" | "apply" | "reload">;
	capabilities: CapabilityRegistry;
	roles: Pick<RoleMirror, "apply" | "inspect" | "states" | "check">;
	home: Pick<Home, "status" | "check" | "getStates">;
	homeDevices: Pick<HomeDeviceStore, "view" | "reload" | "configured">;
	homeInventory: Pick<HomeInventory, "sync" | "last">;
	switches: Pick<KindSwitch, "set" | "isOn">;
	reporter: ErrorReporter;
	now?: () => Date;
};

function describeCounts(counts: AccessStore["view"]["counts"]): string {
	return `${counts.admins} admins · ${counts.members} members · ${counts.friends} friends`;
}

export function createAdminFeature(deps: AdminDeps): Feature {
	const now = deps.now ?? (() => new Date());
	const runtime = deps.runtime ?? "local";
	return {
		name: "admin",
		commands: [
			{
				name: "admin",
				description: "Administration (admins only)",
				access: { minTier: "admin" },
				subcommands: [
					{
						name: "status",
						description: "Bot health and access list overview",
						access: { minTier: "admin" },
						private: true,
						handler: async () => ({
							embeds: [
								{
									title: "Pixel status",
									fields: [
										{ name: "Version", value: deps.version, inline: true },
										{ name: "Where", value: runtime, inline: true },
										{ name: "Node.js", value: process.version, inline: true },
										{
											name: "Uptime",
											value: formatDuration(now().getTime() - deps.startedAt.getTime()),
											inline: true,
										},
										{ name: "Access lists", value: describeCounts(deps.access.view.counts) },
										{ name: "Discord roles", value: describeStates(await deps.roles.states()) },
										{
											name: "Home Assistant",
											value: [
												describeHome(
													deps.home.status(),
													deps.homeDevices,
													deps.homeInventory,
													now(),
												),
												...(deps.homeDevices.configured ? [describeDoors(deps.switches)] : []),
											].join("\n"),
										},
									],
								},
							],
						}),
					},
					{
						name: "reload",
						description: "Re-read the admin and member lists after editing the files by hand",
						access: { minTier: "admin" },
						private: true,
						handler: async ({ principal, logger }) => {
							const { before, after } = await deps.access.reload(principal);
							const warnings = deps.access.view.warnings.length;
							const unknown = reportUnknownCapabilities(
								deps.access.view.records.values(),
								deps.capabilities,
								{ logger, reporter: deps.reporter },
							);
							// Re-check the role mapping too, so a renamed or moved role is noticed.
							const roleStates = await deps.roles.check();
							const homeStatus = await deps.home.check();
							return {
								text: [
									"Reloaded the access lists.",
									`Before: ${describeCounts(before)}`,
									`Now: ${describeCounts(after)}`,
									...(warnings > 0 ? [`${warnings} warning(s), see the logs.`] : []),
									...(unknown.length > 0
										? [`These capabilities don't exist and are ignored: ${unknown.join(", ")}.`]
										: []),
									...homeLines(homeStatus),
									...(await reloadDevices(deps.homeDevices, deps.home)),
									...inventoryLines(await deps.homeInventory.sync()),
									...roleStates.flatMap((state) =>
										state.status === "off"
											? [`Role mirroring for ${state.tier} is off: ${state.reason}.`]
											: [],
									),
								].join("\n"),
							};
						},
					},
					createLevelSubgroup(deps.access, deps.capabilities, deps.roles),
					...createRoleSubcommands(deps.access, deps.roles),
					createCapabilitySubgroup({ access: deps.access, capabilities: deps.capabilities }),
					createDoorsSubgroup({ switches: deps.switches, reporter: deps.reporter }),
				],
			},
		],
	};
}
