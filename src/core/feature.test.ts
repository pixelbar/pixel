import { describe, expect, it, vi } from "vitest";
import { type Feature, startFeatures } from "./feature.ts";

describe("startFeatures", () => {
	it("starts every feature that has background work and skips the rest", () => {
		const start = vi.fn(() => () => {});
		startFeatures([{ name: "with", start }, { name: "without" }]);
		expect(start).toHaveBeenCalledOnce();
	});

	it("stops all the work it started", () => {
		const stopA = vi.fn();
		const stopB = vi.fn();
		const features: Feature[] = [
			{ name: "a", start: () => stopA },
			{ name: "plain" },
			{ name: "b", start: () => stopB },
		];
		const stop = startFeatures(features);
		expect(stopA).not.toHaveBeenCalled();
		stop();
		expect(stopA).toHaveBeenCalledOnce();
		expect(stopB).toHaveBeenCalledOnce();
	});

	it("does nothing, without failing, for no features", () => {
		expect(() => startFeatures([])()).not.toThrow();
	});
});
