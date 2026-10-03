import type { Feature } from "../../core/feature.ts";

export function createPingFeature(deps: { version: string }): Feature {
	return {
		name: "ping",
		commands: [
			{
				name: "ping",
				description: "Check that Pixel is alive",
				access: { minTier: "guest" },
				handler: async () => ({ text: `Pong! Pixel ${deps.version} is up and running.` }),
			},
		],
	};
}
