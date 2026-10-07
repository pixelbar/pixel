import { ApplicationCommandOptionType, ChannelType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type {
	DispatchHooks,
	DispatchRequest,
	DispatchResult,
	FormOption,
} from "../../core/dispatcher.ts";
import { command, IDS } from "../../testing/fixtures.ts";
import { callerAbilities, parseOptions } from "./args.ts";
import { requiredPermissions, toDiscordMessage } from "./channel-poster.ts";
import { toSlashCommand } from "./commands.ts";
import { FORM_PREFIX, formModal, PendingForms } from "./forms.ts";
import {
	createCommandHandler,
	createModalHandler,
	FORM_EXPIRED_MESSAGE,
	type IncomingCommand,
	type IncomingModal,
	WRONG_GUILD_MESSAGE,
} from "./handlers.ts";

const GUILD = "100000000000000020";
const CHANNEL = "100000000000000050";
const { ViewChannel, SendMessages, MentionEveryone, SendPolls, Administrator } =
	PermissionFlagsBits;

const TEXT: FormOption = {
	name: "text",
	description: "Message",
	type: "string",
	required: true,
	form: { style: "paragraph", maxLength: 2000, placeholder: "What to post" },
};
const QUESTION: FormOption = {
	name: "question",
	description: "Question",
	type: "string",
	form: { style: "short", maxLength: 300 },
};

describe("channel options", () => {
	it("register as text and announcement channels, and form fields aren't registered at all", () => {
		const json = toSlashCommand(
			command({
				name: "post",
				options: [{ name: "where", description: "Channel", type: "channel", required: true }, TEXT],
			}),
		);
		expect(json.options).toEqual([
			{
				name: "where",
				description: "Channel",
				required: true,
				type: ApplicationCommandOptionType.Channel,
				channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
			},
		]);
	});

	it("parse into the channel's ID and what the caller may do there", () => {
		const parsed = parseOptions([
			{
				name: "where",
				type: ApplicationCommandOptionType.Channel,
				channel: { id: CHANNEL, name: "general" },
				callerPermissions: ViewChannel | SendMessages | SendPolls,
			},
		]);
		expect(parsed.args).toEqual({ where: CHANNEL });
		expect(parsed.channels).toEqual({
			where: {
				id: CHANNEL,
				name: "general",
				caller: { canPost: true, canMentionEveryone: false, canCreatePolls: true },
			},
		});
	});

	it("fall back to the ID when Discord gives no name, and to no rights when it gives no permissions", () => {
		const parsed = parseOptions([
			{
				name: "where",
				type: ApplicationCommandOptionType.Channel,
				channel: { id: CHANNEL, name: null },
			},
		]);
		expect(parsed.channels.where).toEqual({
			id: CHANNEL,
			name: CHANNEL,
			caller: { canPost: false, canMentionEveryone: false, canCreatePolls: false },
		});
	});
});

describe("callerAbilities", () => {
	it("needs both seeing and sending to post, and posting to ping or poll", () => {
		expect(callerAbilities(SendMessages).canPost).toBe(false);
		expect(callerAbilities(ViewChannel | SendMessages)).toEqual({
			canPost: true,
			canMentionEveryone: false,
			canCreatePolls: false,
		});
		expect(callerAbilities(ViewChannel | MentionEveryone | SendPolls)).toEqual({
			canPost: false,
			canMentionEveryone: false,
			canCreatePolls: false,
		});
		expect(callerAbilities(ViewChannel | SendMessages | MentionEveryone).canMentionEveryone).toBe(
			true,
		);
	});

	it("gives a server administrator everything, and unknown permissions nothing", () => {
		expect(callerAbilities(Administrator)).toEqual({
			canPost: true,
			canMentionEveryone: true,
			canCreatePolls: true,
		});
		expect(callerAbilities(null).canPost).toBe(false);
		expect(callerAbilities(undefined).canPost).toBe(false);
	});
});

describe("the poster's Discord messages", () => {
	it("send a message with pings off unless allowed", () => {
		expect(toDiscordMessage({ kind: "message", text: "hi @everyone", mentions: false })).toEqual({
			content: "hi @everyone",
			allowedMentions: { parse: [] },
		});
		expect(
			toDiscordMessage({ kind: "message", text: "hi", mentions: true }).allowedMentions,
		).toEqual({
			parse: ["everyone", "roles", "users"],
		});
	});

	it("send a native poll", () => {
		expect(
			toDiscordMessage({
				kind: "poll",
				question: "Who?",
				answers: ["Yes", "No"],
				durationHours: 24,
				multiple: true,
			}),
		).toEqual({
			poll: {
				question: { text: "Who?" },
				answers: [{ text: "Yes" }, { text: "No" }],
				duration: 24,
				allowMultiselect: true,
			},
			allowedMentions: { parse: [] },
		});
	});

	it("need sending, plus polls or pinging when the post does", () => {
		expect(requiredPermissions({ kind: "message", text: "x", mentions: false })).toEqual([
			ViewChannel,
			SendMessages,
		]);
		expect(requiredPermissions({ kind: "message", text: "x", mentions: true })).toContain(
			MentionEveryone,
		);
		expect(
			requiredPermissions({
				kind: "poll",
				question: "q",
				answers: ["a", "b"],
				durationHours: 1,
				multiple: false,
			}),
		).toContain(SendPolls);
	});
});

describe("formModal", () => {
	it("has one text box per field, short or paragraph, with its limit and placeholder", () => {
		expect(formModal("pixel-form:x", "/schedule message", [TEXT, QUESTION])).toEqual({
			custom_id: "pixel-form:x",
			title: "/schedule message",
			components: [
				{
					type: 1,
					components: [
						{
							type: 4,
							custom_id: "text",
							label: "Message",
							style: 2,
							required: true,
							max_length: 2000,
							placeholder: "What to post",
						},
					],
				},
				{
					type: 1,
					components: [
						{
							type: 4,
							custom_id: "question",
							label: "Question",
							style: 1,
							required: false,
							max_length: 300,
						},
					],
				},
			],
		});
	});

	it("keeps the title within Discord's limit", () => {
		expect(formModal("x", "y".repeat(60), [TEXT]).title).toHaveLength(45);
	});
});

describe("PendingForms", () => {
	const request = (userId = IDS.member): DispatchRequest => ({
		actor: { platform: "discord", userId, displayName: "A", chat: "group" },
		command: "schedule",
		subcommand: "message",
		args: { when: "wed 19" },
	});

	it("keeps a command for its form, for the same person, once", () => {
		const forms = new PendingForms();
		const id = forms.hold(request(), [TEXT]);
		expect(id.startsWith(FORM_PREFIX)).toBe(true);
		expect(forms.take(id, IDS.guest)).toBe("not-yours");
		const taken = forms.take(id, IDS.member);
		expect(taken).toMatchObject({ request: request(), fields: [TEXT] });
		expect(forms.take(id, IDS.member)).toBe("expired");
	});

	it("expires after 15 minutes, and refuses IDs it didn't make", () => {
		let now = 0;
		const forms = new PendingForms(() => now);
		const id = forms.hold(request(), [TEXT]);
		now = 15 * 60_000;
		expect(forms.take(id, IDS.member)).toBe("expired");
		expect(forms.size).toBe(0);
		expect(forms.take("pixel-form:nothex", IDS.member)).toBe("expired");
		expect(forms.take("something-else", IDS.member)).toBe("expired");
	});

	it("never holds more than its limit, dropping the oldest", () => {
		const forms = new PendingForms();
		const first = forms.hold(request(), [TEXT]);
		for (let i = 0; i < 250; i++) forms.hold(request(), [TEXT]);
		expect(forms.size).toBeLessThanOrEqual(200);
		expect(forms.take(first, IDS.member)).toBe("expired");
	});
});

function fakeDispatcher(fields: FormOption[], refused?: DispatchResult) {
	return {
		dispatch: vi.fn(
			async (_req: DispatchRequest, _hooks?: DispatchHooks): Promise<DispatchResult> => ({
				reply: { text: "done" },
				private: true,
			}),
		),
		defaultPrivacy: vi.fn(() => true),
		formFields: vi.fn(() => fields),
		precheck: vi.fn(async (): Promise<DispatchResult | undefined> => refused),
	};
}
const respondable = () => ({
	reply: vi.fn(async () => {}),
	deferReply: vi.fn(async () => {}),
	editReply: vi.fn(async () => {}),
	followUp: vi.fn(async () => {}),
	deleteReply: vi.fn(async () => {}),
});
const incoming = (over: Partial<IncomingCommand> = {}): IncomingCommand => ({
	...respondable(),
	guildId: GUILD,
	commandName: "schedule",
	user: { id: IDS.member, displayName: "Ada", username: "ada" },
	options: {
		data: [
			{
				name: "message",
				type: ApplicationCommandOptionType.Subcommand,
				options: [
					{ name: "when", type: ApplicationCommandOptionType.String, value: "wed 19" },
					{
						name: "channel",
						type: ApplicationCommandOptionType.Channel,
						channel: { id: CHANNEL, name: "general" },
						callerPermissions: ViewChannel | SendMessages,
					},
				],
			},
		],
	},
	showModal: vi.fn(async () => {}),
	...over,
});
const modal = (
	customId: string,
	values: Record<string, string>,
	over: Partial<IncomingModal> = {},
): IncomingModal => ({
	...respondable(),
	guildId: GUILD,
	customId,
	user: { id: IDS.member, displayName: "Ada", username: "ada" },
	fields: { getTextInputValue: (id: string) => values[id] ?? "" },
	...over,
});

describe("commands with a form", () => {
	it("open the form first, then run with what was typed in it plus the options", async () => {
		const forms = new PendingForms();
		const dispatcher = fakeDispatcher([TEXT, QUESTION]);
		const command = incoming();
		await createCommandHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500, forms })(command);
		expect(dispatcher.dispatch).not.toHaveBeenCalled();
		const [shown] = vi.mocked(command.showModal).mock.calls[0] as [ReturnType<typeof formModal>];
		expect(shown.title).toBe("/schedule message");

		const submitted = modal(shown.custom_id, { text: "Pizza night!", question: "" });
		await createModalHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500, forms })(submitted);
		const [request] = dispatcher.dispatch.mock.calls[0] as [DispatchRequest];
		expect(request).toMatchObject({
			command: "schedule",
			subcommand: "message",
			args: { when: "wed 19", channel: CHANNEL, text: "Pizza night!" },
			channels: { channel: { id: CHANNEL, name: "general", caller: { canPost: true } } },
		});
		// An empty optional field is left out, not passed as "".
		expect(request.args).not.toHaveProperty("question");
		expect(submitted.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "done" }));
	});

	it("tell someone who'd be refused straight away, without opening the form", async () => {
		const dispatcher = fakeDispatcher([TEXT], { reply: { text: "no" }, private: true });
		const command = incoming();
		await createCommandHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500 })(command);
		expect(command.showModal).not.toHaveBeenCalled();
		expect(command.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "no" }));
	});

	it("refuse a form that expired, was already used, or isn't theirs", async () => {
		const forms = new PendingForms();
		const dispatcher = fakeDispatcher([TEXT]);
		const handle = createModalHandler({ guildId: GUILD, dispatcher, deferAfterMs: 1500, forms });
		const stale = modal("pixel-form:000000000000000000000000", { text: "x" });
		await handle(stale);
		expect(stale.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: FORM_EXPIRED_MESSAGE }),
		);
		const id = forms.hold(
			{
				actor: { platform: "discord", userId: IDS.admin, displayName: "B", chat: "group" },
				command: "schedule",
				args: {},
			},
			[TEXT],
		);
		const someoneElse = modal(id, { text: "x" });
		await handle(someoneElse);
		expect(someoneElse.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: FORM_EXPIRED_MESSAGE }),
		);
		expect(dispatcher.dispatch).not.toHaveBeenCalled();
	});

	it("refuse a form from another server", async () => {
		const dispatcher = fakeDispatcher([TEXT]);
		const submitted = modal("pixel-form:x", {}, { guildId: "100000000000000099" });
		await createModalHandler({
			guildId: GUILD,
			dispatcher,
			deferAfterMs: 1500,
			forms: new PendingForms(),
		})(submitted);
		expect(submitted.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: WRONG_GUILD_MESSAGE }),
		);
	});
});
