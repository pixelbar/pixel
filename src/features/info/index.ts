import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown } from "../../core/format.ts";
import type { Embed, Reply } from "../../core/reply.ts";
import type { InfoTopic } from "../../services/info-content.ts";

export type InfoDeps = {
	topics: readonly InfoTopic[];
};

/**
 * `/info [topic]`: answers to common questions, from the markdown files in
 * content/info. With no topic it lists what's available.
 *
 * The topic text comes from our own reviewed repository, so it's shown as
 * written (unlike text written by other people, which must be escaped).
 */
export function createInfoFeature({ topics }: InfoDeps): Feature {
	return {
		name: "info",
		commands: [
			{
				name: "info",
				description: "Find out about Pixelbar: where, how to join, house rules and more",
				access: { minTier: "guest" },
				options: [
					{
						name: "topic",
						description: "What do you want to know about? Leave empty to see the list",
						type: "string",
						choices: topics.map((topic) => topic.id),
					},
				],
				handler: async ({ args }): Promise<Reply> => {
					const id = args.topic;
					if (id === undefined) return { embeds: [list(topics)] };

					const topic = topics.find((candidate) => candidate.id === id);
					if (!topic) {
						throw new UserFacingError(
							`I don't have a topic called "${escapeMarkdown(String(id))}". Try /info to see the list.`,
						);
					}
					return { embeds: [{ title: topic.title, description: topic.body, accent: "brand" }] };
				},
			},
		],
	};
}

function list(topics: readonly InfoTopic[]): Embed {
	const lines = topics.map((topic) => `**${topic.id}**: ${topic.summary}`);
	return {
		title: "ℹ️ What would you like to know?",
		description: `${lines.join("\n")}\n\nPick one with \`/info topic:\`, for example \`/info topic:${topics[0]?.id ?? "membership"}\`.`,
		accent: "brand",
	};
}
