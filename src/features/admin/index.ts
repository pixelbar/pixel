import type { Feature } from "../../core/feature.ts";
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
				description: "Bot health and access list overview (admins only)",
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
	};
}

export function formatDuration(ms: number): string {
	const totalMinutes = Math.floor(ms / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}
