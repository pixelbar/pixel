import { MessageFlags } from "discord.js";
import type { DispatchResult } from "../../core/dispatcher.ts";
import {
	type DiscordEditPayload,
	type DiscordReplyPayload,
	renderEdit,
	renderReply,
} from "./render.ts";

/** The parts of a discord.js ChatInputCommandInteraction that responding needs. */
export type Respondable = {
	reply(payload: DiscordReplyPayload): Promise<unknown>;
	deferReply(options: { flags?: MessageFlags.Ephemeral }): Promise<unknown>;
	editReply(payload: DiscordEditPayload): Promise<unknown>;
	followUp(payload: DiscordReplyPayload): Promise<unknown>;
	deleteReply(): Promise<unknown>;
};

/** Shows a placeholder reply straight away; see `DispatchHooks.onPending`. */
export type ShowPending = (pending: DispatchResult) => Promise<void>;

export type RespondOptions = {
	/** Visibility to use if we have to defer before any reply exists. */
	defaultPrivate: boolean;
	/** Discord requires an acknowledgement within 3 s; defer well before that. */
	deferAfterMs: number;
	work: (showPending: ShowPending) => Promise<DispatchResult>;
};

/**
 * Runs `work` and sends its reply. The interaction is acknowledged by
 * whichever comes first: a placeholder from `work` (e.g. "Checking…"), a
 * deferral if `work` is slow, or the final reply. Placeholders and deferrals
 * are later edited into the final reply.
 *
 * A reply's visibility can't be changed after it's sent. If the first
 * acknowledgement was public but the result must be private (e.g. an error),
 * the public message is deleted and the result is sent as an ephemeral
 * follow-up. If it was private, the result stays private — never more visible
 * than intended.
 */
export async function respond(
	interaction: Respondable,
	{ defaultPrivate, deferAfterMs, work }: RespondOptions,
): Promise<void> {
	let acknowledged: Promise<unknown> | undefined;
	let acknowledgedPrivate = defaultPrivate;
	const timer = setTimeout(() => {
		acknowledged = interaction.deferReply(defaultPrivate ? { flags: MessageFlags.Ephemeral } : {});
	}, deferAfterMs);

	const showPending: ShowPending = async (pending) => {
		clearTimeout(timer);
		if (acknowledged) {
			// Already deferred: show the placeholder in the deferred message.
			await acknowledged;
			await interaction.editReply(renderEdit(pending.reply));
			return;
		}
		acknowledgedPrivate = pending.private;
		acknowledged = interaction.reply(renderReply(pending.reply, pending.private));
		await acknowledged;
	};

	let result: DispatchResult;
	try {
		result = await work(showPending);
	} finally {
		clearTimeout(timer);
	}

	if (!acknowledged) {
		await interaction.reply(renderReply(result.reply, result.private));
		return;
	}

	await acknowledged;
	if (result.private && !acknowledgedPrivate) {
		await interaction.deleteReply();
		await interaction.followUp(renderReply(result.reply, true));
		return;
	}
	await interaction.editReply(renderEdit(result.reply));
}
