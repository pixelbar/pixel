/**
 * Registers Pixel's slash commands on the configured guild.
 * Usage: just register
 */
import { REST, Routes } from "discord.js";
import { toSlashCommand } from "../src/adapters/discord/commands.ts";
import { buildCore } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/core/logger.ts";
import { nullErrorReporter } from "../src/core/ports/error-reporter.ts";

const config = loadConfig();
const { registry } = buildCore(config, silentLogger, nullErrorReporter);
const body = registry.all().map(({ definition }) => toSlashCommand(definition));

const rest = new REST().setToken(config.discord.token);
await rest.put(Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId), {
	body,
});

process.stdout.write(
	`Registered ${body.length} commands: ${body.map((c) => `/${c.name}`).join(", ")}\n`,
);
