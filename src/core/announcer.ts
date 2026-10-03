import type { Announcement, Publisher, SpaceSnapshot } from "./announcement.ts";
import type { Logger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

export type AnnouncerDeps = {
	logger: Logger;
	reporter: ErrorReporter;
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

	/** Ids of the registered publishers. */
	get publisherIds(): string[] {
		return [...this.#publishers.keys()];
	}

	announce(announcement: Announcement): Promise<void> {
		return this.#run("publish", (publisher) => publisher.publish(announcement), announcement.kind);
	}

	reconcile(snapshot: SpaceSnapshot): Promise<void> {
		return this.#run("reconcile", (publisher) => publisher.reconcile?.(snapshot), "space.status");
	}

	#run(
		action: "publish" | "reconcile",
		call: (publisher: Publisher) => Promise<void> | undefined,
		kind: string,
	): Promise<void> {
		const next = this.#queue.then(async () => {
			await Promise.all(
				[...this.#publishers.values()].map(async (publisher) => {
					try {
						await call(publisher);
						this.#logger.info(
							{ event: `announcer.${action}`, publisher: publisher.id, kind },
							action === "publish" ? "announced" : "reconciled",
						);
					} catch (error) {
						this.#logger.error(
							{ event: `announcer.${action}_failed`, publisher: publisher.id, kind, err: error },
							`publisher failed to ${action}`,
						);
						this.#reporter.captureBackground(error, `announcer:${publisher.id}`);
					}
				}),
			);
		});
		// Keep the queue alive whatever happens, so one bad call can't wedge later ones.
		this.#queue = next.catch(() => {});
		return next;
	}
}
