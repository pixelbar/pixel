import { describe, expect, it, vi } from "vitest";
import type { CommandDefinition } from "../../core/command.ts";
import { SpaceApiError, type SpaceReading } from "../../services/space-status.ts";
import { context } from "../../testing/fixtures.ts";
import { createStatusFeature } from "./index.ts";

const NOW = new Date("2026-10-03T20:00:00Z");

function statusCommand(checkNow: () => Promise<SpaceReading>): CommandDefinition {
	const command = createStatusFeature({ spaceStatus: { checkNow }, now: () => NOW }).commands?.[0];
	if (!command) throw new Error("no status command");
	return command;
}

const reading = (overrides: Partial<SpaceReading>): SpaceReading => ({
	state: "open",
	since: null,
	checkedAt: NOW,
	...overrides,
});

describe("/status", () => {
	it("is a public guest command with a 'Checking…' placeholder", () => {
		const command = statusCommand(async () => reading({}));
		expect(command.access.minTier).toBe("guest");
		expect(command.private).toBeFalsy();
		expect(command.placeholder?.private).toBeFalsy();
		expect(command.placeholder?.embeds?.[0]?.title).toBe("Checking…");
	});

	it("looks up the status live on every invocation", async () => {
		const checkNow = vi.fn(async () => reading({}));
		const command = statusCommand(checkNow);
		await command.handler(context());
		await command.handler(context());
		expect(checkNow).toHaveBeenCalledTimes(2);
	});

	it("shows open, with how long when known", async () => {
		const since = new Date(NOW.getTime() - (2 * 60 + 15) * 60_000);
		const reply = await statusCommand(async () => reading({ state: "open", since })).handler(
			context(),
		);
		expect(reply.embeds?.[0]).toEqual({
			title: "🟢 Pixelbar is open",
			description: "Open for 2h 15m.",
			accent: "positive",
		});
	});

	it("shows closed without a duration when Pixel didn't see the change", async () => {
		const reply = await statusCommand(async () => reading({ state: "closed" })).handler(context());
		expect(reply.embeds?.[0]).toEqual({ title: "🔴 Pixelbar is closed", accent: "negative" });
	});

	it("shows closed with a duration", async () => {
		const since = new Date(NOW.getTime() - 3 * 86_400_000);
		const reply = await statusCommand(async () => reading({ state: "closed", since })).handler(
			context(),
		);
		expect(reply.embeds?.[0]?.description).toBe("Closed for 3d 0h 0m.");
	});

	it("says when SpaceAPI itself doesn't know", async () => {
		const reply = await statusCommand(async () => reading({ state: "unknown" })).handler(context());
		expect(reply.embeds?.[0]?.title).toBe("❔ Pixelbar's status is unknown");
	});

	it("explains when SpaceAPI can't be reached, without leaking details", async () => {
		const reply = await statusCommand(async () => {
			throw new SpaceApiError("SpaceAPI responded with HTTP 502");
		}).handler(context());
		expect(reply.embeds?.[0]).toMatchObject({ title: "⚠️ Couldn't check", accent: "warning" });
		expect(JSON.stringify(reply)).not.toContain("502");
	});
});
