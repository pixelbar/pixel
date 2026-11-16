/**
 * Formatting helpers for parking spot names. Spot names are always shown quoted and
 * in bold, so they stand out from surrounding text (issue #219). Names can contain
 * spaces, capitals and punctuation, so unquoted names like "pixelbar" or "by the bins"
 * would blend into sentences like "pixelbar is open" (the space or the parking spot?).
 */

/**
 * Formats a parking spot name for display: bold and double-quoted, like **"pixelbar"**.
 * Names that contain double quotes are shown with escaped quotes so the meaning stays clear.
 */
export function formatSpotName(name: string): string {
	const escaped = name.replaceAll('"', '\\"');
	return `**"${escaped}"**`;
}
