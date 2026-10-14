import { describe, expect, it } from "vitest";
import { assertRegisterEnv, parseRegisterTarget } from "./register-env.ts";

describe("parseRegisterTarget", () => {
	it("accepts dev and prod", () => {
		expect(parseRegisterTarget(["dev"])).toBe("dev");
		expect(parseRegisterTarget(["prod"])).toBe("prod");
	});

	it("refuses a missing or unknown target", () => {
		expect(() => parseRegisterTarget([])).toThrow(/Expected dev or prod/);
		expect(() => parseRegisterTarget(["local"])).toThrow(/just register dev\|prod/);
		expect(() => parseRegisterTarget(["dev", "prod"])).toThrow(/Expected dev or prod/);
	});
});

describe("assertRegisterEnv", () => {
	it("allows local or dev files on just register dev", () => {
		expect(() => assertRegisterEnv("dev", "local")).not.toThrow();
		expect(() => assertRegisterEnv("dev", "dev")).not.toThrow();
	});

	it("allows only PIXEL_ENV=prod on just register prod", () => {
		expect(() => assertRegisterEnv("prod", "prod")).not.toThrow();
	});

	it("refuses a prod file on just register dev", () => {
		expect(() => assertRegisterEnv("dev", "prod")).toThrow(/PIXEL_ENV=prod/);
	});

	it("refuses a non-prod file on just register prod", () => {
		expect(() => assertRegisterEnv("prod", "local")).toThrow(/PIXEL_ENV is not prod/);
		expect(() => assertRegisterEnv("prod", "dev")).toThrow(/Never copy the Pixel Dev token/);
	});
});
