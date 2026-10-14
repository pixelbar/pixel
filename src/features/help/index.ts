import type { Feature } from "../../core/feature.ts";
import { PRIVACY_NOTICE_URL } from "../links.ts";

export function createHelpFeature(): Feature {
	return {
		name: "help",
		commands: [
			{
				name: "help",
				description: "List the commands you can use",
				access: { minTier: "guest" },
				private: true,
				handler: async ({ availableCommands }) => {
					const lines = [...availableCommands]
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((c) => `**/${c.name}** — ${c.description}`);
					return {
						embeds: [
							{
								title: "Pixel commands",
								description: lines.join("\n"),
								fields: [
									{
										name: "Privacy",
										value: `What Pixel stores about you, and how to ask for a copy or deletion: ${PRIVACY_NOTICE_URL}`,
									},
								],
							},
						],
					};
				},
			},
		],
	};
}
