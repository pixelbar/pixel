import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";

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

const config = { env: "dev", logLevel: "info", version: "1.2.3" } as const;

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
