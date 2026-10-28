import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../core/logger.ts";
import { InstanceLease } from "./instance-lease.ts";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-lease-"));
	file = join(dir, "data", "instance.lease");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function lease(id: string, onLost = vi.fn()) {
	const logger = { ...silentLogger, info: vi.fn(), warn: vi.fn() };
	logger.child = () => logger;
	return { lease: new InstanceLease({ file, logger, onLost, id }), onLost, logger };
}

describe("InstanceLease", () => {
	it("doesn't answer before it has claimed", async () => {
		expect(await lease("old").lease.holds()).toBe(false);
	});

	it("answers once claimed, writing its ID with a header and no temp file left behind", async () => {
		const { lease: mine } = lease("old");
		await mine.claim();
		expect(await mine.holds()).toBe(true);
		expect(readFileSync(file, "utf8")).toMatch(/^# .*\nold\n$/);
		expect(readdirSync(join(dir, "data"))).toEqual(["instance.lease"]);
	});

	it("hands over to a newer instance, which the old one notices once, for good", async () => {
		const old = lease("old");
		const next = lease("new");
		await old.lease.claim();
		await next.lease.claim();
		expect(await next.lease.holds()).toBe(true);
		expect(await old.lease.holds()).toBe(false);
		expect(await old.lease.holds()).toBe(false);
		expect(old.onLost).toHaveBeenCalledOnce();
		// It never takes the lease back, even if asked to.
		await old.lease.claim();
		expect(readFileSync(file, "utf8")).toContain("new");
		expect(next.onLost).not.toHaveBeenCalled();
	});

	it("writes the file again if it was deleted or emptied", async () => {
		const { lease: mine, logger } = lease("old");
		await mine.claim();
		unlinkSync(file);
		expect(await mine.holds()).toBe(true);
		expect(readFileSync(file, "utf8")).toContain("old");
		writeFileSync(file, "# only a comment\n\n");
		expect(await mine.holds()).toBe(true);
		expect(readFileSync(file, "utf8")).toContain("old");
		expect(logger.warn).toHaveBeenCalledWith({ event: "instance.reclaimed" }, expect.any(String));
	});

	it("carries on answering when the file can't be read, and says so once", async () => {
		const { lease: mine, logger } = lease("old");
		await mine.claim();
		rmSync(file);
		mkdirSync(file); // reading a directory fails with something other than "missing"
		expect(await mine.holds()).toBe(true);
		expect(await mine.holds()).toBe(true);
		expect(logger.warn).toHaveBeenCalledOnce();
		rmSync(file, { recursive: true });
		writeFileSync(file, "old\n");
		expect(await mine.holds()).toBe(true);
	});

	it("still answers when the claim can't be written, and keeps trying to write it", async () => {
		const { lease: mine, logger } = lease("old");
		writeFileSync(join(dir, "data"), "a file where the directory should be");
		await expect(mine.claim()).rejects.toThrow();
		expect(await mine.holds()).toBe(true);
		expect(await mine.holds()).toBe(true);
		// The caller reports the failed claim; retries that fail the same way add nothing.
		expect(logger.warn).not.toHaveBeenCalled();
		rmSync(join(dir, "data"));
		expect(await mine.holds()).toBe(true);
		expect(readFileSync(file, "utf8")).toContain("old");
	});

	it("doesn't answer, or count the old file as a takeover, while its claim is being written", async () => {
		const old = lease("old");
		await old.lease.claim();
		const next = lease("new");
		const claiming = next.lease.claim();
		expect(await next.lease.holds()).toBe(false);
		await claiming;
		expect(await next.lease.holds()).toBe(true);
		expect(next.onLost).not.toHaveBeenCalled();
	});

	it("never stands by because a failed claim left the old instance's ID in the file", async () => {
		const old = lease("old");
		await old.lease.claim();
		const next = lease("new");
		// Writing the temp file fails, so the file still names the old instance.
		mkdirSync(`${file}.new.tmp`);
		await expect(next.lease.claim()).rejects.toThrow();
		expect(await next.lease.holds()).toBe(true);
		expect(next.onLost).not.toHaveBeenCalled();
		// Once it can write, it takes over properly and the old one stands by.
		rmSync(`${file}.new.tmp`, { recursive: true });
		expect(await next.lease.holds()).toBe(true);
		expect(readFileSync(file, "utf8")).toContain("new");
		expect(await old.lease.holds()).toBe(false);
		expect(old.onLost).toHaveBeenCalledOnce();
		expect(await next.lease.holds()).toBe(true);
	});

	it("keeps answering when rewriting a deleted file fails", async () => {
		const { lease: mine, onLost } = lease("old");
		await mine.claim();
		unlinkSync(file);
		mkdirSync(`${file}.old.tmp`);
		expect(await mine.holds()).toBe(true);
		writeFileSync(file, "someone-else\n");
		// Still unwritten, so the stale file isn't a takeover; the next write puts it right.
		rmSync(`${file}.old.tmp`, { recursive: true });
		expect(await mine.holds()).toBe(true);
		expect(readFileSync(file, "utf8")).toContain("old");
		expect(onLost).not.toHaveBeenCalled();
	});

	it("checks on a timer until stopped", async () => {
		vi.useFakeTimers();
		try {
			const old = lease("old");
			await old.lease.claim();
			await lease("new").lease.claim();
			const stop = old.lease.watch(5_000);
			await vi.advanceTimersByTimeAsync(5_000);
			await vi.waitFor(() => expect(old.onLost).toHaveBeenCalledOnce());
			stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("picks a random ID when none is given", () => {
		const a = new InstanceLease({ file, logger: silentLogger, onLost: () => {} });
		const b = new InstanceLease({ file, logger: silentLogger, onLost: () => {} });
		expect(a.id).not.toBe(b.id);
	});
});
