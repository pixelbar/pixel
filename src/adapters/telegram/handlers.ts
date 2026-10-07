import { randomBytes } from "node:crypto";
import type { PlatformActor } from "../../core/access.ts";
import type { Args, Suggestion } from "../../core/command.ts";
import type { Dispatcher } from "../../core/dispatcher.ts";
import type { Logger } from "../../core/logger.ts";
import { type TelegramCommand, usage } from "./commands.ts";
import { parseCommand } from "./parse.ts";
import { renderReply } from "./render.ts";

/**
 * Telegram event handling, kept free of grammY so the decisions (DMs only, who the
 * actor is, what to ask for, what to send) are testable with plain objects.
 *
 * - **DMs only.** In a group, a command gets one short "message me directly" and
 *   nothing else, so no reply (private or not) ever lands in a group.
 * - **Inline keyboards instead of autocomplete.** A command missing a required value
 *   that has suggestions (or fixed choices) shows buttons for it, from the same
 *   access-checked `Dispatcher.suggest`. A button sends only an index into what
 *   Pixel offered, kept here for a few minutes for that one person, and the
 *   command is checked again by the dispatcher when it runs.
 */

/** The parts of a Telegram user the handler reads. The ID is the only thing used for identity. */
export type TelegramUser = {
	id: number;
	first_name: string;
	last_name?: string;
	username?: string;
	is_bot: boolean;
};

export type IncomingMessage = {
	chat: { type: "private" | "group" | "supergroup" | "channel" };
	from?: TelegramUser;
	text: string;
};

export type IncomingCallback = {
	from: TelegramUser;
	data: string;
	/** The message the buttons were on, so it can be updated. */
	messageId?: number;
};

export type Button = { text: string; data: string };

/** What the handler can do in the chat. */
export type ChatOutput = {
	/** Sends a message (HTML), with buttons if given, and returns its ID. */
	send(html: string, buttons?: readonly Button[]): Promise<number>;
	edit(messageId: number, html: string): Promise<void>;
};

export type CallbackOutput = ChatOutput & {
	/** Stops the button's spinner, optionally with a short notice. */
	answer(text?: string): Promise<void>;
};

export const DM_ONLY_MESSAGE = "I only work in a direct message. Message me there.";
export const EXPIRED_MESSAGE = "That menu has expired. Run the command again.";
export const NOT_YOURS_MESSAGE = "That menu is for someone else.";

/** How long a menu of buttons stays usable. */
const PENDING_MS = 5 * 60_000;
/** At most this many menus waiting at once, so nobody can fill memory. */
const MAX_PENDING = 500;
/** Telegram allows at most 64 bytes of callback data: "p:" + 16 hex + ":" + index fits. */
const CALLBACK = /^p:([0-9a-f]{16}):(\d{1,2})$/;

type Pending = {
	userId: string;
	command: TelegramCommand;
	args: Args;
	option: string;
	values: readonly (string | number)[];
	expires: number;
};

export type TelegramHandlerDeps = {
	dispatcher: Pick<Dispatcher, "dispatch" | "suggest">;
	commands: readonly TelegramCommand[];
	botUsername: string;
	logger: Logger;
	now?: () => number;
};

/** Who is behind a Telegram update, by their immutable numeric ID. Names are for display and logs only. */
export function telegramActor(user: TelegramUser): PlatformActor {
	const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
	return {
		platform: "telegram",
		userId: String(user.id),
		displayName: name || user.username || String(user.id),
		...(user.username ? { handle: user.username } : {}),
		chat: "dm",
	};
}

export function createTelegramHandler(deps: TelegramHandlerDeps) {
	const now = deps.now ?? Date.now;
	const byName = new Map(deps.commands.map((c) => [c.name, c]));
	const names = new Map(deps.commands.map((c) => [c.coreName, c.name]));
	const pending = new Map<string, Pending>();
	const log = deps.logger.child({ adapter: "telegram" });

	const render = (reply: Parameters<typeof renderReply>[0]) => renderReply(reply, names);

	function prune(): void {
		const time = now();
		for (const [token, entry] of pending) if (entry.expires <= time) pending.delete(token);
		// Oldest first, if a flood of menus is waiting.
		while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
	}

	/** Runs the command, or asks for the next missing value with buttons. */
	async function run(actor: PlatformActor, command: TelegramCommand, args: Args, out: ChatOutput) {
		const missing = command.options.find(
			(o) => o.required && o.type !== "user" && args[o.name] === undefined,
		);
		if (missing) {
			const offered = await offer(actor, command, args, missing.name);
			if (offered.length > 0) {
				prune();
				const token = randomBytes(8).toString("hex");
				pending.set(token, {
					userId: actor.userId,
					command,
					args,
					option: missing.name,
					values: offered.map((s) => s.value),
					expires: now() + PENDING_MS,
				});
				const buttons = offered.map((s, index) => ({ text: s.name, data: `p:${token}:${index}` }));
				await out.send(`Pick ${escapeText(missing.description.toLowerCase())}:`, buttons);
				return;
			}
			// Nothing to offer: say how to use it, rather than a bare "missing option".
			await out.send(`Usage: <code>${escapeText(usage(command))}</code>`);
			return;
		}

		let placeholder: number | undefined;
		const result = await deps.dispatcher.dispatch(
			{ actor, command: command.path.command, ...pathParts(command), args },
			{
				onPending: async ({ reply }) => {
					placeholder = await out.send(render(reply));
				},
			},
		);
		const html = render(result.reply);
		if (placeholder !== undefined) await out.edit(placeholder, html);
		else await out.send(html);
	}

	/** Values to offer for an option: its fixed choices, or the dispatcher's access-checked suggestions. */
	async function offer(
		actor: PlatformActor,
		command: TelegramCommand,
		args: Args,
		optionName: string,
	): Promise<Suggestion[]> {
		const option = command.options.find((o) => o.name === optionName);
		if (option?.type === "string" && option.choices) {
			return option.choices.map((choice) => ({ name: choice, value: choice }));
		}
		if (!option || !("suggest" in option) || !option.suggest) return [];
		return deps.dispatcher.suggest({
			actor,
			command: command.path.command,
			...pathParts(command),
			option: optionName,
			typed: "",
			args,
		});
	}

	return {
		async onMessage(message: IncomingMessage, out: ChatOutput): Promise<void> {
			const user = message.from;
			if (!user || user.is_bot) return;
			const parsed = parseCommand(message.text, byName, deps.botUsername);
			if (message.chat.type !== "private") {
				// Only answer a command meant for us, and never with anything but this.
				if (parsed.kind === "command" || parsed.kind === "unknown") await out.send(DM_ONLY_MESSAGE);
				return;
			}
			if (parsed.kind === "not-a-command" || parsed.kind === "not-for-us") {
				await out.send("Send /help to see what I can do.");
				return;
			}
			if (parsed.kind === "unknown") {
				await out.send("I don't know that command. Send /help to see what you can use.");
				return;
			}
			await run(telegramActor(user), parsed.command, parsed.args, out);
		},

		async onCallback(callback: IncomingCallback, out: CallbackOutput): Promise<void> {
			const match = CALLBACK.exec(callback.data);
			const entry = match ? pending.get(match[1] as string) : undefined;
			if (!match || !entry || entry.expires <= now()) {
				if (match) pending.delete(match[1] as string);
				await out.answer(EXPIRED_MESSAGE);
				return;
			}
			const actor = telegramActor(callback.from);
			// Only the person the menu was made for can use it.
			if (entry.userId !== actor.userId) {
				log.warn({ event: "telegram.callback_foreign" }, "someone pressed another person's button");
				await out.answer(NOT_YOURS_MESSAGE);
				return;
			}
			const value = entry.values[Number(match[2])];
			pending.delete(match[1] as string);
			if (value === undefined) {
				await out.answer(EXPIRED_MESSAGE);
				return;
			}
			await out.answer();
			if (callback.messageId !== undefined) {
				await out.edit(
					callback.messageId,
					`${escapeText(entry.option)}: <code>${escapeText(String(value))}</code>`,
				);
			}
			await run(actor, entry.command, { ...entry.args, [entry.option]: value }, out);
		},

		/** How many menus are waiting. For tests and status. */
		get pendingCount(): number {
			return pending.size;
		},
	};
}

function pathParts(command: TelegramCommand): { subgroup?: string; subcommand?: string } {
	return {
		...(command.path.subgroup ? { subgroup: command.path.subgroup } : {}),
		...(command.path.subcommand ? { subcommand: command.path.subcommand } : {}),
	};
}

function escapeText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
