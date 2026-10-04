import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../core/logger.ts";
import { logProcessFailures } from "./process-logging.ts";

function setup() {
	const proc = new EventEmitter();
	const error = vi.fn();
	logProcessFailures({ ...silentLogger, error }, proc as unknown as NodeJS.Process);
	return { proc, error };
}

describe("logProcessFailures", () => {
	it("logs an unhandled rejection with its error", () => {
		const { proc, error } = setup();
		const reason = new Error("nobody caught this");
		proc.emit("unhandledRejection", reason);
		expect(error).toHaveBeenCalledWith(
			{ event: "process.unhandled_rejection", err: reason },
			"unhandled promise rejection",
		);
	});

	it("wraps a rejection that isn't an Error, so it can still be logged", () => {
		const { proc, error } = setup();
		proc.emit("unhandledRejection", "just a string");
		const [fields] = error.mock.calls[0] as [{ err: Error }];
		expect(fields.err).toBeInstanceOf(Error);
		expect(fields.err.message).toBe("non-error thrown: just a string");
	});

	it("logs an uncaught exception, and where it came from", () => {
		const { proc, error } = setup();
		const thrown = new Error("boom");
		proc.emit("uncaughtExceptionMonitor", thrown, "uncaughtException");
		expect(error).toHaveBeenCalledWith(
			{ event: "process.uncaught_exception", origin: "uncaughtException", err: thrown },
			"uncaught exception",
		);
	});

	it("only listens, so it never changes whether the process exits", () => {
		const { proc } = setup();
		expect(proc.listenerCount("unhandledRejection")).toBe(1);
		expect(proc.listenerCount("uncaughtExceptionMonitor")).toBe(1);
		expect(proc.listenerCount("uncaughtException")).toBe(0);
	});
});
