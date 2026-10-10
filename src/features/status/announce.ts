import type { Announcement, SpaceSnapshot } from "../../core/announcement.ts";
import type { Stop } from "../../core/feature.ts";
import { formatDuration } from "../../core/format.ts";
import type { Logger } from "../../core/logger.ts";
import type { SpaceChange, SpaceReading, SpaceStatus } from "../../services/space-status.ts";

/** A change is announced once the new state has been seen on this many polls in a row. */
export const READINGS_TO_CONFIRM = 2;

/** How many extra intervals to keep trying to confirm a change while SpaceAPI is unreachable. */
const MAX_CONFIRM_RETRIES = 10;

export type SpaceAnnouncementsDeps = {
	spaceStatus: Pick<SpaceStatus, "checkNow" | "onChange" | "pollIntervalMs">;
	announcer: {
		announce(announcement: Announcement): Promise<void>;
		reconcile(snapshot: SpaceSnapshot): Promise<void>;
	};
	logger: Logger;
	/** Same send path as `/closing-time`. Called after a confirmed close. Must not throw. */
	onSpaceClosed?: () => Promise<void>;
};

/**
 * Announces when the space opens or closes.
 *
 * - **Never on startup.** The status service only reports changes it saw, so
 *   starting up (or changing while Pixel was down) announces nothing.
 * - **Only once it holds.** A change is announced after the new state has been
 *   seen on {@link READINGS_TO_CONFIRM} polls in a row. If it flips back before
 *   that, nothing is posted, so flicking the switch doesn't flood the channel.
 * - **At most once.** A change is never announced twice, even if every
 *   publisher fails.
 * - At startup, publishers get the current state to correct stale posts
 *   (see `Publisher.reconcile`); that never posts anything new.
 */
export function startSpaceAnnouncements({
	spaceStatus,
	announcer,
	logger: parent,
	onSpaceClosed,
}: SpaceAnnouncementsDeps): Stop {
	const logger = parent.child({ job: "space-announcements" });
	const intervalMs = spaceStatus.pollIntervalMs;

	let stopped = false;
	/** The state the channels presumably show: what we last announced, or the state at startup. */
	let announced: "open" | "closed" | undefined;
	let lastChange: SpaceChange | undefined;
	let confirmRetries = 0;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let reconcileTimer: ReturnType<typeof setTimeout> | undefined;

	/** Runs a step from a timer. A bug in it is logged, never an unhandled rejection. */
	const run = (step: string, work: () => Promise<void>): void => {
		work().catch((error: unknown) => {
			logger.error({ event: "announcements.failed", step, err: error }, "announcement step failed");
		});
	};

	const reconcile = async (): Promise<void> => {
		let reading: SpaceReading | undefined;
		try {
			reading = await spaceStatus.checkNow();
		} catch {
			// SpaceAPI is down. The service already logs and counts that.
		}
		if (stopped) return;
		if (reading && reading.state !== "unknown") {
			announced ??= reading.state;
			await announcer.reconcile({ state: reading.state, since: reading.since });
			return;
		}
		// Not known yet: try again next interval.
		reconcileTimer = setTimeout(() => run("reconcile", reconcile), intervalMs);
	};

	const settle = async (): Promise<void> => {
		let reading: SpaceReading;
		try {
			reading = await spaceStatus.checkNow();
		} catch (error) {
			if (stopped) return;
			if (confirmRetries++ < MAX_CONFIRM_RETRIES) {
				settleTimer = setTimeout(() => run("settle", settle), intervalMs);
			} else {
				logger.warn(
					{ event: "announcements.unconfirmed", err: error },
					"couldn't confirm a change",
				);
			}
			return;
		}
		if (stopped) return;
		if (reading.state === "unknown" || reading.state === announced) {
			logger.info({ event: "announcements.dropped", state: reading.state }, "change didn't hold");
			return;
		}

		const state = reading.state;
		announced = state;
		const change = lastChange?.to === state ? lastChange : undefined;
		const at = change?.at ?? reading.since ?? reading.checkedAt;
		const openedAt = state === "closed" ? (change?.previousSince ?? null) : null;
		await announcer.announce({
			kind: "space.status",
			state,
			at,
			openedAt,
			text: describe(state, at, openedAt),
		});
		if (state === "closed" && onSpaceClosed) {
			try {
				await onSpaceClosed();
			} catch (error) {
				logger.error(
					{ event: "closing_time.failed", err: error },
					"closing-time after space-close failed",
				);
			}
		}
	};

	const unsubscribe = spaceStatus.onChange((change) => {
		announced ??= change.from;
		lastChange = change;
		confirmRetries = 0;
		clearTimeout(settleTimer);
		settleTimer = setTimeout(() => run("settle", settle), (READINGS_TO_CONFIRM - 1) * intervalMs);
	});

	run("reconcile", reconcile);

	return () => {
		stopped = true;
		clearTimeout(settleTimer);
		clearTimeout(reconcileTimer);
		unsubscribe();
	};
}

function describe(state: "open" | "closed", at: Date, openedAt: Date | null): string {
	if (state === "open") return "🟢 Pixelbar is now open";
	const duration = openedAt
		? ` after being open for ${formatDuration(at.getTime() - openedAt.getTime())}`
		: "";
	return `🔴 Pixelbar is now closed${duration}`;
}
