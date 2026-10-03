import type { CommandDefinition } from "./command.ts";

/** Stops background work started by a feature. */
export type Stop = () => void;

/**
 * A unit of functionality. Dependencies are injected by the feature's factory
 * function, so features never reach for globals.
 */
export type Feature = {
	name: string;
	commands?: readonly CommandDefinition[];
	/**
	 * Starts background work (e.g. watching the space and announcing changes).
	 * Called once, when the platform adapters are ready. Returns a function that
	 * stops the work again.
	 */
	start?: () => Stop;
};

/** Starts every feature's background work; the returned function stops it all. */
export function startFeatures(features: readonly Feature[]): Stop {
	const stops = features.flatMap((feature) => (feature.start ? [feature.start()] : []));
	return () => {
		for (const stop of stops) stop();
	};
}
