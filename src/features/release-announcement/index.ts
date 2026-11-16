import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { BuildInfo, ReleaseAnnouncement } from "../../core/announcement.ts";
import type { Announcer } from "../../core/announcer.ts";
import type { Feature } from "../../core/feature.ts";
import type { Logger } from "../../core/logger.ts";

export type ReleaseAnnouncementDeps = {
	announcer: Pick<Announcer, "announce">;
	build: BuildInfo;
	logger: Logger;
	changelogFile?: string;
	stateFile?: string;
	now?: () => Date;
};

type LastAnnounced = {
	version: string;
	at: string;
};

const CHANGELOG_FILE = "CHANGELOG.md";
const STATE_FILE = "release-announced.yaml";
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}\s*$/;

/**
 * Extracts the changelog notes for a specific version from the full changelog.
 * Returns undefined if the version isn't found.
 */
function extractVersionNotes(changelog: string, version: string): string | undefined {
	const lines = changelog.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i += 1) {
		const heading = VERSION_HEADING.exec(lines[i] ?? "");
		if (heading?.[1] === version) {
			start = i + 1;
			break;
		}
	}
	if (start === -1) return undefined;
	let end = lines.length;
	for (let i = start; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (line.startsWith("## [") || /^\[unreleased\]:/i.test(line)) {
			end = i;
			break;
		}
	}
	const body = lines.slice(start, end).join("\n").trim();
	return body === "" ? undefined : body;
}

/**
 * Announces a new Pixel release with its changelog entries. Posts once per
 * version on startup, so restarts and rolling deploys don't announce again.
 * The last announced version is kept in `data/release-announced.yaml`.
 */
export function createReleaseAnnouncementFeature(deps: ReleaseAnnouncementDeps): Feature {
	const log = deps.logger.child({ component: "release-announcement" });
	const now = deps.now ?? (() => new Date());
	const changelogFile = deps.changelogFile ?? CHANGELOG_FILE;
	const stateFile = deps.stateFile ?? join(deps.build.env === "prod" ? "data" : "data", STATE_FILE);

	async function announceIfNew(): Promise<void> {
		const currentVersion = deps.build.version;

		if (currentVersion === "dev") {
			log.debug({ event: "release.skipped", reason: "dev version" }, "not announcing dev version");
			return;
		}

		const lastAnnounced = readLastAnnounced();
		if (lastAnnounced?.version === currentVersion) {
			log.debug({ event: "release.skipped", version: currentVersion }, "version already announced");
			return;
		}

		let changelog: string;
		try {
			changelog = readFileSync(changelogFile, "utf8");
		} catch (error) {
			log.error(
				{ event: "release.changelog_unreadable", file: changelogFile, err: error },
				"couldn't read changelog",
			);
			return;
		}

		const notes = extractVersionNotes(changelog, currentVersion);
		if (!notes) {
			log.warn(
				{ event: "release.no_notes", version: currentVersion },
				"no changelog entry for this version",
			);
			return;
		}

		const announcement: ReleaseAnnouncement = {
			kind: "release",
			version: currentVersion,
			build: deps.build,
			notes,
			at: now(),
			text: `📣 Pixel ${currentVersion} is now live`,
		};

		try {
			await deps.announcer.announce(announcement);
			writeLastAnnounced({ version: currentVersion, at: now().toISOString() });
			log.info({ event: "release.announced", version: currentVersion }, "announced new release");
		} catch (error) {
			log.error(
				{ event: "release.failed", version: currentVersion, err: error },
				"couldn't announce",
			);
		}
	}

	function readLastAnnounced(): LastAnnounced | undefined {
		try {
			const content = readFileSync(stateFile, "utf8");
			const parsed: unknown = parse(content);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"version" in parsed &&
				"at" in parsed &&
				typeof parsed.version === "string" &&
				typeof parsed.at === "string"
			) {
				return { version: parsed.version, at: parsed.at };
			}
			return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return undefined;
			}
			log.warn(
				{ event: "release.state_unreadable", file: stateFile, err: error },
				"couldn't read last announced version",
			);
			return undefined;
		}
	}

	function writeLastAnnounced(data: LastAnnounced): void {
		try {
			mkdirSync(dirname(stateFile), { recursive: true });
			const header = "# Last announced Pixel release. Written by Pixel.\n";
			writeFileSync(stateFile, header + stringify(data));
		} catch (error) {
			log.error(
				{ event: "release.state_write_failed", file: stateFile, err: error },
				"couldn't save last announced version",
			);
		}
	}

	return {
		name: "release-announcement",
		commands: [],
		actions: [],
		start: () => {
			void announceIfNew();
			return () => {};
		},
	};
}
