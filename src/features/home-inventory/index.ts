import type { Feature } from "../../core/feature.ts";
import type { Logger } from "../../core/logger.ts";
import type { HomeInventory } from "../../services/home-inventory.ts";

export type HomeInventoryFeatureDeps = {
	inventory: Pick<HomeInventory, "sync" | "intervalMs">;
	logger: Logger;
};

/**
 * Keeps the Home Assistant inventory fresh. It has no commands: the inventory says
 * what exists, never what may be used. The first sync happens when Home Assistant
 * has connected (see `index.ts`); this repeats it on the interval.
 */
export function createHomeInventoryFeature({
	inventory,
	logger,
}: HomeInventoryFeatureDeps): Feature {
	return {
		name: "home-inventory",
		start: () => {
			if (inventory.intervalMs <= 0) return () => {};
			const timer = setInterval(() => {
				// `sync` doesn't throw, but nothing that runs from a timer may let a failure escape.
				inventory.sync().catch((error: unknown) => {
					logger.error({ event: "home.inventory_failed", err: error }, "inventory sync failed");
				});
			}, inventory.intervalMs);
			timer.unref();
			return () => clearInterval(timer);
		},
	};
}
