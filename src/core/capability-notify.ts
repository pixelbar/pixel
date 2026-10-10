import { actorLogFields, type PlatformActor } from "./access.ts";
import type { CapabilityRegistry } from "./capabilities.ts";
import type { Logger } from "./logger.ts";
import type { DirectMessenger } from "./ports/direct-message.ts";

/**
 * Tells someone when their capabilities change. The access store calls this
 * after a successful apply; a platform adapter plugs in a messenger once it's
 * connected. A missing messenger or a failed send never fails the change.
 */

export type CapabilityDiff = {
	readonly granted: readonly string[];
	readonly revoked: readonly string[];
};

export function capabilityDiff(
	before: readonly string[],
	after: readonly string[],
): CapabilityDiff {
	const previous = new Set(before);
	const next = new Set(after);
	return {
		granted: after.filter((name) => !previous.has(name)),
		revoked: before.filter((name) => !next.has(name)),
	};
}

/** English DM body, or `null` when nothing changed. Names come from code, not people. */
export function capabilityChangeText(
	diff: CapabilityDiff,
	label: (name: string) => string = (name) => `**${name}**`,
): string | null {
	const parts: string[] = [];
	const [granted] = diff.granted;
	if (diff.granted.length === 1 && granted) {
		parts.push(`Pixel granted you the ${label(granted)} capability.`);
	} else if (diff.granted.length > 1) {
		parts.push(
			`Pixel granted you these capabilities:\n${diff.granted.map((name) => `• ${label(name)}`).join("\n")}`,
		);
	}
	const [revoked] = diff.revoked;
	if (diff.revoked.length === 1 && revoked) {
		parts.push(`Pixel revoked your ${label(revoked)} capability.`);
	} else if (diff.revoked.length > 1) {
		parts.push(
			`Pixel revoked these capabilities:\n${diff.revoked.map((name) => `• ${label(name)}`).join("\n")}`,
		);
	}
	return parts.length === 0 ? null : parts.join("\n\n");
}

export function capabilityLabel(
	name: string,
	capabilities: Pick<CapabilityRegistry, "get">,
): string {
	const description = capabilities.get(name)?.description;
	return description ? `**${name}** (${description})` : `**${name}**`;
}

export type CapabilityNotifierOptions = {
	logger: Logger;
	capabilities?: Pick<CapabilityRegistry, "get">;
};

export class CapabilityNotifier {
	readonly #logger: Logger;
	readonly #label: (name: string) => string;
	#messenger: DirectMessenger | undefined;

	constructor({ logger, capabilities }: CapabilityNotifierOptions) {
		this.#logger = logger.child({ component: "capability-notify" });
		this.#label = capabilities
			? (name) => capabilityLabel(name, capabilities)
			: (name) => `**${name}**`;
	}

	/** A platform adapter plugs its messenger in once it's connected. */
	attach(messenger: DirectMessenger): void {
		this.#messenger = messenger;
	}

	/**
	 * DMs `userId` when `before` and `after` differ. Swallows send failures
	 * (logs them with who changed what, never the message text).
	 */
	async notify(
		userId: string,
		before: readonly string[],
		after: readonly string[],
		by: PlatformActor,
	): Promise<void> {
		const diff = capabilityDiff(before, after);
		const text = capabilityChangeText(diff, this.#label);
		if (!text || !this.#messenger) return;
		try {
			await this.#messenger.send(userId, text);
			this.#logger.info(
				{
					event: "capability.dm_sent",
					...actorLogFields(by),
					target: `discord:${userId}`,
					granted: diff.granted,
					revoked: diff.revoked,
				},
				"notified about a capability change",
			);
		} catch (error) {
			this.#logger.warn(
				{
					event: "capability.dm_failed",
					...actorLogFields(by),
					target: `discord:${userId}`,
					err: error,
				},
				"couldn't send a capability-change DM",
			);
		}
	}
}
