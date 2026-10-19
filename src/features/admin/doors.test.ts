import { describe, expect, it, vi } from "vitest";
import type { SubcommandDefinition } from "../../core/command.ts";
import { silentLogger } from "../../core/logger.ts";
import { KindSwitch } from "../../services/kind-switch.ts";
import { context, IDS, principal } from "../../testing/fixtures.ts";
import { createDoorsSubgroup, describeDoors } from "./doors.ts";

function setup(saveFails = false) {
	const switches = new KindSwitch({ logger: silentLogger, switchable: ["door"] });
	if (saveFails)
		vi.spyOn(switches, "set").mockImplementation((kind, on, by) => {
			const result = KindSwitch.prototype.set.call(switches, kind, on, by);
			return { ...result, saved: false };
		});
	const reporter = { breadcrumb: vi.fn() };
	const warn = vi.fn();
	const logger = { ...silentLogger, warn };
	const group = createDoorsSubgroup({ switches, reporter });
	const run = (name: "on" | "off") =>
		(group.subcommands.find((s) => s.name === name) as SubcommandDefinition).handler(
			context({ principal: principal("admin", { userId: IDS.admin }), logger }),
		);
	return { switches, reporter, group, run, warn };
}

describe("/admin doors", () => {
	it("is admin-only at every level, and private", () => {
		const { group } = setup();
		expect(group.access.minTier).toBe("admin");
		expect(group.subcommands.map((s) => [s.name, s.access.minTier, s.private])).toEqual([
			["off", "admin", true],
			["on", "admin", true],
		]);
	});

	it("switches door control off and back on, saying what changed", async () => {
		const { switches, run } = setup();
		expect((await run("off")).text).toBe("Door control from Pixel is now **off**.");
		expect(switches.isOn("door")).toBe(false);
		expect((await run("off")).text).toBe("Door control from Pixel was already **off**.");
		expect((await run("on")).text).toBe("Door control from Pixel is now **on**.");
		expect(switches.isOn("door")).toBe(true);
	});

	it("leaves a breadcrumb with who did it", async () => {
		const { run, reporter } = setup();
		await run("off");
		expect(reporter.breadcrumb).toHaveBeenCalledWith("home.kind_switched", "doors off", {
			user: `discord:${IDS.admin}`,
		});
	});

	it("logs each switch on the command's logger, naming the admin", async () => {
		const { run, warn } = setup();
		await run("off");
		expect(warn).toHaveBeenLastCalledWith(
			{
				event: "home.kind_switched",
				kind: "door",
				on: false,
				changed: true,
				saved: true,
				user: `discord:${IDS.admin}`,
				userName: "Test User",
				userHandle: "test-user",
			},
			"door control switched off",
		);
		await run("on");
		expect(warn).toHaveBeenLastCalledWith(
			expect.objectContaining({ event: "home.kind_switched", on: true, changed: true }),
			"door control switched on",
		);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("warns when the switch couldn't be saved, and logs that it wasn't", async () => {
		const { run, warn } = setup(true);
		expect((await run("off")).text).toContain("only holds until Pixel restarts");
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "home.kind_switched", saved: false }),
			"door control switched off",
		);
	});

	it("shows the state for /admin status", () => {
		const { switches } = setup();
		expect(describeDoors(switches)).toBe("Door control: on");
		switches.set("door", false, "x");
		expect(describeDoors(switches)).toBe("Door control: **off** (`/admin doors on`)");
	});
});
