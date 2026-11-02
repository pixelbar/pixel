import { describe, expect, it, vi } from "vitest";
import type { SubcommandDefinition } from "../../core/command.ts";
import { silentLogger } from "../../core/logger.ts";
import type { DoorOpenResult } from "../../core/ports/door-system.ts";
import { KindSwitch } from "../../services/kind-switch.ts";
import { context, IDS, principal } from "../../testing/fixtures.ts";
import {
	createOpenrFeature,
	OPENR_CAPABILITY,
	OPENR_MESSAGES,
	type OpenrDoor,
	openedLine,
	openrGate,
} from "./index.ts";

const DOORS: OpenrDoor[] = [
	{ name: "Entrance", id: "103" },
	{ name: "Living room", id: "203" },
	{ name: "Outdoor area", id: "126" },
];

function setup(
	options: { result?: DoorOpenResult; configured?: boolean; list?: OpenrDoor[] } = {},
) {
	const open = vi.fn(async (): Promise<DoorOpenResult> => options.result ?? { opened: true });
	const switches = new KindSwitch({ logger: silentLogger, switchable: ["door"] });
	const reporter = { breadcrumb: vi.fn() };
	const feature = createOpenrFeature({
		doors: options.configured === false ? undefined : { open },
		list: options.list ?? DOORS,
		switches,
		reporter,
	});
	const group = feature.commands?.[0];
	const sub = group?.subcommands?.[0] as SubcommandDefinition;
	const logs: { level: string; obj: Record<string, unknown> }[] = [];
	const logger = {
		...silentLogger,
		info: (obj: object) => logs.push({ level: "info", obj: obj as Record<string, unknown> }),
		warn: (obj: object) => logs.push({ level: "warn", obj: obj as Record<string, unknown> }),
	};
	const member = principal("member", { userId: IDS.member }, [OPENR_CAPABILITY.name]);
	const run = (door: string) => sub.handler(context({ args: { door }, principal: member, logger }));
	const suggest = (typed: string) => {
		const option = sub.options?.[0];
		if (option?.type !== "string" || !option.suggest) throw new Error("no suggestions");
		return option.suggest({ typed, args: {}, principal: member, logger });
	};
	return { open, switches, reporter, feature, group, sub, logs, run, suggest };
}

describe("/openr open", () => {
	it("needs a member with the openr capability, at every level, and is private", () => {
		const { group, sub } = setup();
		const access = { minTier: "member", capability: "openr" };
		expect(group?.access).toEqual(access);
		expect(sub.name).toBe("open");
		expect(sub.access).toEqual(access);
		expect(sub.private).toBe(true);
		expect(sub.placeholder).toEqual({ text: "Opening…", private: true });
	});

	it("opens the door by its OpenR ID, and logs who opened which", async () => {
		const t = setup();
		expect(await t.run("Entrance")).toEqual({ text: "🔓 **Entrance** is opening.", private: true });
		expect(t.open).toHaveBeenCalledWith("103");
		expect(t.logs).toEqual([
			{
				level: "info",
				obj: {
					event: "openr.door_opened",
					door: "Entrance",
					user: `discord:${IDS.member}`,
					userName: "Test User",
					userHandle: "test-user",
				},
			},
		]);
		expect(t.reporter.breadcrumb).toHaveBeenCalledWith("openr.door", "Entrance: opened", {
			user: `discord:${IDS.member}`,
		});
	});

	it("takes the name in any case, with spaces around it", async () => {
		const t = setup();
		await t.run("  living ROOM ");
		expect(t.open).toHaveBeenCalledWith("203");
	});

	it("says when it didn't open, and logs why", async () => {
		const t = setup({ result: { opened: false, reason: "failed" } });
		expect((await t.run("Entrance")).text).toBe(
			"⚠️ **Entrance** didn't open. Try again in a moment.",
		);
		expect(t.logs[0]?.obj).toMatchObject({ event: "openr.door_failed", reason: "failed" });
		expect(t.reporter.breadcrumb).toHaveBeenCalledWith(
			"openr.door",
			"Entrance: failed",
			expect.anything(),
		);
	});

	it("refuses a door that isn't in the config, without logging what was typed", async () => {
		const t = setup();
		expect(await t.run("Vault 103")).toEqual({ text: OPENR_MESSAGES.unknown, private: true });
		expect(await t.run("103")).toEqual({ text: OPENR_MESSAGES.unknown, private: true });
		expect(t.open).not.toHaveBeenCalled();
		expect(t.logs[0]?.obj).toMatchObject({ event: "openr.door_denied", reason: "unknown-door" });
		expect(JSON.stringify(t.logs)).not.toContain("Vault");
	});

	it("refuses every door while door control is switched off", async () => {
		const t = setup();
		t.switches.set("door", false, `discord:${IDS.admin}`);
		expect(await t.run("Entrance")).toEqual({ text: OPENR_MESSAGES.off, private: true });
		expect(t.open).not.toHaveBeenCalled();
		expect(t.logs[0]?.obj).toMatchObject({
			event: "openr.door_denied",
			reason: "switched-off",
			door: "Entrance",
		});
	});

	it("says so when OpenR isn't configured", async () => {
		const t = setup({ configured: false });
		expect(await t.run("Entrance")).toEqual({ text: OPENR_MESSAGES.notSetUp, private: true });
	});

	it("runs without a reporter", async () => {
		const open = vi.fn(async (): Promise<DoorOpenResult> => ({ opened: true }));
		const feature = createOpenrFeature({
			doors: { open },
			list: DOORS,
			switches: new KindSwitch({ logger: silentLogger, switchable: ["door"] }),
		});
		const sub = feature.commands?.[0]?.subcommands?.[0] as SubcommandDefinition;
		await sub.handler(context({ args: {}, principal: principal("member") }));
		expect(open).not.toHaveBeenCalled();
	});
});

describe("/openr open suggestions", () => {
	it("lists the doors that match what's typed", async () => {
		const t = setup();
		expect(await t.suggest("")).toEqual(DOORS.map((d) => ({ name: d.name, value: d.name })));
		expect(await t.suggest(" ROOM")).toEqual([{ name: "Living room", value: "Living room" }]);
	});

	it("lists at most 25", async () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ name: `Door ${i}`, id: String(i) }));
		expect(await setup({ list: many }).suggest("")).toHaveLength(25);
	});

	it("lists nothing while switched off, or when OpenR isn't configured", async () => {
		const t = setup();
		t.switches.set("door", false, "x");
		expect(await t.suggest("")).toEqual([]);
		expect(await setup({ configured: false }).suggest("")).toEqual([]);
	});
});

describe("openedLine", () => {
	it("says what happened", () => {
		expect(openedLine("Entrance", { opened: false, reason: "busy" })).toBe(
			"**Entrance** is already being opened.",
		);
		expect(openedLine("Entrance", { opened: false, reason: "logged-out" })).toMatch(
			/isn't logged in to OpenR.*\/admin openr login/,
		);
	});
});

describe("openrGate", () => {
	const request = { principal: principal("member"), spot: "ours" };
	const gate = (result: DoorOpenResult) => {
		const open = vi.fn(async () => result);
		const switches = new KindSwitch({ logger: silentLogger, switchable: ["door"] });
		return { open, switches, gate: openrGate({ doors: { open }, gateDoor: "125", switches }) };
	};

	it("opens the gate door", async () => {
		const t = gate({ opened: true });
		expect(await t.gate.open(request)).toEqual({ opened: true });
		expect(t.open).toHaveBeenCalledWith("125");
	});

	it("isn't connected while Pixel is logged out of OpenR", async () => {
		expect(await gate({ opened: false, reason: "logged-out" }).gate.open(request)).toEqual({
			opened: false,
			reason: "not-connected",
		});
	});

	it("failed when it was busy or OpenR didn't open it", async () => {
		for (const reason of ["busy", "failed"] as const) {
			expect(await gate({ opened: false, reason }).gate.open(request)).toEqual({
				opened: false,
				reason: "failed",
			});
		}
	});

	it("stays shut while door control is switched off, without asking OpenR", async () => {
		const t = gate({ opened: true });
		t.switches.set("door", false, "x");
		expect(await t.gate.open(request)).toEqual({ opened: false, reason: "off" });
		expect(t.open).not.toHaveBeenCalled();
	});
});
