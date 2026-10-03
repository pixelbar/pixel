import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

/** What Pixel remembers about the space between restarts. */
export type PersistedSpaceState = {
	state: "open" | "closed";
	/** When Pixel saw the space change to this state; null if it didn't see it happen. */
	since: Date | null;
};

/**
 * Where the space state is remembered. Synchronous on purpose: it's read once
 * at startup and written only when the state changes.
 */
export type SpaceStateStore = {
	/** The saved state, or undefined if nothing has been saved yet. Throws if the saved data is unusable. */
	load(): PersistedSpaceState | undefined;
	save(state: PersistedSpaceState): void;
};

export class SpaceStateFileError extends Error {
	override name = "SpaceStateFileError";
}

const fileSchema = z.strictObject({
	state: z.enum(["open", "closed"]),
	since: z.iso.datetime().nullable(),
});

const HEADER = "# Pixel's record of the last space state it saw. Safe to delete or edit.\n";

/**
 * Keeps the state in a small YAML file (`space.state`). Missing is normal;
 * unreadable or malformed is an error, which the caller treats as "start
 * fresh" — losing this only costs the "open for 2h" detail.
 */
export class FileSpaceStateStore implements SpaceStateStore {
	readonly #path: string;

	constructor(path: string) {
		this.#path = path;
	}

	load(): PersistedSpaceState | undefined {
		let source: string;
		try {
			source = readFileSync(this.#path, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return undefined;
			throw new SpaceStateFileError(`cannot read ${this.#path} (${code ?? "unknown error"})`);
		}

		let data: unknown;
		try {
			data = parse(source);
		} catch {
			throw new SpaceStateFileError(`${this.#path} is not valid YAML`);
		}
		const result = fileSchema.safeParse(data);
		if (!result.success) {
			throw new SpaceStateFileError(`${this.#path} has an unexpected shape`);
		}
		const { state, since } = result.data;
		return { state, since: since === null ? null : new Date(since) };
	}

	save({ state, since }: PersistedSpaceState): void {
		const body = stringify({ state, since: since?.toISOString() ?? null });
		mkdirSync(dirname(this.#path), { recursive: true });
		// Write to a temp file and rename, so a crash can't leave a half-written file.
		const temp = `${this.#path}.tmp`;
		writeFileSync(temp, HEADER + body);
		renameSync(temp, this.#path);
	}
}
