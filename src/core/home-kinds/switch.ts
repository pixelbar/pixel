import type { HomeKind } from "./kind.ts";

export const powerSwitch: HomeKind = {
	name: "switch",
	description: "A power switch or socket",
	domains: ["switch"],
	capability: "ha-switches",
	actions: [
		{ name: "on", description: "Switch it on", service: "turn_on", done: ["on"] },
		{ name: "off", description: "Switch it off", service: "turn_off", done: ["off"] },
		{
			name: "toggle",
			description: "Switch it on if it's off, and off if it's on",
			service: "toggle",
			done: ["on", "off"],
		},
	],
};
