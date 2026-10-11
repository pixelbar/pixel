import type { ChannelPost } from "./channel-posts.ts";

/**
 * Fills `{{tokens}}` in user-set posts at **post time**. Features call
 * `interpolate` right before send. This is not the `/info` load-time
 * placeholders (`services/info-content.ts`): those fail startup on an unknown
 * name. Here an unknown `{{name}}` is left as written.
 *
 * No expressions, no JS eval, no secrets, no user-defined functions. Add a
 * later token (space state, a Home Assistant device, …) by `register`ing a
 * provider — do not grow an if/else in each feature.
 */

export type TokenContext = {
	now: Date;
	timezone: string;
};

export type TokenProvider = {
	name: string;
	resolve(ctx: TokenContext): string;
};

/** The slice features need: fill tokens in a user-set body at post time. */
export type Interpolate = Pick<Interpolator, "interpolate">;

export class InterpolateError extends Error {
	override name = "InterpolateError";
}

/** A well-formed `{{name}}`, with optional spaces around the name. */
const TOKEN = /\{\{([^{}]*)\}\}/g;

/** Token names are simple identifiers so `{{date + 1}}` can never run. */
const TOKEN_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Registry of named token providers plus the fill-in step. Built with
 * `createInterpolator` (date family included) or empty for tests.
 */
export class Interpolator {
	readonly #tokens = new Map<string, TokenProvider>();
	readonly #timezone: string;
	readonly #now: () => Date;

	constructor(options: {
		timezone: string;
		now?: () => Date;
		tokens?: readonly TokenProvider[];
	}) {
		this.#timezone = options.timezone;
		this.#now = options.now ?? (() => new Date());
		for (const token of options.tokens ?? []) this.register(token);
	}

	/** Add a named token. Duplicate names and invalid identifiers fail closed. */
	register(provider: TokenProvider): void {
		if (!TOKEN_NAME.test(provider.name)) {
			throw new InterpolateError(
				`Token name ${JSON.stringify(provider.name)} isn't a simple identifier`,
			);
		}
		if (this.#tokens.has(provider.name)) {
			throw new InterpolateError(`Token ${provider.name} is already registered`);
		}
		this.#tokens.set(provider.name, provider);
	}

	/** Names currently registered, in registration order. For tests and docs. */
	names(): string[] {
		return [...this.#tokens.keys()];
	}

	/**
	 * Replaces each known `{{name}}` with that token's value at `at` (or `now`).
	 * Unknown tokens, empty `{{}}`, and anything that isn't a registered name
	 * stay as written. Never logs the template or the result.
	 */
	interpolate(template: string, at?: Date): string {
		const ctx: TokenContext = { now: at ?? this.#now(), timezone: this.#timezone };
		return template.replace(TOKEN, (whole, inner: string) => {
			const name = inner.trim();
			const provider = this.#tokens.get(name);
			if (!provider) return whole;
			return provider.resolve(ctx);
		});
	}
}

/** Pieces of a wall-clock moment in `timezone`, in English. */
function dateParts(now: Date, timezone: string) {
	const found = new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	}).formatToParts(now);
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		found.find((part) => part.type === type)?.value ?? "";
	return {
		weekday: get("weekday"),
		day: get("day"),
		month: get("month"),
		year: get("year"),
		hour: get("hour"),
		minute: get("minute"),
		zone: get("timeZoneName"),
	};
}

/**
 * The built-in date family. Evaluated at post time in `PIXEL_TIMEZONE`.
 *
 * | Token | Example (Sunday 11 October 2026, 06:54 CEST) |
 * |---|---|
 * | `{{date}}` | 11 October 2026 |
 * | `{{day}}` | Sunday |
 * | `{{month}}` | October |
 * | `{{year}}` | 2026 |
 * | `{{dateWithTime}}` | 11 October 2026, 06:54 CEST |
 */
export function dateTokens(): TokenProvider[] {
	return [
		{
			name: "date",
			resolve: (ctx) => {
				const p = dateParts(ctx.now, ctx.timezone);
				return `${p.day} ${p.month} ${p.year}`;
			},
		},
		{
			name: "day",
			resolve: (ctx) => dateParts(ctx.now, ctx.timezone).weekday,
		},
		{
			name: "month",
			resolve: (ctx) => dateParts(ctx.now, ctx.timezone).month,
		},
		{
			name: "year",
			resolve: (ctx) => dateParts(ctx.now, ctx.timezone).year,
		},
		{
			name: "dateWithTime",
			resolve: (ctx) => {
				const p = dateParts(ctx.now, ctx.timezone);
				return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${p.zone}`;
			},
		},
	];
}

/** Interpolator with the date family. Register further tokens on the result. */
export function createInterpolator(options: { timezone: string; now?: () => Date }): Interpolator {
	return new Interpolator({ ...options, tokens: dateTokens() });
}

/** Fills tokens in every user-set field of a scheduled post. */
export function interpolateChannelPost(
	post: ChannelPost,
	interpolate: (text: string) => string,
): ChannelPost {
	if (post.kind === "message") {
		return { ...post, text: interpolate(post.text) };
	}
	return {
		...post,
		question: interpolate(post.question),
		answers: post.answers.map((answer) => interpolate(answer)),
	};
}
