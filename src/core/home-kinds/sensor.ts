import type { HomeKind } from "./kind.ts";

/** Something that only reports: a temperature, a door contact, a power reading. Nothing can be done to it. */
export const sensor: HomeKind = {
	name: "sensor",
	description: "A sensor that only reports",
	domains: ["sensor", "binary_sensor"],
	attributes: [
		{ key: "device_class", label: "Type", format: "text" },
		{ key: "battery_level", label: "Battery", format: "percent" },
	],
	actions: [],
};
