import { MessageFlags } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionOutcome, ActionRequest } from "../../core/dispatcher.ts";
import type { Form } from "../../core/ui.ts";
import { IDS } from "../../testing/fixtures.ts";
import { CONTROL_PREFIX, HeldControls } from "./controls.ts";
import { WRONG_GUILD_MESSAGE } from "./handlers.ts";
import {
	CONTROL_EXPIRED_MESSAGE,
	createControlHandler,
	createUiFormHandler,
	FIX_IT_LABEL,
	type IncomingControl,
	type IncomingUiForm,
	NOT_YOURS_MESSAGE,
	SLOW_FORM_MESSAGE,
} from "./ui-handlers.ts";

const GUILD = "100000000000000020";
const CHANNEL = "100000000000000050";
const USER = { id: IDS.member, displayName: "Member", username: "member" };
const NOBODY = { parse: [] };

const FORM: Form = {
	title: "Rename",
	submit: { action: "feat.rename", args: { id: "s1" } },
	fields: [{ kind: "text", name: "name", label: "Name", style: "short", maxLength: 20 }],
};

function fakeControl(overrides: Partial<IncomingControl> = {}): IncomingControl {
	return {
		guildId: GUILD,
		customId: "",
		user: USER,
		update: vi.fn(async () => {}),
		deferUpdate: vi.fn(async () => {}),
		editReply: vi.fn(async () => {}),
		reply: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		showModal: vi.fn(async () => {}),
		...overrides,
	};
}

function fakeForm(overrides: Partial<IncomingUiForm> = {}): IncomingUiForm {
	return {
		guildId: GUILD,
		customId: "",
		user: USER,
		fields: [{ customId: "name", value: "New name" }],
		update: vi.fn(async () => {}),
		deferUpdate: vi.fn(async () => {}),
		editReply: vi.fn(async () => {}),
		reply: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		...overrides,
	};
}

function setup(outcome: ActionOutcome | (() => Promise<ActionOutcome>)) {
	const controls = new HeldControls();
	const act = vi.fn(async (_: ActionRequest) =>
		typeof outcome === "function" ? outcome() : outcome,
	);
	const deps = { guildId: GUILD, dispatcher: { act }, deferAfterMs: 1500, controls };
	return {
		controls,
		act,
		onControl: createControlHandler(deps),
		onForm: createUiFormHandler(deps),
	};
}

/** A select on a reply, held for the member, as a custom ID. */
function holdSelect(controls: HeldControls): { id: string; token: string } {
	const token = controls.holdControls(IDS.member, [
		{
			call: { action: "feat.pick", args: { page: 1 } },
			select: { arg: "id", values: ["s1", "s2"], min: 1, max: 1 },
		},
	]);
	return { id: `${CONTROL_PREFIX}${token}:0`, token };
}

const panel = (text: string): ActionOutcome => ({
	kind: "update",
	reply: {
		text,
		controls: [[{ kind: "button", label: "Back", call: { action: "feat.home" } }]],
	},
});

describe("control handler", () => {
	it("refuses another guild before looking at anything", async () => {
		const { act, onControl } = setup(panel("x"));
		const i = fakeControl({ guildId: "999999999999999999" });
		await onControl(i);
		expect(i.reply).toHaveBeenCalledWith({
			content: WRONG_GUILD_MESSAGE,
			flags: MessageFlags.Ephemeral,
			allowedMentions: NOBODY,
		});
		expect(act).not.toHaveBeenCalled();
	});

	it("says privately when a control has expired or isn't the clicker's", async () => {
		const { controls, act, onControl } = setup(panel("x"));
		const expired = fakeControl({ customId: `${CONTROL_PREFIX}${"0".repeat(24)}:0` });
		await onControl(expired);
		expect(expired.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: CONTROL_EXPIRED_MESSAGE, flags: MessageFlags.Ephemeral }),
		);
		const { id } = holdSelect(controls);
		const someoneElse = fakeControl({
			customId: id,
			user: { ...USER, id: IDS.friend },
			values: ["s1"],
		});
		await onControl(someoneElse);
		expect(someoneElse.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: NOT_YOURS_MESSAGE }),
		);
		expect(act).not.toHaveBeenCalled();
	});

	it("refuses select values that weren't offered", async () => {
		const { controls, act, onControl } = setup(panel("x"));
		const i = fakeControl({ customId: holdSelect(controls).id, values: ["s9"] });
		await onControl(i);
		expect(i.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: CONTROL_EXPIRED_MESSAGE }),
		);
		expect(act).not.toHaveBeenCalled();
	});

	it("runs the held action as the clicker and replaces the message with fresh controls", async () => {
		const { controls, act, onControl } = setup(panel("Chosen"));
		const { id, token } = holdSelect(controls);
		const i = fakeControl({ customId: id, values: ["s2"] });
		await onControl(i, "Nick");
		expect(act).toHaveBeenCalledWith({
			actor: {
				platform: "discord",
				userId: IDS.member,
				displayName: "Nick",
				handle: "member",
				chat: "group",
			},
			action: "feat.pick",
			args: { page: 1, id: "s2" },
		});
		expect(i.update).toHaveBeenCalledWith({
			content: "Chosen",
			embeds: [],
			components: [
				{
					type: 1,
					components: [
						expect.objectContaining({
							label: "Back",
							custom_id: expect.stringMatching(/^pixel-ui:/),
						}),
					],
				},
			],
			allowedMentions: NOBODY,
		});
		// The old controls are gone with the message they were on; the new ones are the member's.
		expect(controls.control(id, IDS.member)).toBe("expired");
		const newId = vi.mocked(i.update).mock.calls[0]?.[0].components[0]?.components[0]?.custom_id;
		expect(controls.control(newId as string, IDS.member)).not.toBe("expired");
		expect(controls.control(newId as string, IDS.friend)).toBe("not-yours");
		expect(token).not.toBe("");
	});

	it("replies privately, leaving the message, when the action is refused", async () => {
		const { controls, onControl } = setup({
			kind: "refused",
			reply: { text: "You don't have access to this command.", private: true },
		});
		const i = fakeControl({ customId: holdSelect(controls).id, values: ["s1"] });
		await onControl(i);
		expect(i.update).not.toHaveBeenCalled();
		expect(i.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "You don't have access to this command.",
				flags: MessageFlags.Ephemeral,
			}),
		);
	});

	it("opens a form held for the clicker, keeping the message's controls", async () => {
		const { controls, onControl } = setup({ kind: "form", form: FORM });
		const { id } = holdSelect(controls);
		const i = fakeControl({ customId: id, values: ["s1"] });
		await onControl(i);
		const modal = vi.mocked(i.showModal).mock.calls[0]?.[0];
		expect(modal?.title).toBe("Rename");
		expect(controls.takeForm(modal?.custom_id as string, IDS.member)).toEqual({
			form: FORM,
			panel: expect.any(String),
			opener: { action: "feat.pick", args: expect.any(Object) },
		});
		expect(controls.control(id, IDS.member)).not.toBe("expired");
	});

	describe("when the action is slow", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		const slow = (outcome: ActionOutcome) => () =>
			new Promise<ActionOutcome>((resolve) => setTimeout(() => resolve(outcome), 2000));

		it("defers, then edits the message", async () => {
			const { controls, onControl } = setup(slow(panel("Done")));
			const i = fakeControl({ customId: holdSelect(controls).id, values: ["s1"] });
			const done = onControl(i);
			await vi.advanceTimersByTimeAsync(2000);
			await done;
			expect(i.deferUpdate).toHaveBeenCalled();
			expect(i.update).not.toHaveBeenCalled();
			expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "Done" }));
		});

		it("can't open a form after deferring, so asks to try again", async () => {
			const { controls, onControl } = setup(slow({ kind: "form", form: FORM }));
			const i = fakeControl({ customId: holdSelect(controls).id, values: ["s1"] });
			const done = onControl(i);
			await vi.advanceTimersByTimeAsync(2000);
			await done;
			expect(i.showModal).not.toHaveBeenCalled();
			expect(i.followUp).toHaveBeenCalledWith(
				expect.objectContaining({ content: SLOW_FORM_MESSAGE, flags: MessageFlags.Ephemeral }),
			);
		});

		it("sends a refusal as a private follow-up", async () => {
			const { controls, onControl } = setup(
				slow({ kind: "refused", reply: { text: "No.", private: true } }),
			);
			const i = fakeControl({ customId: holdSelect(controls).id, values: ["s1"] });
			const done = onControl(i);
			await vi.advanceTimersByTimeAsync(2000);
			await done;
			expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: "No." }));
		});

		it("surfaces a failed deferral once the action is done", async () => {
			const { controls, onControl } = setup(slow(panel("Done")));
			const i = fakeControl({
				customId: holdSelect(controls).id,
				values: ["s1"],
				deferUpdate: vi.fn(async () => {
					throw new Error("expired");
				}),
			});
			const done = onControl(i);
			const caught = done.catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(2000);
			expect(await caught).toEqual(new Error("expired"));
		});
	});
});

describe("form handler", () => {
	it("refuses another guild", async () => {
		const { act, onForm } = setup(panel("x"));
		const i = fakeForm({ guildId: null });
		await onForm(i);
		expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: WRONG_GUILD_MESSAGE }));
		expect(act).not.toHaveBeenCalled();
	});

	it("refuses an expired form, someone else's, and one that doesn't match what was shown", async () => {
		const { controls, act, onForm } = setup(panel("x"));
		const expired = fakeForm({ customId: "pixel-ui-form:nope" });
		await onForm(expired);
		expect(expired.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: CONTROL_EXPIRED_MESSAGE }),
		);
		const theirs = fakeForm({
			customId: controls.holdForm(IDS.member, FORM),
			user: { ...USER, id: IDS.friend },
		});
		await onForm(theirs);
		expect(theirs.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: NOT_YOURS_MESSAGE }),
		);
		const tooLong = fakeForm({
			customId: controls.holdForm(IDS.member, FORM),
			fields: [{ customId: "name", value: "x".repeat(21) }],
		});
		await onForm(tooLong);
		expect(tooLong.reply).toHaveBeenCalledWith(
			expect.objectContaining({ content: CONTROL_EXPIRED_MESSAGE }),
		);
		expect(act).not.toHaveBeenCalled();
	});

	it("runs the form's action with what was typed and replaces the message it came from", async () => {
		const { controls, act, onForm } = setup(panel("Renamed"));
		const panelToken = controls.holdControls(IDS.member, [{ call: { action: "feat.home" } }]);
		const i = fakeForm({ customId: controls.holdForm(IDS.member, FORM, panelToken) });
		await onForm(i);
		expect(act).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "feat.rename",
				args: { id: "s1", name: "New name" },
				channels: {},
			}),
		);
		expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ content: "Renamed" }));
		expect(controls.control(`${CONTROL_PREFIX}${panelToken}:0`, IDS.member)).toBe("expired");
	});

	it("passes a picked channel with what the submitter may do there", async () => {
		const { controls, act, onForm } = setup(panel("x"));
		const form: Form = {
			title: "Where",
			submit: { action: "feat.move" },
			fields: [{ kind: "channel", name: "channel", label: "Channel" }],
		};
		await onForm(
			fakeForm({
				customId: controls.holdForm(IDS.member, form),
				fields: [
					{
						customId: "channel",
						values: [CHANNEL],
						channel: { id: CHANNEL, name: "general", callerPermissions: null },
					},
				],
			}),
		);
		expect(act).toHaveBeenCalledWith(
			expect.objectContaining({
				args: { channel: CHANNEL },
				channels: {
					channel: {
						id: CHANNEL,
						name: "general",
						caller: { canPost: false, canMentionEveryone: false, canCreatePolls: false },
					},
				},
			}),
		);
	});

	it("treats a form opening another form as a bug", async () => {
		const { controls, onForm } = setup({ kind: "form", form: FORM });
		const i = fakeForm({ customId: controls.holdForm(IDS.member, FORM) });
		await expect(onForm(i)).rejects.toThrow(/opened a form from a form/);
	});
});

describe("Fix it", () => {
	const OPENER = { action: "feat.rename-form", args: { id: "s1" } };
	const PROBLEM: ActionOutcome = {
		kind: "refused",
		reply: { text: "That name is taken.", private: true },
		problem: true,
	};
	type Payload = {
		content?: string;
		components?: { components: { custom_id?: string; label?: string }[] }[];
	};
	const buttonsOf = (payload: unknown) =>
		((payload as Payload).components ?? []).flatMap((row) => row.components);

	/** Submits FORM, opened by OPENER, and gets the reply's Fix it button. */
	async function submitBadly(outcome: ActionOutcome = PROBLEM) {
		const t = setup(outcome);
		const i = fakeForm({ customId: t.controls.holdForm(IDS.member, FORM, undefined, OPENER) });
		await t.onForm(i);
		const payload = vi.mocked(i.reply).mock.calls[0]?.[0];
		return { ...t, i, payload, buttons: buttonsOf(payload) };
	}

	it("answers a form's problem privately with Fix it", async () => {
		const { i, payload, buttons } = await submitBadly();
		expect(payload).toMatchObject({
			content: "That name is taken.",
			flags: MessageFlags.Ephemeral,
			allowedMentions: NOBODY,
		});
		expect(buttons).toEqual([expect.objectContaining({ label: FIX_IT_LABEL, style: 1 })]);
		expect(i.update).not.toHaveBeenCalled();
	});

	it("opens the form again through the dispatcher, filled in with what was typed", async () => {
		const { controls, act, buttons } = await submitBadly();
		act.mockResolvedValue({ kind: "form", form: FORM });
		const click = fakeControl({ customId: buttons[0]?.custom_id as string });
		await createControlHandler({
			guildId: GUILD,
			dispatcher: { act },
			deferAfterMs: 1500,
			controls,
		})(click);
		expect(act).toHaveBeenLastCalledWith(
			expect.objectContaining({ ...OPENER, actor: expect.any(Object) }),
		);
		const modal = vi.mocked(click.showModal).mock.calls[0]?.[0];
		expect(JSON.stringify(modal)).toContain('"value":"New name"');
		// Fixed and sent again, it can be fixed again.
		expect(controls.takeForm(modal?.custom_id as string, IDS.member)).toMatchObject({
			opener: OPENER,
		});
	});

	it("works only for the person who submitted the form", async () => {
		const { controls, buttons } = await submitBadly();
		expect(controls.control(buttons[0]?.custom_id as string, IDS.friend)).toBe("not-yours");
	});

	it("isn't offered for refusals that aren't the form's problem, or a form nothing opened", async () => {
		const denied = await submitBadly({ kind: "refused", reply: { text: "No.", private: true } });
		expect(denied.buttons).toEqual([]);
		expect(denied.payload).toMatchObject({ content: "No." });

		const t = setup(PROBLEM);
		const i = fakeForm({ customId: t.controls.holdForm(IDS.member, FORM) });
		await t.onForm(i);
		expect(buttonsOf(vi.mocked(i.reply).mock.calls[0]?.[0])).toEqual([]);
	});

	it("comes as a follow-up when the action was slow", async () => {
		vi.useFakeTimers();
		try {
			const t = setup(
				() => new Promise<ActionOutcome>((resolve) => setTimeout(() => resolve(PROBLEM), 2000)),
			);
			const i = fakeForm({ customId: t.controls.holdForm(IDS.member, FORM, undefined, OPENER) });
			const done = t.onForm(i);
			await vi.advanceTimersByTimeAsync(2000);
			await done;
			expect(i.deferUpdate).toHaveBeenCalled();
			expect(buttonsOf(vi.mocked(i.followUp).mock.calls[0]?.[0])).toEqual([
				expect.objectContaining({ label: FIX_IT_LABEL }),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("doesn't hold a secret that was typed", async () => {
		const secret: Form = {
			title: "Code",
			submit: { action: "feat.code" },
			fields: [
				{ kind: "text", name: "code", label: "Code", style: "short", maxLength: 9, secret: true },
			],
		};
		const t = setup(PROBLEM);
		const i = fakeForm({
			customId: t.controls.holdForm(IDS.member, secret, undefined, OPENER),
			fields: [{ customId: "code", value: "123456" }],
		});
		await t.onForm(i);
		const id = buttonsOf(vi.mocked(i.reply).mock.calls[0]?.[0])[0]?.custom_id as string;
		const held = t.controls.control(id, IDS.member);
		expect(held !== "expired" && held !== "not-yours" && held.control.refill).toEqual({});
	});
});
