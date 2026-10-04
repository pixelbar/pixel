import { inlineCode } from "../../core/format.ts";
import type { HomeStatus } from "../../core/home.ts";

/** The "Home Assistant" line of `/admin status`. */
export function describeHome(status: HomeStatus): string {
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
