import { Client, Events, GatewayIntentBits } from "discord.js";
import { actorLogFields, type PlatformActor } from "../../core/access.ts";
import type { Publisher } from "../../core/announcement.ts";
import type { Announcer } from "../../core/announcer.ts";
import type { Calendar } from "../../core/calendar.ts";
import type { Dispatcher } from "../../core/dispatcher.ts";
import type { Logger } from "../../core/logger.ts";
import type { RoleMirror } from "../../core/role-mirror.ts";
import {
	LIVE_PERMISSIONS,
	openAnnouncementChannel,
	TIMELINE_PERMISSIONS,
} from "./announce-channel.ts";
import {
	type AnnouncementChannel,
	createLivePublisher,
	createTimelinePublisher,
	LIVE_PUBLISHER_ID,
	TIMELINE_PUBLISHER_ID,
} from "./announce-publishers.ts";
import { FileLivePostStore } from "./announce-state.ts";
import { createDiscordCalendarSource } from "./calendar-source.ts";
import {
	createAutocompleteHandler,
	createCommandHandler,
	createGuildGuard,
	discordActor,
} from "./handlers.ts";
import { DiscordRoleMirror, type RoleMapping } from "./role-mirror.ts";

export type DiscordAdapterDeps = {
	token: string;
	guildId: string;
	dispatcher: Dispatcher;
	logger: Logger;
	/** Discord channels that get space announcements. Each is optional; unset means off. */
	announce: { liveChannelId: string | undefined; timelineChannelId: string | undefined };
	/** Where the live style remembers which post is open (`announcements.state`). */
	announceStateFile: string;
	/** Where this adapter's announcement publishers register once they're ready. */
	announcer: Pick<Announcer, "register">;
	/** Where this adapter plugs in the server's scheduled events once it's ready. */
	calendar: Pick<Calendar, "use">;
	/** Where this adapter plugs in the role mirror once it's ready. */
	roles: Pick<RoleMirror, "attach" | "check">;
	/** Which Discord role each tier is mirrored to. Unset tiers aren't mirrored. */
	roleMapping: RoleMapping;
	/** Reports errors that escape the dispatcher (e.g. Discord API failures). */
	reportError: (error: unknown, actor?: PlatformActor) => void;
	/** Called once the client is connected and the announcement publishers are registered. */
	onReady?: () => void;
};

export type DiscordAdapter = {
	start(): Promise<void>;
	stop(): Promise<void>;
	isReady(): boolean;
};

const DEFER_AFTER_MS = 1500;

/**
 * Thin wiring between the discord.js Client and the handlers in handlers.ts,
 * which hold all the logic and are unit-tested.
 */
export function createDiscordAdapter(deps: DiscordAdapterDeps): DiscordAdapter {
	const { guildId, dispatcher, reportError } = deps;
	const logger = deps.logger.child({ adapter: "discord" });
	const handleCommand = createCommandHandler({ guildId, dispatcher, deferAfterMs: DEFER_AFTER_MS });
	const handleAutocomplete = createAutocompleteHandler({ guildId, dispatcher });
	const leaveIfForeign = createGuildGuard({ guildId, logger, reportError });

	const client = new Client({
		// Non-privileged only. See AGENTS.md before adding intents.
		intents: [GatewayIntentBits.Guilds],
		allowedMentions: { parse: [] },
	});

	/** Opens the configured announcement channels and registers a publisher for each usable one. */
	async function registerPublishers(ready: Client<true>): Promise<void> {
		const wanted: {
			id: string;
			channelId: string | undefined;
			required: readonly bigint[];
			create: (channel: AnnouncementChannel, channelId: string) => Publisher;
		}[] = [
			{
				id: LIVE_PUBLISHER_ID,
				channelId: deps.announce.liveChannelId,
				required: LIVE_PERMISSIONS,
				create: (channel, channelId) =>
					createLivePublisher(
						channel,
						logger,
						new FileLivePostStore(deps.announceStateFile, channelId),
					),
			},
			{
				id: TIMELINE_PUBLISHER_ID,
				channelId: deps.announce.timelineChannelId,
				required: TIMELINE_PERMISSIONS,
				create: (channel) => createTimelinePublisher(channel),
			},
		];

		for (const { id, channelId, required, create } of wanted) {
			if (!channelId) continue;
			const opened = await openAnnouncementChannel(ready, { channelId, guildId, required });
			if (opened.ok) {
				deps.announcer.register(create(opened.channel, channelId));
			} else {
				// Announcements for this channel stay off; everything else keeps working.
				logger.error(
					{ event: "discord.announce_disabled", publisher: id, channelId },
					`announcements to ${id} are off: ${opened.problem}`,
				);
				reportError(new Error(`Announcements to ${id} are off: ${opened.problem}`));
			}
		}
		if (!deps.announce.liveChannelId && !deps.announce.timelineChannelId) {
			logger.info({ event: "discord.announce_unset" }, "no announcement channels configured");
		}
	}

	client.once(Events.ClientReady, async (ready) => {
		logger.info(
			{ event: "discord.ready", guilds: ready.guilds.cache.size },
			"connected to Discord",
		);
		await Promise.all(ready.guilds.cache.map(leaveIfForeign));
		deps.calendar.use(createDiscordCalendarSource(ready, guildId));
		// Mirror tiers to roles (Pixel to Discord only), and say plainly what works and what doesn't.
		deps.roles.attach(
			new DiscordRoleMirror({
				rest: ready.rest,
				guildId,
				botId: ready.user.id,
				mapping: deps.roleMapping,
			}),
		);
		await deps.roles.check();
		try {
			await registerPublishers(ready);
		} catch (error) {
			logger.error({ err: error }, "couldn't set up announcements");
			reportError(error);
		}
		deps.onReady?.();
	});
	client.on(Events.GuildCreate, leaveIfForeign);
	client.on(Events.Error, (error) => {
		logger.error({ err: error }, "discord client error");
		reportError(error);
	});

	client.on(Events.InteractionCreate, (interaction) => {
		if (interaction.isAutocomplete()) {
			const displayName = interaction.inCachedGuild() ? interaction.member.displayName : undefined;
			handleAutocomplete(interaction, displayName).catch((error: unknown) => {
				// Typically Discord stopped waiting. Nothing to show the person.
				logger.warn(
					{ err: error, command: interaction.commandName },
					"couldn't answer autocomplete",
				);
			});
			return;
		}
		if (!interaction.isChatInputCommand()) return;
		const displayName = interaction.inCachedGuild() ? interaction.member.displayName : undefined;
		handleCommand(interaction, displayName).catch((error: unknown) => {
			logger.error(
				{
					err: error,
					command: interaction.commandName,
					...actorLogFields(discordActor(interaction.user, displayName)),
				},
				"failed to handle interaction",
			);
			// Name who it happened to, by ID, so the report can be traced.
			reportError(error, discordActor(interaction.user, displayName));
		});
	});

	return {
		async start() {
			await client.login(deps.token);
		},
		async stop() {
			await client.destroy();
		},
		isReady() {
			return client.isReady();
		},
	};
}
