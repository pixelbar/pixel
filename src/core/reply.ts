export type EmbedField = { name: string; value: string; inline?: boolean };

export type Embed = {
	title: string;
	description?: string;
	url?: string;
	fields?: EmbedField[];
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
