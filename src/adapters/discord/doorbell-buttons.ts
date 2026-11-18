import type { Dispatcher } from "../../core/dispatcher.ts";
import { CALL_ID, DOORBELL_ANSWER_ACTION, type DoorbellMessage } from "../../core/doorbell.ts";
import type { RowJson } from "./controls.ts";
import { discordActor, WRONG_GUILD_MESSAGE } from "./handlers.ts";
import { type DiscordEditPayload, type DiscordReplyPayload, renderReply } from "./render.ts";

/**
 * The Answer button on a doorbell post ([ADR 0026](../../../docs/adr/0026-doorbell-button.md)).
 * Like the attendance buttons ([ADR 0025](../../../docs/adr/0025-attendance-poll-buttons.md)),
 * it's public and survives a restart, so nothing about it is held in memory. Its custom ID
 * is `pixel-doorbell:<callId>`: pixel-phone's random call ID, nothing secret or personal.
 * It's untrusted, so it's parsed exactly and anything else is refused. A click always runs
 * the one action `DOORBELL_ANSWER_ACTION` through `Dispatcher.act`, for whoever clicked,
 * by ID; the action checks they may answer, and pixel-phone decides whether the call can
 * still be answered. The post itself is never changed by the click: the person gets a
 * private answer, and the feature edits the post.
 */

export const DOORBELL_PREFIX = "pixel-doorbell:";
const DOORBELL_ID = new RegExp(`^pixel-doorbell:(${CALL_ID.source.slice(1, -1)})$`);

const STALE_MESSAGE = "That doorbell isn't ringing any more.";

/** The call a button's custom ID names, or undefined if it isn't one of Pixel's doorbell buttons. */
export function parseDoorbellId(customId: string): string | undefined {
	return DOORBELL_ID.exec(customId)?.[1];
}

/** The Answer button while the call can be answered, and nothing once it can't. */
export function doorbellComponents(message: DoorbellMessage): RowJson[] {
	if (!message.answerable) return [];
	if (!CALL_ID.test(message.callId)) throw new Error("not a doorbell call ID");
	return [
		{
			type: 1,
			components: [
				{
					type: 2 as const,
					style: 3,
					label: "Answer",
					custom_id: `${DOORBELL_PREFIX}${message.callId}`,
				},
			],
		},
	];
}

/** The parts of a button interaction this handler reads. */
export type IncomingDoorbell = {
	guildId: string | null;
	customId: string;
	user: { id: string; displayName: string; username: string };
	reply(payload: DiscordReplyPayload): Promise<unknown>;
	deferReply(): Promise<unknown>;
	editReply(payload: DiscordEditPayload): Promise<unknown>;
};

export type DoorbellHandlerDeps = {
	guildId: string;
	dispatcher: Pick<Dispatcher, "act">;
	deferAfterMs: number;
};

/**
 * Handles a click on an Answer button: the configured server only, an exact custom ID
 * only, then `Dispatcher.act` for the clicker. Whatever happens, the answer is private.
 */
export function createDoorbellHandler({ guildId, dispatcher, deferAfterMs }: DoorbellHandlerDeps) {
	return async (interaction: IncomingDoorbell, displayName?: string): Promise<void> => {
		if (interaction.guildId !== guildId) {
			await interaction.reply(renderReply({ text: WRONG_GUILD_MESSAGE }, true));
			return;
		}
		const callId = parseDoorbellId(interaction.customId);
		if (!callId) {
			await interaction.reply(renderReply({ text: STALE_MESSAGE }, true));
			return;
		}
		// Asking pixel-phone can take longer than Discord waits for an answer (3 seconds).
		let deferred: Promise<unknown> | undefined;
		const timer = setTimeout(() => {
			deferred = interaction.deferReply();
			// Awaited below, once the action is done.
			deferred.catch(() => {});
		}, deferAfterMs);
		let outcome: Awaited<ReturnType<Dispatcher["act"]>>;
		try {
			outcome = await dispatcher.act({
				actor: discordActor(interaction.user, displayName),
				action: DOORBELL_ANSWER_ACTION,
				args: { call: callId },
			});
		} finally {
			clearTimeout(timer);
		}
		// The action never opens a form: one that does has a bug.
		if (outcome.kind === "form")
			throw new Error(`action "${DOORBELL_ANSWER_ACTION}" opened a form`);
		const payload = renderReply(outcome.reply, true);
		if (deferred) {
			await deferred;
			await interaction.editReply({
				content: payload.content ?? null,
				embeds: payload.embeds ?? [],
				components: [],
				allowedMentions: { parse: [] },
			});
			return;
		}
		await interaction.reply(payload);
	};
}
