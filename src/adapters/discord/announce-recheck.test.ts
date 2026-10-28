import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Publisher } from "../../core/announcement.ts";
import { silentLogger } from "../../core/logger.ts";
import { LIVE_PERMISSIONS, type OpenedChannel, TIMELINE_PERMISSIONS } from "./announce-channel.ts";
import type { AnnouncementChannel } from "./announce-publishers.ts";
import {
	AnnouncementRecheck,
	type ConfiguredChannel,
	ConfiguredChannels,
	type Recheckable,
} from "./announce-recheck.ts";

const BOT_CHANNEL = "100000000000000002";
const CLOSING_CHANNEL = "100000000000000003";
const HIDDEN = "the bot lacks these permissions there: ViewChannel";

const channel: AnnouncementChannel = {
	send: async () => ({ id: "m1" }),
	edit: async () => {},
	delete: async () => {},
	recentOwnPosts: async () => [],
	findOwnPost: async () => undefined,
};

/** A target that can be told whether it has problems, and counts its retries. */
function target(hasProblems = true) {
	const t = {
		problems: hasProblems,
		retries: 0,
		hasProblems: () => t.problems,
		retry: vi.fn(async () => {
			t.retries++;
		}),
	};
	return t;
}

describe("AnnouncementRecheck", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const recheck = (targets: Recheckable[], reportError = vi.fn()) =>
		new AnnouncementRecheck({
			targets,
			settleMs: 5_000,
			everyMs: 300_000,
			logger: silentLogger,
			reportError,
		});

	it("retries only the targets with problems", async () => {
		const broken = target();
		const fine = target(false);
		await recheck([broken, fine]).run();
		expect(broken.retries).toBe(1);
		expect(fine.retries).toBe(0);
	});

	it("waits for a burst of changes to settle, then retries once", async () => {
		const broken = target();
		const r = recheck([broken]);
		r.changed();
		await vi.advanceTimersByTimeAsync(3_000);
		r.changed();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(broken.retries).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(broken.retries).toBe(1);
	});

	it("ignores changes when nothing is broken", async () => {
		const fine = target(false);
		const r = recheck([fine]);
		r.changed();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fine.retry).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("tries every so often until stopped", async () => {
		const broken = target();
		const r = recheck([broken]);
		const stop = r.start();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(broken.retries).toBe(2);
		r.changed();
		stop();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(broken.retries).toBe(2);
	});

	it("runs one at a time, and once more for a call that came during a run", async () => {
		let release: () => void = () => {};
		const slow = target();
		slow.retry.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					slow.retries++;
					release = resolve;
				}),
		);
		const r = recheck([slow]);
		const first = r.run();
		await r.run();
		await r.run();
		expect(slow.retries).toBe(1);
		release();
		await first;
		// The two calls during the run make one more run, not two.
		expect(slow.retries).toBe(2);
	});

	it("reports a target that throws and still tries the others", async () => {
		const throwing = target();
		throwing.retry.mockRejectedValueOnce(new Error("boom"));
		const broken = target();
		const reportError = vi.fn();
		await recheck([throwing, broken], reportError).run();
		expect(reportError).toHaveBeenCalledOnce();
		expect(broken.retries).toBe(1);
	});
});

describe("ConfiguredChannels", () => {
	function setup(channels: Omit<ConfiguredChannel, "create">[]) {
		const problems = new Map<string, string>();
		const registered: string[] = [];
		const reportError = vi.fn();
		const configured = new ConfiguredChannels({
			channels: channels.map((c) => ({
				...c,
				create: (): Publisher => ({ id: c.id, publish: async () => {} }),
			})),
			openChannel: async (channelId): Promise<OpenedChannel> => {
				const problem = problems.get(channelId);
				return problem ? { ok: false, problem } : { ok: true, channel };
			},
			announcer: { register: (publisher) => registered.push(publisher.id) },
			logger: silentLogger,
			reportError,
		});
		return { configured, problems, registered, reportError };
	}

	const both = [
		{ id: "discord:bot-status", channelId: BOT_CHANNEL, required: LIVE_PERMISSIONS },
		{ id: "discord:closing-time", channelId: CLOSING_CHANNEL, required: TIMELINE_PERMISSIONS },
	];

	it("registers every channel it can open, and reports the others", async () => {
		const { configured, problems, registered, reportError } = setup(both);
		problems.set(BOT_CHANNEL, HIDDEN);
		await configured.start();
		expect(registered).toEqual(["discord:closing-time"]);
		expect(configured.hasProblems()).toBe(true);
		expect(reportError).toHaveBeenCalledOnce();
		expect(String(reportError.mock.calls[0]?.[0])).toContain(
			`Announcements to discord:bot-status are off: ${HIDDEN}`,
		);
	});

	it("turns a channel on once its permissions are fixed", async () => {
		const { configured, problems, registered } = setup(both);
		problems.set(BOT_CHANNEL, HIDDEN);
		await configured.start();
		problems.delete(BOT_CHANNEL);
		await configured.retry();
		expect(registered).toEqual(["discord:closing-time", "discord:bot-status"]);
		expect(configured.hasProblems()).toBe(false);
		// Nothing left to retry: it isn't registered twice.
		await configured.retry();
		expect(registered).toHaveLength(2);
	});

	it("reports each problem once, not at every retry", async () => {
		const { configured, problems, reportError } = setup(both);
		problems.set(BOT_CHANNEL, HIDDEN);
		await configured.start();
		await configured.retry();
		await configured.retry();
		expect(reportError).toHaveBeenCalledOnce();
		problems.set(BOT_CHANNEL, "there's no channel with that ID");
		await configured.retry();
		expect(reportError).toHaveBeenCalledTimes(2);
	});
});
