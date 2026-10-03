import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, principal } from "../testing/fixtures.ts";
import { createPseudonymizer } from "./pseudonym.ts";

const scope = { setTags: vi.fn(), setUser: vi.fn() };
const captureException = vi.fn();

vi.mock("@sentry/node", () => ({
	withScope: (callback: (s: typeof scope) => void) => callback(scope),
	captureException: (error: unknown) => captureException(error),
}));

const { createSentryReporter } = await import("./sentry-reporter.ts");

describe("createSentryReporter", () => {
	beforeEach(() => vi.clearAllMocks());

	const pseudonymize = createPseudonymizer("k".repeat(32));
	const caller = principal("member", { userId: IDS.member, displayName: "Ada Lovelace" });

	it("captures the error with command, feature, platform and tier tags", () => {
		const error = new Error("boom");
		createSentryReporter(pseudonymize).capture(error, {
			command: "whoami",
			feature: "whoami",
			principal: caller,
		});
		expect(captureException).toHaveBeenCalledWith(error);
		expect(scope.setTags).toHaveBeenCalledWith({
			command: "whoami",
			feature: "whoami",
			platform: "discord",
			tier: "member",
		});
	});

	it("identifies the user only by pseudonym — never raw ID or name", () => {
		createSentryReporter(pseudonymize).capture(new Error("boom"), {
			command: "x",
			feature: "x",
			principal: caller,
		});
		expect(scope.setUser).toHaveBeenCalledWith({ id: pseudonymize(caller) });
		const sent = JSON.stringify([scope.setUser.mock.calls, scope.setTags.mock.calls]);
		expect(sent).not.toContain(IDS.member);
		expect(sent).not.toContain("Ada Lovelace");
	});
});
