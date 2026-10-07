import type { Access } from "../../core/access.ts";

/**
 * Admin commands that pick a person (the `user` option) or change Discord roles only
 * work on Discord: other platforms have no reliable way to pick someone by ID, and
 * roles are Discord's. Commands without either (status, reload, doors) run everywhere.
 */
export const ADMIN_ON_DISCORD: Access = { minTier: "admin", platforms: ["discord"] };
