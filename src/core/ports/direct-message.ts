/**
 * Sends a private message to one person, by their immutable platform user ID.
 * Implemented by a platform adapter (Discord). The caller owns failures: a
 * closed inbox, a missing user, or a network error must not fail the change
 * that triggered the message.
 */
export type DirectMessenger = {
	/** `userId` is the immutable Discord user ID. Never a name. */
	send(userId: string, text: string): Promise<void>;
};
