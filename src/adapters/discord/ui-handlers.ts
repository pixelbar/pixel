import type { ActionOutcome, ActionRequest, Dispatcher } from "../../core/dispatcher.ts";
import type { Form } from "../../core/ui.ts";
import {
	controlArgs,
	formArgs,
	type HeldControls,
	renderForm,
	type SubmittedField,
} from "./controls.ts";
import { controlsFor, discordActor, WRONG_GUILD_MESSAGE } from "./handlers.ts";
import {
	type DiscordEditPayload,
	type DiscordReplyPayload,
	renderEdit,
	renderReply,
} from "./render.ts";

/**
 * Buttons, select menus and the forms they open. Every use becomes a
 * `Dispatcher.act` call for the person who used it, so it's checked exactly like a
 * command. What it runs comes from what Pixel holds (`controls.ts`), never from
 * Discord: the click only says which control, and which of the offered values.
 */

export const CONTROL_EXPIRED_MESSAGE = "That's expired. Run the command again.";
export const NOT_YOURS_MESSAGE = "That isn't yours to use. Run the command yourself.";
export const SLOW_FORM_MESSAGE = "That took too long to open. Try again.";

type User = { id: string; displayName: string; username: string };

/** What answering a control or a form needs: replace its message, or reply apart from it. */
type Answerable = {
	update(payload: DiscordEditPayload): Promise<unknown>;
	deferUpdate(): Promise<unknown>;
	editReply(payload: DiscordEditPayload): Promise<unknown>;
	reply(payload: DiscordReplyPayload): Promise<unknown>;
	followUp(payload: DiscordReplyPayload): Promise<unknown>;
};

/** The parts of a button or select menu interaction the handler reads. */
export type IncomingControl = Answerable & {
	guildId: string | null;
	customId: string;
	user: User;
	/** The chosen values, for a select menu. */
	values?: readonly string[];
	showModal(modal: ReturnType<typeof renderForm>): Promise<unknown>;
};

/** The parts of a submitted form (opened from a control on a message) the handler reads. */
export type IncomingUiForm = Answerable & {
	guildId: string | null;
	customId: string;
	user: User;
	fields: readonly SubmittedField[];
};

export type UiHandlerDeps = {
	guildId: string;
	dispatcher: Pick<Dispatcher, "act">;
	deferAfterMs: number;
	controls: HeldControls;
};

export function createControlHandler({
	guildId,
	dispatcher,
	deferAfterMs,
	controls,
}: UiHandlerDeps) {
	return async (interaction: IncomingControl, displayName?: string): Promise<void> => {
		if (interaction.guildId !== guildId) {
			await interaction.reply(renderReply({ text: WRONG_GUILD_MESSAGE }, true));
			return;
		}
		const held = controls.control(interaction.customId, interaction.user.id);
		if (held === "expired" || held === "not-yours") {
			await refuse(interaction, held);
			return;
		}
		const args = controlArgs(held.control, interaction.values);
		if (!args) {
			await refuse(interaction, "expired");
			return;
		}
		const actor = discordActor(interaction.user, displayName);
		await answer(interaction, {
			request: { actor, action: held.control.call.action, args },
			dispatcher,
			deferAfterMs,
			controls,
			openForm: (form) =>
				interaction.showModal(
					renderForm(form, controls.holdForm(interaction.user.id, form, held.token)),
				),
			replaced: held.token,
		});
	};
}

export function createUiFormHandler({
	guildId,
	dispatcher,
	deferAfterMs,
	controls,
}: UiHandlerDeps) {
	return async (interaction: IncomingUiForm, displayName?: string): Promise<void> => {
		if (interaction.guildId !== guildId) {
			await interaction.reply(renderReply({ text: WRONG_GUILD_MESSAGE }, true));
			return;
		}
		const held = controls.takeForm(interaction.customId, interaction.user.id);
		if (held === "expired" || held === "not-yours") {
			await refuse(interaction, held);
			return;
		}
		const input = formArgs(held.form, interaction.fields);
		if (!input) {
			await refuse(interaction, "expired");
			return;
		}
		const actor = discordActor(interaction.user, displayName);
		await answer(interaction, {
			request: { actor, action: held.form.submit.action, ...input },
			dispatcher,
			deferAfterMs,
			controls,
			// Discord can't open a form from a form. A feature that tries has a bug.
			openForm: () => {
				throw new Error(`action "${held.form.submit.action}" opened a form from a form`);
			},
			...(held.panel === undefined ? {} : { replaced: held.panel }),
		});
	};
}

function refuse(interaction: Answerable, why: "expired" | "not-yours"): Promise<unknown> {
	const text = why === "expired" ? CONTROL_EXPIRED_MESSAGE : NOT_YOURS_MESSAGE;
	return interaction.reply(renderReply({ text }, true));
}

/**
 * Runs the action and answers within Discord's 3 seconds: by replacing the message,
 * opening a form, or replying privately when it was refused. If the action is slow,
 * the update is deferred first; a form can't open after that, so the person is asked
 * to try again.
 */
async function answer(
	interaction: Answerable,
	options: {
		request: ActionRequest;
		dispatcher: Pick<Dispatcher, "act">;
		deferAfterMs: number;
		controls: HeldControls;
		openForm: (form: Form) => Promise<unknown>;
		/** The token of the controls on the message, released once it's replaced. */
		replaced?: string;
	},
): Promise<void> {
	const { request, dispatcher, deferAfterMs, controls } = options;
	let deferred: Promise<unknown> | undefined;
	const timer = setTimeout(() => {
		deferred = interaction.deferUpdate();
		// Awaited below, once the action is done.
		deferred.catch(() => {});
	}, deferAfterMs);
	let outcome: ActionOutcome;
	try {
		outcome = await dispatcher.act(request);
	} finally {
		clearTimeout(timer);
	}
	if (deferred) await deferred;

	switch (outcome.kind) {
		case "update": {
			const payload = renderEdit(outcome.reply, controlsFor(controls, request.actor.userId));
			await (deferred ? interaction.editReply(payload) : interaction.update(payload));
			if (options.replaced !== undefined) controls.release(options.replaced);
			return;
		}
		case "form":
			if (deferred) {
				await interaction.followUp(renderReply({ text: SLOW_FORM_MESSAGE }, true));
				return;
			}
			await options.openForm(outcome.form);
			return;
		default: {
			const payload = renderReply(outcome.reply, true);
			await (deferred ? interaction.followUp(payload) : interaction.reply(payload));
		}
	}
}
