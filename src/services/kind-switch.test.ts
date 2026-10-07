import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../core/logger.ts";
import { KindSwitch } from "./kind-switch.ts";

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-switch-"));
	file = join(dir, "data", "home-switches.state");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function logs() {
	const warn = vi.fn();
	const error = vi.fn();
	const logger = { ...silentLogger, warn, error };
	logger.child = () => logger;
	return { logger, warn, error };
}
const make = (logger = silentLogger) => new KindSwitch({ file, logger, switchable: ["door"] });

describe("KindSwitch", () => {
	it("starts with everything on when nothing has been saved", () => {
		expect(make().isOn("door")).toBe(true);
		expect(make().isOn("light")).toBe(true);
	});

	it("switches a kind off and on, saying whether it changed, and logs who did it", () => {
		const { logger, warn } = logs();
		const switches = make(logger);
		expect(switches.set("door", false, "discord:1")).toEqual({ changed: true, saved: true });
		expect(switches.isOn("door")).toBe(false);
		expect(switches.isOn("light")).toBe(true);
		expect(switches.set("door", false, "discord:1")).toEqual({ changed: false, saved: true });
		expect(switches.set("door", true, "discord:2")).toEqual({ changed: true, saved: true });
		expect(switches.isOn("door")).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "home.kind_switched",
				kind: "door",
				on: false,
				by: "discord:1",
			}),
			"control of doors switched off",
		);
	});

	it("remembers what's off across a restart, with who and when", () => {
		make().set("door", false, "discord:1");
		expect(make().isOn("door")).toBe(false);
		const text = readFileSync(file, "utf8");
		expect(text).toContain("off:");
		expect(text).toContain("changedBy: discord:1");
		make().set("door", true, "discord:1");
		expect(make().isOn("door")).toBe(true);
	});

	it.each([
		["invalid YAML", "off: [door\n"],
		["the wrong shape", "off: door\n"],
		["unknown keys", "off: []\nextra: 1\n"],
	])("switches the switchable kinds off when the file has %s, and says so", (_label, text) => {
		mkdirSync(join(dir, "data"), { recursive: true });
		writeFileSync(file, text);
		const { logger, error } = logs();
		const switches = make(logger);
		expect(switches.isOn("door")).toBe(false);
		expect(switches.isOn("light")).toBe(true);
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "home.kind_switch_unreadable" }),
			expect.any(String),
		);
		// An admin switching it on rewrites the file, so it's fixed from then on.
		switches.set("door", true, "discord:1");
		expect(make().isOn("door")).toBe(true);
	});

	it("switches off when the file can't be read at all", () => {
		mkdirSync(file, { recursive: true });
		expect(make().isOn("door")).toBe(false);
	});

	it("still switches in memory when it can't save, and says so", () => {
		writeFileSync(join(dir, "data"), "a file where the directory should be");
		const { logger, error } = logs();
		const switches = make(logger);
		// The state can't be read either, so doors start off (fail closed).
		expect(switches.isOn("door")).toBe(false);
		expect(switches.set("door", true, "discord:1")).toEqual({ changed: true, saved: false });
		expect(switches.isOn("door")).toBe(true);
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "home.kind_switch_save_failed" }),
			expect.any(String),
		);
	});

	it("works without a file, for tests and tools", () => {
		const switches = new KindSwitch({ logger: silentLogger, switchable: ["door"] });
		expect(switches.set("door", false, "x")).toEqual({ changed: true, saved: true });
		expect(switches.isOn("door")).toBe(false);
	});
});
