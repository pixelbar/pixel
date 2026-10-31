import { describe, expect, it, vi } from "vitest";
import type { SubcommandDefinition } from "../../core/command.ts";
import { silentLogger } from "../../core/logger.ts";
import type {
	DoorStatusResult,
	DoorSystem,
	DoorSystemStatus,
	LoginStep,
} from "../../core/ports/door-system.ts";
import { context, IDS, principal } from "../../testing/fixtures.ts";
import { createOpenrSubgroup, describeDoorStatus, describeOpenr } from "./openr.ts";

const NOW = new Date("2030-01-01T10:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function fakeSystem(status: DoorSystemStatus = { state: "logged-out" }) {
	return {
		status: vi.fn(() => status),
		startLogin: vi.fn<DoorSystem["startLogin"]>(async () => ({
			step: "code-sent",
			codeUntil: at(10),
		})),
		completeLogin: vi.fn<DoorSystem["completeLogin"]>(async () => ({
			step: "logged-in",
			sessionUntil: at(60 * 24 * 30),
		})),
		logout: vi.fn<DoorSystem["logout"]>(async () => {}),
		open: vi.fn<DoorSystem["open"]>(async () => ({ opened: true })),
		doorStatus: vi.fn<DoorSystem["doorStatus"]>(async () => ({
			kind: "ok",
			online: true,
			errors: [],
		})),
	};
}

/** `null`: OpenR isn't configured. */
function setup(configured: ReturnType<typeof fakeSystem> | null = fakeSystem()) {
	const system = configured ?? undefined;
	const reporter = { breadcrumb: vi.fn() };
	const group = createOpenrSubgroup({
		system,
		doors: [
			{ name: "Entrance", id: "103" },
			{ name: "Living room", id: "203" },
		],
		gateDoor: "125",
		reporter,
		now: () => NOW,
	});
	const warn = vi.fn();
	const logger = { ...silentLogger, warn };
	const run = async (name: string, args: Record<string, string> = {}) => {
		const sub = group.subcommands.find((s) => s.name === name) as SubcommandDefinition;
		const reply = await sub.handler(
			context({ args, principal: principal("admin", { userId: IDS.admin }), logger }),
		);
		return reply.text ?? "";
	};
	return { system, reporter, group, warn, run };
}

describe("/admin openr", () => {
	it("is admin-only at every level, and private", () => {
		const { group } = setup();
		expect(group.access.minTier).toBe("admin");
		expect(group.subcommands.map((s) => [s.name, s.access.minTier, s.private])).toEqual([
			["status", "admin", true],
			["login", "admin", true],
			["code", "admin", true],
			["logout", "admin", true],
		]);
	});

	it("says OpenR isn't configured, for every subcommand", async () => {
		const { run } = setup(null);
		for (const name of ["status", "login", "code", "logout"]) {
			expect(await run(name, { code: "123456" })).toMatch(/OpenR isn't configured/);
		}
	});
});

describe("/admin openr login", () => {
	it("starts a login, says a code is on its way, and logs who did it", async () => {
		const { run, system, warn, reporter } = setup();
		expect(await run("login")).toBe(
			"OpenR has emailed a code to Pixel's account. Pass it on with `/admin openr code` (Pixel waits 10m for it).",
		);
		expect(system?.startLogin).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			{
				event: "openr.login_started",
				result: "code-sent",
				user: `discord:${IDS.admin}`,
				userName: "Test User",
				userHandle: "test-user",
			},
			"an admin started an OpenR login",
		);
		expect(reporter.breadcrumb).toHaveBeenCalledWith("openr.login", "code-sent", {
			user: `discord:${IDS.admin}`,
		});
	});

	it.each<[LoginStep, RegExp]>([
		[{ step: "logged-in", sessionUntil: at(60 * 24 * 2) }, /logged in to OpenR.*ends in 2 days/],
		[{ step: "refused", why: "credentials" }, /refused Pixel's email or password.*openr-password/],
		[{ step: "failed" }, /Couldn't reach OpenR/],
	])("says what happened: %j", async (step, text) => {
		const { run, system } = setup();
		system?.startLogin.mockResolvedValueOnce(step);
		expect(await run("login")).toMatch(text);
	});
});

describe("/admin openr code", () => {
	it("passes the code on, without spaces, and never logs it", async () => {
		const { run, system, warn } = setup();
		expect(await run("code", { code: " 123 456 " })).toMatch(
			/logged in to OpenR and can open doors/,
		);
		expect(system?.completeLogin).toHaveBeenCalledWith("123456");
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "openr.login_completed", result: "logged-in" }),
			"an admin entered an OpenR login code",
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("123");
	});

	it("refuses something that isn't a code, without asking OpenR", async () => {
		const { run, system } = setup();
		expect(await run("code", { code: "abc123" })).toMatch(/only digits/);
		expect(await run("code", {})).toMatch(/only digits/);
		expect(system?.completeLogin).not.toHaveBeenCalled();
	});

	it.each<[LoginStep, RegExp]>([
		[{ step: "refused", why: "code" }, /didn't accept that code/],
		[{ step: "refused", why: "no-login" }, /no login waiting.*\/admin openr login/],
	])("says what went wrong: %j", async (step, text) => {
		const { run, system, warn } = setup();
		system?.completeLogin.mockResolvedValueOnce(step);
		expect(await run("code", { code: "123456" })).toMatch(text);
		expect(warn.mock.calls[0]?.[0]).toMatchObject({
			result: `refused-${step.step === "refused" ? step.why : ""}`,
		});
	});
});

describe("/admin openr logout", () => {
	it("logs Pixel out, and logs who did it", async () => {
		const { run, system, warn, reporter } = setup();
		expect(await run("logout")).toMatch(/logged out of OpenR and can't open any door/);
		expect(system?.logout).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "openr.logged_out", user: `discord:${IDS.admin}` }),
			"an admin logged Pixel out of OpenR",
		);
		expect(reporter.breadcrumb).toHaveBeenCalledWith("openr.logout", "logged out", {
			user: `discord:${IDS.admin}`,
		});
	});
});

describe("/admin openr status", () => {
	it("lists the doors without reading them while logged out", async () => {
		const { run, system } = setup(fakeSystem({ state: "logged-out" }));
		expect(await run("status")).toBe(
			[
				"OpenR: **logged out**. Log in with `/admin openr login`.",
				"Doors: Entrance (103), Living room (203), Parking gate (125)",
			].join("\n"),
		);
		expect(system?.doorStatus).not.toHaveBeenCalled();
	});

	it("reads every door and the gate live while logged in", async () => {
		const system = fakeSystem({
			state: "logged-in",
			sessionUntil: at(60 * 24 * 180),
			refreshedAt: NOW,
			refreshFailingSince: undefined,
		});
		system.doorStatus
			.mockResolvedValueOnce({ kind: "ok", online: true, errors: [] })
			.mockResolvedValueOnce({ kind: "ok", online: false, errors: ["Lock *jammed*"] })
			.mockResolvedValueOnce({ kind: "failed" });
		const { run, group } = setup(system);
		expect(await run("status")).toBe(
			[
				"OpenR: logged in, session ends in 180 days unless refreshed",
				"",
				"**Entrance** (103): 🟢 online",
				"**Living room** (203): 🔴 **offline** · ⚠️ Lock \\*jammed\\*",
				"**Parking gate** (125): ⚠️ couldn't read its status (see `openr.status_failed` in the logs)",
			].join("\n"),
		);
		expect(system.doorStatus.mock.calls.map((c) => c[0])).toEqual(["103", "203", "125"]);
		const sub = group.subcommands.find((s) => s.name === "status");
		expect(sub?.placeholder).toEqual({ text: "Checking…", private: true });
	});

	it("says when there are no doors or gate", async () => {
		const group = createOpenrSubgroup({
			system: fakeSystem(),
			doors: [],
			gateDoor: undefined,
			reporter: { breadcrumb: vi.fn() },
			now: () => NOW,
		});
		const status = group.subcommands.find((s) => s.name === "status") as SubcommandDefinition;
		expect((await status.handler(context())).text).toMatch(
			/No doors are set\.\nParking gate: not set\.$/,
		);
	});
});

describe("describeDoorStatus", () => {
	it.each<[DoorStatusResult | undefined, string]>([
		[{ kind: "ok", online: undefined, errors: [] }, "answered"],
		[{ kind: "ok", online: true, errors: ["a", "b"] }, "🟢 online · ⚠️ a · ⚠️ b"],
		[{ kind: "logged-out" }, "not logged in"],
		[undefined, "⚠️ couldn't read its status (see `openr.status_failed` in the logs)"],
	])("describes %j", (status, text) => {
		expect(describeDoorStatus(status)).toBe(text);
	});
});

describe("describeOpenr", () => {
	it.each<[DoorSystemStatus, string]>([
		[
			{
				state: "logged-in",
				sessionUntil: at(90),
				refreshedAt: NOW,
				refreshFailingSince: undefined,
			},
			"OpenR: logged in, session ends in 1h 30m unless refreshed\n⚠️ The session ends soon: log in again with `/admin openr login` before it does.",
		],
		[
			{
				state: "logged-in",
				sessionUntil: at(60 * 24 * 20),
				refreshedAt: NOW,
				refreshFailingSince: undefined,
			},
			"OpenR: logged in, session ends in 20 days unless refreshed",
		],
		[
			{ state: "logged-in", sessionUntil: at(90), refreshedAt: NOW, refreshFailingSince: at(-30) },
			"OpenR: logged in, session ends in 1h 30m unless refreshed\n⚠️ The session ends soon: log in again with `/admin openr login` before it does.\n⚠️ Refreshing has failed since 30m ago: OpenR may be down.",
		],
		[
			{ state: "awaiting-code", codeUntil: at(7) },
			"OpenR: waiting for the emailed code (`/admin openr code`) for another 7m",
		],
		[{ state: "logged-out" }, "OpenR: **logged out**. Log in with `/admin openr login`."],
		[
			{ state: "logged-out", endedAt: at(-0.5) },
			"OpenR: **logged out**: OpenR ended the session just now. Log in with `/admin openr login`.",
		],
		[
			{ state: "logged-out", endedAt: at(-180) },
			"OpenR: **logged out**: OpenR ended the session 3h ago. Log in with `/admin openr login`.",
		],
		[
			{ state: "logged-out", endedAt: at(-60 * 50) },
			"OpenR: **logged out**: OpenR ended the session 2d ago. Log in with `/admin openr login`.",
		],
	])("describes %j", (status, text) => {
		expect(describeOpenr(status, NOW)).toBe(text);
	});
});
