import { ApplicationCommandOptionType, MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DispatchHooks, DispatchRequest, DispatchResult } from "../../core/dispatcher.ts";
import { silentLogger } from "../../core/logger.ts";
import { IDS } from "../../testing/fixtures.ts";
import {
	createCommandHandler,
	createGuildGuard,
	type IncomingCommand,
	WRONG_GUILD_MESSAGE,
} from "./handlers.ts";

const GUILD = "100000000000000020";
const OTHER_GUILD = "100000000000000099";

function fakeDispatcher(result: DispatchResult = { reply: { text: "ok" }, private: false }) {
	return {
		dispatch: vi.fn(async (_req: DispatchRequest, _hooks?: DispatchHooks) => result),
		defaultPrivacy: vi.fn((_name: string, _sub?: string) => false),
	};
}

function fakeInteraction(overrides: Partial<IncomingCommand> = {}) {
	return {
		guildId: GUILD,
		commandName: "whoami",
		user: { id: IDS.member, displayName: "global-name", username: "member_handle" },
		options: { data: [] },
		reply: vi.fn(async () => {}),
		deferReply: vi.fn(async () => {}),
		editReply: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		deleteReply: vi.fn(async () => {}),
		...overrides,
	} satisfies IncomingCommand;
}

describe("createCommandHandler", () => {
	it.each([
		["another guild", OTHER_GUILD],
		["outside any guild (DM)", null],
	])("refuses interactions from %s without dispatching", async (_label, guildId) => {
		const dispatcher = fakeDispatcher();
		const handle = createCommandHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500 });
		const interaction = fakeInteraction({ guildId });

		await handle(interaction);

		expect(dispatcher.dispatch).not.toHaveBeenCalled();
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: WRONG_GUILD_MESSAGE,
				flags: MessageFlags.Ephemeral,
				allowedMentions: { parse: [] },
			}),
		);
	});

	it("dispatches commands from the configured guild with the user's ID, name and handle", async () => {
		const dispatcher = fakeDispatcher();
		const handle = createCommandHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500 });
		const interaction = fakeInteraction({
			commandName: "info",
			options: {
				data: [{ name: "topic", type: ApplicationCommandOptionType.String, value: "hours" }],
			},
		});

		await handle(interaction, "Server Nick");

		expect(dispatcher.dispatch).toHaveBeenCalledWith(
			{
				actor: {
					platform: "discord",
					userId: IDS.member,
					displayName: "Server Nick",
					handle: "member_handle",
					chat: "group",
				},
				command: "info",
				args: { topic: "hours" },
				users: {},
			},
			{ onPending: expect.any(Function) },
		);
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "ok" }));
	});

	it("passes the subcommand and a picked user's ID to the dispatcher", async () => {
		const dispatcher = fakeDispatcher();
		const handle = createCommandHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500 });
		const target = { id: IDS.guest, displayName: "Target", username: "target", bot: false };
		const interaction = fakeInteraction({
			commandName: "admin",
			options: {
				data: [
					{
						name: "whois",
						type: ApplicationCommandOptionType.Subcommand,
						options: [
							{
								name: "who",
								type: ApplicationCommandOptionType.User,
								value: IDS.guest,
								user: target,
							},
						],
					},
				],
			},
		});

		await handle(interaction);

		expect(dispatcher.defaultPrivacy).toHaveBeenCalledWith("admin", "whois");
		expect(dispatcher.dispatch.mock.calls[0]?.[0]).toMatchObject({
			command: "admin",
			subcommand: "whois",
			args: { who: IDS.guest },
			users: { who: { id: IDS.guest, displayName: "Target", handle: "target", isBot: false } },
		});
	});

	it("posts a placeholder from the dispatcher, then edits in the result", async () => {
		const dispatcher = fakeDispatcher();
		dispatcher.dispatch.mockImplementation(async (_req, hooks) => {
			await hooks?.onPending?.({ reply: { text: "Checking…" }, private: false });
			return { reply: { text: "Open" }, private: false };
		});
		const handle = createCommandHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500 });
		const interaction = fakeInteraction({ commandName: "status" });

		await handle(interaction);

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: "Checking…" }),
		);
		expect(interaction.editReply).toHaveBeenCalledWith(
			expect.objectContaining({ content: "Open" }),
		);
	});

	it("falls back to the user's global display name", async () => {
		const dispatcher = fakeDispatcher();
		const handle = createCommandHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500 });

		await handle(fakeInteraction());

		expect(dispatcher.dispatch.mock.calls[0]?.[0].actor.displayName).toBe("global-name");
	});

	it("uses the command's default privacy when deferring", async () => {
		vi.useFakeTimers();
		try {
			const dispatcher = fakeDispatcher({ reply: { text: "slow" }, private: true });
			dispatcher.defaultPrivacy.mockReturnValue(true);
			dispatcher.dispatch.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(() => resolve({ reply: { text: "slow" }, private: true }), 2000),
					),
			);
			const handle = createCommandHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500 });
			const interaction = fakeInteraction();

			const done = handle(interaction);
			await vi.advanceTimersByTimeAsync(2000);
			await done;

			expect(dispatcher.defaultPrivacy).toHaveBeenCalledWith("whoami", undefined);
			expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("createGuildGuard", () => {
	const guild = (id: string, leave = vi.fn(async () => {})) => ({ id, leave });

	it("stays in the configured guild", async () => {
		const g = guild(GUILD);
		await createGuildGuard({ guildId: GUILD, logger: silentLogger, reportError: vi.fn() })(g);
		expect(g.leave).not.toHaveBeenCalled();
	});

	it("leaves any other guild", async () => {
		const g = guild(OTHER_GUILD);
		await createGuildGuard({ guildId: GUILD, logger: silentLogger, reportError: vi.fn() })(g);
		expect(g.leave).toHaveBeenCalledOnce();
	});

	it("reports a failure to leave instead of throwing", async () => {
		const error = new Error("Missing Access");
		const reportError = vi.fn();
		const g = guild(
			OTHER_GUILD,
			vi.fn(async () => Promise.reject(error)),
		);

		await expect(
			createGuildGuard({ guildId: GUILD, logger: silentLogger, reportError })(g),
		).resolves.toBeUndefined();
		expect(reportError).toHaveBeenCalledWith(error);
	});
});
