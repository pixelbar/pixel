import { describe, expect, it } from "vitest";
import { command, group, subcommand } from "../testing/fixtures.ts";
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

describe("CommandRegistry subcommands", () => {
	it("registers a group under its own name", () => {
		const registry = register(group({ name: "admin" }));
		expect(registry.get("admin")?.definition.subcommands).toHaveLength(1);
	});

	it("rejects a group without subcommands, or with too many", () => {
		expect(() => register(group({ subcommands: [] }))).toThrow(/Subcommands must number/);
		const many = Array.from({ length: 26 }, (_, i) => subcommand({ name: `s${i}` }));
		expect(() => register(group({ subcommands: many }))).toThrow(/Subcommands must number/);
		const missing = { ...group(), subcommands: null } as unknown as CommandDefinition;
		expect(() => register(missing)).toThrow(/Subcommands must number/);
	});

	it("rejects a group that also has a handler or options", () => {
		const withHandler = { ...group(), handler: async () => ({}) } as unknown as CommandDefinition;
		expect(() => register(withHandler)).toThrow(/can't have a handler or options/);
		const withOptions = { ...group(), options: [] } as unknown as CommandDefinition;
		expect(() => register(withOptions)).toThrow(/can't have a handler or options/);
	});

	it("validates each subcommand like a command", () => {
		expect(() => register(group({ subcommands: [subcommand({ name: "Bad Name" })] }))).toThrow(
			/Invalid name/,
		);
		const noAccess = { ...subcommand(), access: undefined } as never;
		expect(() => register(group({ subcommands: [noAccess] }))).toThrow(/access\.minTier/);
		const noHandler = { ...subcommand(), handler: undefined } as never;
		expect(() => register(group({ subcommands: [noHandler] }))).toThrow(/Missing handler/);
		const options = [{ name: "a", description: "a", type: "user" }] as const;
		expect(() =>
			register(group({ subcommands: [subcommand({ options: [...options, ...options] })] })),
		).toThrow(/Duplicate option/);
	});

	it("rejects more than 25 options on a command or subcommand", () => {
		const options = Array.from({ length: 26 }, (_, i) => ({
			name: `o${i}`,
			description: "o",
			type: "string" as const,
		}));
		expect(() => register(command({ options }))).toThrow(/At most 25 options/);
		expect(() => register(group({ subcommands: [subcommand({ options })] }))).toThrow(
			/At most 25 options/,
		);
	});

	it("rejects duplicate subcommand names", () => {
		expect(() => register(group({ subcommands: [subcommand(), subcommand()] }))).toThrow(
			/Duplicate subcommand/,
		);
	});

	it("never lets a subcommand be looser than its group", () => {
		const strict = group({
			access: { minTier: "member" },
			subcommands: [subcommand({ access: { minTier: "friend" } })],
		});
		expect(() => register(strict)).toThrow(/lower tier than its command/);
		register(
			group({
				access: { minTier: "member" },
				subcommands: [subcommand({ access: { minTier: "admin" } })],
			}),
		);
	});

	it("never lets a subcommand be allowed in more contexts than its group", () => {
		const dmOnly = { minTier: "guest", contexts: ["dm"] } as const;
		expect(() => register(group({ access: dmOnly, subcommands: [subcommand()] }))).toThrow(
			/more contexts/,
		);
		expect(() =>
			register(
				group({
					access: dmOnly,
					subcommands: [subcommand({ access: { minTier: "guest", contexts: ["dm", "group"] } })],
				}),
			),
		).toThrow(/more contexts/);
		register(
			group({
				access: { minTier: "guest", contexts: ["dm", "group"] },
				subcommands: [subcommand({ access: { minTier: "guest", contexts: ["dm"] } })],
			}),
		);
	});
});
