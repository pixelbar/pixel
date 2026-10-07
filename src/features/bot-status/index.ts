import type { BotStatusAnnouncement, BuildInfo, StatusCheck } from "../../core/announcement.ts";
import type { Announcer } from "../../core/announcer.ts";
import type { Home, HomeStatus } from "../../core/home.ts";
import type { Logger } from "../../core/logger.ts";
import type { SpaceStatus } from "../../services/space-status.ts";

export type BotStatusDeps = {
	announcer: Pick<Announcer, "announce">;
	build: BuildInfo;
	startedAt: Date;
	home: Pick<Home, "status">;
	spaceStatus: Pick<SpaceStatus, "checkNow">;
	logger: Logger;
	now?: () => Date;
};

export type BotStatus = {
	/** Says Pixel is online, with how it's doing. Call once Discord is ready. Never throws. */
	up(): Promise<void>;
	/** Says Pixel is going offline, and why. Call before disconnecting. Never throws. */
	down(reason: string): Promise<void>;
};

/** How long `up` waits for SpaceAPI before saying it couldn't check. */
const CHECK_TIMEOUT_MS = 5000;

/**
 * Pixel's own online and offline announcements. The checks are short and public
 * (they're posted in a channel): whether each part is working, never details.
 */
export function createBotStatus(deps: BotStatusDeps): BotStatus {
	const now = deps.now ?? (() => new Date());
	const log = deps.logger.child({ component: "bot-status" });
	const version = [deps.build.version, deps.build.commit].filter(Boolean).join(" ");

	const announce = async (announcement: BotStatusAnnouncement) => {
		try {
			await deps.announcer.announce(announcement);
		} catch (error) {
			log.error(
				{ event: "bot_status.failed", phase: announcement.phase, err: error },
				"couldn't announce",
			);
		}
	};

	return {
		async up() {
			await announce({
				kind: "bot.status",
				phase: "up",
				build: deps.build,
				startedAt: deps.startedAt,
				at: now(),
				checks: await checks(deps),
				text: `🟢 Pixel ${version} is online`,
			});
		},
		async down(reason) {
			await announce({
				kind: "bot.status",
				phase: "down",
				build: deps.build,
				startedAt: deps.startedAt,
				at: now(),
				checks: [],
				reason,
				text: `🔴 Pixel ${version} is going offline: ${reason}`,
			});
		},
	};
}

/** Discord (connected, or this wouldn't be posted), Home Assistant when set up, and SpaceAPI. */
export async function checks(
	deps: Pick<BotStatusDeps, "home" | "spaceStatus">,
): Promise<StatusCheck[]> {
	const list: StatusCheck[] = [{ name: "Discord", state: "ok", detail: "connected" }];
	const home = homeCheck(deps.home.status());
	if (home) list.push(home);
	list.push(await spaceCheck(deps.spaceStatus));
	return list;
}

function homeCheck(status: HomeStatus): StatusCheck | undefined {
	switch (status.kind) {
		case "unconfigured":
			return undefined;
		case "connected":
			return { name: "Home Assistant", state: "ok", detail: "connected" };
		case "connecting":
		case "reconnecting":
			return { name: "Home Assistant", state: "warn", detail: "not connected yet" };
		case "off":
			return { name: "Home Assistant", state: "warn", detail: "off" };
	}
}

async function spaceCheck(space: Pick<SpaceStatus, "checkNow">): Promise<StatusCheck> {
	let timer: NodeJS.Timeout | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("timed out")), CHECK_TIMEOUT_MS);
		});
		const reading = await Promise.race([space.checkNow(), timeout]);
		return reading.state === "unknown"
			? { name: "SpaceAPI", state: "warn", detail: "reachable, but the state is unknown" }
			: { name: "SpaceAPI", state: "ok", detail: `reachable (Pixelbar is ${reading.state})` };
	} catch {
		return { name: "SpaceAPI", state: "warn", detail: "unreachable" };
	} finally {
		clearTimeout(timer);
	}
}
