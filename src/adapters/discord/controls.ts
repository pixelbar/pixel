import { randomBytes } from "node:crypto";
import type { ArgValue, ResolvedChannel, ResolvedUser } from "../../core/command.ts";
import {
	type ActionCall,
	type ChoiceOption,
	type ControlRow,
	type Form,
	type FormInput,
	UI_LIMITS,
} from "../../core/ui.ts";
import { callerAbilities } from "./args.ts";

/**
 * Controls (buttons and select menus) and forms built from `core/ui.ts`. What a
 * control does stays here, under a random token in its custom ID, so nothing a
 * person sends back is trusted except which control they used and what they chose
 * from what was offered. Only the person a reply was for can use its controls, and
 * they expire, so a reply left open can't run anything much later. The dispatcher
 * checks access and arguments again on every use.
 */

/** How long controls and forms stay usable. Every update holds new ones, so it's per step. */
const HOLD_MS = 15 * 60_000;
/** At most this many replies and forms held at once. */
const MAX_HELD = 500;

export const CONTROL_PREFIX = "pixel-ui:";
export const UI_FORM_PREFIX = "pixel-ui-form:";
const CONTROL_ID = /^pixel-ui:([0-9a-f]{24}):(\d{1,2})$/;
const FORM_ID = /^pixel-ui-form:([0-9a-f]{24})$/;

/** What a control runs, plus what a select offered. */
export type HeldControl = {
	call: ActionCall;
	select?: { arg: string; values: readonly string[]; min: number; max: number };
};

type Held =
	| { kind: "controls"; owner: string; controls: readonly HeldControl[]; expires: number }
	| { kind: "form"; owner: string; form: Form; panel?: string; expires: number };

export type Taken<T> = T | "expired" | "not-yours";

export class HeldControls {
	readonly #held = new Map<string, Held>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Keeps a reply's controls for its owner and returns their token. */
	holdControls(owner: string, controls: readonly HeldControl[]): string {
		return this.#hold({ kind: "controls", owner, controls, expires: this.#now() + HOLD_MS });
	}

	/** Keeps a form for its owner and returns the modal's custom ID. `panel` is the reply it came from. */
	holdForm(owner: string, form: Form, panel?: string): string {
		const token = this.#hold({
			kind: "form",
			owner,
			form,
			...(panel === undefined ? {} : { panel }),
			expires: this.#now() + HOLD_MS,
		});
		return `${UI_FORM_PREFIX}${token}`;
	}

	/** The control behind a custom ID, if it's still held and belongs to `userId`. */
	control(customId: string, userId: string): Taken<{ token: string; control: HeldControl }> {
		const match = CONTROL_ID.exec(customId);
		const entry = this.#get(match?.[1], "controls");
		if (!match || !entry) return "expired";
		if (entry.owner !== userId) return "not-yours";
		const control = entry.controls[Number(match[2])];
		if (!control) return "expired";
		return { token: match[1] as string, control };
	}

	/** Takes a submitted form, once, if it's still held and belongs to `userId`. */
	takeForm(customId: string, userId: string): Taken<{ form: Form; panel?: string }> {
		const token = FORM_ID.exec(customId)?.[1];
		const entry = this.#get(token, "form");
		if (!token || !entry) return "expired";
		if (entry.owner !== userId) return "not-yours";
		this.#held.delete(token);
		return { form: entry.form, ...(entry.panel === undefined ? {} : { panel: entry.panel }) };
	}

	/** Forgets a reply's controls once the reply has been replaced. */
	release(token: string): void {
		this.#held.delete(token);
	}

	get size(): number {
		return this.#held.size;
	}

	#get<K extends Held["kind"]>(token: string | undefined, kind: K) {
		if (token === undefined) return undefined;
		const entry = this.#held.get(token);
		if (!entry || entry.kind !== kind) return undefined;
		if (entry.expires <= this.#now()) {
			this.#held.delete(token);
			return undefined;
		}
		return entry as Extract<Held, { kind: K }>;
	}

	#hold(entry: Held): string {
		const now = this.#now();
		for (const [token, held] of this.#held) if (held.expires <= now) this.#held.delete(token);
		while (this.#held.size >= MAX_HELD) this.#held.delete(this.#held.keys().next().value as string);
		const token = randomBytes(12).toString("hex");
		this.#held.set(token, entry);
		return token;
	}
}

// The API's JSON shapes (component types from Discord's reference).
type ButtonJson = {
	type: 2;
	style: 1 | 2 | 3 | 4 | 5;
	label: string;
	custom_id?: string;
	url?: string;
	disabled?: boolean;
};
type SelectJson = {
	type: 3;
	custom_id: string;
	placeholder: string;
	min_values: number;
	max_values: number;
	options: { label: string; value: string; description?: string; default?: boolean }[];
};
export type RowJson = { type: 1; components: (ButtonJson | SelectJson)[] };

const STYLES = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;

/**
 * Draws a reply's controls as Discord action rows. `hold` keeps what they run and
 * returns the token their custom IDs carry. A layout Discord would refuse is a bug in
 * the feature, so it throws rather than drop a control without saying.
 */
export function renderControls(
	rows: readonly ControlRow[],
	hold: (controls: readonly HeldControl[]) => string,
): RowJson[] {
	if (rows.length === 0) return [];
	if (rows.length > UI_LIMITS.rows) throw new Error(`at most ${UI_LIMITS.rows} rows of controls`);
	const held: HeldControl[] = [];
	const indexed = rows.map((row) => {
		const selects = row.filter((c) => c.kind === "select").length;
		if (row.length === 0 || (selects > 0 && row.length !== 1)) {
			throw new Error("a row holds buttons, or exactly one select");
		}
		if (row.length > UI_LIMITS.buttonsPerRow) {
			throw new Error(`at most ${UI_LIMITS.buttonsPerRow} buttons in a row`);
		}
		return row.map((control) => {
			if (control.kind === "link") return { control, index: -1 };
			if (control.kind === "button") {
				held.push({ call: control.call });
				return { control, index: held.length - 1 };
			}
			const { min = 1, max = 1, options } = control;
			if (options.length < 1 || options.length > UI_LIMITS.options) {
				throw new Error(`a select offers 1 to ${UI_LIMITS.options} options`);
			}
			if (min < 0 || max < Math.max(min, 1) || max > options.length) {
				throw new Error("a select's min and max must fit its options");
			}
			if (max > 1 && options.some((o) => /\s/.test(o.value))) {
				throw new Error("values of a multiple choice can't contain whitespace");
			}
			held.push({
				call: control.call,
				select: { arg: control.arg, values: options.map((o) => o.value), min, max },
			});
			return { control, index: held.length - 1 };
		});
	});
	const token = hold(held);
	return indexed.map((row) => ({
		type: 1,
		components: row.map(({ control, index }) => {
			const id = `${CONTROL_PREFIX}${token}:${index}`;
			switch (control.kind) {
				case "link":
					return { type: 2, style: 5, label: cut(control.label, 80), url: control.url };
				case "button":
					return {
						type: 2,
						style: STYLES[control.style ?? "secondary"],
						label: cut(control.label, 80),
						custom_id: id,
						...(control.disabled ? { disabled: true } : {}),
					};
				default:
					return {
						type: 3,
						custom_id: id,
						placeholder: cut(control.placeholder, 150),
						min_values: control.min ?? 1,
						max_values: control.max ?? 1,
						options: control.options.map(choiceJson),
					};
			}
		}),
	}));
}

function choiceJson(option: ChoiceOption) {
	return {
		label: cut(option.label, 100),
		value: option.value,
		...(option.description ? { description: cut(option.description, 100) } : {}),
		...(option.selected ? { default: true } : {}),
	};
}

/**
 * The arguments for a used control: what it holds, plus the chosen values for a
 * select. Undefined if the values aren't what was offered, which a real client
 * can't send.
 */
export function controlArgs(
	control: HeldControl,
	values: readonly string[] | undefined,
): Record<string, ArgValue> | undefined {
	const args = { ...control.call.args };
	if (!control.select) return args;
	const { arg, values: offered, min, max } = control.select;
	const chosen = values ?? [];
	if (
		chosen.length < min ||
		chosen.length > max ||
		new Set(chosen).size !== chosen.length ||
		!chosen.every((value) => offered.includes(value))
	) {
		return undefined;
	}
	if (chosen.length > 0) args[arg] = chosen.join(", ");
	return args;
}

/** A modal for a form (the API's JSON shape). Every input sits in a Label. */
export function renderForm(form: Form, customId: string) {
	if (form.fields.length < 1 || form.fields.length > UI_LIMITS.formFields) {
		throw new Error(`a form has 1 to ${UI_LIMITS.formFields} fields`);
	}
	return {
		custom_id: customId,
		title: cut(form.title, UI_LIMITS.formTitle),
		components: form.fields.map((field) => ({
			type: 18,
			label: cut(field.label, UI_LIMITS.fieldLabel),
			...(field.description
				? { description: cut(field.description, UI_LIMITS.fieldDescription) }
				: {}),
			component: inputJson(field),
		})),
	};
}

function inputJson(field: FormInput) {
	const required = field.required ?? true;
	switch (field.kind) {
		case "text": {
			const value = field.value?.slice(0, field.maxLength);
			return {
				type: 4,
				custom_id: field.name,
				style: field.style === "paragraph" ? 2 : 1,
				required,
				max_length: field.maxLength,
				...(field.placeholder ? { placeholder: cut(field.placeholder, 100) } : {}),
				...(value ? { value } : {}),
			};
		}
		case "radio":
			if (field.options.length < 2 || field.options.length > UI_LIMITS.choices) {
				throw new Error(`a radio group has 2 to ${UI_LIMITS.choices} options`);
			}
			return { type: 21, custom_id: field.name, required, options: field.options.map(choiceJson) };
		case "checkboxes":
			if (field.options.length < 1 || field.options.length > UI_LIMITS.choices) {
				throw new Error(`a checkbox group has 1 to ${UI_LIMITS.choices} options`);
			}
			if (field.options.some((o) => /\s/.test(o.value))) {
				throw new Error("checkbox values can't contain whitespace");
			}
			return {
				type: 22,
				custom_id: field.name,
				required,
				min_values: required ? 1 : 0,
				max_values: field.options.length,
				options: field.options.map(choiceJson),
			};
		case "user":
			return {
				type: 5,
				custom_id: field.name,
				required,
				min_values: required ? 1 : 0,
				max_values: 1,
				...(field.value ? { default_values: [{ id: field.value, type: "user" }] } : {}),
			};
		default:
			return {
				type: 8,
				custom_id: field.name,
				required,
				min_values: required ? 1 : 0,
				max_values: 1,
				// Text and announcement channels: where messages and polls go.
				channel_types: [0, 5],
				...(field.value ? { default_values: [{ id: field.value, type: "channel" }] } : {}),
			};
	}
}

/** One input as submitted, read off the modal by the adapter. */
export type SubmittedField = {
	customId: string;
	/** Text inputs and radio groups. */
	value?: string | null;
	/** Checkbox groups and selects. */
	values?: readonly string[];
	/** For a channel select: the picked channel and the submitter's permission bits there. */
	channel?: { id: string; name: string | null; callerPermissions: bigint | null };
	/** For a user select: who was picked. The name is for display only. */
	user?: { id: string; displayName: string; username: string; bot: boolean };
};

/**
 * Turns a submitted form into arguments, checked against the form that was shown:
 * only its fields, within their lengths, choices only from what was offered.
 * Undefined if anything doesn't match, which a real client can't send.
 */
export function formArgs(
	form: Form,
	submitted: readonly SubmittedField[],
):
	| {
			args: Record<string, ArgValue>;
			channels: Record<string, ResolvedChannel>;
			users: Record<string, ResolvedUser>;
	  }
	| undefined {
	const args: Record<string, ArgValue> = { ...form.submit.args };
	const channels: Record<string, ResolvedChannel> = {};
	const users: Record<string, ResolvedUser> = {};
	for (const field of form.fields) {
		const sent = submitted.find((s) => s.customId === field.name);
		const required = field.required ?? true;
		const offered = (o: readonly ChoiceOption[]) => new Set(o.map((choice) => choice.value));
		switch (field.kind) {
			case "text": {
				const value = sent?.value ?? "";
				if ([...value].length > field.maxLength) return undefined;
				if (value.trim() === "") {
					if (required) return undefined;
					continue;
				}
				args[field.name] = value;
				break;
			}
			case "radio": {
				const value = sent?.value ?? null;
				if (value === null) {
					if (required) return undefined;
					continue;
				}
				if (!offered(field.options).has(value)) return undefined;
				args[field.name] = value;
				break;
			}
			case "checkboxes": {
				const values = sent?.values ?? [];
				const allowed = offered(field.options);
				if (new Set(values).size !== values.length || !values.every((v) => allowed.has(v))) {
					return undefined;
				}
				if (values.length === 0) {
					if (required) return undefined;
					continue;
				}
				args[field.name] = values.join(", ");
				break;
			}
			case "user": {
				const user = sent?.user;
				if (!user || sent?.values?.[0] !== user.id || sent.values.length !== 1) {
					if (required || (sent?.values?.length ?? 0) > 0) return undefined;
					continue;
				}
				args[field.name] = user.id;
				users[field.name] = {
					id: user.id,
					displayName: user.displayName,
					handle: user.username,
					isBot: user.bot,
				};
				break;
			}
			default: {
				const channel = sent?.channel;
				if (!channel || sent?.values?.[0] !== channel.id || sent.values.length !== 1) {
					if (required || (sent?.values?.length ?? 0) > 0) return undefined;
					continue;
				}
				args[field.name] = channel.id;
				channels[field.name] = {
					id: channel.id,
					name: channel.name ?? channel.id,
					caller: callerAbilities(channel.callerPermissions),
				};
			}
		}
	}
	return { args, channels, users };
}

function cut(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** The parts of discord.js's submitted modal data that `submittedFields` reads. */
export type ModalDataLike = {
	customId: string;
	value?: string | boolean | null;
	values?: readonly string[];
	channels?: { get(id: string): { id: string; name?: string | null } | null | undefined } | null;
	users?: {
		get(
			id: string,
		):
			| { id: string; username: string; globalName?: string | null; bot?: boolean }
			| null
			| undefined;
	} | null;
	members?: {
		get(id: string): { displayName?: string; nick?: string | null } | null | undefined;
	} | null;
};

/**
 * Reads a submitted modal's inputs into plain values. `permissionsIn` says what the
 * submitter may do in a picked channel (their permission bits), or null if unknown.
 */
export function submittedFields(
	data: Iterable<ModalDataLike>,
	permissionsIn: (channel: { id: string; name?: string | null }) => bigint | null,
): SubmittedField[] {
	return [...data].map(({ customId, value, values, channels, users, members }) => {
		const first = values?.[0];
		const picked = first === undefined ? undefined : channels?.get(first);
		const person = first === undefined ? undefined : users?.get(first);
		const member = first === undefined ? undefined : members?.get(first);
		return {
			customId,
			...(typeof value === "string" || value === null ? { value } : {}),
			...(values ? { values } : {}),
			...(picked
				? {
						channel: {
							id: picked.id,
							name: picked.name ?? null,
							callerPermissions: permissionsIn(picked),
						},
					}
				: {}),
			...(person
				? {
						user: {
							id: person.id,
							// The server nickname when known. For display only.
							displayName:
								member?.displayName ?? member?.nick ?? person.globalName ?? person.username,
							username: person.username,
							bot: person.bot ?? false,
						},
					}
				: {}),
		};
	});
}
