import { actorRef } from "../../core/access.ts";
import type { SubgroupDefinition } from "../../core/command.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { KindSwitch } from "../../services/kind-switch.ts";

/**
 * `/admin doors on|off`: the emergency switch for door control. Off stops every
 * door action from `/ha set` and `/ha open` at once, for everyone, until an admin
 * switches it back on. Admins only, private, logged and left as a Sentry breadcrumb.
 */
export function createDoorsSubgroup(deps: {
	switches: Pick<KindSwitch, "set" | "isOn">;
	reporter: Pick<ErrorReporter, "breadcrumb">;
}): SubgroupDefinition {
	const subcommand = (on: boolean) => ({
		name: on ? "on" : "off",
		description: on
			? "Switch door control from Pixel back on"
			: "Switch door control from Pixel off for everyone, at once",
		access: { minTier: "admin" as const },
		private: true,
		handler: async ({ principal }: { principal: Parameters<typeof actorRef>[0] }) => {
			const by = actorRef(principal);
			const { changed, saved } = deps.switches.set("door", on, by);
			deps.reporter.breadcrumb("home.kind_switched", `doors ${on ? "on" : "off"}`, { user: by });
			const state = on ? "on" : "off";
			const lines = [
				changed
					? `Door control from Pixel is now **${state}**.`
					: `Door control from Pixel was already **${state}**.`,
			];
			if (!saved) {
				lines.push("⚠️ I couldn't save this, so it only holds until Pixel restarts. See the logs.");
			}
			return { text: lines.join("\n"), private: true };
		},
	});
	return {
		name: "doors",
		description: "Switch door control from Pixel on or off (admins only)",
		access: { minTier: "admin" },
		subcommands: [subcommand(false), subcommand(true)],
	};
}

/** The line `/admin status` shows for door control. */
export function describeDoors(switches: Pick<KindSwitch, "isOn">): string {
	return switches.isOn("door") ? "Door control: on" : "Door control: **off** (`/admin doors on`)";
}
