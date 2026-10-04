import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IDS, principal } from "../testing/fixtures.ts";
import { sentryOptions } from "./sentry-options.ts";
import { createSentryReporter } from "./sentry-reporter.ts";

/**
 * The real Sentry client, with the real options (which turn user info collection off)
 * and a transport that keeps what would have been sent: the Discord ID has to be on
 * every error that can be traced to someone.
 */
const envelopes: unknown[][] = [];
beforeAll(() => {
	Sentry.init({
		...sentryOptions({
			dsn: "https://key@o0.ingest.sentry.io/1",
			environment: "test",
			release: "1",
		}),
		transport: () => ({
			send: async (envelope: unknown[]) => {
				envelopes.push(envelope);
				return {};
			},
			flush: async () => true,
		}),
	});
});
beforeEach(() => {
	envelopes.length = 0;
});
afterAll(async () => {
	await Sentry.close(1000);
});

type SentEvent = { user?: Record<string, string>; tags?: Record<string, string> };
const events = (): SentEvent[] =>
	envelopes.flatMap((envelope) =>
		(envelope[1] as [{ type: string }, SentEvent][])
			.filter(([header]) => header.type === "event")
			.map(([, payload]) => payload),
	);

const caller = principal("member", { userId: IDS.member, displayName: "Ada", handle: "ada_l" });
const user = { id: `discord:${IDS.member}`, username: "ada_l", name: "Ada" };

describe("the Discord ID on Sentry errors", () => {
	it("is on an error from a command, even though user info collection is off", async () => {
		createSentryReporter().capture(new Error("boom"), {
			command: "ha set",
			feature: "home",
			principal: caller,
		});
		await Sentry.flush(1000);
		expect(events()).toHaveLength(1);
		expect(events()[0]?.user).toMatchObject(user);
		expect(events()[0]?.tags).toMatchObject({ command: "ha set", feature: "home", tier: "member" });
	});

	it("is on a background error reported while a command runs, however deep", async () => {
		const reporter = createSentryReporter();
		const deep = async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			reporter.captureBackground(new Error("Home Assistant fell over"), "home-assistant");
		};
		await reporter.withContext?.(
			{ command: "ha set", feature: "home", principal: caller },
			async () => {
				await deep();
			},
		);
		await Sentry.flush(1000);
		expect(events()).toHaveLength(1);
		expect(events()[0]?.user).toMatchObject(user);
		expect(events()[0]?.tags).toMatchObject({
			source: "home-assistant",
			command: "ha set",
			platform: "discord",
		});
	});

	it("keeps two commands running at once apart", async () => {
		const reporter = createSentryReporter();
		const other = principal("friend", { userId: IDS.friend, displayName: "Grace" });
		const slow = (who: typeof caller, ms: number, label: string) =>
			reporter.withContext?.({ command: label, feature: "x", principal: who }, async () => {
				await new Promise((resolve) => setTimeout(resolve, ms));
				reporter.captureBackground(new Error(label), "test");
			});
		await Promise.all([slow(caller, 30, "first"), slow(other, 5, "second")]);
		await Sentry.flush(1000);
		const byTag = Object.fromEntries(events().map((e) => [e.tags?.command, e.user?.id]));
		expect(byTag).toEqual({ first: `discord:${IDS.member}`, second: `discord:${IDS.friend}` });
	});

	it("is not on an error that has nothing to do with a person", async () => {
		createSentryReporter().captureBackground(new Error("SpaceAPI down"), "spaceapi");
		await Sentry.flush(1000);
		expect(events()).toHaveLength(1);
		expect(events()[0]?.user?.id).toBeUndefined();
	});

	it("is not left behind on errors reported after the command is over", async () => {
		const reporter = createSentryReporter();
		await reporter.withContext?.({ command: "x", feature: "x", principal: caller }, async () => {});
		reporter.captureBackground(new Error("later"), "test");
		await Sentry.flush(1000);
		expect(events()[0]?.user?.id).toBeUndefined();
	});

	it("is on a failure handling an interaction, when the adapter says who", async () => {
		createSentryReporter().captureBackground(new Error("interaction failed"), "discord", {
			platform: "discord",
			userId: IDS.member,
			displayName: "Ada",
			handle: "ada_l",
		});
		await Sentry.flush(1000);
		expect(events()[0]?.user).toMatchObject(user);
	});
});
