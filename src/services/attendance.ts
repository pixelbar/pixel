import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
	ATTENDANCE_COLOURS,
	type AttendanceAnswer,
	MAX_ATTENDANCE_ANSWERS,
} from "../core/channel-posts.ts";
import { UserFacingError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import { MAX_ATTENDANCE_LABEL, MAX_POLL_QUESTION, MAX_RESULTS_TEXT } from "./schedules.ts";

/**
 * Attendance polls Pixel has posted, and who answered what, kept in
 * `data/attendance.yaml` so a poll keeps counting across restarts. People are kept by
 * their immutable ID; the name is what they were called when they last voted, for the
 * totals. Written atomically (temp file and rename). If the file exists but is
 * invalid, no vote is taken and nothing is posted until it's fixed, so a bad edit is
 * never silently overwritten. Deleting it while a poll is open loses that poll's
 * votes, and its buttons stop working.
 */

/** The polls kept at once. Closed ones go first, a week after closing. */
export const MAX_POLLS = 100;
/** How long a closed poll is kept, for anyone looking at the file. */
const KEEP_CLOSED_MS = 7 * 24 * 3_600_000;
/** Votes on one poll. */
export const MAX_VOTES = 500;

export const POLL_ID = /^[0-9a-f]{12}$/;

export type AttendanceVote = {
	/** `discord:<id>`. Only ever matched by ID. */
	ref: string;
	/** Their display name when they last voted. For the totals only, never for deciding anything. */
	name: string;
	/** Which answer, by position. */
	answer: number;
};

export type AttendancePoll = {
	id: string;
	/** The schedule that posted it. It may have been deleted since. */
	scheduleId: string;
	/** Who made that schedule (`actorRef`): results go out only while they may still schedule. */
	createdBy: string;
	channelId: string;
	messageId: string;
	url: string;
	/** As posted, tokens filled. */
	question: string;
	answers: readonly AttendanceAnswer[];
	/** The occurrence it was posted for: the date tokens in the results count from it. */
	postedAt: string;
	closesAt: string;
	/** Copied from the schedule when it was posted, so a later edit doesn't change it. */
	results?: {
		channelId: string;
		/** When the totals so far are posted, if they are. */
		statusAt?: string;
		statusText: string;
		closedText: string;
	};
	/** The status post has been handled (posted or skipped), so it's never posted twice. */
	statusHandled?: boolean;
	/** It has closed and its close has been handled. */
	closed: boolean;
	/**
	 * Its message has been edited to show it closed (the buttons gone). Until then the
	 * runner keeps trying, so a failed edit never leaves buttons on a closed poll.
	 */
	closeShown?: boolean;
	votes: readonly AttendanceVote[];
};

const snowflake = z.string().regex(/^\d{17,20}$/);

const pollSchema = z
	.strictObject({
		id: z.string().regex(POLL_ID),
		scheduleId: z.string().regex(/^[a-z0-9]{6}$/),
		createdBy: z.string().min(1).max(64),
		channelId: snowflake,
		messageId: snowflake,
		url: z.url({ protocol: /^https$/ }).max(500),
		question: z.string().min(1).max(MAX_POLL_QUESTION),
		answers: z
			.array(
				z.strictObject({
					label: z.string().min(1).max(MAX_ATTENDANCE_LABEL),
					counts: z.boolean(),
					colour: z.enum(ATTENDANCE_COLOURS).optional(),
				}),
			)
			.min(1)
			.max(MAX_ATTENDANCE_ANSWERS),
		postedAt: z.iso.datetime(),
		closesAt: z.iso.datetime(),
		results: z
			.strictObject({
				channelId: snowflake,
				statusAt: z.iso.datetime().optional(),
				statusText: z.string().min(1).max(MAX_RESULTS_TEXT),
				closedText: z.string().min(1).max(MAX_RESULTS_TEXT),
			})
			.optional(),
		statusHandled: z.boolean().optional(),
		closed: z.boolean(),
		closeShown: z.boolean().optional(),
		votes: z
			.array(
				z.strictObject({
					ref: z.string().regex(/^discord:\d{17,20}$/),
					name: z.string().max(100),
					answer: z.number().int().min(0),
				}),
			)
			.max(MAX_VOTES),
	})
	.refine((p) => p.votes.every((v) => v.answer < p.answers.length), {
		error: "a vote is for an answer the poll doesn't have",
		path: ["votes"],
	})
	.refine((p) => new Set(p.votes.map((v) => v.ref)).size === p.votes.length, {
		error: "someone has voted twice",
		path: ["votes"],
	});

const fileSchema = z.strictObject({ polls: z.array(pollSchema).max(MAX_POLLS) });

const HEADER =
	"# Pixel's attendance polls and their votes. Deleting it loses the votes of polls still open.\n";

export class AttendanceStoreError extends UserFacingError {
	override name = "AttendanceStoreError";
}

/** What a click did: the answer they now have, or none if they took theirs back. */
export type VoteResult = { poll: AttendancePoll; answer: number | undefined };

export class AttendanceStore {
	readonly #file: string | undefined;
	readonly #logger: Logger;
	#polls: AttendancePoll[] = [];
	/** Why the file can't be used, if it can't. Nothing runs or changes until it's fixed. */
	readonly problem: string | undefined;

	constructor(options: { file?: string; logger: Logger }) {
		this.#file = options.file;
		this.#logger = options.logger.child({ component: "attendance" });
		this.problem = this.#load();
	}

	all(): readonly AttendancePoll[] {
		return this.#polls;
	}

	get(id: string): AttendancePoll | undefined {
		return this.#polls.find((p) => p.id === id);
	}

	/** A fresh poll ID, for the buttons, before its message is posted. */
	newId(): string {
		for (;;) {
			const id = randomBytes(6).toString("hex");
			if (!this.get(id)) return id;
		}
	}

	/** Keeps a poll that has just been posted. Drops closed ones a week old, then the oldest closed. */
	add(poll: AttendancePoll, now: Date): void {
		this.#writable();
		let kept = this.#polls.filter(
			(p) => !(p.closed && now.getTime() - new Date(p.closesAt).getTime() > KEEP_CLOSED_MS),
		);
		while (kept.length >= MAX_POLLS) {
			const oldest = kept.findIndex((p) => p.closed);
			if (oldest === -1) {
				throw new AttendanceStoreError(`There are already ${MAX_POLLS} open attendance polls.`);
			}
			kept = kept.filter((_, i) => i !== oldest);
		}
		this.#save([...kept, poll]);
	}

	/**
	 * Records a click: their answer if they had none, the new one if they had another,
	 * or none if they clicked the one they had. Undefined if the poll has gone.
	 */
	vote(id: string, ref: string, name: string, answer: number): VoteResult | undefined {
		this.#writable();
		const poll = this.get(id);
		if (!poll) return undefined;
		if (!Number.isInteger(answer) || answer < 0 || answer >= poll.answers.length) {
			throw new Error(`answer ${answer} is out of range`);
		}
		const had = poll.votes.find((v) => v.ref === ref);
		const others = poll.votes.filter((v) => v.ref !== ref);
		const chosen = had?.answer === answer ? undefined : answer;
		if (chosen !== undefined && !had && poll.votes.length >= MAX_VOTES) {
			throw new AttendanceStoreError("This poll has as many answers as it can hold.");
		}
		const votes =
			chosen === undefined
				? others
				: [...others, { ref, name: [...name].slice(0, 100).join(""), answer: chosen }];
		const updated = { ...poll, votes };
		this.#replace(updated);
		return { poll: updated, answer: chosen };
	}

	/** Changes a poll. Undefined if it has gone. */
	update(
		id: string,
		change: Partial<Pick<AttendancePoll, "statusHandled" | "closed" | "closeShown">>,
	): AttendancePoll | undefined {
		this.#writable();
		const poll = this.get(id);
		if (!poll) return undefined;
		const updated = { ...poll, ...change };
		this.#replace(updated);
		return updated;
	}

	#replace(poll: AttendancePoll): void {
		this.#save(this.#polls.map((p) => (p.id === poll.id ? poll : p)));
	}

	#writable(): void {
		if (this.problem) {
			throw new AttendanceStoreError(
				"Attendance polls are unavailable until an admin fixes their file. See the logs.",
			);
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
		const ids = result.data.polls.map((p) => p.id);
		if (new Set(ids).size !== ids.length) return this.#broken(`${this.#file} repeats a poll id`);
		this.#polls = result.data.polls as AttendancePoll[];
		return undefined;
	}

	#broken(problem: string): string {
		this.#logger.error({ event: "attendance.unreadable" }, `${problem}; no votes will be taken`);
		return problem;
	}

	#save(next: AttendancePoll[]): void {
		if (this.#file) {
			try {
				mkdirSync(dirname(this.#file), { recursive: true });
				const temp = `${this.#file}.tmp`;
				writeFileSync(temp, HEADER + stringify({ polls: next }));
				renameSync(temp, this.#file);
			} catch (error) {
				this.#logger.error(
					{ event: "attendance.save_failed", err: error },
					"couldn't save the attendance polls",
				);
				throw new AttendanceStoreError("Couldn't save that, so nothing was changed.");
			}
		}
		this.#polls = next;
	}
}
