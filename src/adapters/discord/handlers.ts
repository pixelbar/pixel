import type { PlatformActor } from "../../core/access.ts";
import type { Dispatcher, DispatchRequest } from "../../core/dispatcher.ts";
import type { Logger } from "../../core/logger.ts";
import { type DiscordOption, parseAutocomplete, parseOptions } from "./args.ts";
import { formModal, PendingForms } from "./forms.ts";
import { renderReply } from "./render.ts";
import { type Respondable, respond } from "./respond.ts";

/**
 * Discord event handling, kept free of the discord.js Client so the security
 * decisions here (guild allow-list, actor construction) are unit-testable.
 */

/**
 * Who is behind an interaction, by their immutable Discord ID. The names are for
 * display and logs only, never for authorisation.
 */
export function discordActor(
	user: { id: string; displayName: string; username: string },
	displayName?: string,
): PlatformActor {
	return {
		platform: "discord",
		userId: user.id,
		displayName: displayName ?? user.displayName,
		handle: user.username,
		chat: "group",
	};
}

export const WRONG_GUILD_MESSAGE = "Pixel only works in the Pixelbar Discord server.";

/** The parts of a ChatInputCommandInteraction the command handler reads. */
export type IncomingCommand = Respondable & {
	guildId: string | null;
	commandName: string;
	user: { id: string; displayName: string; username: string };
	options: { data: readonly DiscordOption[] };
	/** Opens a modal. Only possible as the first response. */
	showModal(modal: ReturnType<typeof formModal>): Promise<unknown>;
};

/** The parts of a ModalSubmitInteraction the form handler reads. */
export type IncomingModal = Respondable & {
	guildId: string | null;
	customId: string;
	user: { id: string; displayName: string; username: string };
	/** What was typed in each field, by the field's custom ID (the option's name). */
	fields: { getTextInputValue(customId: string): string };
};

export type CommandHandlerDeps = {
	guildId: string;
	dispatcher: Pick<Dispatcher, "dispatch" | "defaultPrivacy" | "formFields" | "prepareForm">;
	deferAfterMs: number;
	/** Commands waiting for their form. Shared with the modal handler. */
	forms?: PendingForms;
};

export const FORM_EXPIRED_MESSAGE = "That form has expired. Run the command again.";

/**
 * Returns a handler for slash command interactions. Interactions from any
 * guild other than the configured one — or from outside a guild — are refused
 * before anything reaches the dispatcher.
 *
 * `displayName` is the caller's server nickname when known. It and the
 * username (handle) are for display and logs only, never for authorisation.
 */
export function createCommandHandler({
	guildId,
	dispatcher,
	deferAfterMs,
	forms = new PendingForms(),
}: CommandHandlerDeps) {
	return async (interaction: IncomingCommand, displayName?: string): Promise<void> => {
		if (interaction.guildId !== guildId) {
			await interaction.reply(renderReply({ text: WRONG_GUILD_MESSAGE }, true));
			return;
		}
		const actor = discordActor(interaction.user, displayName);
		const { subgroup, subcommand, args, users, channels } = parseOptions(interaction.options.data);
		const request: DispatchRequest = {
			actor,
			command: interaction.commandName,
			subgroup,
			subcommand,
			args,
			users,
			channels,
		};
		const fields = dispatcher.formFields(interaction.commandName, subcommand, subgroup);
		if (fields.length > 0) {
			// Access, then slash options such as `when`, before the body form opens.
			const prepared = await dispatcher.prepareForm(request);
			if (!prepared.ready) {
				await interaction.reply(renderReply(prepared.refuse.reply, true));
				return;
			}
			const fallback = [interaction.commandName, subgroup, subcommand].filter(Boolean).join(" ");
			await interaction.showModal(
				formModal(forms.hold(request, fields), prepared.title ?? `/${fallback}`, fields),
			);
			return;
		}
		await run(interaction, request, dispatcher, deferAfterMs);
	};
}

/**
 * Returns a handler for submitted forms. It finds the command waiting for this form,
 * adds what was typed, and runs it like any other command.
 */
export function createModalHandler({
	guildId,
	dispatcher,
	deferAfterMs,
	forms,
}: Omit<CommandHandlerDeps, "forms"> & { forms: PendingForms }) {
	return async (interaction: IncomingModal): Promise<void> => {
		if (interaction.guildId !== guildId) {
			await interaction.reply(renderReply({ text: WRONG_GUILD_MESSAGE }, true));
			return;
		}
		const pending = forms.take(interaction.customId, interaction.user.id);
		if (pending === "expired" || pending === "not-yours") {
			await interaction.reply(renderReply({ text: FORM_EXPIRED_MESSAGE }, true));
			return;
		}
		const typed = Object.fromEntries(
			pending.fields.map((field) => [field.name, interaction.fields.getTextInputValue(field.name)]),
		);
		// Only the typed text comes from the modal; empty optional fields are left out.
		const filled = Object.fromEntries(Object.entries(typed).filter(([, value]) => value !== ""));
		await run(
			interaction,
			{ ...pending.request, args: { ...pending.request.args, ...filled } },
			dispatcher,
			deferAfterMs,
		);
	};
}

function run(
	interaction: Respondable,
	request: DispatchRequest,
	dispatcher: Pick<Dispatcher, "dispatch" | "defaultPrivacy">,
	deferAfterMs: number,
): Promise<void> {
	return respond(interaction, {
		defaultPrivate: dispatcher.defaultPrivacy(
			request.command,
			request.subcommand,
			request.subgroup,
		),
		deferAfterMs,
		work: (showPending) => dispatcher.dispatch(request, { onPending: showPending }),
	});
}

/** The parts of an AutocompleteInteraction the suggestion handler reads. */
export type IncomingAutocomplete = {
	guildId: string | null;
	commandName: string;
	user: { id: string; displayName: string; username: string };
	options: { data: readonly DiscordOption[] };
	respond(choices: { name: string; value: string | number }[]): Promise<unknown>;
};

export type AutocompleteHandlerDeps = {
	guildId: string;
	dispatcher: Pick<Dispatcher, "suggest">;
};

/**
 * Returns a handler for autocomplete requests. Like commands, requests from any
 * other guild are ignored before anything reaches the dispatcher. It always
 * answers, with an empty list when there is nothing to suggest, because Discord
 * shows a failure otherwise. Access is the dispatcher's job: it only ever returns
 * suggestions to someone who may run the command.
 */
export function createAutocompleteHandler({ guildId, dispatcher }: AutocompleteHandlerDeps) {
	return async (interaction: IncomingAutocomplete, displayName?: string): Promise<void> => {
		if (interaction.guildId !== guildId) {
			await interaction.respond([]);
			return;
		}
		const actor = discordActor(interaction.user, displayName);
		const { subgroup, subcommand, focused, args } = parseAutocomplete(interaction.options.data);
		const choices = focused
			? await dispatcher.suggest({
					actor,
					command: interaction.commandName,
					subgroup,
					subcommand,
					option: focused.name,
					typed: focused.typed,
					args,
				})
			: [];
		await interaction.respond(choices);
	};
}

export type GuildLike = { id: string; leave(): Promise<unknown> };

export type GuildGuardDeps = {
	guildId: string;
	logger: Logger;
	reportError: (error: unknown) => void;
};

/** Returns a function that makes the bot leave any guild but the configured one. */
export function createGuildGuard({ guildId, logger, reportError }: GuildGuardDeps) {
	return async (guild: GuildLike): Promise<void> => {
		if (guild.id === guildId) return;
		logger.warn(
			{ event: "discord.foreign_guild" },
			"leaving a guild that isn't the configured one",
		);
		try {
			await guild.leave();
		} catch (error) {
			logger.error({ err: error }, "failed to leave foreign guild");
			reportError(error);
		}
	};
}
