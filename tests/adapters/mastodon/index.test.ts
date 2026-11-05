import { describe, expect, it, vi } from "vitest";
import { startMastodonPublisher } from "../../../src/adapters/mastodon/index.ts";
import { MASTODON_PUBLISHER_ID } from "../../../src/adapters/mastodon/publisher.ts";
import { Announcer } from "../../../src/core/announcer.ts";
import { silentLogger } from "../../../src/core/logger.ts";

const mastodon = {
	instanceUrl: "https://mastodon.example",
	token: "test-token",
	account: "pixel@mastodon.example",
	visibility: "public" as const,
	kinds: ["space.status"] as const,
};

describe("startMastodonPublisher", () => {
	it("registers the publisher when instance, token and kinds are set", () => {
		const announcer = new Announcer({
			logger: silentLogger,
			reporter: {
				capture: vi.fn(),
				captureBackground: vi.fn(),
				breadcrumb: vi.fn(),
			},
		});
		startMastodonPublisher({ mastodon, announcer, logger: silentLogger });
		expect(announcer.publisherIds).toEqual([MASTODON_PUBLISHER_ID]);
	});

	it("stays off when Mastodon is unset, so Discord can still run", () => {
		const register = vi.fn();
		startMastodonPublisher({ mastodon: undefined, announcer: { register }, logger: silentLogger });
		expect(register).not.toHaveBeenCalled();
	});

	it("stays off when every kind is turned off", () => {
		const register = vi.fn();
		startMastodonPublisher({
			mastodon: { ...mastodon, kinds: [] },
			announcer: { register },
			logger: silentLogger,
		});
		expect(register).not.toHaveBeenCalled();
	});
});
