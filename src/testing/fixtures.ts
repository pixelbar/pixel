import type { PlatformActor, Principal, Tier } from "../core/access.ts";
import type {
	CommandContext,
	CommandDefinition,
	GroupCommand,
	PlainCommand,
	SubcommandDefinition,
	SubgroupDefinition,
} from "../core/command.ts";
import { silentLogger } from "../core/logger.ts";

/** Obviously fake Discord IDs. Never use real people's IDs in tests. */
export const IDS = {
	admin: "100000000000000001",
	member: "100000000000000002",
	friend: "100000000000000003",
	guest: "100000000000000004",
} as const;

export function actor(overrides: Partial<PlatformActor> = {}): PlatformActor {
	return {
		platform: "discord",
		userId: IDS.guest,
		displayName: "Test User",
		handle: "test-user",
		chat: "group",
		...overrides,
	};
}

export function principal(
	tier: Tier,
	overrides: Partial<PlatformActor> = {},
	capabilities: readonly string[] = [],
): Principal {
	return { ...actor(overrides), tier, capabilities };
}

export function context(overrides: Partial<CommandContext> = {}): CommandContext {
	return {
		args: {},
		users: {},
		principal: principal("guest"),
		logger: silentLogger,
		availableCommands: [],
		...overrides,
	};
}

export function command(overrides: Partial<PlainCommand> = {}): PlainCommand {
	return {
		name: "test",
		description: "A test command",
		access: { minTier: "guest" },
		handler: async () => ({ text: "ok" }),
		...overrides,
	};
}

export function subcommand(overrides: Partial<SubcommandDefinition> = {}): SubcommandDefinition {
	return {
		name: "sub",
		description: "A test subcommand",
		access: { minTier: "guest" },
		handler: async () => ({ text: "ok" }),
		...overrides,
	};
}

export function subgroup(overrides: Partial<SubgroupDefinition> = {}): SubgroupDefinition {
	return {
		name: "sg",
		description: "A test subgroup",
		access: { minTier: "guest" },
		subcommands: [subcommand()],
		...overrides,
	};
}

export function group(overrides: Partial<GroupCommand> = {}): GroupCommand {
	return {
		name: "grp",
		description: "A test group",
		access: { minTier: "guest" },
		subcommands: [subcommand()],
		...overrides,
	};
}

/** Narrows a registered definition to a plain command, failing the test otherwise. */
export function plain(def: CommandDefinition | undefined): PlainCommand {
	if (!def || def.subcommands) throw new Error("expected a plain command");
	return def;
}
