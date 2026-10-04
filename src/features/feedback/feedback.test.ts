import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../core/logger.ts";
import type { FeedbackSink } from "../../core/ports/feedback.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import { context, IDS, plain, principal } from "../../testing/fixtures.ts";
import { createFeedbackFeature, MAX_FEEDBACK_LENGTH, MIN_FEEDBACK_LENGTH } from "./index.ts";

function setup(options: { send?: FeedbackSink["send"]; limiter?: RateLimiter } = {}) {
	const send = vi.fn(options.send ?? (() => true));
	const logged: Record<string, unknown>[] = [];
	const logger: Logger = {
		debug: () => {},
		info: (obj) => logged.push(obj as Record<string, unknown>),
		warn: () => {},
		error: () => {},
		child: () => logger,
	};
	const feature = createFeedbackFeature({
		sink: { send },
		...(options.limiter ? { limiter: options.limiter } : {}),
	});
	const command = plain(feature.commands?.[0]);
	const run = (
		message: unknown,
		who = principal("guest", { userId: IDS.guest, displayName: "Guest Person" }),
	) => command.handler(context({ args: { message: message as string }, principal: who, logger }));
	return { command, run, send, logged, feature };
}

describe("/feedback", () => {
	it("is open to everyone, guests included, and replies privately", () => {
		const { command, feature } = setup();
		expect(command.access.minTier).toBe("guest");
		expect(command.private).toBe(true);
		expect(command.options).toMatchObject([{ name: "message", type: "string", required: true }]);
		new CommandRegistry().register(feature);
	});

	it("sends the message with who it's from, and thanks them without promising a reply", async () => {
		const { run, send } = setup();
		const who = principal("member", { userId: IDS.member, displayName: "Ada", handle: "ada_l" });
		const reply = await run("The /events list is missing the quiz night", who);
		expect(send).toHaveBeenCalledWith({
			message: "The /events list is missing the quiz night",
			from: who,
		});
		expect(reply.text).toContain("Thank you");
		expect(reply.text).toContain("Discord name and ID");
		expect(reply.text).not.toMatch(/reply|respond|answer/i);
	});

	it("tidies whitespace and line breaks before sending", async () => {
		const { run, send } = setup();
		await run("  too   many\n\n spaces\t here  ");
		expect(send.mock.calls[0]?.[0].message).toBe("too many spaces here");
	});

	it("never logs the message, only its length and who sent it", async () => {
		const { run, logged } = setup();
		await run("my secret feedback about a private matter");
		expect(logged).toEqual([{ event: "feedback.sent", length: 41 }]);
		expect(JSON.stringify(logged)).not.toContain("secret");
	});

	describe("refuses", () => {
		it.each([
			["nothing", ""],
			["only spaces", "     "],
			["too little", "hi"],
		])("%s", async (_label, message) => {
			const { run, send } = setup();
			await expect(run(message)).rejects.toThrow(/a little more/);
			expect(send).not.toHaveBeenCalled();
		});

		it("a message that is too long, counting characters not bytes", async () => {
			const { run, send } = setup();
			await expect(run("x".repeat(MAX_FEEDBACK_LENGTH + 1))).rejects.toThrow(/keep it to 1000/);
			await expect(run("é".repeat(MAX_FEEDBACK_LENGTH + 1))).rejects.toThrow(/keep it to 1000/);
			expect(send).not.toHaveBeenCalled();
			await run("é".repeat(MAX_FEEDBACK_LENGTH));
			expect(send).toHaveBeenCalledTimes(1);
		});

		it("accepts the shortest and longest allowed", async () => {
			const { run, send } = setup();
			await run("x".repeat(MIN_FEEDBACK_LENGTH));
			await run("y".repeat(MAX_FEEDBACK_LENGTH));
			expect(send).toHaveBeenCalledTimes(2);
		});
	});

	describe("rate limiting", () => {
		const tight = () => new RateLimiter({ capacity: 2, refillPerSecond: 0, now: () => 0 });

		it("stops one person after a few messages, without sending more", async () => {
			const { run, send } = setup({ limiter: tight() });
			await run("first piece of feedback");
			await run("second piece of feedback");
			await expect(run("third piece of feedback")).rejects.toThrow(/a few messages already/);
			expect(send).toHaveBeenCalledTimes(2);
		});

		it("limits each person separately", async () => {
			const { run, send } = setup({ limiter: tight() });
			const other = principal("friend", { userId: IDS.friend });
			await run("hi", principal("guest")).catch(() => {});
			await run("first piece of feedback");
			await run("second piece of feedback");
			await expect(run("third piece of feedback")).rejects.toThrow();
			await run("feedback from someone else", other);
			expect(send).toHaveBeenLastCalledWith(
				expect.objectContaining({ message: "feedback from someone else" }),
			);
		});

		it("doesn't count a message that was refused for its length", async () => {
			const { run, send } = setup({ limiter: tight() });
			for (let i = 0; i < 5; i++) await run("hi").catch(() => {});
			await run("a real piece of feedback");
			expect(send).toHaveBeenCalledTimes(1);
		});

		it("has a sensible default: a few at once", async () => {
			const { run, send } = setup();
			for (let i = 0; i < 3; i++) await run(`feedback number ${i}`);
			await expect(run("one more than allowed")).rejects.toThrow(/a few messages already/);
			expect(send).toHaveBeenCalledTimes(3);
		});
	});

	it("says so, rather than pretending, when there is nowhere to send it", async () => {
		const { run } = setup({ send: () => false });
		await expect(run("this goes nowhere at all")).rejects.toThrow(
			"Feedback isn't set up right now, sorry.",
		);
	});
});
