import type { HomeKind } from "./kind.ts";

/** Something that only reports: a temperature, a door contact, a power reading. Nothing can be done to it. */
export const sensor: HomeKind = {
	name: "sensor",
	description: "A sensor that only reports",
	domains: ["sensor", "binary_sensor"],
	actions: [],
};
