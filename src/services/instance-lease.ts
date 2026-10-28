import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Stop } from "../core/feature.ts";
import type { Logger } from "../core/logger.ts";

/**
 * Makes sure only one Pixel answers at a time (#11, ADR 0021). Container Apps
 * starts a new revision before it stops the old one, so for up to a minute two
 * instances are connected with the same bot token and both get every command.
 *
 * Each instance writes its own ID to a file on the shared volume once it is
 * connected (`claim`). Whoever's ID is in the file answers; the other one sees
 * it lost the file and stands by. The newest instance always wins, and an
 * instance that has lost never claims again, so the two can't take turns.
 *
 * Reading the file can fail (a share hiccup). Then the last answer stands, so
 * a slow share never silences the bot. A missing or empty file after a claim
 * means someone deleted it: it's written again.
 */

const HEADER = "# Which Pixel instance is answering (ADR 0021). Safe to delete.\n";

export type InstanceLeaseOptions = {
	/** The lease file, on storage every instance of this environment shares. */
	file: string;
	logger: Logger;
	/** Called once, when another instance has taken over. */
	onLost: () => void;
	/** This instance's ID. Random unless a test sets it. */
	id?: string;
};

/**
 * - `idle`: not claimed yet, so not answering (the instance it replaces still is).
 * - `claiming`: the claim is being written. Still not answering, and a file that names
 *   another instance is the one being replaced, not a takeover.
 * - `held`: written; answering until the file names someone else.
 * - `unwritten`: the claim couldn't be written. Answering anyway, never counted as lost
 *   (the file still names the old instance), and trying the write again on each check.
 * - `lost`: a newer instance took over. Never answers or claims again.
 */
type LeaseState = "idle" | "claiming" | "held" | "unwritten" | "lost";

export class InstanceLease {
	readonly id: string;
	readonly #file: string;
	readonly #logger: Logger;
	readonly #onLost: () => void;
	#state: LeaseState = "idle";
	/** Whether the last read or write failed, so a problem that persists is logged once. */
	#failing = false;

	constructor({ file, logger, onLost, id = randomUUID() }: InstanceLeaseOptions) {
		this.id = id;
		this.#file = file;
		this.#logger = logger.child({ component: "instance-lease" });
		this.#onLost = onLost;
	}

	/**
	 * Takes over from any other instance. Call once this one is connected and ready to answer.
	 * If the file can't be written it throws, but this instance still answers: a broken share
	 * must not silence the bot.
	 */
	async claim(): Promise<void> {
		if (this.#state !== "idle") return;
		this.#state = "claiming";
		try {
			await this.#write();
		} catch (error) {
			this.#state = "unwritten";
			this.#failing = true;
			throw error;
		}
		this.#state = "held";
		this.#logger.info(
			{ event: "instance.claimed", instance: this.id },
			"this instance is answering",
		);
	}

	/**
	 * Whether this instance should answer: it has claimed the lease and nobody
	 * has claimed it since. Never throws.
	 */
	async holds(): Promise<boolean> {
		if (this.#state === "unwritten") return this.#retry();
		if (this.#state !== "held") return false;
		let owner: string;
		try {
			owner = parseOwner(await readFile(this.#file, "utf8"));
		} catch (error) {
			if (isMissing(error)) return this.#reclaim();
			this.#problem(error, "couldn't read the instance lease, so carrying on");
			return true;
		}
		// A check that started before a failed rewrite mustn't count the stale file as a takeover.
		if (this.#state !== "held") return this.#state === "unwritten";
		this.#failing = false;
		if (owner === this.id) return true;
		if (owner === "") return this.#reclaim();
		this.#state = "lost";
		this.#logger.warn(
			{ event: "instance.lost", instance: this.id, now: owner },
			"another instance took over, so this one is standing by",
		);
		this.#onLost();
		return false;
	}

	/** Checks every `everyMs`, so an instance with nothing to answer still notices it lost. */
	watch(everyMs: number): Stop {
		const timer = setInterval(() => {
			void this.holds();
		}, everyMs);
		return () => clearInterval(timer);
	}

	/** The file is missing or empty: someone deleted it, so write it again. */
	async #reclaim(): Promise<boolean> {
		try {
			await this.#write();
			this.#logger.warn(
				{ event: "instance.reclaimed" },
				"the instance lease was missing, so wrote it again",
			);
		} catch (error) {
			this.#state = "unwritten";
			this.#problem(error, "couldn't write the instance lease, so carrying on");
		}
		return true;
	}

	/** The claim was never written: try again, answering either way. */
	async #retry(): Promise<boolean> {
		try {
			await this.#write();
		} catch (error) {
			this.#problem(error, "couldn't write the instance lease, so carrying on");
			return true;
		}
		if (this.#state === "unwritten") this.#state = "held";
		this.#failing = false;
		this.#logger.info(
			{ event: "instance.claimed", instance: this.id },
			"this instance is answering",
		);
		return true;
	}

	#problem(error: unknown, message: string): void {
		if (!this.#failing) {
			this.#logger.warn({ event: "instance.lease_failed", err: error }, message);
		}
		this.#failing = true;
	}

	/** Temp file then rename, so a reader never sees half a file. */
	async #write(): Promise<void> {
		await mkdir(dirname(this.#file), { recursive: true });
		const temp = `${this.#file}.${this.id}.tmp`;
		await writeFile(temp, `${HEADER}${this.id}\n`);
		await rename(temp, this.#file);
	}
}

function parseOwner(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line !== "" && !line.startsWith("#")) ?? ""
	);
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
	);
}
