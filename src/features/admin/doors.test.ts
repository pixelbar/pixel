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
	const group = createDoorsSubgroup({ switches, reporter });
	const run = (name: "on" | "off") =>
		(group.subcommands.find((s) => s.name === name) as SubcommandDefinition).handler(
			context({ principal: principal("admin", { userId: IDS.admin }) }),
		);
	return { switches, reporter, group, run };
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

	it("warns when the switch couldn't be saved", async () => {
		const { run } = setup(true);
		expect((await run("off")).text).toContain("only holds until Pixel restarts");
	});

	it("shows the state for /admin status", () => {
		const { switches } = setup();
		expect(describeDoors(switches)).toBe("Door control: on");
		switches.set("door", false, "x");
		expect(describeDoors(switches)).toBe("Door control: **off** (`/admin doors on`)");
	});
});
