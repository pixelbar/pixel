import { randomBytes } from "node:crypto";
import type { AttendanceColour } from "../../core/channel-posts.ts";
import type { ResolvedChannel } from "../../core/command.ts";
import type { Weekday } from "../../core/recurrence.ts";

export const REPEATS = ["once", "weekly", "fortnightly", "monthly", "every-2-months"] as const;
export type Repeat = (typeof REPEATS)[number];

/**
 * A scheduled post being made or changed, before it's saved. Nothing in a draft
 * posts or reaches the schedules file until the person presses Schedule (or Save).
 * Drafts live in memory: a restart drops them, like the controls that point at them.
 */
export type Draft = {
	id: string;
	/** Who it belongs to (`actorRef`). Nobody else can see or change it. */
	owner: string;
	/** The schedule it changes, for an edit. */
	editing?: string;
	kind: "message" | "poll" | "attendance";
	/** As picked on the form, with what the person may do there. */
	channel?: ResolvedChannel;
	/** As typed. */
	when: string;
	/** On an edit: what `when` was filled in with. Unchanged means keep the timing. */
	whenAsShown?: string;
	repeat: Repeat;
	/** For weekly and fortnightly. Unset means the first post's weekday. */
	days?: readonly Weekday[];
	text: string;
	mentions: boolean;
	question: string;
	/** As typed: one per line. */
	answers: string;
	durationHours: number;
	multiple: boolean;
	/** For an attendance poll: which answers count as coming, by position. Unset means the first. */
	counting?: readonly number[];
	/** For an attendance poll: each answer's button colour, by position. Missing ones are grey. */
	colours?: readonly AttendanceColour[];
	/** Unset means the start of the text. */
	name?: string;
	/**
	 * For a poll: a reminder every day while it's open. `at` is as typed. The channel's
	 * `caller` is set when it was picked on the form; an unchanged one from an edit has none.
	 */
	reminder?: {
		at: string;
		channel?: { id: string; name: string; caller?: ResolvedChannel["caller"] };
	};
	/**
	 * For an attendance poll: where and when the totals are posted. `at` is as typed
	 * (empty for no status post), and the channel is as for `reminder`. Unset means no
	 * results posts: the totals only show on the poll.
	 */
	results?: {
		at: string;
		statusText: string;
		closedText: string;
		channel: { id: string; name: string; caller?: ResolvedChannel["caller"] };
	};
};

/** How long a draft lasts without being touched. */
const DRAFT_MS = 30 * 60_000;
/** At most this many drafts at once, the oldest dropped first. */
const MAX_DRAFTS = 100;

export class Drafts {
	readonly #drafts = new Map<string, { draft: Draft; expires: number }>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	create(fields: Omit<Draft, "id">): Draft {
		const now = this.#now();
		for (const [id, entry] of this.#drafts) if (entry.expires <= now) this.#drafts.delete(id);
		while (this.#drafts.size >= MAX_DRAFTS)
			this.#drafts.delete(this.#drafts.keys().next().value as string);
		const draft = { ...fields, id: randomBytes(6).toString("hex") };
		this.#drafts.set(draft.id, { draft, expires: now + DRAFT_MS });
		return draft;
	}

	/** The draft, if it exists, hasn't expired and belongs to `owner`. */
	get(id: string, owner: string): Draft | undefined {
		const entry = this.#drafts.get(id);
		if (!entry || entry.draft.owner !== owner) return undefined;
		if (entry.expires <= this.#now()) {
			this.#drafts.delete(id);
			return undefined;
		}
		return entry.draft;
	}

	/** Changes a draft and gives it more time. */
	update(draft: Draft, change: Partial<Omit<Draft, "id" | "owner">>): Draft {
		const updated = { ...draft, ...change };
		// Re-inserted, so the cap drops the least recently touched draft, not the oldest made.
		this.#drafts.delete(draft.id);
		this.#drafts.set(draft.id, { draft: updated, expires: this.#now() + DRAFT_MS });
		return updated;
	}

	remove(id: string): void {
		this.#drafts.delete(id);
	}
}
