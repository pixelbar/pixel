import {
	type Connection,
	callService,
	createConnection,
	createLongLivedTokenAuth,
	ERR_CANNOT_CONNECT,
	ERR_CONNECTION_LOST,
	ERR_HASS_HOST_REQUIRED,
	ERR_INVALID_AUTH,
	ERR_INVALID_HTTPS_TO_HTTP,
	getStates,
} from "home-assistant-js-websocket";
import {
	type EntityState,
	HOME_MESSAGES,
	type HomeBackend,
	HomeRequestError,
	type HomeStatus,
	HomeUnavailableError,
	type ServiceCall,
} from "../../core/home.ts";
import type { Logger } from "../../core/logger.ts";

/**
 * The Home Assistant side of the home: the official `home-assistant-js-websocket`
 * client over a WebSocket, with a long-lived token. This is the only place that
 * imports the library. It connects in the background and reconnects forever, so
 * a slow or absent Home Assistant never holds up the bot, and every call is a
 * single attempt: if the connection is down the call fails at once.
 *
 * The library throws numbers (connection errors) and plain `{ code, message }`
 * objects (Home Assistant's own errors), not `Error`s. They are translated here
 * into safe messages, and never include the token or the address.
 */

export type HomeAssistantOptions = {
	/** The address to reach Home Assistant at, e.g. the Nabu Casa cloud URL. Not logged. */
	url: string;
	/** A long-lived access token. A secret: never logged or put in a message. */
	token: string;
	logger: Logger;
};

type Phase = "connecting" | "connected" | "reconnecting" | "off";

type CurrentUser = { is_admin?: boolean };

/** Why the login can't work, in words that name no secret. */
const REFUSED = "Home Assistant refused the token, so it needs replacing";

export class HomeAssistantBackend implements HomeBackend {
	readonly #url: string;
	readonly #token: string;
	readonly #logger: Logger;
	#connection: Connection | undefined;
	#phase: Phase = "connecting";
	#offReason = "";
	#adminToken: boolean | undefined;
	#attempt: Promise<void> | undefined;
	/** Settles once the first attempt has either connected or given up. */
	readonly settled: Promise<void>;

	constructor({ url, token, logger }: HomeAssistantOptions) {
		this.#url = url.replace(/\/+$/, "");
		this.#token = token;
		this.#logger = logger.child({ component: "home-assistant" });
		this.settled = this.#connect();
	}

	status(): HomeStatus {
		switch (this.#phase) {
			case "connected":
				return {
					kind: "connected",
					haVersion: this.#connection?.haVersion,
					adminToken: this.#adminToken,
				};
			case "off":
				return { kind: "off", reason: this.#offReason };
			default:
				return { kind: this.#phase };
		}
	}

	/** Re-checks the login. If the token was refused, this tries again (after it was replaced). */
	async check(): Promise<HomeStatus> {
		if (this.#phase === "off") await this.#connect();
		else if (this.#phase === "connected") await this.#identify();
		return this.status();
	}

	async getStates(entityIds: readonly string[]): Promise<Map<string, EntityState>> {
		const connection = this.#live();
		const wanted = new Set(entityIds);
		try {
			const out = new Map<string, EntityState>();
			for (const entity of await getStates(connection)) {
				if (!wanted.has(entity.entity_id)) continue;
				out.set(entity.entity_id, {
					entityId: entity.entity_id,
					state: entity.state,
					attributes: entity.attributes,
					lastChanged: toDate(entity.last_changed),
				});
			}
			return out;
		} catch (error) {
			throw this.#translate(error);
		}
	}

	async callService({ domain, service, entityId, data }: ServiceCall): Promise<void> {
		const connection = this.#live();
		try {
			await callService(connection, domain, service, { ...data }, { entity_id: entityId });
		} catch (error) {
			throw this.#translate(error);
		}
	}

	/** Stops reconnecting and closes the socket. For shutdown. */
	close(): void {
		this.#connection?.close();
	}

	/** Connects, once at a time. Never throws: a failure becomes the state. */
	#connect(): Promise<void> {
		this.#attempt ??= this.#tryConnect().finally(() => {
			this.#attempt = undefined;
		});
		return this.#attempt;
	}

	async #tryConnect(): Promise<void> {
		this.#phase = "connecting";
		try {
			// With infinite retries this only ever rejects when the token is refused.
			const connection = await createConnection({
				auth: createLongLivedTokenAuth(this.#url, this.#token),
				setupRetry: -1,
			});
			this.#connection?.close();
			this.#connection = connection;
			connection.addEventListener("ready", () => {
				this.#phase = "connected";
				this.#logger.info({ event: "home.ready" }, "reconnected to Home Assistant");
				void this.#identify();
			});
			connection.addEventListener("disconnected", () => {
				if (this.#phase === "connected") this.#phase = "reconnecting";
				this.#logger.warn({ event: "home.disconnected" }, "lost the connection to Home Assistant");
			});
			connection.addEventListener("reconnect-error", (_connection, code) => {
				if (code === ERR_INVALID_AUTH) this.#turnOff(REFUSED);
			});
			this.#phase = "connected";
			await this.#identify();
		} catch (error) {
			this.#logger.error(
				{ event: "home.connect_failed", why: describeFailure(error) },
				"couldn't connect to Home Assistant",
			);
			this.#turnOff(reasonFor(error));
		}
	}

	/** Asks who the token belongs to, so an admin's token can be flagged. Failure isn't fatal. */
	async #identify(): Promise<void> {
		try {
			const me = await this.#connection?.sendMessagePromise<CurrentUser>({
				type: "auth/current_user",
			});
			this.#adminToken = me?.is_admin;
		} catch (error) {
			this.#adminToken = undefined;
			this.#logger.warn(
				{ event: "home.identify_failed", why: describeFailure(error) },
				"couldn't tell whose token this is",
			);
		}
	}

	#turnOff(reason: string): void {
		this.#phase = "off";
		this.#offReason = reason;
		this.#connection?.close();
		this.#connection = undefined;
	}

	/** The connection if it's up. Otherwise fail at once: nothing waits for it to come back. */
	#live(): Connection {
		if (this.#phase !== "connected" || !this.#connection) {
			throw new HomeUnavailableError(HOME_MESSAGES.unreachable);
		}
		return this.#connection;
	}

	/** Turns what the library throws into something safe, or lets a real bug through. */
	#translate(error: unknown): unknown {
		const translated = translateError(error);
		if (translated instanceof HomeUnavailableError && error === ERR_INVALID_AUTH) {
			this.#turnOff(REFUSED);
		}
		return translated;
	}
}

/**
 * The library throws a number for a connection problem and `{ code, message }` for
 * Home Assistant's own errors. Anything else is a bug, and is returned as it is.
 */
export function translateError(error: unknown): unknown {
	if (typeof error === "number") return new HomeUnavailableError(HOME_MESSAGES.unreachable);
	if (isHaError(error)) return new HomeRequestError(HOME_MESSAGES.refused, error.code);
	return error;
}

function isHaError(error: unknown): error is { code: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		typeof (error as { code?: unknown }).code === "string"
	);
}

function reasonFor(error: unknown): string {
	switch (error) {
		case ERR_INVALID_AUTH:
			return REFUSED;
		case ERR_HASS_HOST_REQUIRED:
			return "no Home Assistant address was given";
		case ERR_INVALID_HTTPS_TO_HTTP:
			return "the address must be https when Pixel itself is served over https";
		case ERR_CANNOT_CONNECT:
		case ERR_CONNECTION_LOST:
			return "the connection couldn't be made";
		default:
			return "the connection failed for a reason Pixel doesn't recognise";
	}
}

/** A short, safe description of a failure for logs: a code or a type, never a message that could hold a secret. */
function describeFailure(error: unknown): string {
	if (typeof error === "number") return `connection error ${error}`;
	if (isHaError(error)) return error.code;
	return error instanceof Error ? error.name : "unknown";
}

function toDate(value: string | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}
