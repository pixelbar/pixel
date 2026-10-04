import { inlineCode } from "../../core/format.ts";
import type { Home, HomeStatus } from "../../core/home.ts";
import {
	findMissingDevices,
	type HomeDeviceStore,
	HomeDevicesError,
} from "../../services/home-devices.ts";

/** The "Home Assistant" field of `/admin status`: the connection, and how many devices are allowed. */
export function describeHome(
	status: HomeStatus,
	devices?: Pick<HomeDeviceStore, "view" | "configured">,
): string {
	const connection = describeConnection(status);
	if (!devices?.configured) return connection;
	const count = devices.view.devices.length;
	return `${connection}\n${count} ${count === 1 ? "device" : "devices"} allowed`;
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
