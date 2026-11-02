import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";
import type { Control, Form } from "../../core/ui.ts";
import { IDS } from "../../testing/fixtures.ts";
import {
	CONTROL_PREFIX,
	controlArgs,
	formArgs,
	type HeldControl,
	HeldControls,
	renderControls,
	renderForm,
	submittedFields,
	UI_FORM_PREFIX,
} from "./controls.ts";

const CHANNEL = "100000000000000050";
type Button = Extract<Control, { kind: "button" }>;
const button = (label: string, action = "feat.go"): Button => ({
	kind: "button",
	label,
	call: { action, args: { id: label } },
});
const select = (overrides: Partial<Extract<Control, { kind: "select" }>> = {}): Control => ({
	kind: "select",
	placeholder: "Choose one",
	call: { action: "feat.pick" },
	arg: "id",
	options: [
		{ label: "A", value: "a" },
		{ label: "B", value: "b", description: "the second", selected: true },
	],
	...overrides,
});

/** Renders with a store that records what it held. */
function render(rows: Control[][]) {
	const held: (readonly HeldControl[])[] = [];
	const json = renderControls(rows, (controls) => {
		held.push(controls);
		return "a".repeat(24);
	});
	return { json, held };
}

describe("HeldControls", () => {
	it("gives a reply's controls back to their owner only, until they expire", () => {
		let now = 0;
		const store = new HeldControls(() => now);
		const token = store.holdControls(IDS.member, [{ call: { action: "feat.go" } }]);
		const id = `${CONTROL_PREFIX}${token}:0`;
		expect(store.control(id, IDS.member)).toEqual({
			token,
			control: { call: { action: "feat.go" } },
		});
		// Controls can be used more than once: a select can be changed.
		expect(store.control(id, IDS.member)).not.toBe("expired");
		expect(store.control(id, IDS.friend)).toBe("not-yours");
		expect(store.control(`${CONTROL_PREFIX}${token}:1`, IDS.member)).toBe("expired");
		now = 15 * 60_000;
		expect(store.control(id, IDS.member)).toBe("expired");
		expect(store.size).toBe(0);
	});

	it.each([
		"pixel-ui:abc:0",
		`pixel-ui:${"a".repeat(24)}`,
		`pixel-ui:${"A".repeat(24)}:0`,
		`pixel-ui:${"a".repeat(24)}:0:1`,
		`pixel-form:${"a".repeat(24)}`,
		"",
	])("treats a malformed custom ID as expired: %j", (id) => {
		const store = new HeldControls();
		store.holdControls(IDS.member, [{ call: { action: "feat.go" } }]);
		expect(store.control(id, IDS.member)).toBe("expired");
		expect(store.takeForm(id, IDS.member)).toBe("expired");
	});

	it("gives a form back once, to its owner, with the reply it came from", () => {
		const store = new HeldControls();
		const form: Form = { title: "T", submit: { action: "feat.go" }, fields: [] };
		const id = store.holdForm(IDS.member, form, "panel");
		expect(id.startsWith(UI_FORM_PREFIX)).toBe(true);
		expect(id.length).toBeLessThanOrEqual(100);
		expect(store.takeForm(id, IDS.friend)).toBe("not-yours");
		expect(store.takeForm(id, IDS.member)).toEqual({ form, panel: "panel" });
		expect(store.takeForm(id, IDS.member)).toBe("expired");
		const bare = store.holdForm(IDS.member, form);
		expect(store.takeForm(bare, IDS.member)).toEqual({ form });
	});

	it("doesn't mix up a form's token and a reply's", () => {
		const store = new HeldControls();
		const form: Form = { title: "T", submit: { action: "feat.go" }, fields: [] };
		const token = store.holdForm(IDS.member, form).slice(UI_FORM_PREFIX.length);
		expect(store.control(`${CONTROL_PREFIX}${token}:0`, IDS.member)).toBe("expired");
		const controls = store.holdControls(IDS.member, []);
		expect(store.takeForm(`${UI_FORM_PREFIX}${controls}`, IDS.member)).toBe("expired");
	});

	it("forgets released controls, prunes expired ones and stays bounded", () => {
		let now = 0;
		const store = new HeldControls(() => now);
		const token = store.holdControls(IDS.member, []);
		store.release(token);
		expect(store.size).toBe(0);
		store.holdControls(IDS.member, []);
		now = 15 * 60_000;
		store.holdControls(IDS.member, []);
		expect(store.size).toBe(1);
		for (let i = 0; i < 600; i++) store.holdControls(IDS.member, []);
		expect(store.size).toBe(500);
	});
});

describe("renderControls", () => {
	it("draws buttons and links in a row, holding only what runs something", () => {
		const { json, held } = render([
			[
				{ ...button("Go"), style: "primary" },
				{ ...button("Stop"), style: "danger", disabled: true },
				{ kind: "link", label: "Docs", url: "https://example.org" },
			],
		]);
		expect(json).toEqual([
			{
				type: 1,
				components: [
					{ type: 2, style: 1, label: "Go", custom_id: `pixel-ui:${"a".repeat(24)}:0` },
					{
						type: 2,
						style: 4,
						label: "Stop",
						custom_id: `pixel-ui:${"a".repeat(24)}:1`,
						disabled: true,
					},
					{ type: 2, style: 5, label: "Docs", url: "https://example.org" },
				],
			},
		]);
		expect(held).toEqual([
			[
				{ call: { action: "feat.go", args: { id: "Go" } } },
				{ call: { action: "feat.go", args: { id: "Stop" } } },
			],
		]);
	});

	it("draws a select, holding what it offered", () => {
		const { json, held } = render([[select()], [button("Back")]]);
		expect(json[0]).toEqual({
			type: 1,
			components: [
				{
					type: 3,
					custom_id: `pixel-ui:${"a".repeat(24)}:0`,
					placeholder: "Choose one",
					min_values: 1,
					max_values: 1,
					options: [
						{ label: "A", value: "a" },
						{ label: "B", value: "b", description: "the second", default: true },
					],
				},
			],
		});
		expect(json[1]?.components[0]).toMatchObject({ style: 2, label: "Back" });
		expect(held[0]?.[0]?.select).toEqual({ arg: "id", values: ["a", "b"], min: 1, max: 1 });
	});

	it("holds nothing when there are no controls", () => {
		expect(render([])).toEqual({ json: [], held: [] });
	});

	it("cuts labels to what Discord takes", () => {
		const { json } = render([[button("x".repeat(100))]]);
		expect([
			...String((json[0]?.components[0] as { label?: string } | undefined)?.label),
		]).toHaveLength(80);
	});

	it.each<[string, Control[][]]>([
		["too many rows", Array.from({ length: 6 }, () => [button("x")])],
		["an empty row", [[]]],
		["too many buttons", [Array.from({ length: 6 }, () => button("x"))]],
		["a select beside a button", [[select(), button("x")]]],
		["a select with no options", [[select({ options: [] })]]],
		[
			"a select with too many options",
			[
				[
					select({
						options: Array.from({ length: 26 }, (_, i) => ({ label: "x", value: `${i}` })),
					}),
				],
			],
		],
		["max below min", [[select({ min: 2, max: 1 })]]],
		["max above the options", [[select({ max: 3 })]]],
		["max of zero", [[select({ min: 0, max: 0 })]]],
		["a negative min", [[select({ min: -1 })]]],
		[
			"multiple choice values with spaces",
			[
				[
					select({
						max: 2,
						options: [
							{ label: "x", value: "a b" },
							{ label: "y", value: "c" },
						],
					}),
				],
			],
		],
	])("refuses a layout Discord would refuse: %s", (_, rows) => {
		expect(() => render(rows)).toThrow();
	});
});

describe("controlArgs", () => {
	const plain: HeldControl = { call: { action: "feat.go", args: { id: "x" } } };
	const pick: HeldControl = {
		call: { action: "feat.pick", args: { from: "list" } },
		select: { arg: "days", values: ["mon", "tue", "wed"], min: 0, max: 2 },
	};

	it("gives a button its held arguments, whatever values arrive", () => {
		expect(controlArgs(plain, undefined)).toEqual({ id: "x" });
		expect(controlArgs({ call: { action: "feat.go" } }, ["x"])).toEqual({});
	});

	it("adds a select's chosen values, space-separated", () => {
		expect(controlArgs(pick, ["mon", "wed"])).toEqual({ from: "list", days: "mon wed" });
		expect(controlArgs(pick, [])).toEqual({ from: "list" });
		expect(controlArgs(pick, undefined)).toEqual({ from: "list" });
	});

	it.each([[["fri"]], [["mon", "tue", "wed"]], [["mon", "mon"]]])(
		"refuses values that weren't offered or don't fit: %j",
		(values) => {
			expect(controlArgs(pick, values)).toBeUndefined();
		},
	);

	it("refuses fewer than the minimum", () => {
		expect(
			controlArgs({ ...pick, select: { arg: "days", values: ["mon"], min: 1, max: 1 } }, []),
		).toBeUndefined();
	});
});

const FORM: Form = {
	title: "New message",
	submit: { action: "feat.save", args: { draft: "d1" } },
	fields: [
		{ kind: "channel", name: "channel", label: "Channel", value: CHANNEL },
		{
			kind: "text",
			name: "when",
			label: "When",
			description: "For example wed 1900",
			style: "short",
			maxLength: 10,
			placeholder: "wed 1900",
			value: "tomorrow 9am and more",
		},
		{
			kind: "radio",
			name: "repeat",
			label: "Repeat",
			options: [
				{ label: "Once", value: "once", selected: true },
				{ label: "Weekly", value: "weekly" },
			],
		},
		{
			kind: "checkboxes",
			name: "days",
			label: "Days",
			required: false,
			options: [
				{ label: "Mon", value: "mon" },
				{ label: "Tue", value: "tue" },
			],
		},
		{
			kind: "text",
			name: "text",
			label: "Text",
			style: "paragraph",
			maxLength: 100,
			required: false,
		},
	],
};

describe("renderForm", () => {
	it("puts every input in a label, in Discord's shapes", () => {
		expect(renderForm(FORM, "pixel-ui-form:x")).toEqual({
			custom_id: "pixel-ui-form:x",
			title: "New message",
			components: [
				{
					type: 18,
					label: "Channel",
					component: {
						type: 8,
						custom_id: "channel",
						required: true,
						min_values: 1,
						max_values: 1,
						channel_types: [0, 5],
						default_values: [{ id: CHANNEL, type: "channel" }],
					},
				},
				{
					type: 18,
					label: "When",
					description: "For example wed 1900",
					component: {
						type: 4,
						custom_id: "when",
						style: 1,
						required: true,
						max_length: 10,
						placeholder: "wed 1900",
						value: "tomorrow 9",
					},
				},
				{
					type: 18,
					label: "Repeat",
					component: {
						type: 21,
						custom_id: "repeat",
						required: true,
						options: [
							{ label: "Once", value: "once", default: true },
							{ label: "Weekly", value: "weekly" },
						],
					},
				},
				{
					type: 18,
					label: "Days",
					component: {
						type: 22,
						custom_id: "days",
						required: false,
						min_values: 0,
						max_values: 2,
						options: [
							{ label: "Mon", value: "mon" },
							{ label: "Tue", value: "tue" },
						],
					},
				},
				{
					type: 18,
					label: "Text",
					component: { type: 4, custom_id: "text", style: 2, required: false, max_length: 100 },
				},
			],
		});
	});

	it("draws an optional channel, and a checkbox group that needs one", () => {
		const modal = renderForm(
			{
				...FORM,
				fields: [
					{ kind: "channel", name: "channel", label: "Channel", required: false },
					{
						kind: "checkboxes",
						name: "days",
						label: "Days",
						options: [{ label: "Mon", value: "mon" }],
					},
				],
			},
			"x",
		);
		expect(modal.components[0]?.component).toMatchObject({ required: false, min_values: 0 });
		expect(modal.components[0]?.component).not.toHaveProperty("default_values");
		expect(modal.components[1]?.component).toMatchObject({ required: true, min_values: 1 });
	});

	it("cuts the title, labels and descriptions to Discord's limits", () => {
		const modal = renderForm(
			{
				title: "t".repeat(50),
				submit: { action: "feat.go" },
				fields: [
					{
						kind: "text",
						name: "a",
						label: "l".repeat(50),
						description: "d".repeat(120),
						placeholder: "p".repeat(120),
						style: "short",
						maxLength: 5,
					},
				],
			},
			"x",
		);
		expect([...modal.title]).toHaveLength(45);
		expect([...String(modal.components[0]?.label)]).toHaveLength(45);
		expect([...(modal.components[0] as { description: string }).description]).toHaveLength(100);
		expect([
			...String(
				(modal.components[0]?.component as { placeholder?: string } | undefined)?.placeholder,
			),
		]).toHaveLength(100);
	});

	it.each<[string, Form["fields"]]>([
		["no fields", []],
		[
			"six fields",
			Array.from({ length: 6 }, (_, i) => ({
				kind: "text" as const,
				name: `f${i}`,
				label: "x",
				style: "short" as const,
				maxLength: 5,
			})),
		],
		[
			"a radio group of one",
			[{ kind: "radio", name: "r", label: "r", options: [{ label: "a", value: "a" }] }],
		],
		[
			"a radio group of eleven",
			[
				{
					kind: "radio",
					name: "r",
					label: "r",
					options: Array.from({ length: 11 }, (_, i) => ({ label: "x", value: `${i}` })),
				},
			],
		],
		["no checkboxes", [{ kind: "checkboxes", name: "c", label: "c", options: [] }]],
		[
			"a checkbox value with a space",
			[{ kind: "checkboxes", name: "c", label: "c", options: [{ label: "x", value: "a b" }] }],
		],
	])("refuses a form Discord would refuse: %s", (_, fields) => {
		expect(() => renderForm({ title: "T", submit: { action: "feat.go" }, fields }, "x")).toThrow();
	});
});

describe("formArgs", () => {
	const BITS = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
	const full = [
		{
			customId: "channel",
			values: [CHANNEL],
			channel: { id: CHANNEL, name: "general", callerPermissions: BITS },
		},
		{ customId: "when", value: "wed 1900" },
		{ customId: "repeat", value: "weekly" },
		{ customId: "days", values: ["mon", "tue"] },
		{ customId: "text", value: "Hello" },
	];

	it("turns what was submitted into arguments, on top of the held ones", () => {
		expect(formArgs(FORM, full)).toEqual({
			args: {
				draft: "d1",
				channel: CHANNEL,
				when: "wed 1900",
				repeat: "weekly",
				days: "mon tue",
				text: "Hello",
			},
			channels: {
				channel: {
					id: CHANNEL,
					name: "general",
					caller: { canPost: true, canMentionEveryone: false, canCreatePolls: false },
				},
			},
		});
	});

	it("leaves out empty optional fields and ignores fields the form didn't have", () => {
		const sent = [
			...full.filter((f) => f.customId !== "days" && f.customId !== "text"),
			{ customId: "days", values: [] },
			{ customId: "text", value: "  " },
			{ customId: "extra", value: "x" },
		];
		const out = formArgs(FORM, sent);
		expect(out?.args).not.toHaveProperty("days");
		expect(out?.args).not.toHaveProperty("text");
		expect(out?.args).not.toHaveProperty("extra");
	});

	it("names a channel by its ID when Discord sent no name", () => {
		const sent = full.map((f) =>
			f.customId === "channel"
				? { ...f, channel: { id: CHANNEL, name: null, callerPermissions: null } }
				: f,
		);
		expect(formArgs(FORM, sent)?.channels.channel).toEqual({
			id: CHANNEL,
			name: CHANNEL,
			caller: { canPost: false, canMentionEveryone: false, canCreatePolls: false },
		});
	});

	const without = (id: string) => full.filter((f) => f.customId !== id);
	const replacing = (id: string, field: object) =>
		full.map((f) => (f.customId === id ? { customId: id, ...field } : f));

	it.each<[string, Parameters<typeof formArgs>[1]]>([
		["a missing required text", without("when")],
		["a blank required text", replacing("when", { value: " " })],
		["text over its length", replacing("when", { value: "x".repeat(11) })],
		["a radio choice that wasn't offered", replacing("repeat", { value: "daily" })],
		["no radio choice", replacing("repeat", { value: null })],
		["a checkbox that wasn't offered", replacing("days", { values: ["sun"] })],
		["the same checkbox twice", replacing("days", { values: ["mon", "mon"] })],
		["no channel", without("channel")],
		[
			"a channel that doesn't match the value",
			replacing("channel", { values: ["1"], channel: full[0]?.channel }),
		],
		[
			"two channels",
			replacing("channel", { values: [CHANNEL, CHANNEL], channel: full[0]?.channel }),
		],
	])("refuses %s", (_, sent) => {
		expect(formArgs(FORM, sent)).toBeUndefined();
	});

	it("allows an optional radio, checkbox group and channel to be left empty, but not half-filled", () => {
		const form: Form = {
			title: "T",
			submit: { action: "feat.go" },
			fields: [
				{
					kind: "radio",
					name: "r",
					label: "r",
					required: false,
					options: [
						{ label: "Once", value: "once" },
						{ label: "Weekly", value: "weekly" },
					],
				},
				{ kind: "checkboxes", name: "c", label: "c", options: [{ label: "x", value: "x" }] },
				{ kind: "channel", name: "ch", label: "ch", required: false },
			],
		};
		expect(formArgs(form, [{ customId: "c", values: ["x"] }])).toEqual({
			args: { c: "x" },
			channels: {},
		});
		expect(formArgs(form, [{ customId: "c", values: [] }])).toBeUndefined();
		expect(
			formArgs(form, [
				{ customId: "c", values: ["x"] },
				{ customId: "ch", values: [CHANNEL] },
			]),
		).toBeUndefined();
	});
});

describe("submittedFields", () => {
	it("reads text, choices and a picked channel with the submitter's permissions there", () => {
		const channels = new Map([[CHANNEL, { id: CHANNEL, name: "general" }]]);
		const bits = (channel: { id: string }) => (channel.id === CHANNEL ? 3n : null);
		expect(
			submittedFields(
				[
					{ customId: "when", value: "wed" },
					{ customId: "repeat", value: null },
					{ customId: "agree", value: true },
					{ customId: "days", values: ["mon"] },
					{ customId: "channel", values: [CHANNEL], channels },
					{ customId: "gone", values: ["1"], channels },
					{ customId: "empty", values: [], channels },
				],
				bits,
			),
		).toEqual([
			{ customId: "when", value: "wed" },
			{ customId: "repeat", value: null },
			{ customId: "agree" },
			{ customId: "days", values: ["mon"] },
			{
				customId: "channel",
				values: [CHANNEL],
				channel: { id: CHANNEL, name: "general", callerPermissions: 3n },
			},
			{ customId: "gone", values: ["1"] },
			{ customId: "empty", values: [] },
		]);
	});

	it("keeps a channel without a name", () => {
		const channels = new Map([[CHANNEL, { id: CHANNEL }]]);
		expect(
			submittedFields([{ customId: "c", values: [CHANNEL], channels }], () => null)[0]?.channel,
		).toEqual({ id: CHANNEL, name: null, callerPermissions: null });
	});
});
