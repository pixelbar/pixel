import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { OpenrSession } from "./client.ts";

/**
 * Keeps Pixel's OpenR session in a file (`data/openr-session.json`), so a restart or a
 * deploy doesn't need an admin and a new emailed code. The file holds the session's
 * cookies: anyone who can read it can open the doors until the session ends, so it's
 * written owner-only, never mirrored to laptops, and deleted when the session ends.
 */

const fileSchema = z.strictObject({
	version: z.literal(1),
	cookies: z.record(z.string().regex(/^_openr_\w+$/), z.string().min(1)),
	accessToken: z.string().min(1).optional(),
	refreshToken: z.string().min(1).optional(),
	accessUntil: z.iso.datetime(),
	refreshUntil: z.iso.datetime(),
	refreshedAt: z.iso.datetime().optional(),
});

export type SavedSession = { session: OpenrSession; refreshedAt: Date | undefined };

export type SessionFileRead =
	| { kind: "none" }
	| { kind: "found"; saved: SavedSession }
	/** The file is there but can't be read or used. Treated as logged out. */
	| { kind: "invalid" };

export class SessionFile {
	readonly #file: string;

	constructor(file: string) {
		this.#file = file;
	}

	read(): SessionFileRead {
		let source: string;
		try {
			source = readFileSync(this.#file, "utf8");
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT"
				? { kind: "none" }
				: { kind: "invalid" };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(source);
		} catch {
			return { kind: "invalid" };
		}
		const result = fileSchema.safeParse(parsed);
		if (!result.success) return { kind: "invalid" };
		const data = result.data;
		return {
			kind: "found",
			saved: {
				session: {
					cookies: data.cookies,
					accessToken: data.accessToken,
					refreshToken: data.refreshToken,
					accessUntil: new Date(data.accessUntil),
					refreshUntil: new Date(data.refreshUntil),
				},
				refreshedAt: data.refreshedAt ? new Date(data.refreshedAt) : undefined,
			},
		};
	}

	/** Saves atomically, readable by Pixel's user only. Throws when it can't. */
	write({ session, refreshedAt }: SavedSession): void {
		mkdirSync(dirname(this.#file), { recursive: true });
		const body = {
			version: 1,
			cookies: session.cookies,
			...(session.accessToken ? { accessToken: session.accessToken } : {}),
			...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
			accessUntil: session.accessUntil.toISOString(),
			refreshUntil: session.refreshUntil.toISOString(),
			...(refreshedAt ? { refreshedAt: refreshedAt.toISOString() } : {}),
		};
		const temp = `${this.#file}.tmp`;
		writeFileSync(temp, `${JSON.stringify(body, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, this.#file);
	}

	/** Deletes the file. Throws when it's there and can't be deleted. */
	remove(): void {
		rmSync(this.#file, { force: true });
	}
}
