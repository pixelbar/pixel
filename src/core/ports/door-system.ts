/**
 * The building's door system (OpenR): opens a door by its ID, using the one account
 * Pixel is logged in to. Who may open which door is decided before this is called (the
 * dispatcher, the doors in the config, `/admin doors`); an implementation only makes the
 * call and never decides who may.
 *
 * Opening must fail closed: one attempt with a time limit, no retries and no queueing,
 * because a late opening must never happen.
 *
 * Logging in needs a person. The system emails a one-time code to the account, and an
 * admin passes it back with `completeLogin`. After that the implementation keeps the
 * session alive on its own until an admin logs out or the system ends it.
 */
export type DoorSystem = {
	status(): DoorSystemStatus;
	/** Logs in with the configured account. Usually the system then emails a code. */
	startLogin(): Promise<LoginStep>;
	/** Finishes a login with the code the system emailed. */
	completeLogin(code: string): Promise<LoginStep>;
	/** Ends the session, here and (as far as it can) with the system. Never throws. */
	logout(): Promise<void>;
	/** Opens one door, once. Never throws. */
	open(doorId: string): Promise<DoorOpenResult>;
	/** Whether a door is online and any errors it reports. Read-only. Never throws. */
	doorStatus(doorId: string): Promise<DoorStatusResult>;
};

export type DoorStatusResult =
	/** `online` is undefined when the system doesn't say. `errors` are short and cleaned. */
	| { kind: "ok"; online: boolean | undefined; errors: readonly string[] }
	| { kind: "logged-out" }
	| { kind: "failed" };

export type DoorSystemStatus =
	/** `endedAt`: when the system ended the last session by itself, so an admin must log in again. */
	| { state: "logged-out"; endedAt?: Date }
	| { state: "awaiting-code"; codeUntil: Date }
	| {
			state: "logged-in";
			/** When the session ends unless it is refreshed before then. */
			sessionUntil: Date;
			refreshedAt: Date | undefined;
			/** Set while refreshing keeps failing (an outage, say). Cleared by the next success. */
			refreshFailingSince: Date | undefined;
	  };

export type LoginStep =
	| { step: "code-sent"; codeUntil: Date }
	| { step: "logged-in"; sessionUntil: Date }
	/**
	 * `credentials`: the account's email or password were refused. `code`: the code was
	 * wrong or too old. `no-login`: there's no login waiting for a code (none was started,
	 * or it timed out).
	 */
	| { step: "refused"; why: "credentials" | "code" | "no-login" }
	/** Couldn't reach the system, or it answered something unexpected. */
	| { step: "failed" };

export type DoorOpenResult =
	| { opened: true }
	/**
	 * `logged-out`: Pixel has no session. `busy`: that door is already being opened.
	 * `failed`: it tried and couldn't (an error, a timeout or an unclear answer).
	 */
	| { opened: false; reason: "logged-out" | "busy" | "failed" };
