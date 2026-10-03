import { TIER_LABELS } from "../../core/access.ts";
import type { Feature } from "../../core/feature.ts";

export function createWhoamiFeature(): Feature {
	return {
		name: "whoami",
		commands: [
			{
				name: "whoami",
				description: "See what Pixel knows about you",
				access: { minTier: "guest" },
				private: true,
				handler: async ({ principal }) => ({
					embeds: [
						{
							title: principal.displayName,
							fields: [
								{ name: "Access level", value: TIER_LABELS[principal.tier] },
								{ name: `${capitalize(principal.platform)} ID`, value: principal.userId },
							],
						},
					],
				}),
			},
		],
	};
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
