import { ApplicationCommandOptionType, MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type {
	DispatchHooks,
	DispatchRequest,
	DispatchResult,
	SuggestRequest,
} from "../../core/dispatcher.ts";
import { silentLogger } from "../../core/logger.ts";
import { IDS } from "../../testing/fixtures.ts";
import {
	createAutocompleteHandler,
	createCommandHandler,
	createGuildGuard,
	discordActor,
	type IncomingAutocomplete,
	type IncomingCommand,
	WRONG_GUILD_MESSAGE,
} from "./handlers.ts";

const GUILD = "100000000000000020";
const OTHER_GUILD = "100000000000000099";

function fakeDispatcher(result: DispatchResult = { reply: { text: "ok" }, private: false }) {
	return {
		dispatch: vi.fn(async (_req: DispatchRequest, _hooks?: DispatchHooks) => result),
		defaultPrivacy: vi.fn((_name: string, _sub?: string, _group?: string) => false),
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

		expect(dispatcher.defaultPrivacy).toHaveBeenCalledWith("admin", "whois", undefined);
		expect(dispatcher.dispatch.mock.calls[0]?.[0]).toMatchObject({
			command: "admin",
			subcommand: "whois",
			args: { who: IDS.guest },
			users: { who: { id: IDS.guest, displayName: "Target", handle: "target", isBot: false } },
		});
	});

	it("passes the subgroup too", async () => {
		const dispatcher = fakeDispatcher();
		const handle = createCommandHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500 });
		const interaction = fakeInteraction({
			commandName: "admin",
			options: {
				data: [
					{
						name: "capabilities",
						type: ApplicationCommandOptionType.SubcommandGroup,
						options: [{ name: "grant", type: ApplicationCommandOptionType.Subcommand }],
					},
				],
			},
		});

		await handle(interaction);

		expect(dispatcher.defaultPrivacy).toHaveBeenCalledWith("admin", "grant", "capabilities");
		expect(dispatcher.dispatch.mock.calls[0]?.[0]).toMatchObject({
			command: "admin",
			subgroup: "capabilities",
			subcommand: "grant",
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

			expect(dispatcher.defaultPrivacy).toHaveBeenCalledWith("whoami", undefined, undefined);
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

describe("createAutocompleteHandler", () => {
	const string = ApplicationCommandOptionType.String;

	function fakeAutocomplete(overrides: Partial<IncomingAutocomplete> = {}) {
		return {
			guildId: GUILD,
			commandName: "ha",
			user: { id: IDS.member, displayName: "global-name", username: "member_handle" },
			options: {
				data: [
					{
						name: "run",
						type: ApplicationCommandOptionType.Subcommand,
						options: [
							{ name: "device", type: string, value: "door" },
							{ name: "action", type: string, value: "un", focused: true },
						],
					},
				],
			},
			respond: vi.fn(async () => {}),
			...overrides,
		} satisfies IncomingAutocomplete;
	}

	const dispatcherReturning = (choices: { name: string; value: string }[]) => ({
		suggest: vi.fn(async (_request: SuggestRequest) => choices),
	});

	it("asks the dispatcher with who is typing, what, and the other options, then answers", async () => {
		const dispatcher = dispatcherReturning([{ name: "Unlock", value: "unlock" }]);
		const interaction = fakeAutocomplete();
		await createAutocompleteHandler({ guildId: GUILD, dispatcher })(interaction, "Server Nick");

		expect(dispatcher.suggest).toHaveBeenCalledWith({
			actor: {
				platform: "discord",
				userId: IDS.member,
				displayName: "Server Nick",
				handle: "member_handle",
				chat: "group",
			},
			command: "ha",
			subcommand: "run",
			option: "action",
			typed: "un",
			args: { device: "door" },
		});
		expect(interaction.respond).toHaveBeenCalledWith([{ name: "Unlock", value: "unlock" }]);
	});

	it("falls back to the global display name", async () => {
		const dispatcher = dispatcherReturning([]);
		await createAutocompleteHandler({ guildId: GUILD, dispatcher })(fakeAutocomplete());
		expect(dispatcher.suggest.mock.calls[0]?.[0].actor.displayName).toBe("global-name");
	});

	it.each([
		["another guild", OTHER_GUILD],
		["outside any guild", null],
	])("answers with nothing, and asks nobody, from %s", async (_label, guildId) => {
		const dispatcher = dispatcherReturning([{ name: "x", value: "x" }]);
		const interaction = fakeAutocomplete({ guildId });
		await createAutocompleteHandler({ guildId: GUILD, dispatcher })(interaction);
		expect(dispatcher.suggest).not.toHaveBeenCalled();
		expect(interaction.respond).toHaveBeenCalledWith([]);
	});

	it("answers with nothing when Discord sent no focused option", async () => {
		const dispatcher = dispatcherReturning([{ name: "x", value: "x" }]);
		const interaction = fakeAutocomplete({ options: { data: [] } });
		await createAutocompleteHandler({ guildId: GUILD, dispatcher })(interaction);
		expect(dispatcher.suggest).not.toHaveBeenCalled();
		expect(interaction.respond).toHaveBeenCalledWith([]);
	});
});

describe("discordActor", () => {
	it("identifies the person by their immutable Discord ID, with names for display only", () => {
		expect(
			discordActor(
				{ id: IDS.member, displayName: "Global Name", username: "ada_l" },
				"Server Nick",
			),
		).toEqual({
			platform: "discord",
			userId: IDS.member,
			displayName: "Server Nick",
			handle: "ada_l",
			chat: "group",
		});
	});

	it("falls back to their global display name when there's no server nickname", () => {
		expect(
			discordActor({ id: IDS.member, displayName: "Global Name", username: "ada_l" }).displayName,
		).toBe("Global Name");
	});
});
