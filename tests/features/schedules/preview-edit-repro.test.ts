import { describe, expect, it, vi } from "vitest";
import type { PlatformActor, Tier } from "../../../src/core/access.ts";
import { CapabilityRegistry } from "../../../src/core/capabilities.ts";
import {
	type ChannelCheck,
	type ChannelPost,
	ChannelPosts,
} from "../../../src/core/channel-posts.ts";
import type { ResolvedChannel } from "../../../src/core/command.ts";
import { type ActionOutcome, Dispatcher } from "../../../src/core/dispatcher.ts";
import { IdentityService } from "../../../src/core/identity.ts";
import { createInterpolator } from "../../../src/core/interpolate.ts";
import { silentLogger } from "../../../src/core/logger.ts";
import { nullErrorReporter } from "../../../src/core/ports/error-reporter.ts";
import { RateLimiter } from "../../../src/core/rate-limit.ts";
import { CommandRegistry } from "../../../src/core/registry.ts";
import type { Reply } from "../../../src/core/reply.ts";
import type { Control, Form } from "../../../src/core/ui.ts";
import {
	createSchedulesFeature,
	SCHEDULE_CAPABILITY,
} from "../../../src/features/schedules/index.ts";
import { runDue } from "../../../src/features/schedules/runner.ts";
import { AttendanceStore } from "../../../src/services/attendance.ts";
import { ScheduleStore } from "../../../src/services/schedules.ts";
import { actor, IDS } from "../../../src/testing/fixtures.ts";

const AMS = "Europe/Amsterdam";
const NOW = new Date("2026-10-12T08:00:00Z");
const CHANNEL = "100000000000000050";
const PICKED = "100000000000000077";
const PEOPLE: Record<string, { tier: Tier; holds: string[] }> = {
	[IDS.member]: { tier: "member", holds: [SCHEDULE_CAPABILITY.name] },
};
const channel = (): ResolvedChannel => ({
	id: CHANNEL,
	name: "general",
	caller: { canPost: true, canMentionEveryone: true, canCreatePolls: true },
});
const controlsOf = (reply: Reply): Control[] => (reply.controls ?? []).flat();
function replyOf(outcome: ActionOutcome): Reply {
	if (outcome.kind !== "update") throw new Error(`expected update, got ${outcome.kind}`);
	return outcome.reply;
}
function formOf(outcome: ActionOutcome): Form {
	if (outcome.kind !== "form") throw new Error(`expected form, got ${outcome.kind}`);
	return outcome.form;
}

function setup() {
	const store = new ScheduleStore({ logger: silentLogger });
	const posts = new ChannelPosts();
	const posted: ChannelPost[] = [];
	const clock = { now: NOW };
	const poster = {
		check: vi.fn(async (): Promise<ChannelCheck> => ({ ok: true, name: "general" })),
		post: vi.fn(async (_id: string, post: ChannelPost) => {
			posted.push(post);
			return { url: "https://discord.com/channels/1/2/1", messageId: "1" };
		}),
		postAttendance: vi.fn(async () => ({ url: "u", messageId: "9" })),
		editAttendance: vi.fn(async () => {}),
		postDoorbell: vi.fn(async () => ({ url: "u", messageId: "9" })),
		editDoorbell: vi.fn(async () => {}),
	};
	posts.use(poster);
	const interpolator = createInterpolator({ timezone: AMS, now: () => clock.now });
	const feature = createSchedulesFeature({
		store,
		posts,
		timezone: AMS,
		stillAllowed: async () => true,
		interpolator,
		logger: silentLogger,
		reporter: nullErrorReporter,
		attendance: new AttendanceStore({ logger: silentLogger }),
		now: () => clock.now,
	});
	const registry = new CommandRegistry({
		capabilities: new CapabilityRegistry([SCHEDULE_CAPABILITY]),
	});
	registry.register(feature);
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService(
			[{ name: "t", tierFor: async (a: PlatformActor) => PEOPLE[a.userId]?.tier ?? null }],
			[{ name: "t", capabilitiesFor: async (a: PlatformActor) => PEOPLE[a.userId]?.holds ?? [] }],
		),
		rateLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 0, now: () => 0 }),
		logger: silentLogger,
		reporter: nullErrorReporter,
	});
	const who = () => actor({ userId: IDS.member, displayName: "Ada" });
	const act = (
		action: string,
		args: Record<string, string | number>,
		opts: {
			channels?: Record<string, ResolvedChannel>;
			users?: Record<string, { id: string; displayName: string; handle: string; isBot: boolean }>;
		} = {},
	) =>
		dispatcher.act({
			actor: who(),
			action,
			args,
			...(opts.channels ? { channels: opts.channels } : {}),
			...(opts.users ? { users: opts.users } : {}),
		});
	const click = (reply: Reply, label: string) => {
		const control = controlsOf(reply).find(
			(c) =>
				(c.kind === "select" ? c.placeholder : c.label) === label ||
				(c.kind !== "select" && c.label.startsWith(label)),
		);
		if (!control || control.kind === "link") throw new Error(`no "${label}"`);
		return act(control.call.action, { ...control.call.args } as Record<string, string | number>);
	};
	const submit = (form: Form, fields: Record<string, string>) => {
		const picked = channel();
		return act(
			form.submit.action,
			{ ...(form.submit.args as Record<string, string>), ...fields, channel: picked.id },
			{ channels: { channel: picked } },
		);
	};
	return { store, posted, poster, clock, act, click, submit, dispatcher, interpolator, posts };
}

describe("preview vs saved vs posted after edit (#242)", () => {
	it("fills the draft preview even when the draft can't be saved yet", async () => {
		const ctx = setup();
		const home = await ctx.dispatcher.dispatch({
			actor: actor({ userId: IDS.member, displayName: "Ada" }),
			command: "schedule",
			args: {},
		});
		const newForm = formOf(await ctx.click(home.reply, "New message"));
		const draft = replyOf(
			await ctx.submit(newForm, {
				when: "someday",
				repeat: "once",
				text: "Hello {{date}}",
			}),
		);
		expect(draft.embeds?.[0]?.description).toContain("⚠️");
		// Content slot stays filled (not the raw "{{date}}") so it matches the saved view language.
		expect(draft.text).toBe("Hello 12 October 2026");
		expect(ctx.store.all()).toEqual([]);
	});

	it("keeps edit preview, saved detail and posted text identical across two edits with tokens and a mention", async () => {
		const ctx = setup();
		const home = await ctx.dispatcher.dispatch({
			actor: actor({ userId: IDS.member, displayName: "Ada" }),
			command: "schedule",
			args: {},
		});
		const newForm = formOf(await ctx.click(home.reply, "New message"));
		let draft = replyOf(
			await ctx.submit(newForm, {
				when: "wed 19:00",
				repeat: "once",
				text: "Hello {{date}}",
			}),
		);
		expect(draft.text).toBe("Hello 14 October 2026");

		// Add a mention on the draft
		const mentionForm = formOf(await ctx.click(draft, "Mention someone…"));
		draft = replyOf(
			await ctx.act(
				mentionForm.submit.action,
				{ ...(mentionForm.submit.args as Record<string, string>), user: PICKED },
				{
					users: {
						user: { id: PICKED, displayName: "Bea", handle: "bea", isBot: false },
					},
				},
			),
		);
		const expected = `Hello 14 October 2026 <@${PICKED}>`;
		expect(draft.text).toBe(expected);

		const saved1 = replyOf(await ctx.click(draft, "Schedule"));
		expect(saved1.text).toBe(expected);
		const created = ctx.store.all()[0];
		expect(created?.post).toEqual({
			kind: "message",
			text: `Hello {{date}} <@${PICKED}>`,
		});
		const id = created?.id as string;

		// First edit: change wording, keep tokens + mention
		const edit1 = formOf(await ctx.click(saved1, "Edit"));
		const textField = edit1.fields.find((f) => f.name === "text");
		expect(textField && "value" in textField ? textField.value : undefined).toBe(
			`Hello {{date}} <@${PICKED}>`,
		);
		draft = replyOf(
			await ctx.submit(edit1, {
				when: "14 oct 2026 19:00",
				repeat: "once",
				text: `Hello there {{date}} <@${PICKED}>`,
			}),
		);
		const expected2 = `Hello there 14 October 2026 <@${PICKED}>`;
		expect(draft.text).toBe(expected2);

		const saved2 = replyOf(await ctx.click(draft, "Save changes"));
		expect(saved2.text).toBe(expected2);
		expect(ctx.store.get(id)?.post).toEqual({
			kind: "message",
			text: `Hello there {{date}} <@${PICKED}>`,
		});

		// Second edit: tweak again
		const edit2 = formOf(await ctx.click(saved2, "Edit"));
		draft = replyOf(
			await ctx.submit(edit2, {
				when: "14 oct 2026 19:00",
				repeat: "once",
				text: `Hi {{date}} <@${PICKED}>`,
			}),
		);
		const expected3 = `Hi 14 October 2026 <@${PICKED}>`;
		expect(draft.text).toBe(expected3);
		const saved3 = replyOf(await ctx.click(draft, "Save changes"));
		expect(saved3.text).toBe(expected3);

		// Advance to post time and compare what actually posts
		ctx.clock.now = new Date("2026-10-14T17:00:00Z");
		await runDue(
			{
				store: ctx.store,
				posts: ctx.posts,
				timezone: AMS,
				interpolator: ctx.interpolator,
				stillAllowed: async () => true,
				logger: silentLogger,
				reporter: nullErrorReporter,
				handled: new Set(),
			},
			ctx.clock.now,
		);
		expect(ctx.posted).toHaveLength(1);
		expect(ctx.posted[0]).toEqual({
			kind: "message",
			text: expected3,
		});
	});
});
