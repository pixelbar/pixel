import type { Publisher } from "../../core/announcement.ts";
import type { Announcer } from "../../core/announcer.ts";
import type { Logger } from "../../core/logger.ts";
import type { OpenedChannel } from "./announce-channel.ts";
import type { AnnouncementChannel } from "./announce-publishers.ts";

/** Something holding announcement channels that couldn't be opened, which it can try again. */
export type Recheckable = {
	/** Whether any channel is waiting to be tried again. */
	hasProblems(): boolean;
	/** Tries every channel that isn't posting again. */
	retry(): Promise<void>;
};

export type RecheckOptions = {
	targets: readonly Recheckable[];
	/** How long to wait after Discord says something changed, so a burst of changes is one recheck. */
	settleMs: number;
	/** How often to try anyway, for changes Discord doesn't tell the bot about (a role given to it). */
	everyMs: number;
	logger: Logger;
	reportError: (error: unknown) => void;
};

/**
 * Tries announcement channels that couldn't be opened again: shortly after Discord
 * says a channel or role changed, and every so often in case it didn't. So fixing a
 * channel's permissions turns its announcements on without a restart.
 */
export class AnnouncementRecheck {
	readonly #options: RecheckOptions;
	readonly #logger: Logger;
	#soon: ReturnType<typeof setTimeout> | undefined;
	#running = false;
	#again = false;

	constructor(options: RecheckOptions) {
		this.#options = options;
		this.#logger = options.logger.child({ component: "announce-recheck" });
	}

	/** Discord says permissions may have changed: try the failing channels again shortly. */
	changed(): void {
		if (!this.#options.targets.some((target) => target.hasProblems())) return;
		clearTimeout(this.#soon);
		this.#soon = setTimeout(() => void this.run(), this.#options.settleMs);
		this.#soon.unref();
	}

	/** Tries every `everyMs` until the returned function stops it. */
	start(): () => void {
		const timer = setInterval(() => void this.run(), this.#options.everyMs);
		timer.unref();
		return () => {
			clearInterval(timer);
			clearTimeout(this.#soon);
		};
	}

	/** Tries the failing channels now. One run at a time: a call during a run makes it go once more. Never throws. */
	async run(): Promise<void> {
		if (this.#running) {
			this.#again = true;
			return;
		}
		this.#running = true;
		try {
			do {
				this.#again = false;
				for (const target of this.#options.targets) {
					if (!target.hasProblems()) continue;
					try {
						await target.retry();
					} catch (error) {
						this.#logger.error(
							{ event: "discord.announce_recheck_failed", err: error },
							"couldn't try the announcement channels again",
						);
						this.#options.reportError(error);
					}
				}
			} while (this.#again);
		} finally {
			this.#running = false;
		}
	}
}

/** An announcement channel set in the environment, such as the bot status channel. */
export type ConfiguredChannel = {
	/** The publisher's id, such as `discord:bot-status`. */
	id: string;
	channelId: string;
	required: readonly bigint[];
	create: (channel: AnnouncementChannel, channelId: string) => Publisher;
};

export type ConfiguredChannelsOptions = {
	channels: readonly ConfiguredChannel[];
	/** Opens a channel and checks the bot can use it. */
	openChannel: (channelId: string, required: readonly bigint[]) => Promise<OpenedChannel>;
	announcer: Pick<Announcer, "register">;
	logger: Logger;
	reportError: (error: unknown) => void;
};

/**
 * The announcement channels set in the environment (bot status, closing time). Each
 * one that opens gets its publisher. One that doesn't stays off with the reason, and
 * `retry` tries it again; everything else keeps working either way.
 */
export class ConfiguredChannels implements Recheckable {
	readonly #options: ConfiguredChannelsOptions;
	/** Why a channel isn't posting, by publisher id. */
	readonly #problems = new Map<string, string>();

	constructor(options: ConfiguredChannelsOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		for (const channel of this.#options.channels) await this.#open(channel);
	}

	hasProblems(): boolean {
		return this.#problems.size > 0;
	}

	async retry(): Promise<void> {
		for (const channel of this.#options.channels) {
			if (this.#problems.has(channel.id)) await this.#open(channel);
		}
	}

	async #open(wanted: ConfiguredChannel): Promise<void> {
		const { id, channelId } = wanted;
		const before = this.#problems.get(id);
		const opened = await this.#options.openChannel(channelId, wanted.required);
		if (opened.ok) {
			this.#problems.delete(id);
			this.#options.announcer.register(wanted.create(opened.channel, channelId));
			if (before) {
				this.#options.logger.info(
					{ event: "discord.announce_enabled", publisher: id, channelId },
					`announcements to ${id} are on again`,
				);
			}
			return;
		}
		this.#problems.set(id, opened.problem);
		// Say it once per problem, not at every retry.
		if (before === opened.problem) return;
		this.#options.logger.error(
			{ event: "discord.announce_disabled", publisher: id, channelId },
			`announcements to ${id} are off: ${opened.problem}`,
		);
		this.#options.reportError(new Error(`Announcements to ${id} are off: ${opened.problem}`));
	}
}
