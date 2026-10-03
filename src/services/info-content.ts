import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The topics `/info` can answer, loaded from markdown files (one per topic,
 * e.g. content/info/membership.md). A file starts with a small YAML block:
 *
 *     ---
 *     title: Becoming a member
 *     summary: Member and Friend memberships, what they cost and how to join
 *     order: 10        # optional; lower comes first (default 100)
 *     ---
 *     The text of the answer, in markdown…
 *
 * The file name is the topic's ID (lowercase letters, digits and dashes).
 *
 * Everything is checked at startup and Pixel refuses to start if anything is
 * wrong, listing every problem at once. CI loads the real content too, so a
 * broken edit can't be merged.
 *
 * This content is committed to a PUBLIC repository: never put secrets or
 * personal data in it.
 */

export type InfoTopic = {
	id: string;
	title: string;
	summary: string;
	body: string;
};

export class InfoContentError extends Error {
	override name = "InfoContentError";
}

/** Discord allows at most 25 choices for a command option. */
export const MAX_TOPICS = 25;

/** A Discord embed description holds 4096 characters; leave a little room. */
export const MAX_BODY_LENGTH = 4000;

const MAX_ID_LENGTH = 32;
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DEFAULT_ORDER = 100;

const frontMatterSchema = z.strictObject({
	title: z.string().trim().min(1).max(80),
	summary: z.string().trim().min(1).max(120),
	order: z.number().int().min(0).max(999).optional(),
});

type Loaded = InfoTopic & { order: number };

/**
 * Values that topic text can refer to as `{{name}}`, filled in when the topics
 * are loaded. They let the same reviewed text work in every environment, for
 * example by pointing at that server's own channel.
 */
export type InfoVariables = Readonly<Record<string, string>>;

/**
 * The placeholders topics can use:
 * - `{{announcements-channel}}`: the channel where announcements and the
 *   weekly poll are posted. A clickable channel link in Discord when
 *   `announcementsChannelId` is set, and the plain words "the announcements
 *   channel" otherwise.
 */
export function infoVariables(options: {
	announcementsChannelId?: string | undefined;
}): InfoVariables {
	return {
		"announcements-channel": options.announcementsChannelId
			? `<#${options.announcementsChannelId}>`
			: "the announcements channel",
	};
}

/** Loads and validates every topic in `dir`, ordered by `order` and then by ID. */
export function loadInfoTopics(dir: string, variables: InfoVariables = {}): InfoTopic[] {
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
		throw new InfoContentError(`Invalid info content: cannot read ${dir} (${code})`);
	}

	const problems: string[] = [];
	const loaded: Loaded[] = [];
	for (const file of files) {
		const result = parseTopic(file, readFileSync(join(dir, file), "utf8"), variables);
		if ("problems" in result) problems.push(...result.problems.map((p) => `${file}: ${p}`));
		else loaded.push(result.topic);
	}

	if (files.length === 0) problems.push(`${dir} has no .md files`);
	if (files.length > MAX_TOPICS) {
		problems.push(`${files.length} topics is too many; Discord allows at most ${MAX_TOPICS}`);
	}
	if (problems.length > 0) {
		throw new InfoContentError(
			`Invalid info content:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
		);
	}

	return loaded
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
		.map(({ order: _order, ...topic }) => topic);
}

function parseTopic(
	file: string,
	source: string,
	variables: InfoVariables,
): { topic: Loaded } | { problems: string[] } {
	const problems: string[] = [];

	const id = file.slice(0, -".md".length);
	if (!ID_PATTERN.test(id) || id.length > MAX_ID_LENGTH) {
		problems.push(
			`the file name must be lowercase letters, digits and dashes, up to ${MAX_ID_LENGTH} characters (for example "membership.md")`,
		);
	}

	const text = source.replace(/\r\n/g, "\n");
	const match = /^---\n(?:([\s\S]*?)\n)?---(?:\n|$)([\s\S]*)$/.exec(text);
	if (!match) {
		problems.push("must start with a --- block giving the title and summary");
		return { problems };
	}

	let data: unknown;
	try {
		data = parse(match[1] ?? "");
	} catch {
		problems.push("the --- block at the top isn't valid YAML");
		return { problems };
	}
	const front = frontMatterSchema.safeParse(data);
	if (!front.success) {
		for (const issue of front.error.issues) {
			problems.push(`${issue.path.join(".") || "the --- block"}: ${issue.message}`);
		}
	}

	// Fill in {{placeholders}} first, so the length limit applies to the text people will see.
	const body = fillPlaceholders((match[2] ?? "").trim(), variables, problems);
	if (body.length === 0) problems.push("has no text after the --- block");
	else if (body.length > MAX_BODY_LENGTH) {
		problems.push(`the text is ${body.length} characters; the limit is ${MAX_BODY_LENGTH}`);
	}

	if (problems.length > 0 || !front.success) return { problems };
	const { title, summary, order } = front.data;
	return { topic: { id, title, summary, body, order: order ?? DEFAULT_ORDER } };
}

/**
 * Replaces `{{name}}` with the variable's value. A name that isn't a known
 * variable, or a stray `{{` or `}}`, is a problem, so a typo can't slip into a
 * reply as literal text.
 */
function fillPlaceholders(text: string, variables: InfoVariables, problems: string[]): string {
	const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

	// Once every well-formed {{…}} is out of the way, any brace pair left over is a typo.
	if (/\{\{|\}\}/.test(text.replace(PLACEHOLDER, ""))) {
		problems.push("has a stray {{ or }}; placeholders look like {{announcements-channel}}");
	}

	return text.replace(PLACEHOLDER, (whole, inner: string) => {
		const name = inner.trim();
		// hasOwn, so a name like "constructor" can't pick up an inherited property.
		if (Object.hasOwn(variables, name)) return variables[name] ?? whole;
		const known = Object.keys(variables)
			.map((key) => `{{${key}}}`)
			.join(", ");
		problems.push(`${whole} isn't a known placeholder${known ? ` (known: ${known})` : ""}`);
		return whole;
	});
}
