import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, principal } from "../testing/fixtures.ts";

const scope = { setUser: vi.fn() };
const captureFeedback = vi.fn();
let hasClient = true;

vi.mock("@sentry/node", () => ({
	getClient: () => (hasClient ? {} : undefined),
	withScope: (callback: (s: typeof scope) => void) => callback(scope),
	captureFeedback: (...args: unknown[]) => captureFeedback(...args),
}));

const { createSentryFeedback } = await import("./sentry-feedback.ts");

describe("createSentryFeedback", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		hasClient = true;
	});

	const from = principal("member", {
		userId: IDS.member,
		displayName: "Ada Lovelace",
		handle: "ada_l",
	});

	it("sends the message as Sentry user feedback, with who it's from", () => {
		expect(createSentryFeedback().send({ message: "Great bot", from })).toBe(true);
		expect(scope.setUser).toHaveBeenCalledWith({
			id: `discord:${IDS.member}`,
			username: "ada_l",
			name: "Ada Lovelace",
		});
		expect(captureFeedback).toHaveBeenCalledWith(
			{
				message: "Great bot",
				name: "Ada Lovelace",
				source: "discord",
				tags: { command: "feedback", platform: "discord", tier: "member" },
			},
			undefined,
			scope,
		);
	});

	it("leaves the handle out when there is none", () => {
		const noHandle = principal("guest", { userId: IDS.guest, displayName: "Guest" });
		createSentryFeedback().send({
			message: "Hello there",
			from: { ...noHandle, handle: undefined as never },
		});
		expect(scope.setUser).toHaveBeenCalledWith({ id: `discord:${IDS.guest}`, name: "Guest" });
	});

	it("redacts anything that looks like a secret, in case someone pastes one", () => {
		const token = `${"A".repeat(26)}.${"B".repeat(6)}.${"C".repeat(38)}`;
		createSentryFeedback().send({ message: `my token is ${token} ok`, from });
		const sent = captureFeedback.mock.calls[0]?.[0] as { message: string };
		expect(sent.message).toBe("my token is [redacted-token] ok");
	});

	it("sends nothing, and says so, when Sentry isn't configured", () => {
		hasClient = false;
		expect(createSentryFeedback().send({ message: "Anyone there?", from })).toBe(false);
		expect(captureFeedback).not.toHaveBeenCalled();
	});
});
