import { describe, expect, it, vi } from "vitest";
import {
	CapabilityError,
	CapabilityRegistry,
	MAX_REGISTERED_CAPABILITIES,
	reportUnknownCapabilities,
	unknownCapabilities,
} from "./capabilities.ts";
import { silentLogger } from "./logger.ts";
import { nullErrorReporter } from "./ports/error-reporter.ts";

describe("CapabilityRegistry", () => {
	it("starts empty", () => {
		const registry = new CapabilityRegistry();
		expect(registry.all()).toEqual([]);
		expect(registry.has("door")).toBe(false);
		expect(registry.get("door")).toBeUndefined();
	});

	it("holds what it's given", () => {
		const registry = new CapabilityRegistry([
			{ name: "front-door", description: "Open the front door" },
			{ name: "workshop", description: "Use the workshop" },
		]);
		expect(registry.has("front-door")).toBe(true);
		expect(registry.get("workshop")?.description).toBe("Use the workshop");
		expect(registry.all().map((c) => c.name)).toEqual(["front-door", "workshop"]);
	});

	it.each(["Door", "front door", "", "1door", "x".repeat(33), "door_"])(
		"rejects the invalid name %j",
		(name) => {
			expect(() => new CapabilityRegistry([{ name, description: "d" }])).toThrow(CapabilityError);
		},
	);

	it("rejects empty and too-long descriptions", () => {
		expect(() => new CapabilityRegistry([{ name: "a", description: "" }])).toThrow(/Description/);
		expect(() => new CapabilityRegistry([{ name: "a", description: "x".repeat(101) }])).toThrow(
			/Description/,
		);
	});

	it("rejects duplicates", () => {
		expect(
			() =>
				new CapabilityRegistry([
					{ name: "a", description: "d" },
					{ name: "a", description: "d" },
				]),
		).toThrow(/Duplicate capability/);
	});

	it("rejects more than Discord can offer as choices", () => {
		const many = Array.from({ length: MAX_REGISTERED_CAPABILITIES + 1 }, (_, i) => ({
			name: `c${i}`,
			description: "d",
		}));
		expect(() => new CapabilityRegistry(many)).toThrow(/At most 25/);
	});
});

describe("unknownCapabilities", () => {
	const registry = new CapabilityRegistry([{ name: "door", description: "d" }]);

	it("counts how many people hold each name that isn't registered", () => {
		const unknown = unknownCapabilities(
			[{ capabilities: ["door", "old"] }, { capabilities: ["old", "gone"] }, { capabilities: [] }],
			registry,
		);
		expect([...unknown]).toEqual([
			["old", 2],
			["gone", 1],
		]);
	});

	it("is empty when everything exists", () => {
		expect(unknownCapabilities([{ capabilities: ["door"] }], registry).size).toBe(0);
	});
});

describe("reportUnknownCapabilities", () => {
	const registry = new CapabilityRegistry([{ name: "door", description: "d" }]);

	function deps() {
		const logger = { ...silentLogger, warn: vi.fn() };
		const reporter = { ...nullErrorReporter, captureBackground: vi.fn() };
		return { logger, reporter };
	}

	it("warns and reports names, sorted, without failing", () => {
		const { logger, reporter } = deps();
		const names = reportUnknownCapabilities(
			[{ capabilities: ["zeta", "alpha", "door"] }],
			registry,
			{ logger, reporter },
		);
		expect(names).toEqual(["alpha", "zeta"]);
		expect(logger.warn).toHaveBeenCalledWith(
			{ event: "access.unknown_capabilities", capabilities: ["alpha", "zeta"] },
			expect.any(String),
		);
		expect(reporter.captureBackground).toHaveBeenCalledTimes(1);
		const [error, source] = reporter.captureBackground.mock.calls[0] ?? [];
		expect(error).toBeInstanceOf(CapabilityError);
		expect((error as Error).message).toBe("Unknown capabilities in the members file: alpha, zeta");
		expect(source).toBe("access-config");
	});

	it("stays quiet when there's nothing to report", () => {
		const { logger, reporter } = deps();
		expect(
			reportUnknownCapabilities([{ capabilities: ["door"] }], registry, { logger, reporter }),
		).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
		expect(reporter.captureBackground).not.toHaveBeenCalled();
	});
});
