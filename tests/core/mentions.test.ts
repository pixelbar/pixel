import { describe, expect, it } from "vitest";
import {
	allowedMentionsFor,
	checkMentionPermissions,
	detectMentions,
	detectPostMentions,
} from "../../src/core/mentions.ts";

const NONE = { everyone: false, roles: false, users: false };
const CAN_ALL = { canPost: true, canMentionEveryone: true };
const CAN_POST = { canPost: true, canMentionEveryone: false };
const CANT_POST = { canPost: false, canMentionEveryone: true };

describe("detectMentions", () => {
	it("finds each kind of mention", () => {
		expect(detectMentions("")).toEqual(NONE);
		expect(detectMentions("hello")).toEqual(NONE);
		expect(detectMentions("hi @everyone")).toEqual({ ...NONE, everyone: true });
		expect(detectMentions("hi @here")).toEqual({ ...NONE, everyone: true });
		expect(detectMentions("hi <@&100000000000000003>")).toEqual({ ...NONE, roles: true });
		expect(detectMentions("hi <@100000000000000004>")).toEqual({ ...NONE, users: true });
		expect(detectMentions("hi <@!100000000000000004>")).toEqual({ ...NONE, users: true });
	});

	it("doesn't treat a typed @name as a mention", () => {
		expect(detectMentions("hi @Ada and @everyoneelse")).toEqual(NONE);
	});
});

describe("detectPostMentions", () => {
	it("looks through text, questions and both kinds of answers", () => {
		expect(detectPostMentions({ text: "<@100000000000000004>" }).users).toBe(true);
		expect(detectPostMentions({ question: "@here?", answers: ["a"] }).everyone).toBe(true);
		expect(detectPostMentions({ question: "q", answers: ["<@&100000000000000003>"] }).roles).toBe(
			true,
		);
		expect(
			detectPostMentions({ question: "q", answers: [{ label: "<@100000000000000004>" }] }).users,
		).toBe(true);
		expect(detectPostMentions({})).toEqual(NONE);
	});
});

describe("checkMentionPermissions", () => {
	it("needs posting for anything, and Mention Everyone for @everyone", () => {
		expect(checkMentionPermissions(NONE, CANT_POST)).toEqual({ ok: false, problem: "cant-post" });
		expect(checkMentionPermissions({ ...NONE, everyone: true }, CAN_POST)).toEqual({
			ok: false,
			problem: "cant-mention-everyone",
		});
		expect(checkMentionPermissions({ ...NONE, everyone: true }, CAN_ALL)).toEqual({ ok: true });
		expect(checkMentionPermissions({ ...NONE, users: true, roles: true }, CAN_POST)).toEqual({
			ok: true,
		});
	});
});

describe("allowedMentionsFor", () => {
	const ALL = { everyone: true, roles: true, users: true };

	it("pings only what was written", () => {
		expect(allowedMentionsFor(NONE, CAN_ALL)).toEqual({ parse: [], repliedUser: false });
		expect(allowedMentionsFor({ ...NONE, users: true }, CAN_ALL).parse).toEqual(["users"]);
		expect(allowedMentionsFor(ALL, CAN_ALL).parse).toEqual(["everyone", "roles", "users"]);
	});

	it("still pings people and roles when only @everyone isn't allowed", () => {
		expect(allowedMentionsFor(ALL, CAN_POST).parse).toEqual(["roles", "users"]);
	});

	it("pings nobody for someone who can't post there", () => {
		expect(allowedMentionsFor(ALL, CANT_POST)).toEqual({ parse: [], repliedUser: false });
	});
});
