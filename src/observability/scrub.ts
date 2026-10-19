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
	// Discord REST paths that carry an interaction (or webhook) token, which can post as the bot:
	// `/interactions/<id>/<token>/callback` and `/webhooks/<id>/<token>/...`. Sentry's HTTP spans and
	// breadcrumbs keep the path of every request; the ID stays, the token goes.
	[/(\/(?:interactions|webhooks)\/\d+\/)[^/?#\s"'<>]+/gi, "$1[redacted]"],
];

export function scrubString(input: string): string {
	let out = input;
	for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

/**
 * Deep-copies `value`, scrubbing every string inside it. An object referenced more
 * than once (or in a cycle) is scrubbed once and its copy reused. An `Error` becomes
 * a plain object with its `name`, `message`, `stack`, `cause` and own fields.
 */
export function scrubDeep<T>(value: T): T {
	return scrubValue(value, new WeakMap()) as T;
}

function scrubValue(value: unknown, copies: WeakMap<object, unknown>): unknown {
	if (typeof value === "string") return scrubString(value);
	if (value === null || typeof value !== "object") return value;
	const copied = copies.get(value);
	if (copied !== undefined) return copied;
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		copies.set(value, out);
		for (const item of value) out.push(scrubValue(item, copies));
		return out;
	}
	const out: Record<string, unknown> = {};
	copies.set(value, out);
	if (value instanceof Error) {
		// These are not enumerable, so the loop below would miss them.
		out.name = scrubString(value.name);
		out.message = scrubString(value.message);
		if (value.stack !== undefined) out.stack = scrubString(value.stack);
		if (value.cause !== undefined) out.cause = scrubValue(value.cause, copies);
	}
	for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, copies);
	return out;
}
