import { describe, expect, it, vi } from "vitest";
import { HomeRequestError, HomeUnavailableError } from "../../core/home.ts";
import { HOME_KINDS } from "../../core/home-kinds/index.ts";
import type { HomeDevice } from "../../services/home-devices.ts";
import {
	type ControlResult,
	DEFAULT_COOLDOWN_MS,
	DEFAULT_POLL_MS,
	DEFAULT_TIMEOUT_MS,
	DeviceControl,
	flips,
} from "./control.ts";

const device = (kind: string, name: string, entityId: string): HomeDevice => {
	const found = HOME_KINDS.get(kind);
	if (!found) throw new Error(`no kind ${kind}`);
	return { name, entityId, kind: found, actions: found.actions, minTier: "member" };
};
const lamp = device("light", "lamp", "light.lamp");
const front = device("door", "front-door", "lock.front_door");
const action = (d: HomeDevice, name: string) => {
	const found = d.actions.find((a) => a.name === name);
	if (!found) throw new Error(`no action ${name}`);
	return found;
};

type Change = { afterMs: number; state: string | null };

/** A fake Home Assistant and a fake clock: sleeping moves time on, and entities change on a timeline after the call. */
function rig(
	initial: Record<string, string | null>,
	timeline: Record<string, Change[]> = {},
	options: { cooldownMs?: number; timeoutMs?: number } = {},
) {
	let t = 1_000_000;
	const states = new Map(Object.entries(initial));
	const called = new Map<string, number>();
	const calls: unknown[] = [];
	const reads: number[] = [];
	const current = (key: string): string | null | undefined => {
		const at = called.get(key);
		if (at === undefined) return states.get(key);
		let state = states.get(key);
		for (const change of timeline[key] ?? []) if (t - at >= change.afterMs) state = change.state;
		return state;
	};
	const home = {
		getStates: vi.fn(async (ids: readonly string[]) => {
			reads.push(t);
			const key = ids[0] as string;
			const state = current(key);
			return new Map(
				state === undefined || state === null
					? []
					: [[key, { entityId: key, state, attributes: {}, lastChanged: null }]],
			);
		}),
		callService: vi.fn(async (call: { entityId: string }) => {
			calls.push(call);
			called.set(call.entityId, t);
		}),
	};
	const control = new DeviceControl({
		home,
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
		pollMs: 500,
		timeoutMs: options.timeoutMs ?? 8000,
		cooldownMs: options.cooldownMs ?? 3000,
	});
	return {
		control,
		home,
		calls,
		advance: (ms: number) => {
			t += ms;
		},
		set: (key: string, state: string | null) => {
			states.set(key, state);
			called.delete(key);
		},
		now: () => t,
	};
}

const outcome = (result: ControlResult) => result.outcome;

describe("an action that works", () => {
	it("calls exactly the catalogue's service for that entity, once, and reports the end state", async () => {
		const { control, calls } = rig(
			{ "light.lamp": "off" },
			{ "light.lamp": [{ afterMs: 0, state: "on" }] },
		);
		const result = await control.run(lamp, action(lamp, "on"));
		expect(result).toMatchObject({ outcome: "done", before: "off", after: "on" });
		expect(calls).toEqual([{ domain: "light", service: "turn_on", entityId: "light.lamp" }]);
	});

	it("uses the entity's own domain, unless the action names another, and sends only the fixed data", async () => {
		const kind = {
			name: "scene",
			description: "A scene",
			domains: ["scene"],
			actions: [],
		};
		const custom = {
			name: "scene",
			entityId: "scene.movie",
			kind,
			minTier: "member" as const,
			actions: [],
		};
		const { control, calls } = rig(
			{ "scene.movie": "off" },
			{ "scene.movie": [{ afterMs: 0, state: "on" }] },
		);
		await control.run(custom, {
			name: "go",
			description: "d",
			service: "turn_on",
			serviceDomain: "homeassistant",
			data: { transition: 2 },
			done: ["on"],
		});
		expect(calls).toEqual([
			{
				domain: "homeassistant",
				service: "turn_on",
				entityId: "scene.movie",
				data: { transition: 2 },
			},
		]);
	});

	it("reads states in lower case, as Home Assistant's own states are compared", async () => {
		const { control } = rig(
			{ "light.lamp": "OFF" },
			{ "light.lamp": [{ afterMs: 0, state: "ON" }] },
		);
		expect(await control.run(lamp, action(lamp, "on"))).toMatchObject({
			before: "off",
			after: "on",
		});
	});

	it("waits through the working states for a slow lock, and reports how long it took", async () => {
		const { control, calls } = rig(
			{ "lock.front_door": "locked" },
			{
				"lock.front_door": [
					{ afterMs: 1000, state: "unlocking" },
					{ afterMs: 4000, state: "unlocked" },
				],
			},
		);
		const result = await control.run(front, action(front, "unlock"));
		expect(result).toMatchObject({ outcome: "done", before: "locked", after: "unlocked" });
		expect(result.durationMs).toBe(4000);
		expect(calls).toEqual([{ domain: "lock", service: "unlock", entityId: "lock.front_door" }]);
	});

	it("treats a toggle as done when the state changed, to either end state", async () => {
		const on = rig({ "light.lamp": "off" }, { "light.lamp": [{ afterMs: 0, state: "on" }] });
		expect(await on.control.run(lamp, action(lamp, "toggle"))).toMatchObject({
			outcome: "done",
			after: "on",
		});
		const off = rig({ "light.lamp": "on" }, { "light.lamp": [{ afterMs: 0, state: "off" }] });
		expect(await off.control.run(lamp, action(lamp, "toggle"))).toMatchObject({
			outcome: "done",
			after: "off",
		});
		expect(flips(action(lamp, "toggle"))).toBe(true);
		expect(flips(action(lamp, "on"))).toBe(false);
	});

	it("never sends a toggle twice, and reports no change when nothing changed", async () => {
		const { control, calls } = rig({ "light.lamp": "on" });
		expect(outcome(await control.run(lamp, action(lamp, "toggle")))).toBe("no-change");
		expect(calls).toHaveLength(1);
	});
});

describe("an action that doesn't need sending", () => {
	it("says so when the device is already there, and sends nothing", async () => {
		const { control, calls } = rig({ "light.lamp": "on" });
		expect(await control.run(lamp, action(lamp, "on"))).toMatchObject({
			outcome: "already",
			before: "on",
		});
		expect(calls).toEqual([]);
	});

	it("doesn't start a cool-down, so it can be changed straight away after", async () => {
		const { control, set } = rig(
			{ "light.lamp": "on" },
			{ "light.lamp": [{ afterMs: 0, state: "off" }] },
		);
		await control.run(lamp, action(lamp, "on"));
		expect(outcome(await control.run(lamp, action(lamp, "off")))).toBe("done");
		set("light.lamp", "on");
	});

	it.each(["unavailable", "unknown", "UNAVAILABLE"])(
		"sends nothing to a device that is %s",
		async (state) => {
			const { control, calls } = rig({ "light.lamp": state });
			expect(await control.run(lamp, action(lamp, "on"))).toMatchObject({
				outcome: "not-attempted",
				reason: "unavailable",
				before: state.toLowerCase(),
			});
			expect(calls).toEqual([]);
		},
	);

	it("sends nothing to an entity Home Assistant doesn't have", async () => {
		const { control, calls } = rig({ "light.lamp": null });
		expect(await control.run(lamp, action(lamp, "on"))).toMatchObject({
			outcome: "not-attempted",
			reason: "missing",
		});
		expect(calls).toEqual([]);
	});

	it("sends nothing to a lock that is already on its way", async () => {
		const { control, calls } = rig({ "lock.front_door": "unlocking" });
		expect(await control.run(front, action(front, "unlock"))).toMatchObject({
			outcome: "not-attempted",
			reason: "under-way",
			before: "unlocking",
		});
		expect(calls).toEqual([]);
	});
});

describe("an action that doesn't finish cleanly", () => {
	it("reports still in progress, honestly, when the lock is still moving at the time limit", async () => {
		const { control, calls } = rig(
			{ "lock.front_door": "locked" },
			{ "lock.front_door": [{ afterMs: 500, state: "unlocking" }] },
		);
		const result = await control.run(front, action(front, "unlock"));
		expect(result).toMatchObject({ outcome: "in-progress", before: "locked", after: "unlocking" });
		expect(result.durationMs).toBeGreaterThanOrEqual(8000);
		expect(calls).toHaveLength(1);
	});

	it("reports no change when nothing happened by the time limit", async () => {
		const { control } = rig({ "light.lamp": "off" });
		const result = await control.run(lamp, action(lamp, "on"));
		expect(result).toMatchObject({ outcome: "no-change", before: "off", after: "off" });
		expect(result.durationMs).toBeGreaterThanOrEqual(8000);
	});

	it("reports a jammed lock at once, without waiting for the time limit", async () => {
		const { control } = rig(
			{ "lock.front_door": "locked" },
			{ "lock.front_door": [{ afterMs: 1000, state: "jammed" }] },
		);
		const result = await control.run(front, action(front, "unlock"));
		expect(result).toMatchObject({ outcome: "failed", before: "locked", after: "jammed" });
		expect(result.durationMs).toBeLessThan(8000);
	});

	it("reports a device that went unavailable, or vanished, as failed", async () => {
		const gone = rig(
			{ "light.lamp": "off" },
			{ "light.lamp": [{ afterMs: 500, state: "unavailable" }] },
		);
		expect(await gone.control.run(lamp, action(lamp, "on"))).toMatchObject({
			outcome: "failed",
			after: "unavailable",
		});
		const vanished = rig(
			{ "light.lamp": "off" },
			{ "light.lamp": [{ afterMs: 500, state: null }] },
		);
		expect(await vanished.control.run(lamp, action(lamp, "on"))).toMatchObject({
			outcome: "failed",
			after: "unavailable",
		});
	});

	it("leaves the time limit to the options", async () => {
		const { control } = rig({ "light.lamp": "off" }, {}, { timeoutMs: 2000 });
		expect((await control.run(lamp, action(lamp, "on"))).durationMs).toBeLessThan(3000);
		expect(control.timeoutMs).toBe(2000);
	});
});

describe("when Home Assistant fails", () => {
	it("sends nothing, and throws, when it can't even read the state", async () => {
		const { control, home, calls } = rig({ "light.lamp": "off" });
		home.getStates.mockRejectedValueOnce(
			new HomeUnavailableError("I can't reach Home Assistant right now."),
		);
		await expect(control.run(lamp, action(lamp, "on"))).rejects.toThrow(HomeUnavailableError);
		expect(calls).toEqual([]);
		// And it isn't stuck: a later run works.
		expect(outcome(await control.run(lamp, action(lamp, "on")))).toBe("no-change");
	});

	it("doesn't poll or retry when Home Assistant refuses the call", async () => {
		const { control, home } = rig({ "light.lamp": "off" });
		home.callService.mockRejectedValueOnce(
			new HomeRequestError("Home Assistant couldn't do that.", "not_found"),
		);
		expect(await control.run(lamp, action(lamp, "on"))).toMatchObject({
			outcome: "rejected",
			before: "off",
		});
		expect(home.callService).toHaveBeenCalledTimes(1);
		expect(home.getStates).toHaveBeenCalledTimes(1);
	});

	it("says it can't confirm, and never resends, when the call times out or the connection drops", async () => {
		const { control, home } = rig({ "light.lamp": "off" });
		home.callService.mockRejectedValueOnce(
			new HomeUnavailableError("I can't reach Home Assistant right now."),
		);
		expect(await control.run(lamp, action(lamp, "on"))).toMatchObject({
			outcome: "unconfirmed",
			before: "off",
		});
		expect(home.callService).toHaveBeenCalledTimes(1);
		expect(home.getStates).toHaveBeenCalledTimes(1);
	});

	it("says it can't confirm when it loses contact while waiting for the end state", async () => {
		const { control, home } = rig({ "light.lamp": "off" });
		home.getStates
			.mockImplementationOnce(
				async () =>
					new Map([
						[
							"light.lamp",
							{ entityId: "light.lamp", state: "off", attributes: {}, lastChanged: null },
						],
					]),
			)
			.mockRejectedValueOnce(new HomeUnavailableError("I can't reach Home Assistant right now."));
		expect(await control.run(lamp, action(lamp, "on"))).toMatchObject({
			outcome: "unconfirmed",
			before: "off",
		});
		expect(home.callService).toHaveBeenCalledTimes(1);
	});
});

describe("one at a time", () => {
	it("sends one action when two runs arrive together, and tells the second why", async () => {
		const { control, calls } = rig(
			{ "light.lamp": "off" },
			{ "light.lamp": [{ afterMs: 500, state: "on" }] },
		);
		const [a, b] = await Promise.all([
			control.run(lamp, action(lamp, "on")),
			control.run(lamp, action(lamp, "on")),
		]);
		expect([a.outcome, b.outcome].sort()).toEqual(["done", "not-attempted"]);
		const refused = [a, b].find((r) => r.outcome === "not-attempted");
		expect(refused).toMatchObject({ reason: "busy" });
		expect(calls).toHaveLength(1);
	});

	it("keeps a short cool-down after an action, then lets the next through", async () => {
		const { control, calls, advance, set } = rig(
			{ "light.lamp": "off" },
			{ "light.lamp": [{ afterMs: 0, state: "on" }] },
			{ cooldownMs: 3000 },
		);
		expect(outcome(await control.run(lamp, action(lamp, "on")))).toBe("done");
		set("light.lamp", "off");
		expect(await control.run(lamp, action(lamp, "on"))).toMatchObject({
			outcome: "not-attempted",
			reason: "cooldown",
		});
		advance(3000);
		expect(outcome(await control.run(lamp, action(lamp, "on")))).toBe("done");
		expect(calls).toHaveLength(2);
	});

	it("starts the cool-down even when the action didn't work out", async () => {
		const { control, home } = rig({ "light.lamp": "off" });
		home.callService.mockRejectedValueOnce(new HomeRequestError("no", "x"));
		await control.run(lamp, action(lamp, "on"));
		expect(await control.run(lamp, action(lamp, "on"))).toMatchObject({ reason: "cooldown" });
	});

	it("doesn't let one device hold up another", async () => {
		const { control, calls } = rig(
			{ "light.lamp": "off", "lock.front_door": "locked" },
			{
				"light.lamp": [{ afterMs: 500, state: "on" }],
				"lock.front_door": [{ afterMs: 500, state: "unlocked" }],
			},
		);
		const results = await Promise.all([
			control.run(lamp, action(lamp, "on")),
			control.run(front, action(front, "unlock")),
		]);
		expect(results.map(outcome)).toEqual(["done", "done"]);
		expect(calls).toHaveLength(2);
	});
});

describe("defaults", () => {
	it("are a half-second poll, an eight-second wait and a three-second cool-down", () => {
		expect([DEFAULT_POLL_MS, DEFAULT_TIMEOUT_MS, DEFAULT_COOLDOWN_MS]).toEqual([500, 8000, 3000]);
		expect(new DeviceControl({ home: rig({}).home }).timeoutMs).toBe(8000);
	});

	it("really waits, on real timers, between looks", async () => {
		vi.useFakeTimers();
		try {
			const { home } = rig({ "light.lamp": "on" });
			const control = new DeviceControl({ home, pollMs: 100, timeoutMs: 250 });
			const running = control.run(lamp, action(lamp, "toggle"));
			await vi.advanceTimersByTimeAsync(1000);
			expect(outcome(await running)).toBe("no-change");
		} finally {
			vi.useRealTimers();
		}
	});
});
