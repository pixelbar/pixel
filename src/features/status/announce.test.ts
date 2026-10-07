import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Announcement, SpaceSnapshot } from "../../core/announcement.ts";
import { type Logger, silentLogger } from "../../core/logger.ts";
import type { SpaceChange, SpaceReading } from "../../services/space-status.ts";
import { READINGS_TO_CONFIRM, startSpaceAnnouncements } from "./announce.ts";

const INTERVAL = 30_000;
const T0 = new Date("2026-10-03T12:00:00Z");
const minutesBefore = (date: Date, minutes: number) => new Date(date.getTime() - minutes * 60_000);

/**
 * A fake status service the test drives by hand: set `current`, then `emit` a change.
 * With `holdChecks`, `checkNow` doesn't answer until the test calls `release()`.
 */
function setup(
	initial: SpaceReading | Error = reading("closed"),
	options: { holdChecks?: boolean; logger?: Logger } = {},
) {
	let current: SpaceReading | Error = initial;
	let held = options.holdChecks ?? false;
	const waiting: (() => void)[] = [];
	const listeners = new Set<(change: SpaceChange) => void>();
	const spaceStatus = {
		pollIntervalMs: INTERVAL,
		checkNow: vi.fn(async () => {
			if (held) await new Promise<void>((resolve) => waiting.push(resolve));
			if (current instanceof Error) throw current;
			return current;
		}),
		onChange: (listener: (change: SpaceChange) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const announcer = {
		announce: vi.fn(async (_announcement: Announcement) => {}),
		reconcile: vi.fn(async (_snapshot: SpaceSnapshot) => {}),
	};
	const stop = startSpaceAnnouncements({
		spaceStatus,
		announcer,
		logger: options.logger ?? silentLogger,
	});
	return {
		announcer,
		spaceStatus,
		stop,
		listeners,
		set: (next: SpaceReading | Error) => {
			current = next;
		},
		/** Makes checks from now on wait until `release()`. */
		hold: () => {
			held = true;
		},
		/** Lets every held check answer (and stops holding future ones). */
		release: async () => {
			held = false;
			for (const resolve of waiting.splice(0)) resolve();
			await vi.advanceTimersByTimeAsync(0);
		},
		emit: (change: Partial<SpaceChange> & Pick<SpaceChange, "from" | "to">) => {
			for (const listener of listeners) listener({ at: T0, previousSince: null, ...change });
		},
		advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
	};
}

function reading(state: SpaceReading["state"], since: Date | null = null): SpaceReading {
	return { state, since, checkedAt: T0 };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startup", () => {
	it("tells publishers the current state but announces nothing", async () => {
		const { announcer, advance } = setup(reading("closed", minutesBefore(T0, 90)));
		await advance(0);
		expect(announcer.reconcile).toHaveBeenCalledExactlyOnceWith({
			state: "closed",
			since: minutesBefore(T0, 90),
		});
		expect(announcer.announce).not.toHaveBeenCalled();
	});

	it("keeps trying until SpaceAPI answers with a definite state", async () => {
		const { announcer, set, advance } = setup(new Error("SpaceAPI is down"));
		await advance(0);
		expect(announcer.reconcile).not.toHaveBeenCalled();

		set(reading("unknown"));
		await advance(INTERVAL);
		expect(announcer.reconcile).not.toHaveBeenCalled();

		set(reading("open"));
		await advance(INTERVAL);
		expect(announcer.reconcile).toHaveBeenCalledExactlyOnceWith({ state: "open", since: null });
		await advance(INTERVAL * 5);
		expect(announcer.reconcile).toHaveBeenCalledOnce();
	});
});

describe("announcing changes", () => {
	it("confirms a change on the next reading, so it's announced after one interval", async () => {
		expect(READINGS_TO_CONFIRM).toBe(2);
		const { announcer, set, emit, advance } = setup(reading("closed"));
		await advance(0);

		set(reading("open", T0));
		emit({ from: "closed", to: "open", at: T0 });
		await advance(INTERVAL - 1);
		expect(announcer.announce).not.toHaveBeenCalled();

		await advance(1);
		expect(announcer.announce).toHaveBeenCalledExactlyOnceWith({
			kind: "space.status",
			state: "open",
			at: T0,
			openedAt: null,
			text: "🟢 Pixelbar is now open",
		});
	});

	it("says how long the space had been open when it closes", async () => {
		const openedAt = minutesBefore(T0, 200);
		const { announcer, set, emit, advance } = setup(reading("open", openedAt));
		await advance(0);

		set(reading("closed", T0));
		emit({ from: "open", to: "closed", at: T0, previousSince: openedAt });
		await advance(INTERVAL);

		expect(announcer.announce).toHaveBeenCalledExactlyOnceWith({
			kind: "space.status",
			state: "closed",
			at: T0,
			openedAt,
			text: "🔴 Pixelbar is now closed after being open for 3h 20m",
		});
	});

	it("leaves the duration out when it isn't known", async () => {
		const { announcer, set, emit, advance } = setup(reading("open"));
		await advance(0);
		set(reading("closed", T0));
		emit({ from: "open", to: "closed", at: T0, previousSince: null });
		await advance(INTERVAL);
		expect(announcer.announce).toHaveBeenCalledWith(
			expect.objectContaining({ openedAt: null, text: "🔴 Pixelbar is now closed" }),
		);
	});

	it("posts nothing if the change doesn't hold", async () => {
		const { announcer, set, emit, advance } = setup(reading("closed"));
		await advance(0);

		set(reading("open", T0));
		emit({ from: "closed", to: "open" });
		set(reading("closed", T0));
		emit({ from: "open", to: "closed" });
		await advance(INTERVAL * 5);

		expect(announcer.announce).not.toHaveBeenCalled();
	});

	it("restarts the wait when the state changes again, then announces what held", async () => {
		const { announcer, set, emit, advance } = setup(reading("closed"));
		await advance(0);

		emit({ from: "closed", to: "open" });
		await advance(INTERVAL - 1000);
		set(reading("open", T0));
		emit({ from: "open", to: "closed" });
		emit({ from: "closed", to: "open" });
		await advance(INTERVAL - 1);
		expect(announcer.announce).not.toHaveBeenCalled();
		await advance(1);
		expect(announcer.announce).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ state: "open" }),
		);
	});

	it("announces each change once, in order", async () => {
		const { announcer, set, emit, advance } = setup(reading("closed"));
		await advance(0);

		set(reading("open", T0));
		emit({ from: "closed", to: "open" });
		await advance(INTERVAL * 3);
		set(reading("closed", T0));
		emit({ from: "open", to: "closed", previousSince: T0 });
		await advance(INTERVAL * 3);

		expect(
			announcer.announce.mock.calls.map(([a]) => (a.kind === "space.status" ? a.state : a.kind)),
		).toEqual(["open", "closed"]);
	});

	it("doesn't announce a change twice even if every publisher failed", async () => {
		const { announcer, set, emit, advance } = setup(reading("closed"));
		announcer.announce.mockRejectedValue(new Error("all publishers down"));
		await advance(0);
		set(reading("open", T0));
		emit({ from: "closed", to: "open" });
		await advance(INTERVAL);
		await advance(INTERVAL * 5);
		expect(announcer.announce).toHaveBeenCalledOnce();
	});

	it("logs a failing step instead of leaving an unhandled rejection", async () => {
		const errors = vi.fn();
		const logger: Logger = { ...silentLogger, error: errors, child: () => logger };
		const { announcer, set, emit, advance } = setup(reading("closed"), { logger });
		announcer.announce.mockRejectedValue(new Error("bug in the announcer"));
		announcer.reconcile.mockRejectedValue(new Error("bug in reconcile"));
		await advance(0);
		set(reading("open", T0));
		emit({ from: "closed", to: "open" });
		await advance(INTERVAL);

		const steps = errors.mock.calls.map(([fields]) => (fields as { step: string }).step);
		expect(steps).toEqual(["reconcile", "settle"]);
	});

	it("assumes the state before the first change is what was last announced", async () => {
		// SpaceAPI was down at startup, so nothing was reconciled yet.
		const { announcer, set, emit, advance } = setup(new Error("down"));
		await advance(0);

		set(reading("open", T0));
		emit({ from: "closed", to: "open" });
		await advance(INTERVAL);

		expect(announcer.announce).toHaveBeenCalledWith(expect.objectContaining({ state: "open" }));
	});

	it("falls back to the reading's own times if the change doesn't match it", async () => {
		const since = minutesBefore(T0, 5);
		const { announcer, set, emit, advance } = setup(reading("closed"));
		await advance(0);

		set(reading("open", since));
		emit({ from: "open", to: "closed" }); // doesn't match what the reading now says
		await advance(INTERVAL);
		expect(announcer.announce).toHaveBeenLastCalledWith(
			expect.objectContaining({ state: "open", at: since }),
		);

		// And with no time on the reading either, the time of the check itself.
		set(reading("closed", null));
		emit({ from: "closed", to: "open" });
		await advance(INTERVAL);
		expect(announcer.announce).toHaveBeenLastCalledWith(
			expect.objectContaining({ state: "closed", at: T0, openedAt: null }),
		);
	});
});

describe("when SpaceAPI is unreachable while confirming", () => {
	it("keeps trying each interval and announces once it can confirm", async () => {
		const { announcer, set, emit, advance } = setup(reading("closed"));
		await advance(0);

		set(new Error("SpaceAPI is down"));
		emit({ from: "closed", to: "open" });
		await advance(INTERVAL * 3);
		expect(announcer.announce).not.toHaveBeenCalled();

		set(reading("open", T0));
		await advance(INTERVAL);
		expect(announcer.announce).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ state: "open" }),
		);
	});

	it("eventually gives up rather than retrying forever", async () => {
		const { announcer, spaceStatus, set, emit, advance } = setup(reading("closed"));
		await advance(0);
		set(new Error("SpaceAPI is down"));
		emit({ from: "closed", to: "open" });
		const checksBefore = spaceStatus.checkNow.mock.calls.length;

		await advance(INTERVAL * 30);
		const attempts = spaceStatus.checkNow.mock.calls.length - checksBefore;
		expect(attempts).toBe(11); // the first confirmation, plus 10 retries

		set(reading("open", T0));
		await advance(INTERVAL * 5);
		expect(announcer.announce).not.toHaveBeenCalled();
	});

	it("doesn't announce while the state is unknown", async () => {
		const { announcer, set, emit, advance } = setup(reading("closed"));
		await advance(0);
		set(reading("unknown"));
		emit({ from: "closed", to: "open" });
		await advance(INTERVAL * 3);
		expect(announcer.announce).not.toHaveBeenCalled();
	});
});

describe("stopping", () => {
	it("stops listening and cancels a change that was waiting to be confirmed", async () => {
		const { announcer, listeners, set, emit, stop, advance } = setup(reading("closed"));
		await advance(0);
		set(reading("open", T0));
		emit({ from: "closed", to: "open" });

		stop();
		expect(listeners.size).toBe(0);
		await advance(INTERVAL * 5);
		expect(announcer.announce).not.toHaveBeenCalled();
	});

	it("doesn't announce a change whose confirmation was in flight when it stopped", async () => {
		const { announcer, set, emit, stop, hold, release, advance } = setup(reading("closed"), {
			holdChecks: true,
		});
		await release(); // the startup check answers
		set(reading("open", T0));
		emit({ from: "closed", to: "open" });
		hold(); // the confirmation check will wait
		await advance(INTERVAL); // ...and it's now in flight

		stop();
		await release(); // it answers after stopping
		expect(announcer.announce).not.toHaveBeenCalled();
	});

	it("doesn't reconcile if it stopped while the startup check was in flight", async () => {
		const { announcer, stop, release, advance } = setup(reading("closed"), { holdChecks: true });
		await advance(0);
		stop();
		await release();
		expect(announcer.reconcile).not.toHaveBeenCalled();
	});

	it("doesn't retry a failed confirmation after stopping", async () => {
		const { announcer, spaceStatus, set, emit, stop, release, advance } = setup(reading("closed"), {
			holdChecks: true,
		});
		await release(); // startup reconcile answers; later checks are no longer held
		set(new Error("SpaceAPI is down"));
		emit({ from: "closed", to: "open" });
		await advance(INTERVAL - 1);
		stop();
		const checks = spaceStatus.checkNow.mock.calls.length;
		await advance(INTERVAL * 5);
		expect(spaceStatus.checkNow.mock.calls.length).toBe(checks);
		expect(announcer.announce).not.toHaveBeenCalled();
	});

	it("stops a startup that is still waiting for SpaceAPI", async () => {
		const { announcer, set, stop, advance } = setup(new Error("down"));
		await advance(0);
		stop();
		set(reading("open"));
		await advance(INTERVAL * 5);
		expect(announcer.reconcile).not.toHaveBeenCalled();
	});
});
