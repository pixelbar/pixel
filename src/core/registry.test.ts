import { describe, expect, it } from "vitest";
import { command } from "../testing/fixtures.ts";
import type { CommandDefinition } from "./command.ts";
import { CommandRegistry, RegistryError } from "./registry.ts";

function register(...commands: CommandDefinition[]): CommandRegistry {
	const registry = new CommandRegistry();
	registry.register({ name: "test-feature", commands });
	return registry;
}

describe("CommandRegistry", () => {
	it("registers and looks up commands with their feature", () => {
		const registry = register(command({ name: "one" }), command({ name: "two" }));
		expect(registry.get("one")?.feature).toBe("test-feature");
		expect(registry.all().map((c) => c.definition.name)).toEqual(["one", "two"]);
	});

	it("rejects a command without access.minTier", () => {
		const noAccess = { ...command(), access: undefined } as unknown as CommandDefinition;
		expect(() => register(noAccess)).toThrow(RegistryError);
	});

	it("rejects a command with an empty access object", () => {
		const emptyAccess = { ...command(), access: {} } as unknown as CommandDefinition;
		expect(() => register(emptyAccess)).toThrow(/access\.minTier/);
	});

	it("rejects an unknown tier", () => {
		const badTier = command({ access: { minTier: "superuser" as never } });
		expect(() => register(badTier)).toThrow(/access\.minTier/);
	});

	it("rejects duplicate command names across features", () => {
		const registry = new CommandRegistry();
		registry.register({ name: "a", commands: [command({ name: "dup" })] });
		expect(() => registry.register({ name: "b", commands: [command({ name: "dup" })] })).toThrow(
			/Duplicate command/,
		);
	});

	it.each(["Upper", "has space", "", "x".repeat(33)])("rejects invalid name %j", (name) => {
		expect(() => register(command({ name }))).toThrow(/Invalid name/);
	});

	it("rejects descriptions that are empty or too long", () => {
		expect(() => register(command({ description: "" }))).toThrow(/Description/);
		expect(() => register(command({ description: "x".repeat(101) }))).toThrow(/Description/);
	});

	it("rejects invalid option names", () => {
		const options = [{ name: "Bad Name", description: "a", type: "string" }] as const;
		expect(() => register(command({ options }))).toThrow(/Invalid option name/);
	});

	it("rejects a command without a handler", () => {
		const noHandler = { ...command(), handler: undefined } as unknown as CommandDefinition;
		expect(() => register(noHandler)).toThrow(/Missing handler/);
	});

	it("rejects duplicate option names", () => {
		const options = [
			{ name: "a", description: "a", type: "string" },
			{ name: "a", description: "a", type: "integer" },
		] as const;
		expect(() => register(command({ options }))).toThrow(/Duplicate option/);
	});

	it("rejects required options after optional ones", () => {
		const options = [
			{ name: "a", description: "a", type: "string" },
			{ name: "b", description: "b", type: "string", required: true },
		] as const;
		expect(() => register(command({ options }))).toThrow(/Required options/);
	});
});
