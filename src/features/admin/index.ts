import type { Feature } from "../../core/feature.ts";
import { formatDuration } from "../../core/format.ts";
import type { AccessConfig } from "../../services/access-config.ts";

export type AdminDeps = {
	version: string;
	startedAt: Date;
	accessCounts: AccessConfig["counts"];
	now?: () => Date;
};

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
										{
											name: "Access lists",
											value: `${deps.accessCounts.admins} admins · ${deps.accessCounts.members} members · ${deps.accessCounts.friends} friends`,
										},
									],
								},
							],
						}),
					},
				],
			},
		],
	};
}
