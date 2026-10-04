import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * A stand-in for Home Assistant's WebSocket API, for tests. It speaks the real
 * protocol (the auth handshake, `get_states`, `call_service`, `auth/current_user`)
 * closely enough for the official client, and lets a test drop connections, stop
 * and restart the server, refuse tokens and fail services. Never imported by app
 * code, and never talks to a real Home Assistant.
 */

export type FakeEntity = {
	entityId: string;
	state: string;
	attributes?: Record<string, unknown>;
	lastChanged?: string;
	/** In the entity registry as a setup or diagnostic entity. */
	category?: "config" | "diagnostic";
	/** Hidden in the entity registry. */
	hidden?: boolean;
	/** The id of the area it is in itself. */
	areaId?: string;
	/** The id of its device, whose area counts when the entity has none. */
	deviceId?: string;
};

export type FakeArea = { id: string; name: string };
export type FakeDevice = { id: string; areaId?: string };

export type FakeServiceCall = {
	domain: string;
	service: string;
	target: unknown;
	serviceData: unknown;
};

export type FakeHomeAssistantOptions = {
	token?: string;
	isAdmin?: boolean;
	haVersion?: string;
	entities?: FakeEntity[];
	areas?: FakeArea[];
	devices?: FakeDevice[];
	/** Listen on this port, for starting a server where one used to be. Default: any free port. */
	port?: number;
};

export type FakeHomeAssistant = {
	/** The address to give to the client. */
	url: string;
	port: number;
	token: string;
	/** Every call_service received, in order. */
	calls: FakeServiceCall[];
	setEntities(entities: FakeEntity[]): void;
	/** Make the entity registry list fail (domain.service-style: a HA error code), or work again with undefined. */
	failEntityRegistry(code: string | undefined): void;
	/** Make the area and device registries fail, or work again with undefined. */
	failAreaRegistry(code: string | undefined): void;
	/** Accept this token from now on, and refuse the old one. */
	setToken(token: string): void;
	setAdmin(isAdmin: boolean): void;
	/** Make `auth/current_user` fail, like an older Home Assistant might. */
	failIdentity(fail: boolean): void;
	/** Answer this service with an error (domain.service → HA error code). */
	failService(key: string, code: string): void;
	/** Cut every connection but keep serving, so the client has to reconnect. */
	dropConnections(): void;
	connectionCount(): number;
	/** Stop serving and cut every connection. */
	stop(): Promise<void>;
	/** Start serving again on the same port. */
	start(): Promise<void>;
};

export async function startFakeHomeAssistant(
	options: FakeHomeAssistantOptions = {},
): Promise<FakeHomeAssistant> {
	let token = options.token ?? "test-token";
	let isAdmin = options.isAdmin ?? false;
	let identityFails = false;
	let entities = options.entities ?? [];
	const areas = options.areas ?? [];
	const devices = options.devices ?? [];
	let entityRegistryFails: string | undefined;
	let areaRegistryFails: string | undefined;
	const failing = new Map<string, string>();
	const calls: FakeServiceCall[] = [];
	const sockets = new Set<WebSocket>();
	let wss: WebSocketServer | undefined;
	let port = options.port ?? 0;

	const asHa = (e: FakeEntity) => ({
		entity_id: e.entityId,
		state: e.state,
		attributes: e.attributes ?? {},
		last_changed: e.lastChanged ?? "2026-10-04T08:00:00.000000+00:00",
		last_updated: e.lastChanged ?? "2026-10-04T08:00:00.000000+00:00",
		context: { id: "ctx", parent_id: null, user_id: null },
	});

	function serve(ws: WebSocket): void {
		sockets.add(ws);
		ws.on("close", () => sockets.delete(ws));
		ws.send(
			JSON.stringify({ type: "auth_required", ha_version: options.haVersion ?? "2026.10.0" }),
		);
		let authed = false;
		ws.on("message", (raw) => {
			const msg = JSON.parse(raw.toString()) as {
				id?: number;
				type: string;
				access_token?: string;
				domain?: string;
				service?: string;
				target?: unknown;
				service_data?: unknown;
			};
			if (msg.type === "auth") {
				authed = msg.access_token === token;
				ws.send(
					JSON.stringify(
						authed
							? { type: "auth_ok", ha_version: options.haVersion ?? "2026.10.0" }
							: { type: "auth_invalid", message: "Invalid access token or password" },
					),
				);
				return;
			}
			if (!authed) return;
			const reply = (result: unknown) =>
				ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result }));
			const fail = (code: string) =>
				ws.send(
					JSON.stringify({
						id: msg.id,
						type: "result",
						success: false,
						error: { code, message: `fake error ${code}` },
					}),
				);
			switch (msg.type) {
				case "auth/current_user":
					return identityFails
						? fail("unknown_command")
						: reply({ id: "u1", name: "Pixel", is_admin: isAdmin });
				case "get_states":
					return reply(entities.map(asHa));
				case "config/entity_registry/list_for_display":
					return entityRegistryFails
						? fail(entityRegistryFails)
						: reply({
								entity_categories: { "0": "config", "1": "diagnostic" },
								entities: entities.map((e) => ({
									ei: e.entityId,
									...(e.category ? { ec: e.category === "config" ? 0 : 1 } : {}),
									...(e.hidden ? { hb: true } : {}),
									...(e.areaId ? { ai: e.areaId } : {}),
									...(e.deviceId ? { di: e.deviceId } : {}),
								})),
							});
				case "config/area_registry/list":
					return areaRegistryFails
						? fail(areaRegistryFails)
						: reply(areas.map((a) => ({ area_id: a.id, name: a.name })));
				case "config/device_registry/list":
					return areaRegistryFails
						? fail(areaRegistryFails)
						: reply(devices.map((d) => ({ id: d.id, area_id: d.areaId ?? null })));
				case "call_service": {
					calls.push({
						domain: String(msg.domain),
						service: String(msg.service),
						target: msg.target,
						serviceData: msg.service_data,
					});
					const code = failing.get(`${msg.domain}.${msg.service}`);
					return code ? fail(code) : reply({ context: { id: "ctx" } });
				}
				case "ping":
					return ws.send(JSON.stringify({ id: msg.id, type: "pong" }));
				default:
					return fail("unknown_command");
			}
		});
	}

	async function start(): Promise<void> {
		const server = await new Promise<WebSocketServer>((resolve, reject) => {
			const created: WebSocketServer = new WebSocketServer({ port, path: "/api/websocket" }, () =>
				resolve(created),
			);
			created.on("error", reject);
			created.on("connection", serve);
		});
		wss = server;
		port = (server.address() as AddressInfo).port;
	}

	function dropConnections(): void {
		for (const ws of sockets) ws.terminate();
	}

	async function stop(): Promise<void> {
		dropConnections();
		const server = wss;
		wss = undefined;
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	}

	await start();
	return {
		get url() {
			return `http://127.0.0.1:${port}`;
		},
		get port() {
			return port;
		},
		get token() {
			return token;
		},
		calls,
		setEntities: (next) => {
			entities = next;
		},
		failEntityRegistry: (code) => {
			entityRegistryFails = code;
		},
		failAreaRegistry: (code) => {
			areaRegistryFails = code;
		},
		setToken: (next) => {
			token = next;
		},
		setAdmin: (next) => {
			isAdmin = next;
		},
		failIdentity: (fail) => {
			identityFails = fail;
		},
		failService: (key, code) => {
			failing.set(key, code);
		},
		dropConnections,
		connectionCount: () => sockets.size,
		stop,
		start,
	};
}
