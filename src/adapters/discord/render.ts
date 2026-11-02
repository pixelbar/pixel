import { type APIEmbed, MessageFlags } from "discord.js";
import type { Accent, Embed, Reply } from "../../core/reply.ts";
import type { ControlRow } from "../../core/ui.ts";
import type { RowJson } from "./controls.ts";

/** Draws a reply's controls and holds what they run; see `controls.ts`. */
export type ControlsRenderer = (rows: readonly ControlRow[]) => RowJson[];

/** Discord's documented limits. */
const LIMITS = {
	content: 2000,
	embeds: 10,
	title: 256,
	description: 4096,
	fields: 25,
	fieldName: 256,
	fieldValue: 1024,
} as const;

const ACCENT_COLORS: Record<Accent, number> = {
	brand: 0xf5a623,
	positive: 0x2ecc71,
	negative: 0xe74c3c,
	warning: 0xf1c40f,
	neutral: 0x95a5a6,
};

export function accentColor(accent: Accent): number {
	return ACCENT_COLORS[accent];
}

export type DiscordReplyPayload = {
	content?: string;
	embeds?: APIEmbed[];
	flags?: MessageFlags.Ephemeral;
	components?: RowJson[];
	allowedMentions: { parse: [] };
};

/**
 * Payload for editing an existing message. Discord keeps any field an edit
 * omits, so content and embeds are always set explicitly — otherwise a
 * placeholder's embed would linger under a text-only result.
 */
export type DiscordEditPayload = {
	content: string | null;
	embeds: APIEmbed[];
	/** Always set, so an edit without controls removes the old ones. */
	components: RowJson[];
	allowedMentions: { parse: [] };
};

/**
 * Renders a core Reply as a Discord message payload. Mentions are always
 * disabled so that no reply — whatever text it echoes — can ping @everyone,
 * roles or users.
 */
export function renderReply(
	reply: Reply,
	isPrivate: boolean,
	controls?: ControlsRenderer,
): DiscordReplyPayload {
	const { content, embeds } = renderParts(reply);
	const components = renderRows(reply, controls);
	return {
		...(content !== null ? { content } : {}),
		...(embeds.length > 0 ? { embeds } : {}),
		...(isPrivate ? { flags: MessageFlags.Ephemeral } : {}),
		...(components.length > 0 ? { components } : {}),
		allowedMentions: { parse: [] },
	};
}

/** Renders a core Reply as an edit that fully replaces the previous message. */
export function renderEdit(reply: Reply, controls?: ControlsRenderer): DiscordEditPayload {
	return {
		...renderParts(reply),
		components: renderRows(reply, controls),
		allowedMentions: { parse: [] },
	};
}

function renderRows(reply: Reply, controls: ControlsRenderer | undefined): RowJson[] {
	const rows = reply.controls ?? [];
	if (rows.length === 0) return [];
	// Dropping them would leave a reply that says "choose below" with nothing below.
	if (!controls) throw new Error("this reply has controls, but nothing here can draw them");
	return controls(rows);
}

function renderParts(reply: Reply): { content: string | null; embeds: APIEmbed[] } {
	const embeds = (reply.embeds ?? []).slice(0, LIMITS.embeds).map(renderEmbed);
	const text = reply.text ? truncate(reply.text, LIMITS.content) : null;
	// Never send an empty message.
	const content = text ?? (embeds.length === 0 ? "Done." : null);
	return { content, embeds };
}

function renderEmbed(embed: Embed): APIEmbed {
	return {
		color: ACCENT_COLORS[embed.accent ?? "brand"],
		title: truncate(embed.title, LIMITS.title),
		...(embed.description ? { description: truncate(embed.description, LIMITS.description) } : {}),
		...(embed.url ? { url: embed.url } : {}),
		...(embed.fields
			? {
					fields: embed.fields.slice(0, LIMITS.fields).map((f) => ({
						name: truncate(f.name, LIMITS.fieldName),
						value: truncate(f.value, LIMITS.fieldValue),
						inline: f.inline ?? false,
					})),
				}
			: {}),
	};
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
