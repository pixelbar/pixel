import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor } from "../../../src/core/access.ts";
import { CapabilityRegistry } from "../../../src/core/capabilities.ts";
import { type ChannelPoster, ChannelPosts } from "../../../src/core/channel-posts.ts";
import { Dispatcher, MESSAGES } from "../../../src/core/dispatcher.ts";
import {
	DOORBELL_ANSWER_ACTION,
	type DoorbellEvent,
	DoorbellEvents,
	type DoorbellMessage,
} from "../../../src/core/doorbell.ts";
import { IdentityService } from "../../../src/core/identity.ts";
import { silentLogger } from "../../../src/core/logger.ts";
import type { AcceptResult } from "../../../src/core/ports/doorbell-accept.ts";
import { RateLimiter } from "../../../src/core/rate-limit.ts";
import { CommandRegistry } from "../../../src/core/registry.ts";
import {
	createDoorbellFeature,
	DOORBELL_ACCESS,
	DOORBELL_CAPABILITY,
	DOORBELL_MESSAGES,
	doorbellText,
} from "../../../src/features/doorbell/index.ts";
import { DoorbellSettings } from "../../../src/services/doorbell-settings.ts";
import { actor, IDS } from "../../../src/testing/fixtures.ts";

const CALL = "20261118-3f9a1c2b7d4e";
const OTHER = "20261118-0a1b2c3d4e5f";
const CHANNEL = "100000000000000050";
const T0 = new Date("2026-11-18T09:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const ringing = (callId = CALL, acceptBy = at(15)): DoorbellEvent => ({
	type: "ringing",
	callId,
	occurredAt: T0,
	acceptBy,
});

/** Who's who: tiers, and who holds `doorbell`. */
const TIERS: Record<string, "admin" | "member" | "friend" | "guest"> = {
	[IDS.admin]: "admin",
	[IDS.member]: "member",
	[IDS.friend]: "friend",
};
const NO_CAPABILITY = "100000000000000009";
const HOLDERS = new Set<string>([IDS.admin, IDS.member, IDS.friend, IDS.guest]);
TIERS[NO_CAPABILITY] = "member";

function setup(options: { channel?: string | undefined; accept?: AcceptResult | null } = {}) {
	let now = T0;
	const posted: { channelId: string; message: DoorbellMessage }[] = [];
	const edits: { messageId: string; message: DoorbellMessage }[] = [];
	const poster: ChannelPoster = {
		check: vi.fn(),
		post: vi.fn(),
		postAttendance: vi.fn(),
		editAttendance: vi.fn(),
		postDoorbell: vi.fn(async (channelId: string, message: DoorbellMessage) => {
			posted.push({ channelId, message });
			return { url: `https://discord.test/${posted.length}`, messageId: `msg${posted.length}` };
		}),
		editDoorbell: vi.fn(async (_channelId: string, messageId: string, message: DoorbellMessage) => {
			edits.push({ messageId, message });
		}),
	};
	const posts = new ChannelPosts();
	posts.use(poster);
	const settings = new DoorbellSettings({ logger: silentLogger });
	const channel = "channel" in options ? options.channel : CHANNEL;
	if (channel) settings.set(channel, "discord:1");
	const reporter = { captureBackground: vi.fn() };
	const events = new DoorbellEvents({ logger: silentLogger, reporter });
	const acceptResult =
		options.accept === undefined ? ({ kind: "accepted" } as const) : options.accept;
	const accept = vi.fn(async (_callId: string, _by: string): Promise<AcceptResult> => {
		if (!acceptResult) throw new Error("not configured");
		return acceptResult;
	});
	const logger = { ...silentLogger, info: vi.fn(), error: vi.fn() };
	logger.child = () => logger;
	const feature = createDoorbellFeature({
		events,
		posts,
		settings,
		accept: options.accept === null ? undefined : { accept },
		logger,
		reporter,
		now: () => now,
	});
	const stop = feature.start?.() ?? (() => {});
	const registry = new CommandRegistry({
		capabilities: new CapabilityRegistry([DOORBELL_CAPABILITY]),
	});
	registry.register(feature);
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService(
			[{ name: "test", tierFor: async (a: PlatformActor) => TIERS[a.userId] ?? null }],
			[
				{
					name: "test",
					capabilitiesFor: async (a: PlatformActor) => (HOLDERS.has(a.userId) ? ["doorbell"] : []),
				},
			],
		),
		rateLimiter: new RateLimiter({ capacity: 1000, refillPerSecond: 0, now: () => 0 }),
		logger,
		reporter: { ...reporter, capture: vi.fn(), breadcrumb: vi.fn() },
	});
	const answer = (userId: string, call: string = CALL, displayName = "Ada") =>
		dispatcher.act({
			actor: actor({ userId, displayName }),
			action: DOORBELL_ANSWER_ACTION,
			args: { call },
		});
	return {
		events,
		posted,
		edits,
		poster,
		accept,
		reporter,
		logger,
		answer,
		stop,
		feature,
		setNow: (date: Date) => {
			now = date;
		},
	};
}

const textOf = (outcome: Awaited<ReturnType<ReturnType<typeof setup>["answer"]>>) =>
	"reply" in outcome ? outcome.reply.text : undefined;

describe("the doorbell capability", () => {
	it("is friend and above, with `doorbell`", () => {
		expect(DOORBELL_ACCESS).toEqual({ minTier: "friend", capability: "doorbell" });
		expect(DOORBELL_CAPABILITY.name).toBe("doorbell");
	});
});

describe("posting the doorbell", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("posts it with an Answer button when it rings", async () => {
		const { events, posted } = setup();
		await events.emit(ringing());
		expect(posted).toEqual([
			{
				channelId: CHANNEL,
				message: { callId: CALL, text: DOORBELL_MESSAGES.ringing(15), answerable: true },
			},
		]);
	});

	it("posts nothing without a channel, or once the call has stopped ringing", async () => {
		const { events, posted } = setup({ channel: undefined });
		await events.emit(ringing());
		expect(posted).toEqual([]);

		const late = setup();
		late.setNow(at(20));
		await late.events.emit(ringing());
		expect(late.posted).toEqual([]);
	});

	it("posts nothing before Discord is ready", async () => {
		const events = new DoorbellEvents({
			logger: silentLogger,
			reporter: { captureBackground: vi.fn() },
		});
		const posts = new ChannelPosts();
		const settings = new DoorbellSettings({ logger: silentLogger });
		settings.set(CHANNEL, "discord:1");
		const feature = createDoorbellFeature({
			events,
			posts,
			settings,
			accept: undefined,
			logger: silentLogger,
			reporter: { captureBackground: vi.fn() },
			now: () => T0,
		});
		feature.start?.();
		await expect(events.emit(ringing())).resolves.toBeUndefined();
	});

	it("posts a call once, however often it rings", async () => {
		const { events, posted } = setup();
		await events.emit(ringing());
		await events.emit(ringing());
		expect(posted).toHaveLength(1);
	});

	it.each([
		[
			"answered in the space",
			{ type: "accepted", via: "home-assistant" },
			DOORBELL_MESSAGES.answeredInSpace,
		],
		[
			"answered from Discord",
			{ type: "accepted", via: "pixel" },
			DOORBELL_MESSAGES.answeredOnDiscord,
		],
		["answered some other way", { type: "accepted", via: "intercom" }, DOORBELL_MESSAGES.answered],
		["missed", { type: "missed", reason: "timeout" }, DOORBELL_MESSAGES.missed],
		["hung up", { type: "missed", reason: "caller_hung_up" }, DOORBELL_MESSAGES.hungUp],
		["busy", { type: "busy", activeCallId: OTHER }, DOORBELL_MESSAGES.busy],
		["ended", { type: "ended", reason: "playback_finished" }, DOORBELL_MESSAGES.answered],
	])("edits the post when it's %s, and takes the button away", async (_label, event, text) => {
		const { events, edits } = setup();
		await events.emit(ringing());
		await events.emit({ ...event, callId: CALL, occurredAt: at(5) } as DoorbellEvent);
		expect(edits).toEqual([
			{ messageId: "msg1", message: { callId: CALL, text, answerable: false } },
		]);
	});

	it("keeps who answered when the call ends, and ignores a ringing that arrives late", async () => {
		const { events, edits, posted } = setup();
		await events.emit(ringing());
		await events.emit({ type: "accepted", callId: CALL, occurredAt: at(5), via: "home-assistant" });
		await events.emit({
			type: "ended",
			callId: CALL,
			occurredAt: at(12),
			reason: "playback_finished",
		});
		await events.emit(ringing());
		expect(posted).toHaveLength(1);
		expect(edits.map((e) => e.message.text)).toEqual([DOORBELL_MESSAGES.answeredInSpace]);
	});

	it("handles events in either order: an accept after the end still says who", async () => {
		const { events, edits } = setup();
		await events.emit(ringing());
		await events.emit({
			type: "ended",
			callId: CALL,
			occurredAt: at(12),
			reason: "caller_hung_up",
		});
		await events.emit({ type: "accepted", callId: CALL, occurredAt: at(5), via: "home-assistant" });
		expect(edits.map((e) => e.message.text)).toEqual([
			DOORBELL_MESSAGES.answered,
			DOORBELL_MESSAGES.answeredInSpace,
		]);
	});

	it("never posts a call that settled before its ringing arrived", async () => {
		const { events, posted } = setup();
		await events.emit({ type: "missed", callId: CALL, occurredAt: at(15), reason: "timeout" });
		await events.emit(ringing());
		expect(posted).toEqual([]);
	});

	it("shows how it settled if that happened while it was being posted", async () => {
		const { events, edits, poster } = setup();
		let release: () => void = () => {};
		vi.mocked(poster.postDoorbell).mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { url: "u", messageId: "slow" };
		});
		const ring = events.emit(ringing());
		const missed = events.emit({
			type: "missed",
			callId: CALL,
			occurredAt: at(15),
			reason: "timeout",
		});
		await vi.waitFor(() => expect(poster.postDoorbell).toHaveBeenCalled());
		release();
		await Promise.all([ring, missed]);
		expect(edits.map((e) => [e.messageId, e.message.text])).toContainEqual([
			"slow",
			DOORBELL_MESSAGES.missed,
		]);
		expect(edits.at(-1)?.message.answerable).toBe(false);
	});

	it("reports a post that fails, and keeps going", async () => {
		const { events, poster, reporter, edits } = setup();
		vi.mocked(poster.postDoorbell).mockRejectedValueOnce(new Error("Discord is down"));
		await events.emit(ringing());
		await events.emit({ type: "missed", callId: CALL, occurredAt: at(15), reason: "timeout" });
		expect(reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "doorbell");
		// Nothing was posted, so there's nothing to edit.
		expect(edits).toEqual([]);
	});

	it("takes the button away if nothing settles the call", async () => {
		vi.useFakeTimers();
		const { events, edits } = setup();
		await events.emit(ringing());
		await vi.advanceTimersByTimeAsync(15_000 + 29_000);
		expect(edits).toEqual([]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(edits.map((e) => e.message)).toEqual([
			{ callId: CALL, text: DOORBELL_MESSAGES.stopped, answerable: false },
		]);
		// A late event still says how it really went.
		await events.emit({ type: "missed", callId: CALL, occurredAt: at(15), reason: "timeout" });
		expect(edits.at(-1)?.message.text).toBe(DOORBELL_MESSAGES.missed);
	});

	it("forgets old calls, and stops listening when stopped", async () => {
		const { events, posted, setNow, stop } = setup();
		await events.emit(ringing());
		setNow(at(15 + 11 * 60));
		// Forgotten, so a (very) late copy of the ringing is treated as new and is too late to post.
		await events.emit(ringing());
		expect(posted).toHaveLength(1);
		stop();
		setNow(T0);
		await events.emit(ringing(OTHER));
		expect(posted).toHaveLength(1);
	});
});

describe("doorbellText", () => {
	it("says how long is left, at least a second", () => {
		expect(doorbellText({ acceptBy: at(15) }, at(14.9)).text).toBe(DOORBELL_MESSAGES.ringing(1));
	});

	it("names who answered, escaped", () => {
		expect(
			doorbellText(
				{ acceptBy: at(15), outcome: { kind: "accepted", via: "pixel", name: "*Ada*" } },
				T0,
			).text,
		).toBe("🔔 Someone was at the door. **\\*Ada\\*** answered.");
	});
});

describe("Answer", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it.each([
		["a friend", IDS.friend],
		["a member", IDS.member],
		["an admin", IDS.admin],
	])("lets %s holding `doorbell` answer, as themselves", async (_label, userId) => {
		const { answer, accept } = setup();
		const outcome = await answer(userId);
		expect(textOf(outcome)).toBe(DOORBELL_MESSAGES.onIt);
		expect("reply" in outcome && outcome.reply.private).toBe(true);
		expect(accept).toHaveBeenCalledWith(CALL, `discord:${userId}`);
	});

	it.each([
		["a guest", IDS.guest],
		["a member without `doorbell`", NO_CAPABILITY],
	])("refuses %s privately, without asking pixel-phone", async (_label, userId) => {
		const { answer, accept } = setup();
		const outcome = await answer(userId);
		expect(outcome.kind).toBe("refused");
		expect(textOf(outcome)).toBe(MESSAGES.deniedTier);
		expect(accept).not.toHaveBeenCalled();
	});

	it("refuses a call ID that isn't one, without asking pixel-phone", async () => {
		const { answer, accept } = setup();
		expect(textOf(await answer(IDS.member, "../../admin"))).toBe(DOORBELL_MESSAGES.tooLate);
		expect(accept).not.toHaveBeenCalled();
	});

	it("says so when pixel-phone isn't connected", async () => {
		const { answer } = setup({ accept: null });
		expect(textOf(await answer(IDS.member))).toBe(DOORBELL_MESSAGES.notSetUp);
	});

	it("puts who answered on the post at once", async () => {
		const { events, answer, edits, logger } = setup();
		await events.emit(ringing());
		await answer(IDS.member, CALL, "Ada");
		await events.emit({
			type: "accepted",
			callId: CALL,
			occurredAt: at(5),
			via: "pixel",
			by: `discord:${IDS.member}`,
		});
		await vi.waitFor(() => expect(edits).toHaveLength(1));
		expect(edits[0]?.message).toEqual({
			callId: CALL,
			text: DOORBELL_MESSAGES.answeredBy("Ada"),
			answerable: false,
		});
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "doorbell.answered",
				callId: CALL,
				user: `discord:${IDS.member}`,
			}),
			expect.any(String),
		);
	});

	it("names whoever was first", async () => {
		const button = setup({ accept: { kind: "already", via: "home-assistant" } });
		expect(textOf(await button.answer(IDS.member))).toBe(
			DOORBELL_MESSAGES.alreadyBy("the button in the space"),
		);
		const discord = setup({ accept: { kind: "already", via: "pixel", by: "discord:1" } });
		expect(textOf(await discord.answer(IDS.member))).toBe(
			DOORBELL_MESSAGES.alreadyBy("someone on Discord"),
		);
		const other = setup({ accept: { kind: "already", via: "unknown" } });
		expect(textOf(await other.answer(IDS.member))).toBe(
			DOORBELL_MESSAGES.alreadyBy("someone else"),
		);
	});

	it("names the person, when they answered through this Pixel", async () => {
		const first = setup();
		await first.events.emit(ringing());
		await first.answer(IDS.friend, CALL, "Grace");
		// The same Pixel, a moment later: pixel-phone says it was already accepted.
		const result: AcceptResult = { kind: "already", via: "pixel", by: `discord:${IDS.friend}` };
		first.accept.mockResolvedValueOnce(result);
		expect(textOf(await first.answer(IDS.member))).toBe(DOORBELL_MESSAGES.alreadyBy("**Grace**"));
	});

	it("says it's too late, and takes the button away", async () => {
		const { events, answer, edits } = setup({ accept: { kind: "too-late" } });
		await events.emit(ringing());
		expect(textOf(await answer(IDS.member))).toBe(DOORBELL_MESSAGES.tooLate);
		await vi.waitFor(() => expect(edits.at(-1)?.message.text).toBe(DOORBELL_MESSAGES.stopped));
	});

	it.each([
		[{ kind: "failed", why: "timeout" } as const, "Couldn't accept a doorbell call: timeout"],
		[
			{ kind: "failed", why: "status", status: 401 } as const,
			"Couldn't accept a doorbell call: status (HTTP 401)",
		],
	])("says it couldn't reach the doorbell, and reports it: %j", async (result, message) => {
		const { answer, reporter, logger } = setup({ accept: result });
		expect(textOf(await answer(IDS.member))).toBe(DOORBELL_MESSAGES.unreachable);
		expect(reporter.captureBackground).toHaveBeenCalledWith(
			expect.objectContaining({ message }),
			"doorbell",
		);
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "doorbell.answer_failed", why: result.why }),
			expect.any(String),
		);
	});

	it("logs a refusal from pixel-phone as a failed answer", async () => {
		const { answer, logger } = setup({ accept: { kind: "too-late" } });
		await answer(IDS.member);
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({ event: "doorbell.answer_failed", why: "too-late" }),
			expect.any(String),
		);
	});
});
