import { door } from "./door.ts";
import { defineKinds } from "./kind.ts";
import { light } from "./light.ts";
import { sensor } from "./sensor.ts";
import { powerSwitch } from "./switch.ts";

export type { HomeKind, KindAction, KindAttribute, KindCapability } from "./kind.ts";
export { defineKinds, HomeKindError } from "./kind.ts";

/**
 * Every kind of device Pixel knows. To add one (a thermostat, a blind, a scene),
 * write a file like `light.ts` and add it here. The devices file, the commands
 * and autocomplete all read this list, so nothing else changes.
 */
export const HOME_KINDS = defineKinds([light, powerSwitch, door, sensor]);
