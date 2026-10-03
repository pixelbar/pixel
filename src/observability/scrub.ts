/**
 * Redacts secrets and personal identifiers from strings before they leave the
 * process (Sentry events, mainly). Defence in depth: code should not be
 * logging these in the first place.
 */

const PATTERNS: readonly [RegExp, string][] = [
	// Discord bot tokens: base64 user ID . timestamp . HMAC
	[/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,40}/g, "[redacted-token]"],
	// Discord snowflakes (user, guild, channel IDs)
	[/\b\d{17,20}\b/g, "[redacted-id]"],
];

export function scrubString(input: string): string {
	let out = input;
	for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

/** Deep-copies `value`, scrubbing every string inside it. */
export function scrubDeep<T>(value: T, seen = new WeakSet<object>()): T {
	if (typeof value === "string") return scrubString(value) as T;
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => scrubDeep(item, seen)) as T;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = scrubDeep(item, seen);
	return out as T;
}
