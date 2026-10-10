/**
 * Discord already used this interaction (another handler replied, or Discord
 * dropped it). Typical when two Pixels share one bot token.
 *
 * 40060 = already acknowledged. 10062 = unknown / expired interaction.
 */
export function isConsumedInteractionError(error: unknown): boolean {
	if (error === null || typeof error !== "object" || !("code" in error)) return false;
	const code = error.code;
	return code === 40060 || code === 10062 || code === "40060" || code === "10062";
}
