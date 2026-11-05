import {
	ATTEND_ACTION,
	type AttendanceMessage,
	MAX_ATTENDANCE_ANSWERS,
} from "../../core/channel-posts.ts";
import type { Dispatcher } from "../../core/dispatcher.ts";
import type { RowJson } from "./controls.ts";
import { discordActor, WRONG_GUILD_MESSAGE } from "./handlers.ts";
import { type DiscordEditPayload, type DiscordReplyPayload, renderReply } from "./render.ts";

/**
 * The buttons on an attendance poll ([ADR 0025](../../../docs/adr/0025-attendance-poll-buttons.md)).
 * Unlike the controls in `controls.ts`, they're public, last as long as the poll and
 * survive a restart, so nothing about them is held in memory. Their custom ID is
 * `pixel-attend:<poll>:<answer>`: the poll's random ID and the answer's position,
 * nothing secret or personal. It's untrusted, so it's parsed exactly and anything else
 * is refused. A click always runs the one action `ATTEND_ACTION` through
 * `Dispatcher.act`, for whoever clicked, by ID; the action checks the poll exists, is
 * open and has that answer. The poll's message is never changed by the click itself:
 * the person gets a private answer, and the feature edits the message.
 */

export const ATTEND_PREFIX = "pixel-attend:";
const ATTEND_ID = /^pixel-attend:([0-9a-f]{12}):([0-4])$/;

const STALE_MESSAGE = "That poll isn't running any more.";

/** The poll and answer a button's custom ID names, or undefined if it isn't one of Pixel's. */
export function parseAttendId(customId: string): { poll: string; answer: number } | undefined {
	const match = ATTEND_ID.exec(customId);
	if (!match) return undefined;
	return { poll: match[1] as string, answer: Number(match[2]) };
}

/** A button per answer while the poll is open, and none once it has closed. */
export function attendanceComponents(message: AttendanceMessage): RowJson[] {
	if (!message.open) return [];
	if (!/^[0-9a-f]{12}$/.test(message.pollId)) throw new Error("not an attendance poll ID");
	if (message.answers.length < 1 || message.answers.length > MAX_ATTENDANCE_ANSWERS) {
		throw new Error(`an attendance poll has 1 to ${MAX_ATTENDANCE_ANSWERS} answers`);
	}
	return [
		{
			type: 1,
			components: message.answers.map((label, i) => ({
				type: 2 as const,
				// Secondary: no answer looks like the "right" one.
				style: 2 as const,
				label: [...label].length > 80 ? `${[...label].slice(0, 79).join("")}…` : label,
				custom_id: `${ATTEND_PREFIX}${message.pollId}:${i}`,
			})),
		},
	];
}

/** The parts of a button interaction this handler reads. */
export type IncomingAttendance = {
	guildId: string | null;
	customId: string;
	user: { id: string; displayName: string; username: string };
	reply(payload: DiscordReplyPayload): Promise<unknown>;
	deferReply(): Promise<unknown>;
	editReply(payload: DiscordEditPayload): Promise<unknown>;
};

export type AttendanceHandlerDeps = {
	guildId: string;
	dispatcher: Pick<Dispatcher, "act">;
	deferAfterMs: number;
};

/**
 * Handles a click on an attendance button: the configured server only, an exact
 * custom ID only, then `Dispatcher.act` for the clicker. Whatever happens, the answer
 * is private.
 */
export function createAttendanceHandler({
	guildId,
	dispatcher,
	deferAfterMs,
}: AttendanceHandlerDeps) {
	return async (interaction: IncomingAttendance, displayName?: string): Promise<void> => {
		if (interaction.guildId !== guildId) {
			await interaction.reply(renderReply({ text: WRONG_GUILD_MESSAGE }, true));
			return;
		}
		const parsed = parseAttendId(interaction.customId);
		if (!parsed) {
			await interaction.reply(renderReply({ text: STALE_MESSAGE }, true));
			return;
		}
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
				action: ATTEND_ACTION,
				args: { poll: parsed.poll, answer: parsed.answer },
			});
		} finally {
			clearTimeout(timer);
		}
		// The action never opens a form: one that does has a bug.
		if (outcome.kind === "form") throw new Error(`action "${ATTEND_ACTION}" opened a form`);
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
