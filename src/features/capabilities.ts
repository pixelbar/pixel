import type { CapabilityDefinition } from "../core/capabilities.ts";
import { homeCapabilities } from "../core/home-access.ts";
import { HOME_KINDS } from "../core/home-kinds/index.ts";

/**
 * Every capability that exists. Admins can only grant names listed here, and a
 * command that requires a name that isn't listed stops Pixel from starting.
 *
 * Home Assistant brings `ha-admin` (control any device) and one per kind of device
 * that can be controlled (`ha-lights`, `ha-switches`, `ha-doors`). The per-kind ones
 * come from the kinds themselves, so a new kind brings its capability with it. Add
 * other features' capabilities to the list:
 *
 *   { name: "workshop-laser", description: "Use the laser cutter" }
 */
export const CAPABILITIES: readonly CapabilityDefinition[] = [...homeCapabilities(HOME_KINDS)];
