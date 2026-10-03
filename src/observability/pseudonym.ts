import { createHmac } from "node:crypto";
import type { PlatformActor } from "../core/access.ts";

/**
 * Returns a stable, non-reversible identifier for an actor, for logs and
 * Sentry. Keyed so that a known Discord ID can't be hashed and looked up.
 */
export function createPseudonymizer(key: string): (actor: PlatformActor) => string {
	return (actor) =>
		createHmac("sha256", key)
			.update(`${actor.platform}:${actor.userId}`)
			.digest("hex")
			.slice(0, 16);
}
