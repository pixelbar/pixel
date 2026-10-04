import { UserFacingError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

/**
 * Pixel's view of a smart home (Home Assistant today). Features read states and
 * call allowed services here and never touch the platform, the same way they use
 * the calendar. The Home Assistant adapter plugs a backend in at startup.
 *
 * It fails closed: if the home can't be reached, a call fails at once and says
 * so. Nothing is queued and nothing is retried, because a late action in the real
 * world (an unlock, say) must never happen. Reads are never cached, every one
 * asks Home Assistant.
 */

export type EntityState = {
	entityId: string;
	/** What the entity reports, such as "locked", "on" or "unavailable". Untrusted text. */
	state: string;
	/** Untrusted: names and attributes come from Home Assistant and can be anything. */
	attributes: Readonly<Record<string, unknown>>;
	lastChanged: Date | null;
};

/**
 * An entity as Home Assistant lists it, for the inventory: what it is, not what it
 * reports right now. Text here is untrusted.
 */
export type HomeEntity = {
	entityId: string;
	/** The friendly name, if it has one. */
	name: string | undefined;
	/** The area's name, from the entity or else its device. */
	area: string | undefined;
	/** Home Assistant files setup switches and diagnostics under a category. */
	category: "config" | "diagnostic" | undefined;
	/** Hidden by someone in Home Assistant. */
	hidden: boolean;
};

export type ServiceCall = {
	domain: string;
	service: string;
	entityId: string;
	data?: Readonly<Record<string, unknown>>;
};

export type HomeStatus =
	| { kind: "unconfigured" }
	/** Never connected yet. */
	| { kind: "connecting" }
	/** Was connected and is trying to get back. */
	| { kind: "reconnecting" }
	| {
			kind: "connected";
			haVersion: string | undefined;
			/** Whether the token belongs to an admin user, if known. Pixel should use a non-admin one. */
			adminToken: boolean | undefined;
	  }
	/** Won't recover until someone fixes it, such as a token that was refused. `reason` has no secrets. */
	| { kind: "off"; reason: string };

export type HomeBackend = {
	status(): HomeStatus;
	/** Re-checks the login and the connection (on `/admin reload`). */
	check(): Promise<HomeStatus>;
	/** Fresh states for these entities. Entities that don't exist are left out. */
	getStates(entityIds: readonly string[]): Promise<Map<string, EntityState>>;
	callService(call: ServiceCall): Promise<void>;
	/** Every entity Home Assistant has, with its category and area. For the inventory only. */
	listEntities(): Promise<HomeEntity[]>;
};

/** Home Assistant can't be reached or used right now. The message is safe to show. */
export class HomeUnavailableError extends UserFacingError {
	override name = "HomeUnavailableError";
}

/** Home Assistant answered but refused or couldn't do it. The message is safe to show. */
export class HomeRequestError extends UserFacingError {
	override name = "HomeRequestError";
	/** Home Assistant's own code (such as "not_found"), for logs, never for people. */
	readonly code: string | undefined;

	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

export const HOME_MESSAGES = {
	notSetUp: "Home Assistant isn't set up for Pixel.",
	unreachable: "I can't reach Home Assistant right now.",
	refused: "Home Assistant couldn't do that.",
} as const;

class HomeTimeout extends Error {
	override name = "HomeTimeout";
}

export type HomeOptions = {
	logger: Logger;
	reporter: ErrorReporter;
	/** How long any one call may take before it counts as unreachable. */
	timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export class Home {
	readonly #logger: Logger;
	readonly #reporter: ErrorReporter;
	readonly #timeoutMs: number;
	#backend: HomeBackend | undefined;
	#reported = false;
	#adminReported = false;

	constructor({ logger, reporter, timeoutMs = DEFAULT_TIMEOUT_MS }: HomeOptions) {
		this.#logger = logger.child({ component: "home" });
		this.#reporter = reporter;
		this.#timeoutMs = timeoutMs;
	}

	/** The adapter plugs its backend in at startup. Without one, Home Assistant is simply off. */
	attach(backend: HomeBackend): void {
		this.#backend = backend;
	}

	status(): HomeStatus {
		return this.#backend?.status() ?? { kind: "unconfigured" };
	}

	/**
	 * Checks the connection and login and says so, in the logs and (once) to the error
	 * tracker. A token that belongs to an admin is flagged too, since Home Assistant
	 * can't limit a token and a non-admin user is the best fence there is.
	 */
	async check(): Promise<HomeStatus> {
		const backend = this.#backend;
		if (!backend) return { kind: "unconfigured" };
		let status: HomeStatus;
		try {
			status = await withTimeout(backend.check(), this.#timeoutMs);
		} catch (error) {
			this.#logger.warn(
				{ event: "home.check_failed", err: error },
				"couldn't check Home Assistant",
			);
			return { kind: "reconnecting" };
		}

		switch (status.kind) {
			case "connected":
				this.#logger.info(
					{ event: "home.connected", haVersion: status.haVersion },
					"Home Assistant is connected",
				);
				if (status.adminToken === true && !this.#adminReported) {
					this.#adminReported = true;
					const message =
						"The Home Assistant token belongs to an admin user. Use a non-admin user's token: Home Assistant can't limit a token, so this is the best fence available.";
					this.#logger.warn({ event: "home.admin_token" }, message);
					this.#reporter.captureBackground(new Error(message), "home-assistant");
				}
				break;
			case "off": {
				const message = `Home Assistant is off: ${status.reason}`;
				this.#logger.error({ event: "home.off" }, message);
				this.#reporter.captureBackground(new Error(message), "home-assistant");
				break;
			}
			case "connecting":
			case "reconnecting":
				this.#logger.warn(
					{ event: "home.not_connected", status: status.kind },
					"Home Assistant isn't connected yet",
				);
				break;
			case "unconfigured":
				break;
		}
		return status;
	}

	/** Fresh states for these entities. Ones that don't exist are left out. */
	async getStates(entityIds: readonly string[]): Promise<Map<string, EntityState>> {
		return this.#run("getStates", (backend) => backend.getStates(entityIds));
	}

	async getState(entityId: string): Promise<EntityState | undefined> {
		return (await this.getStates([entityId])).get(entityId);
	}

	/** Everything Home Assistant has, fresh. For the inventory: it says what exists, never what may be used. */
	async listEntities(): Promise<HomeEntity[]> {
		return this.#run("listEntities", (backend) => backend.listEntities());
	}

	/** Makes one call, once. If Home Assistant isn't reachable it fails at once and nothing is queued or retried. */
	async callService(call: ServiceCall): Promise<void> {
		return this.#run("callService", (backend) => backend.callService(call));
	}

	async #run<T>(action: string, work: (backend: HomeBackend) => Promise<T>): Promise<T> {
		const backend = this.#backend;
		if (!backend) throw new HomeUnavailableError(HOME_MESSAGES.notSetUp);
		// Don't even try while it's known to be down: that is when a call could hang or arrive late.
		if (backend.status().kind !== "connected") throw this.#unreachable(action, "not connected");

		try {
			const result = await withTimeout(work(backend), this.#timeoutMs);
			this.#reported = false;
			return result;
		} catch (error) {
			if (error instanceof HomeRequestError) {
				// Home Assistant is up and answered, so this is not an outage.
				this.#logger.warn(
					{ event: "home.rejected", action, code: error.code },
					"Home Assistant rejected the call",
				);
				throw error;
			}
			if (error instanceof HomeUnavailableError)
				throw this.#unreachable(action, "unavailable", error);
			if (error instanceof HomeTimeout) throw this.#unreachable(action, "timed out", error);
			this.#logger.error(
				{ event: "home.failed", action, err: error },
				"unexpected Home Assistant failure",
			);
			this.#report(error);
			throw new HomeUnavailableError(HOME_MESSAGES.unreachable, { cause: error });
		}
	}

	#unreachable(action: string, why: string, cause?: unknown): HomeUnavailableError {
		this.#logger.warn({ event: "home.unreachable", action, why }, "Home Assistant is unreachable");
		this.#report(cause ?? new Error(`Home Assistant is unreachable (${why})`));
		return new HomeUnavailableError(HOME_MESSAGES.unreachable, { cause });
	}

	/** Reports once per outage rather than on every command. */
	#report(error: unknown): void {
		if (this.#reported) return;
		this.#reported = true;
		this.#reporter.captureBackground(error, "home-assistant");
	}
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new HomeTimeout()), ms);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
