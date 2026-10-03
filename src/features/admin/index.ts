import { type CapabilityRegistry, reportUnknownCapabilities } from "../../core/capabilities.ts";
import type { Feature } from "../../core/feature.ts";
import { formatDuration } from "../../core/format.ts";
import type { AccessStore } from "../../core/ports/access-store.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import { createCapabilitySubgroup } from "./capabilities.ts";
import { createMemberSubcommands } from "./members.ts";

export type AdminDeps = {
	version: string;
	startedAt: Date;
	access: Pick<AccessStore, "view" | "apply" | "reload">;
	capabilities: CapabilityRegistry;
	reporter: ErrorReporter;
	now?: () => Date;
};

function describeCounts(counts: AccessStore["view"]["counts"]): string {
	return `${counts.admins} admins · ${counts.members} members · ${counts.friends} friends`;
}

export function createAdminFeature(deps: AdminDeps): Feature {
	const now = deps.now ?? (() => new Date());
	return {
		name: "admin",
		commands: [
			{
				name: "admin",
				description: "Administration (admins only)",
				access: { minTier: "admin" },
				subcommands: [
					{
						name: "status",
						description: "Bot health and access list overview",
						access: { minTier: "admin" },
						private: true,
						handler: async () => ({
							embeds: [
								{
									title: "Pixel status",
									fields: [
										{ name: "Version", value: deps.version, inline: true },
										{ name: "Node.js", value: process.version, inline: true },
										{
											name: "Uptime",
											value: formatDuration(now().getTime() - deps.startedAt.getTime()),
											inline: true,
										},
										{ name: "Access lists", value: describeCounts(deps.access.view.counts) },
									],
								},
							],
						}),
					},
					{
						name: "reload",
						description: "Re-read the admin and member lists after editing the files by hand",
						access: { minTier: "admin" },
						private: true,
						handler: async ({ principal, logger }) => {
							const { before, after } = await deps.access.reload(principal);
							const warnings = deps.access.view.warnings.length;
							const unknown = reportUnknownCapabilities(
								deps.access.view.records.values(),
								deps.capabilities,
								{ logger, reporter: deps.reporter },
							);
							return {
								text: [
									"Reloaded the access lists.",
									`Before: ${describeCounts(before)}`,
									`Now: ${describeCounts(after)}`,
									...(warnings > 0 ? [`${warnings} warning(s), see the logs.`] : []),
									...(unknown.length > 0
										? [`These capabilities don't exist and are ignored: ${unknown.join(", ")}.`]
										: []),
								].join("\n"),
							};
						},
					},
					...createMemberSubcommands(deps.access, deps.capabilities),
					createCapabilitySubgroup({ access: deps.access, capabilities: deps.capabilities }),
				],
			},
		],
	};
}
