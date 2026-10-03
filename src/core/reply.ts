export type EmbedField = { name: string; value: string; inline?: boolean };

/**
 * Semantic colour for an embed. Adapters map it to their platform's styling
 * (e.g. the embed colour bar on Discord); platforms without colour ignore it.
 */
export type Accent = "brand" | "positive" | "negative" | "warning" | "neutral";

export type Embed = {
	title: string;
	description?: string;
	url?: string;
	fields?: EmbedField[];
	/** Defaults to "brand". */
	accent?: Accent;
};

/** A platform-neutral reply. Adapters render it however their platform allows. */
export type Reply = {
	text?: string;
	embeds?: Embed[];
	/**
	 * Only visible to the caller (ephemeral on Discord). Overrides the command's
	 * default visibility.
	 */
	private?: boolean;
};
