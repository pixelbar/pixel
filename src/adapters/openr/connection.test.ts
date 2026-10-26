import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../core/logger.ts";
import {
	ACCESS_COOKIE,
	type LoginAnswer,
	type OpenrApi,
	OpenrError,
	type OpenrSession,
	REFRESH_COOKIE,
} from "./client.ts";
import { beforeDeadline, OpenrConnection, type OpenrConnectionOptions } from "./connection.ts";
import { SessionFile } from "./session-file.ts";

// Obviously fake values. Never put anything that looks like a real credential here.
const EMAIL = "pixel@example.invalid";
const PASSWORD = "not-a-real-password";
const START = new Date("2030-01-01T10:00:00.000Z");
const MINUTE = 60_000;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-openr-"));
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

function session(
	name: string,
	accessMinutes: number,
	refreshMinutes = 60 * 24,
	from = START,
): OpenrSession {
	return {
		cookies: { [ACCESS_COOKIE]: `access-${name}`, [REFRESH_COOKIE]: `refresh-${name}` },
		accessToken: undefined,
		refreshToken: undefined,
		accessUntil: new Date(from.getTime() + accessMinutes * MINUTE),
		refreshUntil: new Date(from.getTime() + refreshMinutes * MINUTE),
	};
}

function fakeApi() {
	return {
		login: vi.fn<OpenrApi["login"]>(
			async (): Promise<LoginAnswer> => ({ kind: "code", token: "proto" }),
		),
		completeLogin: vi.fn<OpenrApi["completeLogin"]>(async () => session("one", 10)),
		refresh: vi.fn<OpenrApi["refresh"]>(async () => session("two", 20)),
		openDoor: vi.fn<OpenrApi["openDoor"]>(async () => {}),
		logout: vi.fn<OpenrApi["logout"]>(async () => {}),
	};
}

function setup(overrides: Partial<OpenrConnectionOptions> = {}) {
	let now = START;
	const api = fakeApi();
	const captureBackground = vi.fn();
	const logs: { level: string; obj: Record<string, unknown> }[] = [];
	const record = (level: string) => (obj: object) =>
		logs.push({ level, obj: obj as Record<string, unknown> });
	const logger = {
		...silentLogger,
		debug: record("debug"),
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
		child: () => logger,
	};
	const file = join(dir, "openr-session.json");
	const make = (extra: Partial<OpenrConnectionOptions> = {}) =>
		new OpenrConnection({
			api,
			email: EMAIL,
			password: PASSWORD,
			buildingId: "49",
			file,
			logger,
			reporter: { captureBackground },
			now: () => now,
			...overrides,
			...extra,
		});
	return {
		api,
		captureBackground,
		logs,
		file,
		make,
		setNow: (t: Date) => {
			now = t;
		},
		later: (minutes: number) => {
			now = new Date(now.getTime() + minutes * MINUTE);
		},
		events: () => logs.map((l) => l.obj.event),
	};
}

async function loggedIn(t: ReturnType<typeof setup>, extra: Partial<OpenrConnectionOptions> = {}) {
	const connection = t.make(extra);
	await connection.startLogin();
	await connection.completeLogin("123456");
	return connection;
}

describe("logging in", () => {
	it("starts logged out, waits for the emailed code, then is logged in", async () => {
		const t = setup();
		const connection = t.make();
		expect(connection.status()).toEqual({ state: "logged-out" });

		expect(await connection.startLogin()).toEqual({
			step: "code-sent",
			codeUntil: new Date(START.getTime() + 10 * MINUTE),
		});
		expect(t.api.login).toHaveBeenCalledWith(EMAIL, PASSWORD);
		expect(connection.status()).toEqual({
			state: "awaiting-code",
			codeUntil: new Date(START.getTime() + 10 * MINUTE),
		});

		expect(await connection.completeLogin("123456")).toEqual({
			step: "logged-in",
			sessionUntil: session("one", 10).refreshUntil,
		});
		expect(t.api.completeLogin).toHaveBeenCalledWith("proto", "123456");
		expect(connection.status()).toEqual({
			state: "logged-in",
			sessionUntil: session("one", 10).refreshUntil,
			refreshedAt: START,
			refreshFailingSince: undefined,
		});
		expect(t.events()).toEqual(["openr.code_sent", "openr.session_started"]);
	});

	it("saves the session so a restart picks it up", async () => {
		const t = setup();
		await loggedIn(t);
		expect(new SessionFile(t.file).read()).toEqual({
			kind: "found",
			saved: { session: session("one", 10), refreshedAt: START },
		});
		const restarted = t.make();
		expect(restarted.status()).toMatchObject({ state: "logged-in", refreshedAt: START });
		expect(t.events()).toContain("openr.session_restored");
	});

	it("is logged in at once when OpenR needs no code", async () => {
		const t = setup();
		t.api.login.mockResolvedValueOnce({ kind: "session", session: session("one", 10) });
		const connection = t.make();
		expect(await connection.startLogin()).toEqual({
			step: "logged-in",
			sessionUntil: session("one", 10).refreshUntil,
		});
		expect(connection.status().state).toBe("logged-in");
	});

	it("says when OpenR refuses the account, and keeps it out of Sentry", async () => {
		const t = setup();
		t.api.login.mockRejectedValueOnce(new OpenrError("http", "x", { status: 401 }));
		expect(await t.make().startLogin()).toEqual({ step: "refused", why: "credentials" });
		expect(t.captureBackground).not.toHaveBeenCalled();
		expect(t.logs.at(-1)?.obj).toEqual({
			event: "openr.login_refused",
			why: "credentials",
			status: 401,
		});
	});

	it("reports an outage while logging in", async () => {
		const t = setup();
		const error = new OpenrError("network", "x");
		t.api.login.mockRejectedValueOnce(error);
		expect(await t.make().startLogin()).toEqual({ step: "failed" });
		expect(t.captureBackground).toHaveBeenCalledWith(error, "openr");
		expect(t.logs.at(-1)?.obj).toEqual({ event: "openr.login_failed", kind: "network" });
	});

	it("reports something unexpected without its details", async () => {
		const t = setup();
		t.api.login.mockRejectedValueOnce(new Error(`boom ${PASSWORD}`));
		expect(await t.make().startLogin()).toEqual({ step: "failed" });
		expect(t.logs.at(-1)?.obj).toEqual({ event: "openr.login_failed", kind: "unexpected" });
		expect(JSON.stringify(t.logs)).not.toContain(PASSWORD);
	});

	it("refuses a code when no login is waiting, or it timed out", async () => {
		const t = setup();
		const connection = t.make();
		expect(await connection.completeLogin("123456")).toEqual({ step: "refused", why: "no-login" });
		await connection.startLogin();
		t.later(11);
		expect(connection.status()).toEqual({ state: "logged-out" });
		expect(await connection.completeLogin("123456")).toEqual({ step: "refused", why: "no-login" });
		expect(t.api.completeLogin).not.toHaveBeenCalled();
	});

	it("keeps waiting after a wrong code, so the right one still works", async () => {
		const t = setup();
		const connection = t.make();
		await connection.startLogin();
		t.api.completeLogin.mockRejectedValueOnce(new OpenrError("http", "x", { status: 422 }));
		expect(await connection.completeLogin("000000")).toEqual({ step: "refused", why: "code" });
		expect(connection.status().state).toBe("awaiting-code");
		expect((await connection.completeLogin("123456")).step).toBe("logged-in");
	});

	it("keeps the current session while a new login waits for its code", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		await connection.startLogin();
		expect(connection.status().state).toBe("logged-in");
		expect(await connection.open("103")).toEqual({ opened: true });
	});

	it("keeps going when the session can't be saved", async () => {
		const t = setup({ file: dir });
		const connection = await loggedIn(t);
		expect(connection.status().state).toBe("logged-in");
		expect(t.events()).toContain("openr.session_save_failed");
	});

	it("keeps the session in memory only without a file", async () => {
		const t = setup({ file: undefined });
		const connection = await loggedIn(t);
		expect(connection.status().state).toBe("logged-in");
		expect(existsSync(t.file)).toBe(false);
		await connection.logout();
		expect(connection.status()).toEqual({ state: "logged-out" });
	});
});

describe("defaults", () => {
	it("tells the time by the clock unless given one", async () => {
		const t = setup({ now: undefined });
		const connection = t.make({ now: undefined });
		const step = await connection.startLogin();
		expect(step.step === "code-sent" && step.codeUntil.getTime()).toBeGreaterThan(Date.now());
	});
});

describe("restarting", () => {
	it("drops a saved session that has expired", () => {
		const t = setup();
		new SessionFile(t.file).write({ session: session("old", 1, 10), refreshedAt: undefined });
		t.later(11);
		expect(t.make().status()).toEqual({ state: "logged-out" });
		expect(existsSync(t.file)).toBe(false);
		expect(t.events()).toContain("openr.session_expired");
	});

	it("is logged out when the saved session can't be read, and says so", () => {
		const t = setup();
		writeFileSync(t.file, "{");
		expect(t.make().status()).toEqual({ state: "logged-out" });
		expect(t.logs.at(-1)).toEqual({ level: "error", obj: { event: "openr.session_unreadable" } });
	});

	it("doesn't mind when an expired file can't be deleted", () => {
		const t = setup();
		new SessionFile(t.file).write({ session: session("old", 1, 10), refreshedAt: undefined });
		vi.spyOn(SessionFile.prototype, "remove").mockImplementationOnce(() => {
			throw new Error("read-only");
		});
		t.later(11);
		expect(t.make().status()).toEqual({ state: "logged-out" });
	});
});

describe("opening a door", () => {
	it("opens it with the session, once", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		expect(await connection.open("103")).toEqual({ opened: true });
		expect(t.api.openDoor).toHaveBeenCalledTimes(1);
		expect(t.api.openDoor).toHaveBeenCalledWith(
			session("one", 10),
			"49",
			"103",
			expect.any(AbortSignal),
		);
		expect(t.api.refresh).not.toHaveBeenCalled();
	});

	it("says it's logged out without a session", async () => {
		const t = setup();
		expect(await t.make().open("103")).toEqual({ opened: false, reason: "logged-out" });
		expect(t.api.openDoor).not.toHaveBeenCalled();
	});

	it("refreshes an expired access first", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(11);
		t.api.refresh.mockResolvedValueOnce(
			session("two", 20, 60 * 24, new Date(START.getTime() + 11 * MINUTE)),
		);
		expect(await connection.open("103")).toEqual({ opened: true });
		expect(t.api.refresh).toHaveBeenCalledWith(session("one", 10));
		expect(t.api.openDoor.mock.calls[0]?.[0].cookies[ACCESS_COOKIE]).toBe("access-two");
	});

	it("doesn't open with an access that's still expired after refreshing", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(11);
		t.api.refresh.mockResolvedValueOnce(session("two", 1));
		expect(await connection.open("103")).toEqual({ opened: false, reason: "failed" });
		expect(t.api.openDoor).not.toHaveBeenCalled();
	});

	it("doesn't open when refreshing failed for now, and keeps the session", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(11);
		t.api.refresh.mockRejectedValueOnce(new OpenrError("http", "x", { status: 503 }));
		expect(await connection.open("103")).toEqual({ opened: false, reason: "failed" });
		expect(t.api.openDoor).not.toHaveBeenCalled();
		expect(connection.status().state).toBe("logged-in");
	});

	it("says it's logged out when the refresh is refused", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(11);
		t.api.refresh.mockRejectedValueOnce(new OpenrError("http", "x", { status: 401 }));
		expect(await connection.open("103")).toEqual({ opened: false, reason: "logged-out" });
	});

	it("opens one door at a time, and doesn't queue", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		let finish = () => {};
		t.api.openDoor.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
		const first = connection.open("103");
		expect(await connection.open("103")).toEqual({ opened: false, reason: "busy" });
		expect(await connection.open("203")).toEqual({ opened: true });
		finish();
		expect(await first).toEqual({ opened: true });
		expect(await connection.open("103")).toEqual({ opened: true });
		expect(t.api.openDoor).toHaveBeenCalledTimes(3);
	});

	it("fails without retrying when OpenR doesn't open it, and logs the status only", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.api.openDoor.mockRejectedValueOnce(new OpenrError("http", "x", { status: 500 }));
		expect(await connection.open("103")).toEqual({ opened: false, reason: "failed" });
		expect(t.api.openDoor).toHaveBeenCalledTimes(1);
		expect(t.logs.at(-1)).toEqual({
			level: "warn",
			obj: { event: "openr.open_failed", door: "103", kind: "http", status: 500 },
		});
	});

	it("refreshes for next time when OpenR refuses the access, without retrying the door", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.api.openDoor.mockRejectedValueOnce(new OpenrError("http", "x", { status: 401 }));
		expect(await connection.open("103")).toEqual({ opened: false, reason: "failed" });
		await vi.waitFor(() => expect(t.api.refresh).toHaveBeenCalledTimes(1));
		expect(t.api.openDoor).toHaveBeenCalledTimes(1);
	});

	it("gives up at the deadline while refreshing, and lets the refresh finish", async () => {
		const t = setup({ openTimeoutMs: 20 });
		const connection = await loggedIn(t);
		t.later(11);
		let finish = (_: OpenrSession) => {};
		t.api.refresh.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		expect(await connection.open("103")).toEqual({ opened: false, reason: "failed" });
		expect(t.api.openDoor).not.toHaveBeenCalled();
		expect(t.logs.at(-1)?.obj).toMatchObject({ event: "openr.open_failed", kind: "timeout" });
		finish(session("two", 30));
		await vi.waitFor(() => expect(t.events()).toContain("openr.refreshed"));
		expect(new SessionFile(t.file).read()).toMatchObject({
			kind: "found",
			saved: { session: session("two", 30) },
		});
	});

	it("never opens once the deadline has passed", async () => {
		const t = setup({ openTimeoutMs: 1 });
		const connection = await loggedIn(t);
		t.later(11);
		t.api.refresh.mockImplementationOnce(
			() => new Promise((resolve) => setTimeout(() => resolve(session("two", 30)), 20)),
		);
		expect(await connection.open("103")).toEqual({ opened: false, reason: "failed" });
		expect(t.api.openDoor).not.toHaveBeenCalled();
	});

	it("passes on an unexpected failure while refreshing as a failure to open", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(11);
		t.api.refresh.mockImplementationOnce(async () => {
			throw "not an error";
		});
		expect(await connection.open("103")).toEqual({ opened: false, reason: "failed" });
		expect(t.api.openDoor).not.toHaveBeenCalled();
	});
});

describe("keeping the session alive", () => {
	it("refreshes shortly before the access expires, saves it, and stops when asked", async () => {
		vi.useFakeTimers();
		const t = setup({ tickMs: 30_000 });
		const connection = await loggedIn(t);
		const stop = connection.start();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(t.api.refresh).not.toHaveBeenCalled();

		t.later(8.5);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(t.api.refresh).toHaveBeenCalledTimes(1);
		expect(connection.status()).toMatchObject({
			state: "logged-in",
			refreshedAt: new Date(START.getTime() + 8.5 * MINUTE),
		});
		expect(new SessionFile(t.file).read()).toMatchObject({
			saved: { session: session("two", 20) },
		});

		stop();
		t.later(60);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(t.api.refresh).toHaveBeenCalledTimes(1);
	});

	it("does nothing while logged out", async () => {
		vi.useFakeTimers();
		const t = setup();
		const stop = t.make().start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(t.api.refresh).not.toHaveBeenCalled();
		stop();
	});

	it("refreshes once for everyone who asks at the same time", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(11);
		let finish = (_: OpenrSession) => {};
		t.api.refresh.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		const opening = [connection.open("103"), connection.open("203")];
		finish(session("two", 30));
		expect(await Promise.all(opening)).toEqual([{ opened: true }, { opened: true }]);
		expect(t.api.refresh).toHaveBeenCalledTimes(1);
	});

	it("ends the session when OpenR refuses a refresh, and tells Sentry an admin must log in", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(9);
		t.api.refresh.mockRejectedValueOnce(new OpenrError("http", "x", { status: 401 }));
		const stop = connection.start();
		await vi.waitFor(() => expect(connection.status().state).toBe("logged-out"));
		stop();
		expect(connection.status()).toEqual({
			state: "logged-out",
			endedAt: new Date(START.getTime() + 9 * MINUTE),
		});
		expect(existsSync(t.file)).toBe(false);
		expect(t.captureBackground).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringMatching(/\/admin openr login/) }),
			"openr",
		);
		expect(t.logs.at(-1)).toEqual({
			level: "error",
			obj: { event: "openr.session_ended", why: "refused" },
		});
	});

	it("ends the session once it has expired, without asking OpenR", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(60 * 24);
		const stop = connection.start();
		await vi.waitFor(() => expect(connection.status().state).toBe("logged-out"));
		stop();
		expect(t.api.refresh).not.toHaveBeenCalled();
		expect(t.logs.at(-1)?.obj).toEqual({ event: "openr.session_ended", why: "expired" });
	});

	it("keeps trying through an outage, says so, and reports it once", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(9);
		const outage = new OpenrError("timeout", "x");
		t.api.refresh.mockRejectedValueOnce(outage).mockRejectedValueOnce(outage);
		const failingSince = new Date(START.getTime() + 9 * MINUTE);

		const stop = connection.start();
		await vi.waitFor(() => expect(t.api.refresh).toHaveBeenCalledTimes(1));
		stop();
		await vi.waitFor(() =>
			expect(connection.status()).toMatchObject({ refreshFailingSince: failingSince }),
		);
		t.later(1);
		connection.start()();
		await vi.waitFor(() => expect(t.api.refresh).toHaveBeenCalledTimes(2));
		await vi.waitFor(() =>
			expect(t.events().filter((e) => e === "openr.refresh_failed")).toHaveLength(2),
		);
		expect(t.captureBackground).toHaveBeenCalledTimes(1);
		expect(connection.status()).toMatchObject({
			state: "logged-in",
			refreshFailingSince: failingSince,
		});

		connection.start()();
		await vi.waitFor(() =>
			expect(connection.status()).toMatchObject({ refreshFailingSince: undefined }),
		);
	});

	it("reports an unexpected refresh failure, and keeps the session", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(9);
		const broken = new Error("broken");
		t.api.refresh.mockImplementationOnce(() => {
			throw broken;
		});
		connection.start()();
		await vi.waitFor(() => expect(t.captureBackground).toHaveBeenCalledWith(broken, "openr"));
		expect(connection.status().state).toBe("logged-in");
	});

	it("doesn't bring back a session that was logged out while refreshing", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(11);
		let finish = (_: OpenrSession) => {};
		t.api.refresh.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		const opening = connection.open("103");
		await connection.logout();
		finish(session("two", 30));
		expect(await opening).toEqual({ opened: false, reason: "logged-out" });
		expect(connection.status()).toEqual({ state: "logged-out" });
		expect(existsSync(t.file)).toBe(false);
	});

	it("doesn't end a newer session when an old refresh is refused", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(11);
		let fail = (_: unknown) => {};
		t.api.refresh.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
		const opening = connection.open("103");
		await connection.startLogin();
		t.api.completeLogin.mockResolvedValueOnce(
			session("new", 30, 60 * 24, new Date(START.getTime() + 11 * MINUTE)),
		);
		await connection.completeLogin("123456");
		fail(new OpenrError("http", "x", { status: 401 }));
		expect(await opening).toEqual({ opened: true });
		expect(t.api.openDoor.mock.calls[0]?.[0].cookies[ACCESS_COOKIE]).toBe("access-new");
		expect(connection.status().state).toBe("logged-in");
	});
});

describe("logging out", () => {
	it("forgets the session and the file, and tells OpenR", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		await connection.logout();
		expect(t.api.logout).toHaveBeenCalledWith(session("one", 10));
		expect(connection.status()).toEqual({ state: "logged-out" });
		expect(existsSync(t.file)).toBe(false);
		expect(await connection.open("103")).toEqual({ opened: false, reason: "logged-out" });
		expect(t.captureBackground).not.toHaveBeenCalled();
	});

	it("forgets the session even when OpenR can't be told", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.api.logout.mockRejectedValueOnce(new OpenrError("network", "x"));
		await connection.logout();
		expect(connection.status()).toEqual({ state: "logged-out" });
		expect(t.logs.at(-1)?.obj).toEqual({ event: "openr.logout_failed", kind: "network" });
	});

	it("drops a login waiting for its code, and does nothing more without a session", async () => {
		const t = setup();
		const connection = t.make();
		await connection.startLogin();
		await connection.logout();
		expect(connection.status()).toEqual({ state: "logged-out" });
		expect(t.api.logout).not.toHaveBeenCalled();
	});

	it("still logs out when the file can't be deleted", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		vi.spyOn(SessionFile.prototype, "remove").mockImplementationOnce(() => {
			throw new Error("read-only");
		});
		await connection.logout();
		expect(connection.status()).toEqual({ state: "logged-out" });
		expect(t.events()).toContain("openr.session_remove_failed");
	});
});

describe("secrets", () => {
	it("never logs the password, the code, the login token or the session", async () => {
		const t = setup();
		const connection = await loggedIn(t);
		t.later(11);
		await connection.open("103");
		await connection.logout();
		const logged = JSON.stringify(t.logs);
		for (const secret of [
			PASSWORD,
			EMAIL,
			"123456",
			"proto",
			"access-one",
			"refresh-one",
			"access-two",
		]) {
			expect(logged).not.toContain(secret);
		}
	});

	it("never writes the password or the email to the session file", async () => {
		const t = setup();
		await loggedIn(t);
		const saved = readFileSync(t.file, "utf8");
		expect(saved).not.toContain(PASSWORD);
		expect(saved).not.toContain(EMAIL);
	});
});

describe("beforeDeadline", () => {
	it("refuses at once when the deadline has already passed", async () => {
		const passed = AbortSignal.abort();
		await expect(beforeDeadline(new Promise(() => {}), passed)).rejects.toMatchObject({
			kind: "timeout",
		});
	});

	it("passes on the work's own failure", async () => {
		const deadline = new AbortController();
		await expect(beforeDeadline(Promise.reject(new Error("own")), deadline.signal)).rejects.toThrow(
			"own",
		);
	});
});
