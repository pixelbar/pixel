import type { HomeKind } from "./kind.ts";

export const light: HomeKind = {
	name: "light",
	description: "A light you can switch on and off",
	domains: ["light"],
	capability: "ha-lights",
	actions: [
		{ name: "on", description: "Switch the light on", service: "turn_on", done: ["on"] },
		{ name: "off", description: "Switch the light off", service: "turn_off", done: ["off"] },
		{
			name: "toggle",
			description: "Switch the light on if it's off, and off if it's on",
			service: "toggle",
			done: ["on", "off"],
		},
	],
};
