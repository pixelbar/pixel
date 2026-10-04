import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canWriteLogs,
	createLogger,
	LOG_FILE_PREFIX,
	LOG_FILE_SIZE,
	LOG_FILES_KEPT,
	logTargets,
} from "./logger.ts";

function capture() {
	const lines: Record<string, unknown>[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			lines.push(JSON.parse(chunk.toString()));
			callback();
		},
	});
	return { lines, stream };
}

const config = { env: "dev", logLevel: "info", version: "1.2.3", logDir: undefined } as const;

describe("createLogger", () => {
	it("writes JSON with env and version", () => {
		const { lines, stream } = capture();
		createLogger(config, stream).info({ event: "startup" }, "hello");
		expect(lines[0]).toMatchObject({
			env: "dev",
			version: "1.2.3",
			event: "startup",
			msg: "hello",
		});
	});

	it("respects the log level", () => {
		const { lines, stream } = capture();
		const logger = createLogger({ ...config, logLevel: "warn" }, stream);
		logger.info({}, "dropped");
		logger.warn({}, "kept");
		expect(lines.map((l) => l.msg)).toEqual(["kept"]);
	});

	it("redacts tokens and authorization headers, including in child loggers", () => {
		const { lines, stream } = capture();
		const logger = createLogger(config, stream);
		logger.info({ token: "secret-1", client: { token: "secret-2" } }, "a");
		logger
			.child({ adapter: "x" })
			.info({ request: { headers: { authorization: "Bot secret-3" } } }, "b");
		const out = JSON.stringify(lines);
		expect(out).not.toMatch(/secret-\d/);
		expect(out).toContain("[redacted]");
	});
});

describe("secrets in log lines", () => {
	const discordToken = `${"A".repeat(26)}.${"B".repeat(6)}.${"C".repeat(38)}`;
	const haToken = `eyJ${"h".repeat(30)}.eyJ${"p".repeat(60)}.${"s".repeat(43)}`;

	it("masks token shapes in the message, in fields and in errors, and the line is still JSON", () => {
		const { lines, stream } = capture();
		const logger = createLogger(config, stream);
		logger.info({ event: "x", note: `Bearer ${haToken}` }, `using ${discordToken}`);
		logger.error({ err: new Error(`failed with ${haToken}`) }, "went wrong");
		const out = JSON.stringify(lines);
		expect(out).not.toContain(discordToken);
		expect(out).not.toContain(haToken);
		expect(lines[0]).toMatchObject({
			msg: "using [redacted-token]",
			note: "Bearer [redacted-token]",
		});
		expect(JSON.stringify(lines[1])).toContain("[redacted-token]");
	});

	it("leaves Discord IDs and ordinary text alone", () => {
		const { lines, stream } = capture();
		createLogger(config, stream).info(
			{ user: "discord:100000000000000001", port: 8080 },
			"hello 3 users",
		);
		expect(lines[0]).toMatchObject({
			user: "discord:100000000000000001",
			port: 8080,
			msg: "hello 3 users",
		});
	});
});

describe("logTargets", () => {
	it("prints readably when running locally, and as JSON everywhere else", () => {
		expect(logTargets({ env: "local", logLevel: "debug" }, undefined)).toEqual([
			{ target: "pino-pretty", level: "debug", options: {} },
		]);
		expect(logTargets({ env: "prod", logLevel: "info" }, undefined)).toEqual([
			{ target: "pino/file", level: "info", options: { destination: 1 } },
		]);
	});

	it("adds a rotating file of the same level when there is a directory", () => {
		const targets = logTargets({ env: "prod", logLevel: "warn" }, "/var/log/pixel");
		expect(targets).toHaveLength(2);
		expect(targets[1]).toEqual({
			target: "pino-roll",
			level: "warn",
			options: {
				file: join("/var/log/pixel", LOG_FILE_PREFIX),
				extension: ".log",
				frequency: "daily",
				dateFormat: "yyyy-MM-dd",
				size: LOG_FILE_SIZE,
				symlink: true,
				mkdir: true,
				mode: 0o600,
				limit: { count: LOG_FILES_KEPT, removeOtherLogFiles: true },
			},
		});
	});

	it("keeps about two weeks, in files of at most 20 MB, readable only by the owner", () => {
		expect([LOG_FILES_KEPT, LOG_FILE_SIZE]).toEqual([14, "20m"]);
		const options = logTargets({ env: "prod", logLevel: "info" }, "d", false)[0]?.options as {
			mode: number;
		};
		expect(options.mode).toBe(0o600);
	});

	it("can leave the console out", () => {
		expect(logTargets({ env: "prod", logLevel: "info" }, "d", false).map((t) => t.target)).toEqual([
			"pino-roll",
		]);
		expect(logTargets({ env: "prod", logLevel: "info" }, undefined, false)).toEqual([]);
	});
});

describe("canWriteLogs", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pixel-logs-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("creates the directory, and nested ones, when it can", () => {
		expect(canWriteLogs(join(dir, "a", "b"))).toBe(true);
		expect(existsSync(join(dir, "a", "b"))).toBe(true);
		expect(canWriteLogs(dir)).toBe(true);
	});

	it("says no, without throwing, when it can't", () => {
		writeFileSync(join(dir, "file"), "not a directory");
		expect(canWriteLogs(join(dir, "file", "logs"))).toBe(false);
		expect(canWriteLogs(join(dir, "file"))).toBe(false);
	});
});

describe("createLogger writing a file", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pixel-logs-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** The transport runs in a worker, so wait for the file to hold what was logged. */
	async function lines(logDir: string, count: number): Promise<Record<string, unknown>[]> {
		const until = Date.now() + 8000;
		for (;;) {
			const files = existsSync(logDir)
				? readdirSync(logDir).filter((f) => /^pixel\.\d{4}-\d{2}-\d{2}\.\d+\.log$/.test(f))
				: [];
			const text = files.map((f) => readFileSync(join(logDir, f), "utf8")).join("");
			const parsed = text
				.split("\n")
				.filter((l) => l.trim() !== "")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			if (parsed.length >= count) return parsed;
			if (Date.now() > until) throw new Error(`only ${parsed.length} lines were written`);
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	it("writes every line as JSON, with env and version, redaction and child fields", async () => {
		const logDir = join(dir, "nested", "logs");
		const logger = createLogger(
			{ env: "prod", logLevel: "info", version: "1.2.3", logDir },
			undefined,
			{ console: false },
		);
		logger.debug({ event: "noisy" }, "below the level");
		logger.info({ event: "startup", token: "secret-1" }, "hello");
		logger
			.child({ component: "home" })
			.warn(
				{ event: "x" },
				`careful ${"eyJ" + "h".repeat(20)}.${"p".repeat(20)}.${"s".repeat(20)}`,
			);
		const written = await lines(logDir, 2);
		expect(written[0]).toMatchObject({
			env: "prod",
			version: "1.2.3",
			event: "startup",
			msg: "hello",
			token: "[redacted]",
		});
		// Token shapes are masked in the file too.
		expect(written[1]).toMatchObject({
			component: "home",
			event: "x",
			msg: "careful [redacted-token]",
			level: 40,
		});
		expect(JSON.stringify(written)).not.toContain("secret-1");
		expect(JSON.stringify(written)).not.toContain("below the level");
	});

	it("writes a file only its owner can read, and points current.log at it", async () => {
		const logDir = join(dir, "logs");
		const logger = createLogger(
			{ env: "prod", logLevel: "info", version: "1", logDir },
			undefined,
			{
				console: false,
			},
		);
		logger.info({ event: "startup" }, "hello");
		await lines(logDir, 1);
		const file = readdirSync(logDir).find((f) => /^pixel\.\d{4}-\d{2}-\d{2}\.\d+\.log$/.test(f));
		expect(file).toBeDefined();
		expect(statSync(join(logDir, file as string)).mode & 0o777).toBe(0o600);
		expect(lstatSync(join(logDir, "current.log")).isSymbolicLink()).toBe(true);
	});

	it("carries on with the console when the log directory can't be written", () => {
		writeFileSync(join(dir, "file"), "not a directory");
		const logger = createLogger(
			{ env: "prod", logLevel: "info", version: "1", logDir: join(dir, "file", "logs") },
			undefined,
			{ console: true },
		);
		expect(() => logger.info({ event: "still-works" }, "fine")).not.toThrow();
		expect(existsSync(join(dir, "file", "logs"))).toBe(false);
	});
});
