import type { CommandDefinition } from "./command.ts";

/**
 * A unit of functionality. Dependencies are injected by the feature's factory
 * function, so features never reach for globals.
 */
export type Feature = {
	name: string;
	commands?: readonly CommandDefinition[];
};
