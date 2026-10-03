import { MessageFlags } from "discord.js";
import type { DispatchResult } from "../../core/dispatcher.ts";
import { type DiscordReplyPayload, renderReply } from "./render.ts";

/** The parts of a discord.js ChatInputCommandInteraction that responding needs. */
export type Respondable = {
	reply(payload: DiscordReplyPayload): Promise<unknown>;
	deferReply(options: { flags?: MessageFlags.Ephemeral }): Promise<unknown>;
	editReply(payload: Omit<DiscordReplyPayload, "flags">): Promise<unknown>;
	followUp(payload: DiscordReplyPayload): Promise<unknown>;
	deleteReply(): Promise<unknown>;
};

export type RespondOptions = {
	/** Visibility to use if we have to defer before the reply exists. */
	defaultPrivate: boolean;
	/** Discord requires an acknowledgement within 3 s; defer well before that. */
	deferAfterMs: number;
	work: () => Promise<DispatchResult>;
};

/**
 * Runs `work` and sends its reply. If `work` is slow, defers first so Discord
 * doesn't time the interaction out.
 *
 * A deferred reply's visibility can't be changed afterwards. If we deferred
 * publicly but the result must be private (e.g. an error), the public
 * placeholder is deleted and the reply is sent as an ephemeral follow-up. If we
 * deferred privately, the reply stays private — never more visible than intended.
 */
export async function respond(
	interaction: Respondable,
	{ defaultPrivate, deferAfterMs, work }: RespondOptions,
): Promise<void> {
	let deferral: Promise<unknown> | undefined;
	const timer = setTimeout(() => {
		deferral = interaction.deferReply(defaultPrivate ? { flags: MessageFlags.Ephemeral } : {});
	}, deferAfterMs);

	let result: DispatchResult;
	try {
		result = await work();
	} finally {
		clearTimeout(timer);
	}

	const payload = renderReply(result.reply, result.private);
	if (!deferral) {
		await interaction.reply(payload);
		return;
	}

	await deferral;
	if (result.private && !defaultPrivate) {
		await interaction.deleteReply();
		await interaction.followUp(payload);
		return;
	}
	const { flags: _ignored, ...edit } = payload;
	await interaction.editReply(edit);
}
