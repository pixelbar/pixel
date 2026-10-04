import type { CapabilityDefinition } from "../core/capabilities.ts";

/**
 * Every capability that exists. Admins can only grant names listed here, and a
 * command that requires a name that isn't listed stops Pixel from starting.
 *
 * It's empty on purpose: the generic system comes first, specific capabilities
 * (for example door control) are added with the features that need them.
 *
 *   { name: "front-door", description: "Open and lock the front door" }
 */
export const CAPABILITIES: readonly CapabilityDefinition[] = [];
