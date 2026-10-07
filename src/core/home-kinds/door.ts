import type { HomeKind } from "./kind.ts";

/**
 * A door lock. The sensitive kind: member-only (a device can't be opened to
 * friends), and admins can switch control of every door off at once with
 * `/admin doors off`.
 */
export const door: HomeKind = {
	name: "door",
	description: "A door with a lock",
	domains: ["lock"],
	// Opening the building is for members (and admins), never friends.
	minTier: "member",
	warnStates: ["jammed"],
	capability: {
		name: "ha-doors",
		description: "Lock, unlock and open the doors on the Home Assistant list",
	},
	actions: [
		{
			name: "lock",
			description: "Lock the door",
			service: "lock",
			done: ["locked"],
			working: ["locking"],
		},
		{
			name: "unlock",
			description: "Unlock the door",
			service: "unlock",
			done: ["unlocked"],
			working: ["unlocking"],
		},
		{
			name: "open",
			description: "Unlatch the door so it can be pushed open",
			service: "open",
			done: ["open"],
			working: ["opening"],
		},
	],
};
