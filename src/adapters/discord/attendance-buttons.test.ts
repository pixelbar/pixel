import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTEND_ACTION, type AttendanceMessage } from "../../core/channel-posts.ts";
import type { ActionOutcome, ActionRequest } from "../../core/dispatcher.ts";
import { IDS } from "../../testing/fixtures.ts";
import {
	ATTEND_PREFIX,
	attendanceComponents,
	createAttendanceHandler,
	type IncomingAttendance,
	parseAttendId,
} from "./attendance-buttons.ts";
import { requiredPermissions, toAttendanceMessage, toDiscordMessage } from "./channel-poster.ts";
import { CONTROL_PREFIX } from "./controls.ts";
import { WRONG_GUILD_MESSAGE } from "./handlers.ts";

const GUILD = "100000000000000020";
const USER = { id: IDS.guest, displayName: "Kim", username: "kim" };
const NOBODY = { parse: [] };
const POLL = "0123456789ab";

const message = (over: Partial<AttendanceMessage> = {}): AttendanceMessage => ({
	pollId: POLL,
	text: "🗳️ **Who's coming?**",
	answers: ["Coming", "Not coming"],
	open: true,
	...over,
});

describe("parseAttendId", () => {
	it("reads the poll and answer from one of Pixel's attendance buttons", () => {
		expect(parseAttendId(`${ATTEND_PREFIX}${POLL}:0`)).toEqual({ poll: POLL, answer: 0 });
		expect(parseAttendId(`${ATTEND_PREFIX}${POLL}:4`)).toEqual({ poll: POLL, answer: 4 });
	});

	it.each([
		`${ATTEND_PREFIX}${POLL}:5`,
		`${ATTEND_PREFIX}${POLL}:01`,
		`${ATTEND_PREFIX}${POLL}:-1`,
		`${ATTEND_PREFIX}${POLL}`,
		`${ATTEND_PREFIX}${POLL.toUpperCase()}:0`,
		`${ATTEND_PREFIX}0123456789a:0`,
		`${ATTEND_PREFIX}${POLL}0:0`,
		`${ATTEND_PREFIX}${POLL}:0 `,
		`${ATTEND_PREFIX}${POLL}:0:extra`,
		` ${ATTEND_PREFIX}${POLL}:0`,
		`${CONTROL_PREFIX}${"0".repeat(24)}:0`,
		"",
	])("refuses anything else exactly: %j", (customId) => {
		expect(parseAttendId(customId)).toBeUndefined();
	});
});

describe("attendanceComponents", () => {
	it("draws a grey button per answer, each naming only the poll and the answer's place", () => {
		expect(attendanceComponents(message())).toEqual([
			{
				type: 1,
				components: [
					{ type: 2, style: 2, label: "Coming", custom_id: `${ATTEND_PREFIX}${POLL}:0` },
					{ type: 2, style: 2, label: "Not coming", custom_id: `${ATTEND_PREFIX}${POLL}:1` },
				],
			},
		]);
		for (const row of attendanceComponents(message())) {
			for (const button of row.components) {
				expect(parseAttendId(button.custom_id as string)).toBeDefined();
			}
		}
	});

	it("has none once the poll has closed", () => {
		expect(attendanceComponents(message({ open: false }))).toEqual([]);
	});

	it("keeps labels within Discord's 80 characters", () => {
		const [row] = attendanceComponents(message({ answers: ["x".repeat(90)] }));
		const [button] = row?.components ?? [];
		expect(button && "label" in button && button.label).toHaveLength(80);
	});

	it("refuses a poll ID or a number of answers it wasn't made for", () => {
		expect(() => attendanceComponents(message({ pollId: "nope" }))).toThrow(/poll ID/);
		expect(() => attendanceComponents(message({ answers: [] }))).toThrow(/1 to 5/);
		expect(() =>
			attendanceComponents(message({ answers: ["a", "b", "c", "d", "e", "f"] })),
		).toThrow(/1 to 5/);
	});
});

describe("the poll's message", () => {
	it("is its text and buttons, and never pings", () => {
		expect(toAttendanceMessage(message())).toEqual({
			content: "🗳️ **Who's coming?**",
			components: attendanceComponents(message()),
			allowedMentions: NOBODY,
		});
		// Set even when empty, so closing it takes the buttons away.
		expect(toAttendanceMessage(message({ open: false })).components).toEqual([]);
	});

	it("needs only to see the channel and post in it", () => {
		expect(
			requiredPermissions({ kind: "attendance", question: "Q", answers: [], durationHours: 1 }),
		).toEqual([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
	});

	it("is never sent as a plain post", () => {
		expect(() =>
			toDiscordMessage({ kind: "attendance", question: "Q", answers: [], durationHours: 1 }),
		).toThrow(/postAttendance/);
	});
});

function fake(overrides: Partial<IncomingAttendance> = {}): IncomingAttendance {
	return {
		guildId: GUILD,
		customId: `${ATTEND_PREFIX}${POLL}:1`,
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
		handle: createAttendanceHandler({ guildId: GUILD, dispatcher: { act }, deferAfterMs: 1500 }),
	};
}

const CHOSE: ActionOutcome = { kind: "update", reply: { text: "You're down as **Not coming**." } };

describe("a click on an attendance button", () => {
	it("runs the attend action for whoever clicked, by ID, and answers them privately", async () => {
		const { act, handle } = setup(CHOSE);
		const interaction = fake();
		await handle(interaction, "Kimberly");
		expect(act).toHaveBeenCalledWith({
			actor: {
				platform: "discord",
				userId: IDS.guest,
				displayName: "Kimberly",
				handle: "kim",
				chat: "group",
			},
			action: ATTEND_ACTION,
			args: { poll: POLL, answer: 1 },
		});
		expect(interaction.reply).toHaveBeenCalledWith({
			content: "You're down as **Not coming**.",
			flags: MessageFlags.Ephemeral,
			allowedMentions: NOBODY,
		});
	});

	it("tells them privately when it was refused", async () => {
		const { handle } = setup({
			kind: "refused",
			reply: { text: "That poll has closed.", private: true },
			problem: true,
		});
		const interaction = fake();
		await handle(interaction);
		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: "That poll has closed.", flags: MessageFlags.Ephemeral }),
		);
	});

	it("refuses another server, and a custom ID that isn't exactly one of Pixel's, before the dispatcher", async () => {
		const { act, handle } = setup(CHOSE);
		const elsewhere = fake({ guildId: "100000000000000099" });
		await handle(elsewhere);
		expect(elsewhere.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: WRONG_GUILD_MESSAGE, flags: MessageFlags.Ephemeral }),
		);
		const dm = fake({ guildId: null });
		await handle(dm);
		expect(dm.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: WRONG_GUILD_MESSAGE }),
		);
		const forged = fake({ customId: `${ATTEND_PREFIX}${POLL}:9` });
		await handle(forged);
		expect(forged.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "That poll isn't running any more.",
				flags: MessageFlags.Ephemeral,
			}),
		);
		expect(act).not.toHaveBeenCalled();
	});

	it("is a bug if the action opens a form", async () => {
		const { handle } = setup({
			kind: "form",
			form: { title: "x", submit: { action: "a" }, fields: [] },
		});
		await expect(handle(fake())).rejects.toThrow(/opened a form/);
	});

	describe("when the action is slow", () => {
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
			const done = handle(interaction);
			await vi.advanceTimersByTimeAsync(1500);
			expect(interaction.deferReply).toHaveBeenCalled();
			finish(CHOSE);
			await done;
			expect(interaction.reply).not.toHaveBeenCalled();
			expect(interaction.editReply).toHaveBeenCalledWith({
				content: "You're down as **Not coming**.",
				embeds: [],
				components: [],
				allowedMentions: NOBODY,
			});
		});
	});
});
