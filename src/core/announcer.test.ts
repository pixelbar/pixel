import { describe, expect, it, vi } from "vitest";
import type { Announcement, Publisher } from "./announcement.ts";
import { Announcer } from "./announcer.ts";
import { silentLogger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

const announcement: Announcement = {
	kind: "space.status",
	state: "open",
	at: new Date("2026-10-03T12:00:00Z"),
	openedAt: null,
	text: "🟢 Pixelbar is now open",
};

function setup() {
	const reporter = {
		capture: vi.fn(),
		captureBackground: vi.fn<ErrorReporter["captureBackground"]>(),
	};
	return { announcer: new Announcer({ logger: silentLogger, reporter }), reporter };
}

const publisher = (id: string, overrides: Partial<Publisher> = {}): Publisher => ({
	id,
	publish: vi.fn(async () => {}),
	...overrides,
});

describe("Announcer", () => {
	it("sends an announcement to every registered publisher", async () => {
		const { announcer } = setup();
		const a = publisher("a");
		const b = publisher("b");
		announcer.register(a);
		announcer.register(b);
		await announcer.announce(announcement);
		expect(a.publish).toHaveBeenCalledWith(announcement);
		expect(b.publish).toHaveBeenCalledWith(announcement);
	});

	it("does nothing, without failing, when there are no publishers", async () => {
		const { announcer } = setup();
		await expect(announcer.announce(announcement)).resolves.toBeUndefined();
		await expect(announcer.reconcile({ state: "open", since: null })).resolves.toBeUndefined();
	});

	it("lists its publishers and refuses duplicate ids", () => {
		const { announcer } = setup();
		announcer.register(publisher("discord:live"));
		announcer.register(publisher("discord:timeline"));
		expect(announcer.publisherIds).toEqual(["discord:live", "discord:timeline"]);
		expect(() => announcer.register(publisher("discord:live"))).toThrow(/Duplicate publisher/);
	});

	it("keeps going when one publisher fails, and reports it by publisher id", async () => {
		const { announcer, reporter } = setup();
		const boom = new Error("Missing Permissions");
		const broken = publisher("broken", {
			publish: vi.fn(async () => {
				throw boom;
			}),
		});
		const healthy = publisher("healthy");
		announcer.register(broken);
		announcer.register(healthy);

		await expect(announcer.announce(announcement)).resolves.toBeUndefined();

		expect(healthy.publish).toHaveBeenCalledOnce();
		expect(reporter.captureBackground).toHaveBeenCalledWith(boom, "announcer:broken");
		expect(reporter.captureBackground).toHaveBeenCalledOnce();
	});

	it("keeps working after a failed call", async () => {
		const { announcer } = setup();
		const flaky = publisher("flaky", {
			publish: vi
				.fn<Publisher["publish"]>()
				.mockRejectedValueOnce(new Error("first fails"))
				.mockResolvedValue(),
		});
		announcer.register(flaky);
		await announcer.announce(announcement);
		await announcer.announce(announcement);
		expect(flaky.publish).toHaveBeenCalledTimes(2);
	});

	it("asks only publishers that support it to reconcile, isolating failures", async () => {
		const { announcer, reporter } = setup();
		const snapshot = { state: "closed", since: null } as const;
		const reconciling = publisher("live", { reconcile: vi.fn(async () => {}) });
		const plain = publisher("timeline");
		const broken = publisher("broken", {
			reconcile: vi.fn(async () => {
				throw new Error("nope");
			}),
		});
		announcer.register(reconciling);
		announcer.register(plain);
		announcer.register(broken);

		await announcer.reconcile(snapshot);

		expect(reconciling.reconcile).toHaveBeenCalledWith(snapshot);
		expect(plain.publish).not.toHaveBeenCalled();
		expect(reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "announcer:broken");
	});

	it("runs calls one at a time, in order", async () => {
		const { announcer } = setup();
		const events: string[] = [];
		const gates: (() => void)[] = [];
		announcer.register(
			publisher("p", {
				publish: async (a) => {
					events.push(`start ${a.text}`);
					await new Promise<void>((release) => gates.push(release));
					events.push(`end ${a.text}`);
				},
			}),
		);

		const first = announcer.announce({ ...announcement, text: "one" });
		const second = announcer.announce({ ...announcement, text: "two" });

		await vi.waitFor(() => expect(gates).toHaveLength(1));
		expect(events).toEqual(["start one"]);
		gates[0]?.();
		await vi.waitFor(() => expect(gates).toHaveLength(2));
		expect(events).toEqual(["start one", "end one", "start two"]);
		gates[1]?.();
		await Promise.all([first, second]);
		expect(events).toEqual(["start one", "end one", "start two", "end two"]);
	});
});
