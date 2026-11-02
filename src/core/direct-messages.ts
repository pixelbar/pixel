import type { DirectMessenger } from "./ports/direct-message.ts";

/**
 * Private messages for features (parking reminders, say), by immutable platform
 * user ID. A platform adapter plugs its messenger in once it's connected; until
 * then, and whenever a send fails, `send` throws. Callers own failures: a DM that
 * can't be sent must never stop what triggered it.
 */
export class DirectMessages implements DirectMessenger {
	#messenger: DirectMessenger | undefined;

	/** The adapter plugs its messenger in once it's ready. */
	attach(messenger: DirectMessenger): void {
		this.#messenger = messenger;
	}

	get ready(): boolean {
		return this.#messenger !== undefined;
	}

	async send(userId: string, text: string): Promise<void> {
		if (!this.#messenger) throw new Error("direct messages aren't connected yet");
		await this.#messenger.send(userId, text);
	}
}
