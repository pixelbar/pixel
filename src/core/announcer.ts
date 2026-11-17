import type { Announcement, Publisher, SpaceSnapshot } from "./announcement.ts";
import type { Logger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

export type AnnouncerDeps = {
	logger: Logger;
	reporter: ErrorReporter;
};

/** How an announce or reconcile finished. Failures never reject the promise. */
export type AnnounceResult = {
	/** How many publishers threw. Zero when there were no publishers. */
	failed: number;
};

/**
 * Sends announcements to every registered publisher. Features hand it an
 * announcement and never talk to a platform themselves.
 *
 * - One publisher failing never blocks the others, and never throws: the
 *   failure is logged and reported with the publisher's id.
 * - Calls run one at a time, in order, so a startup `reconcile` can't
 *   interleave with an announcement.
 */
export class Announcer {
	readonly #logger: Logger;
	readonly #reporter: ErrorReporter;
	readonly #publishers = new Map<string, Publisher>();
	#queue: Promise<void> = Promise.resolve();

	constructor({ logger, reporter }: AnnouncerDeps) {
		this.#logger = logger.child({ component: "announcer" });
		this.#reporter = reporter;
	}

	register(publisher: Publisher): void {
		if (this.#publishers.has(publisher.id)) {
			throw new Error(`Duplicate publisher "${publisher.id}"`);
		}
		this.#publishers.set(publisher.id, publisher);
		this.#logger.info(
			{ event: "announcer.registered", publisher: publisher.id },
			"publisher ready",
		);
	}

	/** Stops sending to a publisher. Returns whether it was registered. */
	unregister(id: string): boolean {
		const removed = this.#publishers.delete(id);
		if (removed)
			this.#logger.info({ event: "announcer.unregistered", publisher: id }, "publisher removed");
		return removed;
	}

	/** Ids of the registered publishers. */
	get publisherIds(): string[] {
		return [...this.#publishers.keys()];
	}

	/**
	 * Sends to every publisher. Never throws: failures are counted, logged and
	 * reported. Callers that must know whether anything got through (e.g. release
	 * notes, which are remembered as posted) use `failed`.
	 */
	announce(announcement: Announcement): Promise<AnnounceResult> {
		return this.#run("publish", (publisher) => publisher.publish(announcement), announcement.kind);
	}

	reconcile(snapshot: SpaceSnapshot): Promise<AnnounceResult> {
		return this.#run("reconcile", (publisher) => publisher.reconcile?.(snapshot), "space.status");
	}

	#run(
		action: "publish" | "reconcile",
		call: (publisher: Publisher) => Promise<void> | undefined,
		kind: string,
	): Promise<AnnounceResult> {
		const next = this.#queue.then(async (): Promise<AnnounceResult> => {
			let failed = 0;
			await Promise.all(
				[...this.#publishers.values()].map(async (publisher) => {
					try {
						await call(publisher);
						this.#logger.info(
							{ event: `announcer.${action}`, publisher: publisher.id, kind },
							action === "publish" ? "announced" : "reconciled",
						);
					} catch (error) {
						failed += 1;
						this.#logger.error(
							{ event: `announcer.${action}_failed`, publisher: publisher.id, kind, err: error },
							`publisher failed to ${action}`,
						);
						this.#reporter.captureBackground(error, `announcer:${publisher.id}`);
					}
				}),
			);
			return { failed };
		});
		// Keep the queue alive whatever happens, so one bad call can't wedge later ones.
		this.#queue = next.then(() => {}).catch(() => {});
		return next;
	}
}
