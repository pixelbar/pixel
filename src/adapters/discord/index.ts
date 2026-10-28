import { Client, Events, GatewayIntentBits } from "discord.js";
import type { PlatformActor } from "../../core/access.ts";
import type { Publisher } from "../../core/announcement.ts";
import type { AnnouncementRoutes } from "../../core/announcement-routes.ts";
import type { Announcer } from "../../core/announcer.ts";
import type { Calendar } from "../../core/calendar.ts";
import type { CapabilityNotifier } from "../../core/capability-notify.ts";
import type { ChannelPosts } from "../../core/channel-posts.ts";
import type { Dispatcher } from "../../core/dispatcher.ts";
import type { Logger } from "../../core/logger.ts";
import type { RoleMirror } from "../../core/role-mirror.ts";
import {
	LIVE_PERMISSIONS,
	openAnnouncementChannel,
	TIMELINE_PERMISSIONS,
} from "./announce-channel.ts";
import {
	AnnouncementRecheck,
	type ConfiguredChannel,
	ConfiguredChannels,
} from "./announce-recheck.ts";
import { DiscordAnnouncementRoutes, type DiscordRoutesOptions } from "./announce-routes.ts";
import { FileLivePostStore } from "./announce-state.ts";
import type { DiscordOption } from "./args.ts";
import { BOT_STATUS_PUBLISHER_ID, createBotStatusPublisher } from "./bot-status.ts";
import { createDiscordCalendarSource } from "./calendar-source.ts";
import { createDiscordPoster } from "./channel-poster.ts";
import { CLOSING_TIME_PUBLISHER_ID, createClosingTimePublisher } from "./closing-time.ts";
import { DiscordDirectMessenger } from "./direct-message.ts";
import { PendingForms } from "./forms.ts";
import {
	createAutocompleteHandler,
	createCommandHandler,
	createGuildGuard,
	createModalHandler,
	discordActor,
} from "./handlers.ts";
import { handleInteractionFailure } from "./interaction-errors.ts";
import { createPresencePublisher } from "./presence.ts";
import { DiscordRoleMirror, type RoleMapping } from "./role-mirror.ts";

export type DiscordAdapterDeps = {
	token: string;
	guildId: string;
	dispatcher: Dispatcher;
	logger: Logger;
	/**
	 * Discord channels for the other announcements. Each is optional; unset means off.
	 * Open/closed announcements aren't here: admins set those with `/admin announcements`.
	 */
	announce: {
		/** Where Pixel says it's online or offline. */
		botChannelId: string | undefined;
		/** Closing-time reminder. Undefined means off. */
		closingTimeChannelId: string | undefined;
	};
	/** Where the bot status remembers this run's post (`bot-status.state`). */
	botStatusStateFile: string;
	/** Where each admin-set live or single channel remembers its current post. */
	announcementPostsDir: string;
	/** The (style, channel) pairings admins have set with `/admin announcements`. */
	announcementRouteStore: DiscordRoutesOptions["store"];
	/** Where this adapter plugs in running those pairings once it's ready. */
	announcementRoutes: Pick<AnnouncementRoutes, "use">;
	/** Where this adapter's announcement publishers register once they're ready. */
	announcer: Pick<Announcer, "register" | "unregister">;
	/** Where this adapter plugs in the server's scheduled events once it's ready. */
	calendar: Pick<Calendar, "use">;
	/** Where this adapter plugs in posting to channels (scheduled posts) once it's ready. */
	channelPosts: Pick<ChannelPosts, "use">;
	/** Where this adapter plugs in the role mirror once it's ready. */
	roles: Pick<RoleMirror, "attach" | "check">;
	/** Where this adapter plugs in DMs for capability grant/revoke once it's ready. */
	capabilityNotify: Pick<CapabilityNotifier, "attach">;
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
/** After a permission change, wait for the rest of the burst (a category sync updates every channel in it). */
const RECHECK_SETTLE_MS = 5_000;
/** Giving the bot a role sends no event without the GuildMembers intent, so also try this often. */
const RECHECK_EVERY_MS = 5 * 60_000;

/**
 * Thin wiring between the discord.js Client and the handlers in handlers.ts,
 * which hold all the logic and are unit-tested.
 */
export function createDiscordAdapter(deps: DiscordAdapterDeps): DiscordAdapter {
	const { guildId, dispatcher, reportError } = deps;
	const logger = deps.logger.child({ adapter: "discord" });
	const forms = new PendingForms();
	const handleCommand = createCommandHandler({
		guildId,
		dispatcher,
		deferAfterMs: DEFER_AFTER_MS,
		forms,
	});
	const handleModal = createModalHandler({
		guildId,
		dispatcher,
		deferAfterMs: DEFER_AFTER_MS,
		forms,
	});
	const handleAutocomplete = createAutocompleteHandler({ guildId, dispatcher });
	const leaveIfForeign = createGuildGuard({ guildId, logger, reportError });

	const client = new Client({
		// Non-privileged only. See AGENTS.md before adding intents.
		intents: [GatewayIntentBits.Guilds],
		allowedMentions: { parse: [] },
	});

	/** Tries channels that couldn't be opened again; set once the publishers are. */
	let recheck: AnnouncementRecheck | undefined;
	let stopRecheck: (() => void) | undefined;

	/** Opens the configured announcement channels and registers a publisher for each usable one. */
	async function registerPublishers(ready: Client<true>): Promise<void> {
		const wanted: (Omit<ConfiguredChannel, "channelId"> & { channelId: string | undefined })[] = [
			{
				id: BOT_STATUS_PUBLISHER_ID,
				channelId: deps.announce.botChannelId,
				// Reading history lets it find the post to update when Pixel goes offline.
				required: LIVE_PERMISSIONS,
				create: (channel, channelId) =>
					createBotStatusPublisher(
						channel,
						logger,
						new FileLivePostStore(
							deps.botStatusStateFile,
							channelId,
							"# Pixel's record of its online status post. Safe to delete or edit.\n",
						),
					),
			},
			{
				id: CLOSING_TIME_PUBLISHER_ID,
				channelId: deps.announce.closingTimeChannelId,
				required: TIMELINE_PERMISSIONS,
				create: (channel) => createClosingTimePublisher(channel),
			},
		];

		// Open/closed announcements: the channels admins set with /admin announcements. Plugged in
		// first, so `/admin announcements` works even if a channel below can't be opened.
		const routes = new DiscordAnnouncementRoutes({
			store: deps.announcementRouteStore,
			announcer: deps.announcer,
			logger,
			reportError,
			postsDir: deps.announcementPostsDir,
			openChannel: (channelId, required) =>
				openAnnouncementChannel(ready, { channelId, guildId, required }),
		});
		deps.announcementRoutes.use(routes);
		await routes.start();

		const configured = new ConfiguredChannels({
			channels: wanted.flatMap(({ channelId, ...rest }) =>
				channelId ? [{ ...rest, channelId }] : [],
			),
			openChannel: (channelId, required) =>
				openAnnouncementChannel(ready, { channelId, guildId, required }),
			announcer: deps.announcer,
			logger,
			reportError,
		});
		await configured.start();
		// A channel that couldn't be opened is tried again, so fixing its permissions needs no restart.
		recheck = new AnnouncementRecheck({
			targets: [configured, routes],
			settleMs: RECHECK_SETTLE_MS,
			everyMs: RECHECK_EVERY_MS,
			logger,
			reportError,
		});
		stopRecheck = recheck.start();
		// Pixel's own status in the member list follows the space. It needs no channel.
		const presence = createPresencePublisher(ready.user);
		deps.announcer.register(presence);
		// Client options have no presence (the space isn't known at login), and
		// setPresence is not sent on IDENTIFY. After an invalid session, put it back.
		client.on(Events.ShardReady, () => presence.reapply());
		if (deps.announcementRouteStore.list().length === 0) {
			logger.info(
				{ event: "discord.announce_unset" },
				"no open/closed announcement channels set (/admin announcements set)",
			);
		}
	}

	client.once(Events.ClientReady, async (ready) => {
		logger.info(
			{ event: "discord.ready", guilds: ready.guilds.cache.size },
			"connected to Discord",
		);
		await Promise.all(ready.guilds.cache.map(leaveIfForeign));
		deps.calendar.use(createDiscordCalendarSource(ready, guildId));
		deps.channelPosts.use(createDiscordPoster(ready, guildId));
		// Mirror tiers to roles (and let the role sync read them back), and say plainly what works.
		deps.roles.attach(
			new DiscordRoleMirror({
				rest: ready.rest,
				guildId,
				botId: ready.user.id,
				mapping: deps.roleMapping,
			}),
		);
		await deps.roles.check();
		deps.capabilityNotify.attach(new DiscordDirectMessenger(ready.rest));
		try {
			await registerPublishers(ready);
		} catch (error) {
			logger.error({ err: error }, "couldn't set up announcements");
			reportError(error);
		}
		deps.onReady?.();
	});
	client.on(Events.GuildCreate, leaveIfForeign);
	// A channel's or a role's permissions changed: a channel that couldn't be used may work now.
	client.on(Events.ChannelUpdate, (_, channel) => {
		if (!channel.isDMBased() && channel.guildId === guildId) recheck?.changed();
	});
	client.on(Events.GuildRoleUpdate, (_, role) => {
		if (role.guild.id === guildId) recheck?.changed();
	});
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
		if (interaction.isModalSubmit()) {
			handleModal(interaction).catch((error: unknown) => {
				handleInteractionFailure(
					error,
					{ logger, reportError },
					{ actor: discordActor(interaction.user) },
				);
			});
			return;
		}
		if (!interaction.isChatInputCommand()) return;
		const displayName = interaction.inCachedGuild() ? interaction.member.displayName : undefined;
		// For a channel picked in the command: what this person may do there.
		const permissionsIn = (channelId: string): bigint | null => {
			const resolved = interaction.options.resolved?.channels?.get(channelId);
			if (resolved && "permissions" in resolved && typeof resolved.permissions === "string") {
				return BigInt(resolved.permissions);
			}
			if (resolved && interaction.inCachedGuild() && "permissionsFor" in resolved) {
				return resolved.permissionsFor(interaction.member)?.bitfield ?? null;
			}
			return null;
		};
		const withPermissions = (options: readonly DiscordOption[]): DiscordOption[] =>
			options.map((option) => ({
				...option,
				...(option.options ? { options: withPermissions(option.options) } : {}),
				...(option.channel ? { callerPermissions: permissionsIn(option.channel.id) } : {}),
			}));
		const incoming = Object.assign(Object.create(interaction) as typeof interaction, {
			options: {
				...interaction.options,
				data: withPermissions(interaction.options.data as readonly DiscordOption[]),
			},
		});
		handleCommand(incoming, displayName).catch((error: unknown) => {
			handleInteractionFailure(
				error,
				{ logger, reportError },
				{ actor: discordActor(interaction.user, displayName), command: interaction.commandName },
			);
		});
	});

	return {
		async start() {
			await client.login(deps.token);
		},
		async stop() {
			stopRecheck?.();
			await client.destroy();
		},
		isReady() {
			return client.isReady();
		},
	};
}
