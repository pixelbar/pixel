import { afterEach, describe, expect, it } from "vitest";
import { HomeRequestError, HomeUnavailableError } from "../../core/home.ts";
import type { Logger } from "../../core/logger.ts";
import {
	type FakeHomeAssistant,
	startFakeHomeAssistant,
} from "../../testing/fake-home-assistant.ts";
import { HomeAssistantBackend, translateError } from "./backend.ts";

const TOKEN = "a-very-secret-long-lived-token-value";

let logs: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
function logger(): Logger {
	const make = (bindings: Record<string, unknown>): Logger => ({
		debug: (obj, msg) =>
			logs.push({ level: "debug", obj: { ...bindings, ...obj }, msg: msg ?? "" }),
		info: (obj, msg) => logs.push({ level: "info", obj: { ...bindings, ...obj }, msg: msg ?? "" }),
		warn: (obj, msg) => logs.push({ level: "warn", obj: { ...bindings, ...obj }, msg: msg ?? "" }),
		error: (obj, msg) =>
			logs.push({ level: "error", obj: { ...bindings, ...obj }, msg: msg ?? "" }),
		child: (more) => make({ ...bindings, ...more }),
	});
	return make({});
}

const open: { stop: () => Promise<void> | void }[] = [];
async function fake(options: Parameters<typeof startFakeHomeAssistant>[0] = {}) {
	const server = await startFakeHomeAssistant({ token: TOKEN, ...options });
	open.push(server);
	return server;
}
function backendFor(server: FakeHomeAssistant, token = TOKEN, url = server.url) {
	const backend = new HomeAssistantBackend({ url, token, logger: logger() });
	open.push({ stop: () => backend.close() });
	return backend;
}

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 25));
	}
}

afterEach(async () => {
	for (const item of open.splice(0).reverse()) await item.stop();
	logs = [];
});

describe("connecting", () => {
	it("connects with the token, and reports the version and a non-admin token", async () => {
		const server = await fake({ haVersion: "2026.10.1" });
		const backend = backendFor(server);
		expect(backend.status()).toEqual({ kind: "connecting" });
		await backend.settled;
		expect(backend.status()).toEqual({
			kind: "connected",
			haVersion: "2026.10.1",
			adminToken: false,
		});
	});

	it("notices a token that belongs to an admin", async () => {
		const server = await fake({ isAdmin: true });
		const backend = backendFor(server);
		await backend.settled;
		expect(backend.status()).toMatchObject({ kind: "connected", adminToken: true });
	});

	it("still connects when it can't tell whose token it is", async () => {
		const server = await fake();
		server.failIdentity(true);
		const backend = backendFor(server);
		await backend.settled;
		expect(backend.status()).toMatchObject({ kind: "connected", adminToken: undefined });
		expect(logs.some((l) => l.obj.event === "home.identify_failed")).toBe(true);
	});

	it("ignores a trailing slash on the address", async () => {
		const server = await fake();
		const backend = backendFor(server, TOKEN, `${server.url}///`);
		await backend.settled;
		expect(backend.status().kind).toBe("connected");
	});

	it("turns itself off, saying why without the token, when the token is refused", async () => {
		const server = await fake();
		const backend = backendFor(server, "the-wrong-token-entirely");
		await backend.settled;
		expect(backend.status()).toEqual({
			kind: "off",
			reason: "Home Assistant refused the token, so it needs replacing",
		});
		await expect(
			backend.callService({ domain: "light", service: "turn_on", entityId: "light.x" }),
		).rejects.toBeInstanceOf(HomeUnavailableError);
		expect(JSON.stringify(logs)).not.toContain("the-wrong-token-entirely");
	});

	it("tries again on check, so a replaced token takes effect without a restart", async () => {
		const server = await fake({ token: "old-token-value" });
		const backend = backendFor(server, "new-token-value");
		await backend.settled;
		expect(backend.status().kind).toBe("off");
		expect(await backend.check()).toMatchObject({ kind: "off" });
		server.setToken("new-token-value");
		expect(await backend.check()).toMatchObject({ kind: "connected" });
	});

	it("keeps trying while Home Assistant is unreachable, without ever blocking, and connects when it appears", async () => {
		const server = await fake();
		const { port } = server;
		await server.stop();
		const backend = backendFor(server, TOKEN, `http://127.0.0.1:${port}`);
		let settled = false;
		void backend.settled.then(() => {
			settled = true;
		});
		await new Promise((r) => setTimeout(r, 600));
		expect(settled).toBe(false);
		expect(backend.status()).toEqual({ kind: "connecting" });
		await expect(backend.getStates(["light.x"])).rejects.toBeInstanceOf(HomeUnavailableError);

		await server.start();
		await backend.settled;
		expect(backend.status().kind).toBe("connected");
	}, 20_000);

	it("re-checking while connected asks again who the token belongs to", async () => {
		const server = await fake({ isAdmin: false });
		const backend = backendFor(server);
		await backend.settled;
		server.setAdmin(true);
		expect(await backend.check()).toMatchObject({ kind: "connected", adminToken: true });
	});
});

describe("reading and calling", () => {
	const lamp = {
		entityId: "light.workshop",
		state: "on",
		attributes: { brightness: 200 },
		lastChanged: "2026-10-04T07:00:00+00:00",
	};
	const door = { entityId: "lock.front_door", state: "locked" };

	it("reads fresh states for just the entities asked for", async () => {
		const server = await fake({ entities: [lamp, door, { entityId: "sensor.other", state: "1" }] });
		const backend = backendFor(server);
		await backend.settled;
		const states = await backend.getStates(["light.workshop", "lock.front_door", "light.missing"]);
		expect([...states.keys()].sort()).toEqual(["light.workshop", "lock.front_door"]);
		expect(states.get("light.workshop")).toEqual({
			entityId: "light.workshop",
			state: "on",
			attributes: { brightness: 200 },
			lastChanged: new Date("2026-10-04T07:00:00+00:00"),
		});

		// Nothing is cached: a change in Home Assistant shows on the very next read.
		server.setEntities([{ ...lamp, state: "off" }, door]);
		expect((await backend.getStates(["light.workshop"])).get("light.workshop")?.state).toBe("off");
	});

	it("copes with a missing or unreadable change time", async () => {
		const server = await fake({
			entities: [{ entityId: "light.a", state: "on", lastChanged: "not a date" }],
		});
		const backend = backendFor(server);
		await backend.settled;
		expect((await backend.getStates(["light.a"])).get("light.a")?.lastChanged).toBeNull();
	});

	describe("listing every entity", () => {
		const entities = [
			{
				entityId: "light.workshop",
				state: "on",
				attributes: { friendly_name: "Workshop" },
				areaId: "ws",
			},
			{ entityId: "sensor.temp", state: "21", attributes: { friendly_name: 12 }, deviceId: "d1" },
			{ entityId: "switch.nightlight", state: "off", category: "config" as const },
			{ entityId: "sensor.rssi", state: "-60", category: "diagnostic" as const, hidden: true },
		];
		const areas = [
			{ id: "ws", name: "Workshop" },
			{ id: "hall", name: "Hall" },
		];
		const devices = [{ id: "d1", areaId: "hall" }, { id: "d2" }];

		it("gives name, area (its own, or its device's), category and hidden, without the state", async () => {
			const server = await fake({ entities, areas, devices });
			const backend = backendFor(server);
			await backend.settled;
			expect(await backend.listEntities()).toEqual([
				{
					entityId: "light.workshop",
					name: "Workshop",
					area: "Workshop",
					category: undefined,
					hidden: false,
				},
				{
					entityId: "sensor.temp",
					name: undefined,
					area: "Hall",
					category: undefined,
					hidden: false,
				},
				{
					entityId: "switch.nightlight",
					name: undefined,
					area: undefined,
					category: "config",
					hidden: false,
				},
				{
					entityId: "sensor.rssi",
					name: undefined,
					area: undefined,
					category: "diagnostic",
					hidden: true,
				},
			]);
		});

		it("still lists them, with no areas, when Home Assistant won't give the areas", async () => {
			const server = await fake({ entities, areas, devices });
			server.failAreaRegistry("unauthorized");
			const backend = backendFor(server);
			await backend.settled;
			const listed = await backend.listEntities();
			expect(listed).toHaveLength(4);
			expect(listed.every((entity) => entity.area === undefined)).toBe(true);
			expect(listed.find((entity) => entity.entityId === "switch.nightlight")?.category).toBe(
				"config",
			);
			expect(logs.some((log) => log.obj.event === "home.areas_failed")).toBe(true);
		});

		it("fails, rather than guessing, when it can't tell which entities are setup or hidden", async () => {
			const server = await fake({ entities, areas, devices });
			server.failEntityRegistry("unauthorized");
			const backend = backendFor(server);
			await backend.settled;
			await expect(backend.listEntities()).rejects.toBeInstanceOf(HomeRequestError);
		});

		it("fails at once while not connected", async () => {
			const server = await fake();
			const backend = backendFor(server, "wrong-token");
			await backend.settled;
			await expect(backend.listEntities()).rejects.toBeInstanceOf(HomeUnavailableError);
		});
	});

	it("sends exactly the service, entity and data it was given, once", async () => {
		const server = await fake();
		const backend = backendFor(server);
		await backend.settled;
		await backend.callService({
			domain: "light",
			service: "turn_on",
			entityId: "light.workshop",
			data: { brightness_pct: 40 },
		});
		await backend.callService({ domain: "lock", service: "unlock", entityId: "lock.front_door" });
		expect(server.calls).toEqual([
			{
				domain: "light",
				service: "turn_on",
				target: { entity_id: "light.workshop" },
				serviceData: { brightness_pct: 40 },
			},
			{
				domain: "lock",
				service: "unlock",
				target: { entity_id: "lock.front_door" },
				serviceData: {},
			},
		]);
	});

	it("reports Home Assistant's own refusal as a request error, with its code kept for the logs only", async () => {
		const server = await fake();
		server.failService("lock.unlock", "service_validation_error");
		const backend = backendFor(server);
		await backend.settled;
		const error = await backend
			.callService({ domain: "lock", service: "unlock", entityId: "lock.front_door" })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HomeRequestError);
		expect((error as HomeRequestError).code).toBe("service_validation_error");
		expect((error as Error).message).toBe("Home Assistant couldn't do that.");
		expect(server.calls).toHaveLength(1);
	});
});

describe("when the connection drops", () => {
	it("fails calls at once, never queues them, and works again after reconnecting", async () => {
		const server = await fake({ entities: [{ entityId: "light.a", state: "on" }] });
		const backend = backendFor(server);
		await backend.settled;

		// Stop the server (rather than just dropping the connection), so "reconnecting" holds until it is back.
		await server.stop();
		await waitFor(() => backend.status().kind === "reconnecting");
		const started = Date.now();
		await expect(
			backend.callService({ domain: "lock", service: "unlock", entityId: "lock.front_door" }),
		).rejects.toBeInstanceOf(HomeUnavailableError);
		await expect(backend.getStates(["light.a"])).rejects.toBeInstanceOf(HomeUnavailableError);
		expect(Date.now() - started).toBeLessThan(500);

		await server.start();
		await waitFor(() => backend.status().kind === "connected");
		// The call made while it was down was dropped, not replayed on reconnect.
		await new Promise((r) => setTimeout(r, 200));
		expect(server.calls).toEqual([]);
		expect((await backend.getStates(["light.a"])).size).toBe(1);
	}, 20_000);

	it("goes off if the token is refused when it comes back", async () => {
		const server = await fake({ token: "first-token-value" });
		const backend = backendFor(server, "first-token-value");
		await backend.settled;
		server.setToken("rotated-token-value");
		server.dropConnections();
		await waitFor(() => backend.status().kind === "off");
		expect(backend.status()).toMatchObject({
			reason: expect.stringContaining("refused the token"),
		});
	}, 20_000);
});

describe("close", () => {
	it("stops reconnecting", async () => {
		const server = await fake();
		const backend = backendFor(server);
		await backend.settled;
		backend.close();
		await waitFor(() => server.connectionCount() === 0);
		await new Promise((r) => setTimeout(r, 1500));
		expect(server.connectionCount()).toBe(0);
	}, 20_000);
});

describe("the token", () => {
	it("never appears in a log line", async () => {
		const server = await fake({ isAdmin: true });
		const backend = backendFor(server);
		await backend.settled;
		await backend.getStates(["light.a"]);
		server.failService("light.turn_on", "unauthorized");
		await backend
			.callService({ domain: "light", service: "turn_on", entityId: "light.a" })
			.catch(() => {});
		server.dropConnections();
		await waitFor(() => backend.status().kind !== "connected", 5000).catch(() => {});
		expect(JSON.stringify(logs)).not.toContain(TOKEN);
		expect(JSON.stringify(logs)).not.toContain(server.url);
	}, 20_000);
});

describe("translateError", () => {
	it.each([1, 2, 3, 4, 5])("treats the library's connection error %i as unreachable", (code) => {
		const error = translateError(code);
		expect(error).toBeInstanceOf(HomeUnavailableError);
		expect((error as Error).message).toBe("I can't reach Home Assistant right now.");
	});

	it("treats Home Assistant's own errors as a refusal, keeping the code", () => {
		const error = translateError({ code: "not_found", message: "Service lock.explode not found." });
		expect(error).toBeInstanceOf(HomeRequestError);
		expect((error as HomeRequestError).code).toBe("not_found");
		expect((error as Error).message).not.toContain("explode");
	});

	it("lets a real bug through as it is", () => {
		const bug = new TypeError("oops");
		expect(translateError(bug)).toBe(bug);
		expect(translateError("text")).toBe("text");
		expect(translateError(null)).toBeNull();
		expect(translateError({ code: 5 })).toEqual({ code: 5 });
	});
});
