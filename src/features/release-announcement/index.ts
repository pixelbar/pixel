import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import type { BuildInfo, ReleaseAnnouncement } from "../../core/announcement.ts";
import type { AnnounceResult, Announcer } from "../../core/announcer.ts";
import type { Feature } from "../../core/feature.ts";
import type { Logger } from "../../core/logger.ts";

export type ReleaseAnnouncementDeps = {
	announcer: Pick<Announcer, "announce" | "publisherIds">;
	build: BuildInfo;
	logger: Logger;
	/**
	 * Where the last-announced version is kept (`PIXEL_DATA_DIR/release-announced.yaml`).
	 * Must be on the persist volume in cloud, or every deploy would announce again.
	 */
	stateFile: string;
	changelogFile?: string;
	now?: () => Date;
};

type LastAnnounced = {
	version: string;
	at: string;
	/**
	 * Publisher ids that have already received this version. Missing means a
	 * legacy whole-version mark (treat every current release publisher as done).
	 */
	publishers?: string[];
};

const CHANGELOG_FILE = "CHANGELOG.md";
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}\s*$/;

/** Whether a publisher id is one that posts release notes. */
export function isReleasePublisher(id: string): boolean {
	return id === "discord:release" || id.startsWith("discord:release:");
}

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
 * version per release channel on startup, so restarts and rolling deploys don't
 * announce again. Progress is kept in `PIXEL_DATA_DIR/release-announced.yaml`
 * (version + publisher ids that already got it), so a channel that failed or
 * wasn't open yet can catch up on the next start without re-posting to ones
 * that already succeeded.
 */
export function createReleaseAnnouncementFeature(deps: ReleaseAnnouncementDeps): Feature {
	const log = deps.logger.child({ component: "release-announcement" });
	const now = deps.now ?? (() => new Date());
	const changelogFile = deps.changelogFile ?? CHANGELOG_FILE;
	const stateFile = deps.stateFile;

	async function announceIfNew(): Promise<void> {
		const currentVersion = deps.build.version;

		if (currentVersion === "dev") {
			log.debug({ event: "release.skipped", reason: "dev version" }, "not announcing dev version");
			return;
		}

		const releasePublishers = deps.announcer.publisherIds.filter(isReleasePublisher);
		if (releasePublishers.length === 0) {
			log.debug(
				{ event: "release.skipped", version: currentVersion, reason: "no release publisher" },
				"no release channel configured",
			);
			return;
		}

		const lastAnnounced = readLastAnnounced();
		const alreadyDone = donePublishers(lastAnnounced, currentVersion);
		if (alreadyDone === "all") {
			log.debug({ event: "release.skipped", version: currentVersion }, "version already announced");
			return;
		}
		const pending = releasePublishers.filter((id) => !alreadyDone.has(id));
		if (pending.length === 0) {
			log.debug(
				{ event: "release.skipped", version: currentVersion },
				"every release channel already has this version",
			);
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

		let result: AnnounceResult;
		try {
			result = await deps.announcer.announce(announcement, { only: pending });
		} catch (error) {
			// Announce is documented never to reject; still don't remember a throw.
			log.error(
				{ event: "release.failed", version: currentVersion, err: error },
				"couldn't announce",
			);
			return;
		}

		const newlyDone = pending.filter((id) => result.ok.includes(id));
		if (newlyDone.length === 0) {
			log.error(
				{ event: "release.failed", version: currentVersion, failed: result.failed },
				"no release publisher succeeded; will try again on the next start",
			);
			return;
		}

		const publishers = [...alreadyDone, ...newlyDone];
		writeLastAnnounced({ version: currentVersion, at: now().toISOString(), publishers });
		if (result.failed > 0) {
			log.warn(
				{
					event: "release.partial",
					version: currentVersion,
					ok: newlyDone,
					failed: result.failed,
				},
				"posted to some release channels; will retry the rest on the next start",
			);
			return;
		}
		log.info(
			{ event: "release.announced", version: currentVersion, publishers },
			"announced new release",
		);
	}

	/**
	 * Publishers already recorded for this version. `"all"` means a legacy
	 * whole-version mark (no per-publisher list).
	 */
	function donePublishers(last: LastAnnounced | undefined, version: string): Set<string> | "all" {
		if (!last || last.version !== version) return new Set();
		if (last.publishers === undefined) return "all";
		return new Set(last.publishers);
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
				const publishers = publishersField(parsed);
				return {
					version: parsed.version,
					at: parsed.at,
					...(publishers ? { publishers } : {}),
				};
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

/** Optional `publishers:` list from the state file; undefined when absent or invalid. */
function publishersField(parsed: object): string[] | undefined {
	if (!("publishers" in parsed) || parsed.publishers === undefined) return undefined;
	if (!Array.isArray(parsed.publishers)) return undefined;
	if (!parsed.publishers.every((id): id is string => typeof id === "string")) return undefined;
	return parsed.publishers;
}
