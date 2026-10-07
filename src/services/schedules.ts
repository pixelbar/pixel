import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { ChannelPost } from "../core/channel-posts.ts";
import { UserFacingError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import { parseLocal, type Recurrence, WEEKDAYS } from "../core/recurrence.ts";

/**
 * Scheduled posts, kept in `data/schedules.yaml` so they survive restarts. Unlike the
 * rest of `data/`, this isn't safe to delete: it's the schedules themselves. Written
 * atomically (temp file and rename). If the file exists but is invalid, nothing is
 * posted and nothing can be changed until it's fixed, so a bad edit is never
 * silently overwritten.
 */

export const MAX_SCHEDULES = 50;
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_POLL_QUESTION = 300;
export const MAX_POLL_ANSWER = 55;
export const MAX_POLL_ANSWERS = 10;

export type Schedule = {
	/** Short and typeable: six lowercase letters and digits. */
	id: string;
	/** For finding it again; defaults to the start of the text. */
	name: string;
	channelId: string;
	/** For display; the channel may have been renamed since. */
	channelName: string;
	post: ChannelPost;
	/** The first time, wall clock in the configured zone: "2026-10-14T19:00". */
	start: string;
	recurrence: Recurrence;
	paused: boolean;
	/** Who made it: their platform ID, and a name for humans. */
	createdBy: { ref: string; name: string };
	createdAt: string;
	/** The last occurrence handled (posted or skipped), so nothing is posted twice. */
	lastRunAt: string | null;
};

const ID = /^[a-z0-9]{6}$/;
const snowflake = z.string().regex(/^\d{17,20}$/);

const postSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("message"),
		text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
		mentions: z.boolean(),
	}),
	z.strictObject({
		kind: z.literal("poll"),
		question: z.string().min(1).max(MAX_POLL_QUESTION),
		answers: z.array(z.string().min(1).max(MAX_POLL_ANSWER)).min(2).max(MAX_POLL_ANSWERS),
		durationHours: z.number().int().min(1).max(768),
		multiple: z.boolean(),
	}),
]);

const recurrenceSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("once") }),
	z.strictObject({
		kind: z.literal("weekly"),
		everyWeeks: z.union([z.literal(1), z.literal(2)]),
		days: z.array(z.enum(WEEKDAYS)).min(1).max(7),
	}),
	z.strictObject({
		kind: z.literal("monthly"),
		everyMonths: z.union([z.literal(1), z.literal(2)]),
	}),
]);

const scheduleSchema = z.strictObject({
	id: z.string().regex(ID),
	name: z.string().min(1).max(100),
	channelId: snowflake,
	channelName: z.string().max(100),
	post: postSchema,
	start: z
		.string()
		.refine((s) => parseLocal(s) !== undefined, { error: "must be like 2026-10-14T19:00" }),
	recurrence: recurrenceSchema,
	paused: z.boolean(),
	createdBy: z.strictObject({ ref: z.string().min(1).max(64), name: z.string().max(100) }),
	createdAt: z.iso.datetime(),
	lastRunAt: z.iso.datetime().nullable(),
});

const fileSchema = z.strictObject({ schedules: z.array(scheduleSchema).max(MAX_SCHEDULES) });

const HEADER =
	"# Pixel's scheduled posts. Managed with /schedule; NOT safe to delete. Times are wall-clock in PIXEL_TIMEZONE.\n";

export class ScheduleStoreError extends UserFacingError {
	override name = "ScheduleStoreError";
}

export class ScheduleStore {
	readonly #file: string | undefined;
	readonly #logger: Logger;
	#schedules: Schedule[] = [];
	/** Why the file can't be used, if it can't. Nothing runs or changes until it's fixed. */
	readonly problem: string | undefined;

	constructor(options: { file?: string; logger: Logger }) {
		this.#file = options.file;
		this.#logger = options.logger.child({ component: "schedules" });
		this.problem = this.#load();
	}

	/** Every schedule, in the order they were made. */
	all(): readonly Schedule[] {
		return this.#schedules;
	}

	get(id: string): Schedule | undefined {
		return this.#schedules.find((s) => s.id === id);
	}

	/** Adds a schedule, giving it an ID. */
	add(schedule: Omit<Schedule, "id">): Schedule {
		this.#writable();
		if (this.#schedules.length >= MAX_SCHEDULES) {
			throw new ScheduleStoreError(
				`There are already ${MAX_SCHEDULES} schedules. Delete one first.`,
			);
		}
		const full = { ...schedule, id: this.#newId() };
		this.#save([...this.#schedules, full]);
		return full;
	}

	/** Changes a schedule. Undefined if it no longer exists. */
	update(id: string, change: Partial<Omit<Schedule, "id">>): Schedule | undefined {
		this.#writable();
		const current = this.get(id);
		if (!current) return undefined;
		const next = { ...current, ...change };
		this.#save(this.#schedules.map((s) => (s.id === id ? next : s)));
		return next;
	}

	/** Removes a schedule. Undefined if it no longer exists. */
	remove(id: string): Schedule | undefined {
		this.#writable();
		const current = this.get(id);
		if (current) this.#save(this.#schedules.filter((s) => s.id !== id));
		return current;
	}

	#writable(): void {
		if (this.problem) {
			throw new ScheduleStoreError(
				"The schedules file is invalid, so nothing can be changed until an admin fixes it. See the logs.",
			);
		}
	}

	#newId(): string {
		const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
		for (;;) {
			const id = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("");
			if (!this.get(id)) return id;
		}
	}

	#load(): string | undefined {
		if (!this.#file) return undefined;
		let source: string;
		try {
			source = readFileSync(this.#file, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return undefined;
			return this.#broken(`cannot read ${this.#file} (${code ?? "unknown error"})`);
		}
		let data: unknown;
		try {
			data = parse(source);
		} catch {
			return this.#broken(`${this.#file} is not valid YAML`);
		}
		const result = fileSchema.safeParse(data);
		if (!result.success) {
			const where = result.error.issues
				.slice(0, 5)
				.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
				.join("; ");
			return this.#broken(`${this.#file} is invalid: ${where}`);
		}
		const ids = result.data.schedules.map((s) => s.id);
		if (new Set(ids).size !== ids.length)
			return this.#broken(`${this.#file} repeats a schedule id`);
		this.#schedules = result.data.schedules as Schedule[];
		return undefined;
	}

	#broken(problem: string): string {
		this.#logger.error({ event: "schedules.unreadable" }, `${problem}; no schedules will run`);
		return problem;
	}

	#save(next: Schedule[]): void {
		if (this.#file) {
			try {
				mkdirSync(dirname(this.#file), { recursive: true });
				const temp = `${this.#file}.tmp`;
				writeFileSync(temp, HEADER + stringify({ schedules: next }));
				renameSync(temp, this.#file);
			} catch (error) {
				this.#logger.error(
					{ event: "schedules.save_failed", err: error },
					"couldn't save the schedules",
				);
				throw new ScheduleStoreError("Couldn't save the schedules, so nothing was changed.");
			}
		}
		this.#schedules = next;
	}
}
