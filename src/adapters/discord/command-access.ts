import type { Tier } from "../../core/access.ts";
import type { CommandDefinition } from "../../core/command.ts";

/**
 * Pure helpers for `just command-access`, which shows admin-tier commands to
 * the people in `config/admins.yaml`. This controls what Discord *shows*; the
 * dispatcher still decides who may run a command.
 */

/** Discord allows at most 100 overrides per command. */
export const MAX_OVERRIDES = 100;

const USER_OVERRIDE = 2;

export const COMMAND_PERMISSIONS_SCOPE = "applications.commands.permissions.update";

export type PermissionOverride = { id: string; type: typeof USER_OVERRIDE; permission: true };

/** Names of the top-level commands that are admin-tier, i.e. hidden by default. */
export function hiddenCommandNames(definitions: readonly CommandDefinition[]): string[] {
	return definitions.filter((d) => d.access.minTier === "admin").map((d) => d.name);
}

/** One "allow" override per admin user, by immutable ID. */
export function adminOverrides(
	access: ReadonlyMap<string, Exclude<Tier, "guest">>,
): PermissionOverride[] {
	// Only Discord IDs can be given a Discord permission override.
	const overrides = [...access]
		.filter(([ref, tier]) => tier === "admin" && ref.startsWith("discord:"))
		.map(
			([ref]): PermissionOverride => ({
				id: ref.slice("discord:".length),
				type: USER_OVERRIDE,
				permission: true,
			}),
		);
	if (overrides.length > MAX_OVERRIDES) {
		throw new Error(`Discord allows at most ${MAX_OVERRIDES} overrides per command`);
	}
	return overrides;
}

/**
 * The URL to open while logged in as someone who manages the server. It uses
 * the implicit grant, so Discord hands the token straight to the redirect and
 * no client secret is needed.
 */
export function authorizeUrl(options: {
	appId: string;
	redirectUri: string;
	state: string;
}): string {
	const url = new URL("https://discord.com/oauth2/authorize");
	url.searchParams.set("client_id", options.appId);
	url.searchParams.set("response_type", "token");
	url.searchParams.set("scope", COMMAND_PERMISSIONS_SCOPE);
	url.searchParams.set("redirect_uri", options.redirectUri);
	url.searchParams.set("state", options.state);
	url.searchParams.set("prompt", "consent");
	return url.toString();
}

/**
 * Reads the access token from the redirect's fragment (the part after `#`).
 * Rejects anything whose `state` doesn't match, so a stray or forged redirect
 * can't supply a token.
 */
export function parseGrant(fragment: string, expectedState: string): string {
	const params = new URLSearchParams(fragment.replace(/^#/, ""));
	if (params.get("state") !== expectedState) throw new Error("State mismatch");
	const token = params.get("access_token");
	if (!token) throw new Error("No access token in the response");
	if (params.get("token_type")?.toLowerCase() !== "bearer")
		throw new Error("Unexpected token type");
	return token;
}
