import type { AnnouncementRoutes } from "../../core/announcement-routes.ts";
import {
	type CapabilityRegistry,
	grantedLists,
	reportUnknownCapabilities,
} from "../../core/capabilities.ts";
import type { SubcommandDefinition } from "../../core/command.ts";
import type { Feature } from "../../core/feature.ts";
import { formatDuration } from "../../core/format.ts";
import type { Home } from "../../core/home.ts";
import type { AccessStore } from "../../core/ports/access-store.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { RoleMirror } from "../../core/role-mirror.ts";
import type { HomeDeviceStore } from "../../services/home-devices.ts";
import type { KindSwitch } from "../../services/kind-switch.ts";
import { createAnnouncementsSubgroup } from "./announcements.ts";
import { createCapabilitySubgroup } from "./capabilities.ts";
import { createClosingTimeSubgroup } from "./closing-time.ts";
import { createDoorsSubgroup, describeDoors } from "./doors.ts";
import { describeHome, homeLines, reloadDevices } from "./home.ts";
import { createLevelSubgroup } from "./members.ts";
import { createOpenrSubgroup, describeOpenr, type OpenrAdminDeps } from "./openr.ts";
import { createAdminPanel } from "./panel.ts";
import type { ParkingAdminDeps } from "./parking.ts";
import { createParkingAdmin } from "./parking-panel.ts";
import { createRoleSubcommands, describeStates } from "./roles.ts";

export type AdminDeps = {
	version: string;
	/** `cloud` on Azure Container Apps, `local` on a laptop. Shown on `/admin`. */
	runtime?: "local" | "cloud";
	startedAt: Date;
	access: Pick<AccessStore, "view" | "apply" | "setTierCapabilities" | "reload">;
	capabilities: CapabilityRegistry;
	roles: Pick<RoleMirror, "apply" | "inspect" | "states" | "check">;
	home: Pick<Home, "status" | "check" | "getStates">;
	homeDevices: Pick<HomeDeviceStore, "view" | "reload" | "configured">;
	switches: Pick<KindSwitch, "set" | "isOn">;
	announcementRoutes: Pick<AnnouncementRoutes, "list" | "set" | "remove">;
	reporter: ErrorReporter;
	now?: () => Date;
	/** Persist path for the closing-time body (`PIXEL_DATA_DIR` / Azure Files). */
	closingTimeFile: string;
	/** Parking spots and opening times (`/admin` → Parking). */
	parking: Omit<ParkingAdminDeps, "now">;
	/** Pixel's OpenR login (`/admin` → OpenR). */
	openr: Omit<OpenrAdminDeps, "now" | "reporter">;
};

function describeCounts(counts: AccessStore["view"]["counts"]): string {
	return `${counts.admins} admins · ${counts.members} members · ${counts.friends} friends`;
}

export function createAdminFeature(deps: AdminDeps): Feature {
	const now = deps.now ?? (() => new Date());
	const runtime = deps.runtime ?? "local";
	const parking = createParkingAdmin({ ...deps.parking, now });
	const subcommands = (group: { subcommands: readonly unknown[] }) =>
		Object.fromEntries((group.subcommands as SubcommandDefinition[]).map((sub) => [sub.name, sub]));
	const level = subcommands(createLevelSubgroup(deps.access, deps.capabilities, deps.roles));
	const capabilities = subcommands(
		createCapabilitySubgroup({ access: deps.access, capabilities: deps.capabilities }),
	);
	const announcements = subcommands(
		createAnnouncementsSubgroup({ routes: deps.announcementRoutes }),
	);
	const doors = subcommands(
		createDoorsSubgroup({ switches: deps.switches, reporter: deps.reporter }),
	);
	const openr = subcommands(createOpenrSubgroup({ ...deps.openr, reporter: deps.reporter, now }));
	const [sync] = createRoleSubcommands(deps.access, deps.roles);
	const [closingTime] = createClosingTimeSubgroup({ closingTimeFile: deps.closingTimeFile })
		.subcommands as SubcommandDefinition[];

	const status: SubcommandDefinition = {
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
							value: describeHome(deps.home.status(), deps.homeDevices),
						},
						...(deps.openr.system
							? [{ name: "OpenR", value: describeOpenr(deps.openr.system.status(), now()) }]
							: []),
						...(deps.homeDevices.configured || deps.openr.system
							? [{ name: "Doors", value: describeDoors(deps.switches) }]
							: []),
					],
				},
			],
		}),
	};
	const reload: SubcommandDefinition = {
		name: "reload",
		description: "Re-read the admin and member lists after editing the files by hand",
		access: { minTier: "admin" },
		private: true,
		handler: async ({ principal, logger }) => {
			const { before, after } = await deps.access.reload(principal);
			const warnings = deps.access.view.warnings.length;
			const unknown = reportUnknownCapabilities(grantedLists(deps.access.view), deps.capabilities, {
				logger,
				reporter: deps.reporter,
			});
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
					...roleStates.flatMap((state) =>
						state.status === "off"
							? [`Role mirroring for ${state.tier} is off: ${state.reason}.`]
							: [],
					),
				].join("\n"),
			};
		},
	};

	const panel = createAdminPanel({
		operations: {
			status,
			reload,
			level: { set: need(level, "set"), get: need(level, "get") },
			sync: sync as SubcommandDefinition,
			capabilities: {
				grant: need(capabilities, "grant"),
				"grant-all": need(capabilities, "grant-all"),
				revoke: need(capabilities, "revoke"),
				"grant-level": need(capabilities, "grant-level"),
				"revoke-level": need(capabilities, "revoke-level"),
				list: need(capabilities, "list"),
			},
			announcements: {
				set: need(announcements, "set"),
				remove: need(announcements, "remove"),
				list: need(announcements, "list"),
			},
			closingTime: closingTime as SubcommandDefinition,
			doors: { on: need(doors, "on"), off: need(doors, "off") },
			openr: {
				status: need(openr, "status"),
				login: need(openr, "login"),
				code: need(openr, "code"),
				logout: need(openr, "logout"),
			},
		},
		access: deps.access,
		capabilities: deps.capabilities,
		roles: deps.roles,
		routes: deps.announcementRoutes,
		closingTimeFile: deps.closingTimeFile,
		switches: deps.switches,
		openr: deps.openr.system !== undefined,
		parking: parking.subcommand,
	});
	return {
		name: "admin",
		actions: [...panel.actions, ...parking.actions],
		commands: [panel.command],
	};
}

/** An operation built above; a missing one is a bug, found at startup. */
function need(ops: Record<string, SubcommandDefinition>, name: string): SubcommandDefinition {
	const op = ops[name];
	if (!op) throw new Error(`no admin operation "${name}"`);
	return op;
}
