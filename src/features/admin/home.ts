import { formatDuration, inlineCode } from "../../core/format.ts";
import type { Home, HomeStatus } from "../../core/home.ts";
import {
	findMissingDevices,
	type HomeDeviceStore,
	HomeDevicesError,
} from "../../services/home-devices.ts";
import type { HomeInventory, InventorySync } from "../../services/home-inventory.ts";

/**
 * The "Home Assistant" field of `/admin status`: the connection, how many devices
 * are allowed, and how many Home Assistant has that Pixel knows of (not allowed,
 * just known) and when that was last synced.
 */
export function describeHome(
	status: HomeStatus,
	devices?: Pick<HomeDeviceStore, "view" | "configured">,
	inventory?: Pick<HomeInventory, "last">,
	now: Date = new Date(),
): string {
	const connection = describeConnection(status);
	if (!devices?.configured) return connection;
	const count = devices.view.devices.length;
	const lines = [connection, `${count} ${count === 1 ? "device" : "devices"} allowed`];
	if (inventory) {
		const last = inventory.last;
		lines.push(
			last
				? `${last.count} known, synced ${formatDuration(now.getTime() - last.at.getTime())} ago`
				: "Inventory not synced yet",
		);
	}
	return lines.join("\n");
}

function describeConnection(status: HomeStatus): string {
	switch (status.kind) {
		case "unconfigured":
			return "Not configured";
		case "connecting":
			return "Connecting…";
		case "reconnecting":
			return "Not connected, trying to reconnect";
		case "off":
			return `Off: ${status.reason}`;
		case "connected": {
			// The version comes from Home Assistant, so it's shown as a code span.
			const version = status.haVersion ? ` (version ${inlineCode(status.haVersion, 40)})` : "";
			const admin = status.adminToken
				? "\n⚠ The token belongs to an admin user. Use a non-admin user's token."
				: "";
			return `Connected${version}${admin}`;
		}
	}
}

/** Lines `/admin reload` adds when Home Assistant needs attention. Nothing when all is well or unused. */
export function homeLines(status: HomeStatus): string[] {
	switch (status.kind) {
		case "off":
			return [`Home Assistant is off: ${status.reason}.`];
		case "connecting":
		case "reconnecting":
			return ["Home Assistant isn't connected right now."];
		case "connected":
			return status.adminToken
				? ["Home Assistant's token belongs to an admin user. Use a non-admin user's token."]
				: [];
		case "unconfigured":
			return [];
	}
}

/**
 * Re-reads the devices file for `/admin reload`. A file that's now invalid leaves
 * the old list in place and says why (the message names positions, never values).
 * Also notes devices whose entity Home Assistant doesn't know.
 */
export async function reloadDevices(
	devices: Pick<HomeDeviceStore, "view" | "reload" | "configured">,
	home: Pick<Home, "getStates">,
): Promise<string[]> {
	if (!devices.configured) return [];
	const lines: string[] = [];
	try {
		const { before, after } = devices.reload();
		lines.push(`Home Assistant devices: ${after} (was ${before}).`);
	} catch (error) {
		if (!(error instanceof HomeDevicesError)) throw error;
		lines.push(
			`Home Assistant devices weren't reloaded, so I'm keeping the old list.\n${error.message}`,
		);
	}
	const missing = await findMissingDevices(devices.view, home);
	if (missing && missing.length > 0) {
		lines.push(`Not found in Home Assistant: ${missing.join(", ")}.`);
	}
	return lines;
}

/** What `/admin reload` says about the inventory sync. Nothing when Home Assistant isn't set up. */
export function inventoryLines(result: InventorySync): string[] {
	switch (result.kind) {
		case "synced": {
			const was = result.previous === undefined ? "" : ` (was ${result.previous})`;
			return [`Home Assistant inventory: ${result.count} known${was}.`];
		}
		case "skipped":
			switch (result.reason) {
				case "unavailable":
					return ["The Home Assistant inventory wasn't synced: Home Assistant isn't reachable."];
				case "failed":
					return ["The Home Assistant inventory couldn't be synced, see the logs."];
				case "not-set-up":
					return [];
			}
	}
}
