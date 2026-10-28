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

export class InstanceLease {
	readonly id: string;
	readonly #file: string;
	readonly #logger: Logger;
	readonly #onLost: () => void;
	#claimed = false;
	#lost = false;
	#readFailed = false;

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
		if (this.#lost) return;
		this.#claimed = true;
		await this.#write();
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
		if (!this.#claimed || this.#lost) return false;
		let owner: string;
		try {
			owner = parseOwner(await readFile(this.#file, "utf8"));
		} catch (error) {
			if (isMissing(error)) return this.#reclaim();
			if (!this.#readFailed) {
				this.#logger.warn(
					{ event: "instance.read_failed", err: error },
					"couldn't read the instance lease, so carrying on",
				);
			}
			this.#readFailed = true;
			return true;
		}
		this.#readFailed = false;
		if (owner === this.id) return true;
		if (owner === "") return this.#reclaim();
		this.#lost = true;
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

	async #reclaim(): Promise<boolean> {
		try {
			await this.#write();
			this.#logger.warn(
				{ event: "instance.reclaimed" },
				"the instance lease was missing, so wrote it again",
			);
		} catch (error) {
			this.#logger.warn(
				{ event: "instance.read_failed", err: error },
				"couldn't write the instance lease",
			);
		}
		return true;
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
