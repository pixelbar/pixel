/**
 * Mention detection and permission checking for scheduled posts. Features can
 * schedule any content; this module detects what mention types it contains
 * (@everyone, @here, roles, users) and checks whether the scheduling user may
 * use them in that channel.
 */

/** What mention types are present in text. */
export type DetectedMentions = {
	/** @everyone or @here */
	everyone: boolean;
	/** <@&roleId> */
	roles: boolean;
	/** <@userId> or <@!userId> (deprecated but still recognized) */
	users: boolean;
};

/** Discord mention patterns. */
const EVERYONE_PATTERN = /@(everyone|here)\b/;
const ROLE_MENTION_PATTERN = /<@&\d+>/;
const USER_MENTION_PATTERN = /<@!?\d+>/;

/**
 * Detects which mention types are present in the given text.
 * Returns false for all types when text is empty.
 */
export function detectMentions(text: string): DetectedMentions {
	if (!text) return { everyone: false, roles: false, users: false };
	return {
		everyone: EVERYONE_PATTERN.test(text),
		roles: ROLE_MENTION_PATTERN.test(text),
		users: USER_MENTION_PATTERN.test(text),
	};
}

/**
 * Detects mentions across all text in a post: message text, poll questions,
 * poll answers, attendance poll questions and answer labels.
 */
export function detectPostMentions(post: {
	text?: string;
	question?: string;
	answers?: readonly (string | { label: string })[];
}): DetectedMentions {
	const texts: string[] = [];
	if (post.text) texts.push(post.text);
	if (post.question) texts.push(post.question);
	if (post.answers) {
		for (const answer of post.answers) {
			texts.push(typeof answer === "string" ? answer : answer.label);
		}
	}
	return texts.reduce(
		(acc, text) => {
			const detected = detectMentions(text);
			return {
				everyone: acc.everyone || detected.everyone,
				roles: acc.roles || detected.roles,
				users: acc.users || detected.users,
			};
		},
		{ everyone: false, roles: false, users: false } as DetectedMentions,
	);
}

/**
 * Checks whether the given mentions are allowed based on the caller's
 * permissions in the channel.
 */
export type MentionPermissions = {
	/** Whether they can mention @everyone and @here. */
	canMentionEveryone: boolean;
	/** Whether they can post (required for any mentions). */
	canPost: boolean;
};

export type MentionCheckResult =
	| { ok: true }
	| { ok: false; problem: "cant-post" | "cant-mention-everyone" };

/**
 * Checks whether detected mentions are allowed for a user with the given
 * permissions. Users and roles are allowed when the user can post; @everyone/@here
 * need the specific permission.
 */
export function checkMentionPermissions(
	detected: DetectedMentions,
	permissions: MentionPermissions,
): MentionCheckResult {
	if (!permissions.canPost) return { ok: false, problem: "cant-post" };
	if (detected.everyone && !permissions.canMentionEveryone) {
		return { ok: false, problem: "cant-mention-everyone" };
	}
	// Users and roles are allowed when the user can post.
	return { ok: true };
}

/**
 * Builds Discord's allowedMentions based on what's detected in the text and
 * what's permitted. Someone who can't post pings nobody; someone who can't
 * mention everyone still pings the people and roles they wrote.
 */
export function allowedMentionsFor(
	detected: DetectedMentions,
	permissions: MentionPermissions,
): { parse: ("everyone" | "roles" | "users")[]; repliedUser: boolean } {
	if (!permissions.canPost) return { parse: [], repliedUser: false };

	const parse: ("everyone" | "roles" | "users")[] = [];
	if (detected.everyone && permissions.canMentionEveryone) parse.push("everyone");
	if (detected.roles) parse.push("roles");
	if (detected.users) parse.push("users");

	return { parse, repliedUser: false };
}
