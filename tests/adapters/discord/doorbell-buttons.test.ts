import { MessageFlags } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTEND_PREFIX } from "../../../src/adapters/discord/attendance-buttons.ts";
import { toDoorbellMessage } from "../../../src/adapters/discord/channel-poster.ts";
import { CONTROL_PREFIX } from "../../../src/adapters/discord/controls.ts";
import {
	createDoorbellHandler,
	DOORBELL_PREFIX,
	doorbellComponents,
	type IncomingDoorbell,
	parseDoorbellId,
} from "../../../src/adapters/discord/doorbell-buttons.ts";
import { WRONG_GUILD_MESSAGE } from "../../../src/adapters/discord/handlers.ts";
import type { ActionOutcome, ActionRequest } from "../../../src/core/dispatcher.ts";
import { DOORBELL_ANSWER_ACTION, type DoorbellMessage } from "../../../src/core/doorbell.ts";
import { IDS } from "../../../src/testing/fixtures.ts";

const GUILD = "100000000000000020";
const USER = { id: IDS.friend, displayName: "Kim", username: "kim" };
const NOBODY = { parse: [] };
const CALL = "20261118-3f9a1c2b7d4e";

const message = (over: Partial<DoorbellMessage> = {}): DoorbellMessage => ({
	callId: CALL,
	text: "🔔 **Someone's at the door!**",
	answerable: true,
	...over,
});

describe("parseDoorbellId", () => {
	it("reads the call from one of Pixel's Answer buttons", () => {
		expect(parseDoorbellId(`${DOORBELL_PREFIX}${CALL}`)).toBe(CALL);
	});

	it.each([
		`${DOORBELL_PREFIX}${CALL.toUpperCase()}`,
		`${DOORBELL_PREFIX}${CALL}0`,
		`${DOORBELL_PREFIX}${CALL.slice(0, -1)}`,
		`${DOORBELL_PREFIX}${CALL} `,
		` ${DOORBELL_PREFIX}${CALL}`,
		`${DOORBELL_PREFIX}${CALL}:extra`,
		`${DOORBELL_PREFIX}current`,
		`${DOORBELL_PREFIX}../${CALL}`,
		`${DOORBELL_PREFIX}`,
		`${ATTEND_PREFIX}0123456789ab:0`,
		`${CONTROL_PREFIX}${"0".repeat(24)}:0`,
		"",
	])("refuses anything else exactly: %j", (customId) => {
		expect(parseDoorbellId(customId)).toBeUndefined();
	});
});

describe("doorbellComponents", () => {
	it("draws one green Answer button that names only the call", () => {
		expect(doorbellComponents(message())).toEqual([
			{
				type: 1,
				components: [
					{ type: 2, style: 3, label: "Answer", custom_id: `${DOORBELL_PREFIX}${CALL}` },
				],
			},
		]);
	});

	it("has none once the call can't be answered", () => {
		expect(doorbellComponents(message({ answerable: false }))).toEqual([]);
	});

	it("refuses a call ID it wasn't made for", () => {
		expect(() => doorbellComponents(message({ callId: "nope" }))).toThrow(/call ID/);
	});

	it("is a message that never pings, and loses its button when settled", () => {
		expect(toDoorbellMessage(message())).toEqual({
			content: "🔔 **Someone's at the door!**",
			components: doorbellComponents(message()),
			allowedMentions: NOBODY,
		});
		expect(toDoorbellMessage(message({ answerable: false })).components).toEqual([]);
	});
});

function fake(overrides: Partial<IncomingDoorbell> = {}): IncomingDoorbell {
	return {
		guildId: GUILD,
		customId: `${DOORBELL_PREFIX}${CALL}`,
		user: USER,
		reply: vi.fn(async () => {}),
		deferReply: vi.fn(async () => {}),
		editReply: vi.fn(async () => {}),
		...overrides,
	};
}

function setup(outcome: ActionOutcome | (() => Promise<ActionOutcome>)) {
	const act = vi.fn(async (_: ActionRequest) =>
		typeof outcome === "function" ? outcome() : outcome,
	);
	return {
		act,
		handle: createDoorbellHandler({ guildId: GUILD, dispatcher: { act }, deferAfterMs: 1500 }),
	};
}

const ON_IT: ActionOutcome = { kind: "update", reply: { text: "You're on it!" } };

describe("a click on Answer", () => {
	it("runs the answer action for whoever clicked, by ID, and answers them privately", async () => {
		const { act, handle } = setup(ON_IT);
		const interaction = fake();
		await handle(interaction, "Kimberly");
		expect(act).toHaveBeenCalledWith({
			actor: {
				platform: "discord",
				userId: IDS.friend,
				displayName: "Kimberly",
				handle: "kim",
				chat: "group",
			},
			action: DOORBELL_ANSWER_ACTION,
			args: { call: CALL },
		});
		expect(interaction.reply).toHaveBeenCalledWith({
			content: "You're on it!",
			flags: MessageFlags.Ephemeral,
			allowedMentions: NOBODY,
		});
	});

	it("tells them privately when they may not answer", async () => {
		const { handle } = setup({
			kind: "refused",
			reply: { text: "You don't have access to this command.", private: true },
		});
		const interaction = fake();
		await handle(interaction);
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "You don't have access to this command.",
				flags: MessageFlags.Ephemeral,
			}),
		);
	});

	it("refuses another server, and a forged or malformed custom ID, before the dispatcher", async () => {
		const { act, handle } = setup(ON_IT);
		for (const guildId of ["100000000000000099", null]) {
			const elsewhere = fake({ guildId });
			await handle(elsewhere);
			expect(elsewhere.reply).toHaveBeenCalledWith(
				expect.objectContaining({ content: WRONG_GUILD_MESSAGE, flags: MessageFlags.Ephemeral }),
			);
		}
		for (const customId of [`${DOORBELL_PREFIX}current`, `${DOORBELL_PREFIX}${CALL}:admin`]) {
			const forged = fake({ customId });
			await handle(forged);
			expect(forged.reply).toHaveBeenCalledWith(
				expect.objectContaining({
					content: "That doorbell isn't ringing any more.",
					flags: MessageFlags.Ephemeral,
				}),
			);
		}
		expect(act).not.toHaveBeenCalled();
	});

	it("is a bug if the action opens a form", async () => {
		const { handle } = setup({
			kind: "form",
			form: { title: "x", submit: { action: "a" }, fields: [] },
		});
		await expect(handle(fake())).rejects.toThrow(/opened a form/);
	});

	describe("when pixel-phone is slow", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("defers a private reply first, then fills it in", async () => {
			let finish: (outcome: ActionOutcome) => void = () => {};
			const { handle } = setup(
				() =>
					new Promise<ActionOutcome>((resolve) => {
						finish = resolve;
					}),
			);
			const interaction = fake();
			const handled = handle(interaction);
			await vi.advanceTimersByTimeAsync(1500);
			expect(interaction.deferReply).toHaveBeenCalled();
			finish(ON_IT);
			await handled;
			expect(interaction.reply).not.toHaveBeenCalled();
			expect(interaction.editReply).toHaveBeenCalledWith({
				content: "You're on it!",
				embeds: [],
				components: [],
				allowedMentions: NOBODY,
			});
		});
	});
});
