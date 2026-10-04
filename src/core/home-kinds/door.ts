import type { HomeKind } from "./kind.ts";

/**
 * A door lock. The sensitive kind: see the door safeguards (#29) for what's added
 * on top, such as a public notice and a confirmation.
 */
export const door: HomeKind = {
	name: "door",
	description: "A door with a lock",
	domains: ["lock"],
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
