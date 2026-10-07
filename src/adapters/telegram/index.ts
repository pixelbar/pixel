import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { CommandDefinition } from "../../core/command.ts";
import type { Dispatcher } from "../../core/dispatcher.ts";
import type { Logger } from "../../core/logger.ts";
import { telegramCommands } from "./commands.ts";
import { type Button, createTelegramHandler } from "./handlers.ts";

/**
 * Thin wiring between grammY and the handlers in handlers.ts, which hold the logic
 * and are unit-tested. Long polling, so there's no inbound endpoint: Pixel asks
 * Telegram for updates. A second copy polling with the same token gets a conflict
 * from Telegram, which is why Pixel must run once per bot.
 */

export type TelegramAdapterDeps = {
	/** The bot token from @BotFather. A secret: never logged. */
	token: string;
	dispatcher: Pick<Dispatcher, "dispatch" | "suggest">;
	/** Every registered command; the adapter keeps those that run on Telegram. */
	commands: readonly CommandDefinition[];
	logger: Logger;
	reportError: (error: unknown) => void;
};

export type TelegramAdapter = {
	start(): Promise<void>;
	stop(): Promise<void>;
	isReady(): boolean;
};

const keyboard = (buttons: readonly Button[] | undefined) => {
	if (!buttons || buttons.length === 0) return undefined;
	const board = new InlineKeyboard();
	for (const button of buttons) board.text(button.text.slice(0, 64), button.data).row();
	return board;
};

export function createTelegramAdapter(deps: TelegramAdapterDeps): TelegramAdapter {
	const logger = deps.logger.child({ adapter: "telegram" });
	const commands = telegramCommands(deps.commands);
	const bot = new Bot(deps.token);
	let ready = false;
	let handler: ReturnType<typeof createTelegramHandler> | undefined;

	const sendOptions = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

	bot.on("message:text", async (ctx) => {
		const chatId = ctx.chat.id;
		await handler?.onMessage(
			{ chat: { type: ctx.chat.type }, ...(ctx.from ? { from: ctx.from } : {}), text: ctx.message.text },
			{
				async send(html, buttons) {
					const markup = keyboard(buttons);
					const sent = await ctx.api.sendMessage(chatId, html, {
						...sendOptions,
						...(markup ? { reply_markup: markup } : {}),
					});
					return sent.message_id;
				},
				async edit(messageId, html) {
					await ctx.api.editMessageText(chatId, messageId, html, sendOptions);
				},
			},
		);
	});

	bot.on("callback_query:data", async (ctx) => {
		const chatId = ctx.chat?.id;
		await handler?.onCallback(
			{
				from: ctx.from,
				data: ctx.callbackQuery.data,
				...(ctx.callbackQuery.message ? { messageId: ctx.callbackQuery.message.message_id } : {}),
			},
			{
				async answer(text) {
					await ctx.answerCallbackQuery(text ? { text } : undefined);
				},
				async send(html, buttons) {
					if (chatId === undefined) return 0;
					const markup = keyboard(buttons);
					const sent = await ctx.api.sendMessage(chatId, html, {
						...sendOptions,
						...(markup ? { reply_markup: markup } : {}),
					});
					return sent.message_id;
				},
				async edit(messageId, html) {
					if (chatId === undefined) return;
					await ctx.api.editMessageText(chatId, messageId, html, sendOptions);
				},
			},
		);
	});

	bot.catch((error) => {
		// Telegram's own errors carry a description; never the token.
		const cause = error.error;
		const why =
			cause instanceof GrammyError
				? `telegram ${cause.error_code}: ${cause.description}`
				: cause instanceof HttpError
					? "network error"
					: cause instanceof Error
						? cause.name
						: "unknown";
		logger.error({ event: "telegram.update_failed", why, err: cause }, "failed to handle an update");
		deps.reportError(cause);
	});

	return {
		async start() {
			await bot.init();
			handler = createTelegramHandler({
				dispatcher: deps.dispatcher,
				commands,
				botUsername: bot.botInfo.username,
				logger: deps.logger,
			});
			// The menu people see when they type "/" (Telegram allows 100).
			await bot.api.setMyCommands(
				commands.slice(0, 100).map((c) => ({ command: c.name, description: c.description.slice(0, 256) })),
			);
			// Not awaited: it resolves when polling stops.
			void bot
				.start({
					allowed_updates: ["message", "callback_query"],
					onStart: () => {
						ready = true;
						logger.info(
							{ event: "telegram.ready", bot: bot.botInfo.username, commands: commands.length },
							"connected to Telegram",
						);
					},
				})
				.catch((error: unknown) => {
					ready = false;
					logger.error({ event: "telegram.polling_failed", err: error }, "Telegram polling stopped");
					deps.reportError(error);
				});
		},
		async stop() {
			ready = false;
			await bot.stop();
		},
		isReady: () => ready,
	};
}
