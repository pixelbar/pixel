import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { inlineCode } from "../../core/format.ts";
import { normalizePhrase, PHRASES, replyForPhrase } from "./phrases.ts";

export function createFishbotFeature(): Feature {
	return {
		name: "fishbot",
		commands: [
			{
				name: "fishbot",
				description: "QuakeNet nostalgia: fish go m00!",
				access: { minTier: "guest" },
				subcommands: [
					{
						name: "say",
						description: "Try a classic Fishbot phrase (start typing for suggestions)",
						access: { minTier: "guest" },
						options: [
							{
								name: "phrase",
								description: "Try fish, hello fishbot, spoon or moo?; leave empty for help",
								type: "string",
								suggest: async ({ typed }) =>
									PHRASES.filter(([phrase]) =>
										normalizePhrase(phrase).includes(normalizePhrase(typed)),
									)
										.slice(0, 25)
										.map(([phrase]) => ({ name: phrase, value: phrase })),
							},
						],
						handler: async ({ args, principal }) => {
							const phrase = normalizePhrase(String(args.phrase ?? ""));
							const response = replyForPhrase(phrase);
							if (!response)
								return {
									private: true,
									text: "Fish go m00! Try `/fishbot say phrase:fish`, `hello fishbot`, `spoon` or `moo?`. Start typing a phrase for more suggestions.\nYou can also `/fishbot feed`, `/fishbot pet`, `/fishbot cookie` or `/fishbot trout user:`. I only answer commands, not ordinary chat.",
								};
							const name = inlineCode(principal.displayName, 80, "friend");
							return { text: response.replaceAll("$nick", () => name) };
						},
					},
					{
						name: "trout",
						description: "Give someone a harmless slap with a large trout",
						access: { minTier: "guest" },
						options: [
							{
								name: "user",
								description: "Who gets the trout?",
								type: "user",
								required: true,
								allowBots: true,
							},
						],
						handler: async ({ users, principal }) => {
							const target = users.user;
							if (!target) throw new UserFacingError("Choose someone to trout.");
							return {
								text: `${inlineCode(principal.displayName, 80, "Someone")} slaps ${inlineCode(target.displayName, 80, "a friend")} around a bit with a large trout. trouted!`,
							};
						},
					},
					{
						name: "feed",
						description: "Feed Fishbot hundreds and thousands",
						access: { minTier: "guest" },
						handler: async () => ({ text: "MEDI.. er.. FISHBOT" }),
					},
					{
						name: "pet",
						description: "Give Fishbot a friendly stroke",
						access: { minTier: "guest" },
						handler: async ({ principal }) => ({
							text: `*m00s loudly at ${inlineCode(principal.displayName, 80, "a friend")}.*`,
						}),
					},
					{
						name: "cookie",
						description: "Sneak a cookie away from Fishbot",
						access: { minTier: "guest" },
						handler: async () => ({ text: ":(" }),
					},
				],
			},
		],
	};
}
