/**
 * Redacts secrets from strings before they leave the process (Sentry events,
 * mainly). Defence in depth: code should not be logging these in the first
 * place. Discord IDs are deliberately NOT redacted — they identify users in
 * Sentry.
 */

const PATTERNS: readonly [RegExp, string][] = [
	// Discord bot tokens: base64 user ID . timestamp . HMAC
	[/[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,40}/g, "[redacted-token]"],
	// Home Assistant long-lived tokens are JWTs: three base64url parts, the first starting "eyJ".
	[/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[redacted-token]"],
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
