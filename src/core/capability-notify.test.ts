import { describe, expect, it, vi } from "vitest";
import { actor, IDS } from "../testing/fixtures.ts";
import { CapabilityRegistry } from "./capabilities.ts";
import {
	CapabilityNotifier,
	capabilityChangeText,
	capabilityDiff,
	capabilityLabel,
} from "./capability-notify.ts";
import { silentLogger } from "./logger.ts";
import type { DirectMessenger } from "./ports/direct-message.ts";

const by = actor({ userId: IDS.admin, displayName: "Ada", handle: "ada_l" });
const registry = new CapabilityRegistry([
	{ name: "front-door", description: "Open the front door" },
	{ name: "workshop", description: "Use the workshop" },
]);

describe("capabilityDiff", () => {
	it("lists only names that were added or removed", () => {
		expect(capabilityDiff(["workshop"], ["workshop", "front-door"])).toEqual({
			granted: ["front-door"],
			revoked: [],
		});
		expect(capabilityDiff(["workshop", "front-door"], ["front-door"])).toEqual({
			granted: [],
			revoked: ["workshop"],
		});
		expect(capabilityDiff(["workshop"], ["front-door"])).toEqual({
			granted: ["front-door"],
			revoked: ["workshop"],
		});
	});

	it("is empty when the sets match, even if the order differs", () => {
		expect(capabilityDiff(["a", "b"], ["b", "a"])).toEqual({ granted: [], revoked: [] });
		expect(capabilityDiff([], [])).toEqual({ granted: [], revoked: [] });
	});
});

describe("capabilityChangeText", () => {
	it("names a single grant and a single revoke", () => {
		expect(capabilityChangeText({ granted: ["front-door"], revoked: [] })).toBe(
			"Pixel granted you the **front-door** capability.",
		);
		expect(capabilityChangeText({ granted: [], revoked: ["workshop"] })).toBe(
			"Pixel revoked your **workshop** capability.",
		);
	});

	it("lists several, and can say both grant and revoke", () => {
		expect(capabilityChangeText({ granted: ["a", "b"], revoked: [] })).toBe(
			"Pixel granted you these capabilities:\n• **a**\n• **b**",
		);
		expect(capabilityChangeText({ granted: ["a"], revoked: ["b", "c"] })).toBe(
			"Pixel granted you the **a** capability.\n\nPixel revoked these capabilities:\n• **b**\n• **c**",
		);
	});

	it("is null when nothing changed, and uses a custom label", () => {
		expect(capabilityChangeText({ granted: [], revoked: [] })).toBeNull();
		expect(
			capabilityChangeText({ granted: ["front-door"], revoked: [] }, (name) =>
				capabilityLabel(name, registry),
			),
		).toBe("Pixel granted you the **front-door** (Open the front door) capability.");
	});
});

describe("capabilityLabel", () => {
	it("adds the registry description when there is one", () => {
		expect(capabilityLabel("front-door", registry)).toBe("**front-door** (Open the front door)");
		expect(capabilityLabel("unknown", registry)).toBe("**unknown**");
	});
});

describe("CapabilityNotifier", () => {
	function setup(messenger?: DirectMessenger) {
		const logs: { level: string; obj: Record<string, unknown> }[] = [];
		const make = (bindings: Record<string, unknown>) => ({
			...silentLogger,
			info: (obj: object) => logs.push({ level: "info", obj: { ...bindings, ...obj } }),
			warn: (obj: object) => logs.push({ level: "warn", obj: { ...bindings, ...obj } }),
			child: (more: Record<string, unknown>) => make({ ...bindings, ...more }),
		});
		const notifier = new CapabilityNotifier({ logger: make({}), capabilities: registry });
		if (messenger) notifier.attach(messenger);
		return { notifier, logs };
	}

	it("does nothing before a messenger is attached, and on a no-op change", async () => {
		const send = vi.fn();
		const unattached = setup();
		await unattached.notifier.notify(IDS.member, [], ["front-door"], by);
		expect(unattached.logs).toEqual([]);

		const attached = setup({ send });
		await attached.notifier.notify(IDS.member, ["front-door"], ["front-door"], by);
		expect(send).not.toHaveBeenCalled();
		expect(attached.logs).toEqual([]);
	});

	it("DMs a grant and a revoke, with the capability named, and never logs the text", async () => {
		const sent: { userId: string; text: string }[] = [];
		const { notifier, logs } = setup({
			send: async (userId, text) => {
				sent.push({ userId, text });
			},
		});

		await notifier.notify(IDS.member, [], ["front-door"], by);
		await notifier.notify(IDS.friend, ["workshop"], [], by);

		expect(sent).toEqual([
			{
				userId: IDS.member,
				text: "Pixel granted you the **front-door** (Open the front door) capability.",
			},
			{
				userId: IDS.friend,
				text: "Pixel revoked your **workshop** (Use the workshop) capability.",
			},
		]);
		for (const log of logs) {
			expect(JSON.stringify(log.obj)).not.toContain("Pixel granted");
			expect(JSON.stringify(log.obj)).not.toContain("Pixel revoked");
		}
		expect(logs.map((l) => l.obj.event)).toEqual(["capability.dm_sent", "capability.dm_sent"]);
		expect(logs[0]?.obj).toMatchObject({
			user: `discord:${IDS.admin}`,
			userName: "Ada",
			target: `discord:${IDS.member}`,
			granted: ["front-door"],
			revoked: [],
		});
	});

	it("swallows a send failure, logs who it was, and does not rethrow", async () => {
		const { notifier, logs } = setup({
			send: async () => {
				throw new Error("they have DMs from server members closed");
			},
		});
		await expect(notifier.notify(IDS.member, [], ["front-door"], by)).resolves.toBeUndefined();
		expect(logs[0]?.level).toBe("warn");
		expect(logs[0]?.obj).toMatchObject({
			event: "capability.dm_failed",
			user: `discord:${IDS.admin}`,
			target: `discord:${IDS.member}`,
		});
		expect(JSON.stringify(logs[0]?.obj)).not.toContain("Pixel granted");
	});

	it("names capabilities without a registry", async () => {
		const sent: string[] = [];
		const notifier = new CapabilityNotifier({ logger: silentLogger });
		notifier.attach({
			send: async (_userId, text) => {
				sent.push(text);
			},
		});
		await notifier.notify(IDS.member, [], ["front-door"], by);
		expect(sent).toEqual(["Pixel granted you the **front-door** capability."]);
	});
});
