import { silentLogger } from "../core/logger.ts";
import { ParkingSpotStore } from "../services/parking-spots.ts";
import { ParkingWindowStore } from "../services/parking-windows.ts";

/** Parking stores that keep everything in memory, for tests that don't care about parking. */
export function inMemoryParking() {
	return {
		spots: new ParkingSpotStore({ logger: silentLogger }),
		windows: new ParkingWindowStore({ logger: silentLogger }),
		timezone: "Europe/Amsterdam",
	};
}
