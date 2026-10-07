import { randomBytes } from "node:crypto";
import type { DispatchRequest, FormOption } from "../../core/dispatcher.ts";

/**
 * Commands with form fields (long or multi-line text) open a Discord modal first.
 * The options typed with the command wait here, under a random token in the modal's
 * ID, until the person submits it. Only that person can complete it, and it expires,
 * so a form left open can't run a command much later. Nothing is trusted from the
 * modal except the text typed into it: everything else comes from here, and the
 * dispatcher checks it all again.
 */

/** How long a form may stay open before it's refused. */
const FORM_MS = 15 * 60_000;
/** At most this many forms waiting at once. */
const MAX_PENDING = 200;
export const FORM_PREFIX = "pixel-form:";
const CUSTOM_ID = /^pixel-form:([0-9a-f]{24})$/;

export type PendingForm = {
	request: DispatchRequest;
	fields: readonly FormOption[];
	expires: number;
};

export class PendingForms {
	readonly #pending = new Map<string, PendingForm>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Keeps a command waiting for its form and returns the modal's custom ID. */
	hold(request: DispatchRequest, fields: readonly FormOption[]): string {
		this.#prune();
		const token = randomBytes(12).toString("hex");
		this.#pending.set(token, { request, fields, expires: this.#now() + FORM_MS });
		return `${FORM_PREFIX}${token}`;
	}

	/**
	 * Takes the command waiting for a submitted form, if it's still valid and belongs to
	 * the person submitting it. Used once: a second submit finds nothing.
	 */
	take(customId: string, userId: string): PendingForm | "expired" | "not-yours" {
		const token = CUSTOM_ID.exec(customId)?.[1];
		const entry = token ? this.#pending.get(token) : undefined;
		if (!token || !entry || entry.expires <= this.#now()) {
			if (token) this.#pending.delete(token);
			return "expired";
		}
		if (entry.request.actor.userId !== userId) return "not-yours";
		this.#pending.delete(token);
		return entry;
	}

	get size(): number {
		return this.#pending.size;
	}

	#prune(): void {
		const now = this.#now();
		for (const [token, entry] of this.#pending)
			if (entry.expires <= now) this.#pending.delete(token);
		while (this.#pending.size >= MAX_PENDING)
			this.#pending.delete(this.#pending.keys().next().value as string);
	}
}

/** The modal Discord shows for a command's form fields (the API's JSON shape). */
export function formModal(customId: string, title: string, fields: readonly FormOption[]) {
	return {
		custom_id: customId,
		title: title.slice(0, 45),
		components: fields.map((field) => ({
			type: 1,
			components: [
				{
					type: 4,
					custom_id: field.name,
					label: field.description.slice(0, 45),
					style: field.form.style === "paragraph" ? 2 : 1,
					required: field.required ?? false,
					max_length: field.form.maxLength,
					...(field.form.placeholder ? { placeholder: field.form.placeholder.slice(0, 100) } : {}),
				},
			],
		})),
	};
}
