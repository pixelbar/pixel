import type { Config } from "./config.ts";
import { Dispatcher } from "./core/dispatcher.ts";
import { IdentityService } from "./core/identity.ts";
import type { Logger } from "./core/logger.ts";
import type { ErrorReporter } from "./core/ports/error-reporter.ts";
import { RateLimiter } from "./core/rate-limit.ts";
import { CommandRegistry } from "./core/registry.ts";
import { buildFeatures } from "./features/index.ts";
import { type AccessConfig, ConfigTierSource, loadAccessConfig } from "./services/access-config.ts";

export type Core = {
	access: AccessConfig;
	registry: CommandRegistry;
	dispatcher: Dispatcher;
};

/**
 * Wires up everything platform-independent. Shared by the bot and by scripts
 * (e.g. command registration) so they see exactly the same commands.
 */
export function buildCore(
	config: Config,
	logger: Logger,
	reporter: ErrorReporter,
	startedAt = new Date(),
): Core {
	const access = loadAccessConfig(config.access);
	for (const warning of access.warnings) logger.warn({ event: "access_config.warning" }, warning);

	const registry = new CommandRegistry();
	for (const feature of buildFeatures({ version: config.version, startedAt, access })) {
		registry.register(feature);
	}

	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService([new ConfigTierSource(access)]),
		rateLimiter: new RateLimiter({ capacity: 5, refillPerSecond: 0.5 }),
		logger,
		reporter,
	});

	return { access, registry, dispatcher };
}
