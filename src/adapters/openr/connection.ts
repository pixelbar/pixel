import type { Logger } from "../../core/logger.ts";
import type {
	DoorOpenResult,
	DoorSystem,
	DoorSystemStatus,
	LoginStep,
} from "../../core/ports/door-system.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import { type OpenrApi, OpenrError, type OpenrSession } from "./client.ts";
import { SessionFile } from "./session-file.ts";

/**
 * Pixel's one session with OpenR, as a `DoorSystem`. An admin logs in (`startLogin`,
 * then `completeLogin` with the code OpenR emails); from then on this keeps the session
 * alive by refreshing it shortly before its access expires, saves it so a restart
 * doesn't need a new code, and ends it when OpenR refuses a refresh (then an admin has
 * to log in again, and Sentry says so).
 *
 * Opening a door is one call with one deadline, refreshing included: no retries, no
 * queueing, and one opening at a time per door. A refresh that outlives the deadline
 * still finishes in the background, because OpenR may already have replaced the
 * refresh cookie, and dropping its answer would end the session.
 *
 * Nothing secret is logged: only what happened, an error's kind and its HTTP status.
 */

export type OpenrConnectionOptions = {
	api: OpenrApi;
	/** The account Pixel logs in as. Both are secrets. */
	email: string;
	password: string;
	buildingId: string;
	/** Where the session is kept across restarts. Undefined keeps it in memory only. */
	file?: string;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground">;
	now?: () => Date;
	/** How long opening a door may take, a refresh included. */
	openTimeoutMs?: number;
	/** How long an emailed code is waited for. */
	codeMs?: number;
	/** How long before its access expires the session is refreshed. */
	refreshAheadMs?: number;
	/** How often the background check runs. */
	tickMs?: number;
};

/** Like OpenR's dashboard: something expiring within 5 seconds counts as expired. */
const MARGIN_MS = 5_000;

export class OpenrConnection implements DoorSystem {
	readonly #api: OpenrApi;
	readonly #email: string;
	readonly #password: string;
	readonly #buildingId: string;
	readonly #file: SessionFile | undefined;
	readonly #logger: Logger;
	readonly #reporter: Pick<ErrorReporter, "captureBackground">;
	readonly #now: () => Date;
	readonly #openTimeoutMs: number;
	readonly #codeMs: number;
	readonly #refreshAheadMs: number;
	readonly #tickMs: number;

	#session: OpenrSession | undefined;
	#refreshedAt: Date | undefined;
	#refreshFailingSince: Date | undefined;
	#endedAt: Date | undefined;
	#pending: { token: string; until: Date } | undefined;
	#refreshing: Promise<OpenrSession | undefined> | undefined;
	readonly #opening = new Set<string>();

	constructor(options: OpenrConnectionOptions) {
		this.#api = options.api;
		this.#email = options.email;
		this.#password = options.password;
		this.#buildingId = options.buildingId;
		this.#file = options.file === undefined ? undefined : new SessionFile(options.file);
		this.#logger = options.logger.child({ adapter: "openr" });
		this.#reporter = options.reporter;
		this.#now = options.now ?? (() => new Date());
		this.#openTimeoutMs = options.openTimeoutMs ?? 10_000;
		this.#codeMs = options.codeMs ?? 10 * 60_000;
		this.#refreshAheadMs = options.refreshAheadMs ?? 2 * 60_000;
		this.#tickMs = options.tickMs ?? 30_000;
		this.#load();
	}

	status(): DoorSystemStatus {
		if (this.#session) {
			return {
				state: "logged-in",
				sessionUntil: this.#session.refreshUntil,
				refreshedAt: this.#refreshedAt,
				refreshFailingSince: this.#refreshFailingSince,
			};
		}
		if (this.#pending && this.#pending.until > this.#now()) {
			return { state: "awaiting-code", codeUntil: this.#pending.until };
		}
		return { state: "logged-out", ...(this.#endedAt ? { endedAt: this.#endedAt } : {}) };
	}

	/**
	 * Refreshes the session when it's nearly due, now and every `tickMs`. Returns a
	 * function that stops it. Never throws, and nothing escapes from the timer.
	 */
	start(): () => void {
		const tick = () => {
			this.#tick().catch((error: unknown) => this.#reporter.captureBackground(error, "openr"));
		};
		tick();
		const timer = setInterval(tick, this.#tickMs);
		return () => clearInterval(timer);
	}

	async startLogin(): Promise<LoginStep> {
		let answer: Awaited<ReturnType<OpenrApi["login"]>>;
		try {
			answer = await this.#api.login(this.#email, this.#password);
		} catch (error) {
			return this.#loginFailed(error, "credentials");
		}
		if (answer.kind === "code") {
			const codeUntil = new Date(this.#now().getTime() + this.#codeMs);
			this.#pending = { token: answer.token, until: codeUntil };
			this.#logger.info({ event: "openr.code_sent" }, "OpenR emailed a login code");
			return { step: "code-sent", codeUntil };
		}
		this.#begin(answer.session);
		return { step: "logged-in", sessionUntil: answer.session.refreshUntil };
	}

	async completeLogin(code: string): Promise<LoginStep> {
		const pending = this.#pending;
		if (!pending || pending.until <= this.#now()) {
			this.#pending = undefined;
			return { step: "refused", why: "no-login" };
		}
		let session: OpenrSession;
		try {
			session = await this.#api.completeLogin(pending.token, code);
		} catch (error) {
			return this.#loginFailed(error, "code");
		}
		if (this.#pending === pending) this.#pending = undefined;
		this.#begin(session);
		return { step: "logged-in", sessionUntil: session.refreshUntil };
	}

	async logout(): Promise<void> {
		this.#pending = undefined;
		const session = this.#session;
		if (!session) return;
		// Ended here first, so nothing uses it while OpenR is told.
		this.#end("logout");
		try {
			await this.#api.logout(session);
		} catch (error) {
			this.#logger.warn(
				{ event: "openr.logout_failed", ...describe(error) },
				"couldn't tell OpenR about the logout; Pixel has forgotten the session anyway",
			);
		}
	}

	async open(doorId: string): Promise<DoorOpenResult> {
		if (!this.#session) return { opened: false, reason: "logged-out" };
		if (this.#opening.has(doorId)) return { opened: false, reason: "busy" };
		this.#opening.add(doorId);
		const deadline = AbortSignal.timeout(this.#openTimeoutMs);
		try {
			const session = await beforeDeadline(this.#usableSession(), deadline);
			if (!session) {
				return { opened: false, reason: this.#session ? "failed" : "logged-out" };
			}
			await this.#api.openDoor(session, this.#buildingId, doorId, deadline);
			return { opened: true };
		} catch (error) {
			// Never retried. A refused session is refreshed for next time, in the background.
			if (error instanceof OpenrError && error.status === 401) void this.#refresh();
			this.#logger.warn(
				{ event: "openr.open_failed", door: doorId, ...describe(error) },
				"OpenR didn't open the door",
			);
			return { opened: false, reason: "failed" };
		} finally {
			this.#opening.delete(doorId);
		}
	}

	async #tick(): Promise<void> {
		const session = this.#session;
		if (!session) return;
		if (session.accessUntil.getTime() - this.#refreshAheadMs > this.#now().getTime()) return;
		await this.#refresh();
	}

	/** The session, refreshed first if its access has (nearly) expired. Undefined if that failed. */
	async #usableSession(): Promise<OpenrSession | undefined> {
		const current = this.#session;
		if (current && this.#valid(current.accessUntil)) return current;
		const fresh = await this.#refresh();
		return fresh && this.#valid(fresh.accessUntil) ? fresh : undefined;
	}

	/** One refresh at a time: everyone who asks meanwhile waits for the same one. */
	#refresh(): Promise<OpenrSession | undefined> {
		this.#refreshing ??= this.#refreshOnce().finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	async #refreshOnce(): Promise<OpenrSession | undefined> {
		const session = this.#session;
		if (!session) return undefined;
		if (!this.#valid(session.refreshUntil)) {
			this.#end("expired");
			return undefined;
		}
		let fresh: OpenrSession;
		try {
			fresh = await this.#api.refresh(session);
		} catch (error) {
			// Logged out (or in again) meanwhile: that session is the one that counts.
			if (this.#session !== session) return this.#session;
			if (error instanceof OpenrError && error.refused) {
				this.#end("refused");
				return undefined;
			}
			const first = this.#refreshFailingSince === undefined;
			this.#refreshFailingSince ??= this.#now();
			this.#logger.warn(
				{ event: "openr.refresh_failed", ...describe(error) },
				"couldn't refresh the OpenR session; trying again shortly",
			);
			if (first) this.#reporter.captureBackground(error, "openr");
			return session;
		}
		if (this.#session !== session) return this.#session;
		this.#session = fresh;
		this.#refreshedAt = this.#now();
		this.#refreshFailingSince = undefined;
		this.#save();
		this.#logger.debug(
			{ event: "openr.refreshed", sessionUntil: fresh.refreshUntil.toISOString() },
			"refreshed the OpenR session",
		);
		return fresh;
	}

	#valid(until: Date): boolean {
		return until.getTime() - MARGIN_MS > this.#now().getTime();
	}

	#loginFailed(error: unknown, why: "credentials" | "code"): LoginStep {
		if (error instanceof OpenrError && error.refused) {
			this.#logger.warn(
				{ event: "openr.login_refused", why, status: error.status },
				"OpenR refused the login",
			);
			return { step: "refused", why };
		}
		this.#logger.warn(
			{ event: "openr.login_failed", ...describe(error) },
			"couldn't log in to OpenR",
		);
		this.#reporter.captureBackground(error, "openr");
		return { step: "failed" };
	}

	#begin(session: OpenrSession): void {
		this.#session = session;
		this.#refreshedAt = this.#now();
		this.#refreshFailingSince = undefined;
		this.#endedAt = undefined;
		this.#save();
		this.#logger.info(
			{ event: "openr.session_started", sessionUntil: session.refreshUntil.toISOString() },
			"logged in to OpenR",
		);
	}

	#end(why: "expired" | "refused" | "logout"): void {
		this.#session = undefined;
		this.#refreshedAt = undefined;
		this.#refreshFailingSince = undefined;
		this.#endedAt = why === "logout" ? undefined : this.#now();
		try {
			this.#file?.remove();
		} catch (error) {
			this.#logger.error(
				{ event: "openr.session_remove_failed", err: error },
				"couldn't delete the saved OpenR session",
			);
		}
		if (why === "logout") {
			this.#logger.info({ event: "openr.session_ended", why }, "logged out of OpenR");
			return;
		}
		this.#logger.error(
			{ event: "openr.session_ended", why },
			"OpenR ended Pixel's session: an admin needs to log in again",
		);
		this.#reporter.captureBackground(
			new Error(
				"OpenR ended Pixel's session, so Pixel can't open doors. An admin needs to run /admin openr login.",
			),
			"openr",
		);
	}

	#save(): void {
		const session = this.#session;
		if (!this.#file || !session) return;
		try {
			this.#file.write({ session, refreshedAt: this.#refreshedAt });
		} catch (error) {
			this.#logger.error(
				{ event: "openr.session_save_failed", err: error },
				"couldn't save the OpenR session: after a restart an admin has to log in again",
			);
		}
	}

	#load(): void {
		if (!this.#file) return;
		const read = this.#file.read();
		if (read.kind === "none") return;
		if (read.kind === "invalid") {
			this.#logger.error(
				{ event: "openr.session_unreadable" },
				"couldn't read the saved OpenR session: an admin needs to log in again",
			);
			return;
		}
		const { session, refreshedAt } = read.saved;
		if (!this.#valid(session.refreshUntil)) {
			this.#logger.info(
				{ event: "openr.session_expired" },
				"the saved OpenR session has expired: an admin needs to log in again",
			);
			try {
				this.#file.remove();
			} catch {
				// Harmless: the next login overwrites it.
			}
			return;
		}
		this.#session = session;
		this.#refreshedAt = refreshedAt;
		this.#logger.info(
			{ event: "openr.session_restored", sessionUntil: session.refreshUntil.toISOString() },
			"picked up the saved OpenR session",
		);
	}
}

/** What can be logged about a failure: its kind and HTTP status, never its message's details. */
function describe(error: unknown): { kind: string; status?: number } {
	if (!(error instanceof OpenrError)) return { kind: "unexpected" };
	return error.status === undefined
		? { kind: error.kind }
		: { kind: error.kind, status: error.status };
}

/** `work`, unless `deadline` fires first; then it rejects with a timeout and `work` carries on. */
export function beforeDeadline<T>(work: Promise<T>, deadline: AbortSignal): Promise<T> {
	if (deadline.aborted) return Promise.reject(new OpenrError("timeout", "Out of time"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new OpenrError("timeout", "Out of time"));
		deadline.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				deadline.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				deadline.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
