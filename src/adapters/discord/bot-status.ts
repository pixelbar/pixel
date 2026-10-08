import type { APIEmbed, APIEmbedField } from "discord.js";
import type { BotStatusAnnouncement, BuildInfo, Publisher } from "../../core/announcement.ts";
import { formatDuration, inlineCode } from "../../core/format.ts";
import type { Logger } from "../../core/logger.ts";
import type { AnnouncementChannel, OwnPost } from "./announce-publishers.ts";
import type { AnnouncementPost } from "./announce-render.ts";
import type { LivePostStore } from "./announce-state.ts";
import { accentColor } from "./render.ts";

/**
 * Pixel saying it's online or offline, in a Discord channel.
 *
 * - **Coming online** is a new post every time, so every start (a deploy, a restart)
 *   shows up, and the channel reads as a history of runs.
 * - **Going offline** edits that run's post, so each run is one message and the
 *   newest one always says how Pixel is right now.
 * - **A crash** can't post anything. The next start finds the old post still
 *   saying online and corrects it to "stopped unexpectedly".
 *
 * Pixel finds its posts the way the live space post does: the message ID it
 * remembered, then its own recent messages with the online title and footer.
 */

export const BOT_STATUS_PUBLISHER_ID = "discord:bot-status";
export const BOT_ONLINE_TITLE = "🟢 Pixel is online";
export const BOT_OFFLINE_TITLE = "🔴 Pixel is offline";
export const BOT_CRASHED_TITLE = "⚠️ Pixel stopped unexpectedly";
/** Marks a post as Pixel's own online post, so it can be found again. */
export const BOT_ONLINE_FOOTER = "This post updates when Pixel goes offline";

const RECENT_POSTS = 50;
/** Branches that don't need naming: what's normally deployed. */
const MAIN_BRANCHES = new Set(["main", "master"]);

const stamp = (date: Date, style: "f" | "t" | "R"): string =>
	`<t:${Math.floor(date.getTime() / 1000)}:${style}>`;

const post = (embed: APIEmbed): AnnouncementPost => ({
	embeds: [embed],
	allowedMentions: { parse: [] },
});

/** Version, commit, Where, and (when it isn't main) branch, plus the environment when it isn't prod. */
export function buildFields(build: BuildInfo): APIEmbedField[] {
	const fields: APIEmbedField[] = [
		{ name: "Version", value: inlineCode(build.version, 40), inline: true },
	];
	if (build.commit)
		fields.push({ name: "Commit", value: inlineCode(build.commit, 40), inline: true });
	if (build.branch && !MAIN_BRANCHES.has(build.branch)) {
		fields.push({ name: "Branch", value: inlineCode(build.branch, 100), inline: true });
	}
	if (build.env !== "prod") fields.push({ name: "Environment", value: build.env, inline: true });
	fields.push({ name: "Where", value: build.runtime, inline: true });
	return fields;
}

export function onlinePost(announcement: BotStatusAnnouncement): AnnouncementPost {
	const checks = announcement.checks.map(
		(check) => `${check.state === "ok" ? "✅" : "⚠️"} ${check.name}: ${check.detail}`,
	);
	return post({
		title: BOT_ONLINE_TITLE,
		description: `Online since ${stamp(announcement.startedAt, "f")} (${stamp(announcement.startedAt, "R")})`,
		fields: [
			...buildFields(announcement.build),
			...(checks.length > 0 ? [{ name: "Status", value: checks.join("\n") }] : []),
		],
		color: accentColor("positive"),
		timestamp: announcement.startedAt.toISOString(),
		footer: { text: BOT_ONLINE_FOOTER },
	});
}

export function offlinePost(announcement: BotStatusAnnouncement): AnnouncementPost {
	const { startedAt, at, reason } = announcement;
	const ran = formatDuration(at.getTime() - startedAt.getTime());
	return post({
		title: BOT_OFFLINE_TITLE,
		description: [
			`Was online from ${stamp(startedAt, "f")} to ${stamp(at, "t")} (${ran}).`,
			reason ? `Reason: ${reason}.` : undefined,
		]
			.filter(Boolean)
			.join("\n"),
		fields: buildFields(announcement.build),
		color: accentColor("negative"),
		timestamp: at.toISOString(),
	});
}

/** What an online post becomes when Pixel finds it after a crash. */
export function crashedPost(startedAt: Date | null): AnnouncementPost {
	return post({
		title: BOT_CRASHED_TITLE,
		description: startedAt
			? `Was online from ${stamp(startedAt, "f")}. It stopped without saying goodbye, so when isn't known.`
			: "It stopped without saying goodbye, so when isn't known.",
		color: accentColor("warning"),
	});
}

export function createBotStatusPublisher(
	channel: AnnouncementChannel,
	logger: Logger,
	store?: LivePostStore,
): Publisher {
	const log = logger.child({ publisher: BOT_STATUS_PUBLISHER_ID });
	const isOnline = (p: OwnPost) => p.title === BOT_ONLINE_TITLE && p.footer === BOT_ONLINE_FOOTER;

	async function onlinePosts(): Promise<OwnPost[]> {
		const posts = new Map<string, OwnPost>();
		try {
			const id = store?.load();
			const remembered = id ? await channel.findOwnPost(id) : undefined;
			if (remembered && isOnline(remembered)) posts.set(remembered.id, remembered);
		} catch (error) {
			log.warn(
				{ event: "announcer.bot_hint_failed", err: error },
				"couldn't use the remembered post",
			);
		}
		try {
			for (const p of await channel.recentOwnPosts(RECENT_POSTS))
				if (isOnline(p)) posts.set(p.id, p);
		} catch (error) {
			log.warn({ event: "announcer.bot_history_failed", err: error }, "couldn't read recent posts");
		}
		return [...posts.values()].sort(
			(a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0),
		);
	}

	function remember(id: string | undefined): void {
		try {
			store?.save(id);
		} catch (error) {
			log.warn({ event: "announcer.bot_state_failed", err: error }, "couldn't remember the post");
		}
	}

	async function edit(id: string, next: AnnouncementPost): Promise<boolean> {
		try {
			await channel.edit(id, next);
			return true;
		} catch (error) {
			log.warn({ event: "announcer.bot_edit_failed", err: error }, "couldn't update a status post");
			return false;
		}
	}

	return {
		id: BOT_STATUS_PUBLISHER_ID,
		async publish(announcement) {
			if (announcement.kind !== "bot.status") return;
			const online = await onlinePosts();
			if (announcement.phase === "up") {
				// Anything still saying online belongs to a run that never said goodbye.
				for (const stale of online) await edit(stale.id, crashedPost(stale.timestamp));
				const sent = await channel.send(onlinePost(announcement));
				remember(sent.id);
				return;
			}
			const [current, ...older] = online;
			const updated = current ? await edit(current.id, offlinePost(announcement)) : false;
			for (const stale of older) await edit(stale.id, crashedPost(stale.timestamp));
			remember(undefined);
			// Nothing to update (the online post failed or was deleted): say it in a new post.
			if (!updated) await channel.send(offlinePost(announcement));
		},
	};
}
