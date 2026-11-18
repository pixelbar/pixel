import { type Access, actorLogFields, actorRef } from "../../core/access.ts";
import type { CapabilityDefinition } from "../../core/capabilities.ts";
import type { ChannelPosts } from "../../core/channel-posts.ts";
import {
	CALL_ID,
	DOORBELL_ANSWER_ACTION,
	type DoorbellEvent,
	type DoorbellEvents,
	type DoorbellMessage,
} from "../../core/doorbell.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown } from "../../core/format.ts";
import type { Logger } from "../../core/logger.ts";
import type { AcceptResult, DoorbellAccept } from "../../core/ports/doorbell-accept.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { ActionDefinition } from "../../core/ui.ts";
import type { DoorbellSettings } from "../../services/doorbell-settings.ts";

/**
 * The doorbell in Discord. pixel-phone answers the Pixelbar doorbell and tells Pixel about
 * each call (`DoorbellEvents`). When it rings, Pixel posts "Someone's at the door" in the
 * channel admins picked, with an **Answer** button. Answering asks pixel-phone to pick up;
 * the button in the space does the same, and the first one wins, wherever it came from.
 * The post then follows the call: who answered, or that nobody did, and the button goes.
 *
 * Answering needs `friend` and the `doorbell` capability, which admins grant to a whole
 * level (`/admin` → Capabilities). Every click is `DOORBELL_ANSWER_ACTION` through the
 * dispatcher, for whoever clicked, by ID.
 *
 * What's been posted for each call is kept in memory only: a call lasts seconds, and
 * pixel-phone, not Pixel, knows whether it can still be answered. After a restart, a
 * button still works (it names only the call), but its post isn't edited any more.
 */

export const DOORBELL_CAPABILITY: CapabilityDefinition = {
	name: "doorbell",
	description: "Answer the doorbell from Discord",
};

export const DOORBELL_ACCESS: Access = { minTier: "friend", capability: DOORBELL_CAPABILITY.name };

/** pixel-phone's names for who accepted (`via`). */
const VIA_BUTTON = "home-assistant";
const VIA_PIXEL = "pixel";

/** If nothing settles a call by this long after it stops ringing, its button goes anyway. */
const SETTLE_GRACE_MS = 30_000;
/** Calls are forgotten this long after they settle. */
const FORGET_AFTER_MS = 10 * 60_000;

export const DOORBELL_MESSAGES = {
	ringing: (seconds: number) =>
		`🔔 **Someone's at the door!** Press **Answer** within ${seconds} seconds, then go and let them in.`,
	answeredBy: (name: string) => `🔔 Someone was at the door. **${escapeMarkdown(name)}** answered.`,
	answeredInSpace: "🔔 Someone was at the door. It was answered with the button in the space.",
	answeredOnDiscord: "🔔 Someone was at the door. It was answered from Discord.",
	answered: "🔔 Someone was at the door. It was answered.",
	missed: "🔕 Someone was at the door, but nobody answered in time.",
	hungUp: "🔕 Someone was at the door, but they hung up before anyone answered.",
	busy: "🔕 The doorbell rang again during another call, and wasn't answered.",
	stopped: "🔕 Someone was at the door. The doorbell has stopped ringing.",

	onIt: "You're on it! Go and let them in.",
	alreadyBy: (who: string) => `Already answered by ${who}.`,
	tooLate: "Too late: the doorbell has stopped ringing.",
	unreachable: "Couldn't reach the doorbell. Go and check the door, and tell an admin.",
	notSetUp: "The doorbell isn't connected to Pixel here.",
} as const;

/** How a call ended, as far as Pixel knows. */
type Outcome =
	| { kind: "accepted"; via: string; name?: string }
	| { kind: "missed"; reason: "timeout" | "caller_hung_up" }
	| { kind: "busy" }
	| { kind: "ended" }
	| { kind: "stopped" };

type Call = {
	callId: string;
	acceptBy: Date;
	outcome?: Outcome;
	settledAt?: Date;
	/** The post, once it's out. */
	post?: { channelId: string; messageId: string };
	/** Posting and edits, one at a time. */
	chain: Promise<void>;
	/** Takes the button away if nothing settles the call. */
	timer?: NodeJS.Timeout;
};

export type DoorbellFeatureDeps = {
	events: Pick<DoorbellEvents, "subscribe">;
	posts: Pick<ChannelPosts, "postDoorbell" | "editDoorbell" | "ready">;
	settings: Pick<DoorbellSettings, "channelId">;
	/** Undefined when pixel-phone isn't configured: Answer says so. */
	accept: DoorbellAccept | undefined;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground">;
	now?: () => Date;
};

/** The text of a post for a call in this state. */
export function doorbellText(
	call: Pick<Call, "outcome" | "acceptBy">,
	now: Date,
): { text: string; answerable: boolean } {
	const { outcome } = call;
	if (!outcome) {
		const seconds = Math.max(1, Math.round((call.acceptBy.getTime() - now.getTime()) / 1000));
		return { text: DOORBELL_MESSAGES.ringing(seconds), answerable: true };
	}
	switch (outcome.kind) {
		case "accepted":
			if (outcome.name)
				return { text: DOORBELL_MESSAGES.answeredBy(outcome.name), answerable: false };
			if (outcome.via === VIA_BUTTON)
				return { text: DOORBELL_MESSAGES.answeredInSpace, answerable: false };
			if (outcome.via === VIA_PIXEL)
				return { text: DOORBELL_MESSAGES.answeredOnDiscord, answerable: false };
			return { text: DOORBELL_MESSAGES.answered, answerable: false };
		case "missed":
			return {
				text: outcome.reason === "timeout" ? DOORBELL_MESSAGES.missed : DOORBELL_MESSAGES.hungUp,
				answerable: false,
			};
		case "busy":
			return { text: DOORBELL_MESSAGES.busy, answerable: false };
		case "ended":
			return { text: DOORBELL_MESSAGES.answered, answerable: false };
		case "stopped":
			return { text: DOORBELL_MESSAGES.stopped, answerable: false };
	}
}

/** Who someone else's accept came from, for "Already answered by …". */
function whoAccepted(result: Extract<AcceptResult, { kind: "already" }>, known?: Outcome): string {
	if (known?.kind === "accepted" && known.name) return `**${escapeMarkdown(known.name)}**`;
	if (result.via === VIA_BUTTON) return "the button in the space";
	if (result.via === VIA_PIXEL) return "someone on Discord";
	return "someone else";
}

/**
 * Whether `next` should replace what's known. An accept is the most that can be known
 * (and never replaced); missed and busy replace a call that only stopped or ended; ended
 * means it was answered, so it only fills in a call that had nothing better.
 */
function better(next: Outcome, known: Outcome | undefined): boolean {
	if (!known || known.kind === "stopped") return true;
	if (known.kind === "accepted")
		return next.kind === "accepted" && !known.name && next.name !== undefined;
	if (next.kind === "accepted") return true;
	return known.kind === "ended" && next.kind !== "ended";
}

export function createDoorbellFeature(deps: DoorbellFeatureDeps): Feature {
	const now = deps.now ?? (() => new Date());
	const log = deps.logger.child({ component: "doorbell" });
	const calls = new Map<string, Call>();

	function message(call: Call): DoorbellMessage {
		return { callId: call.callId, ...doorbellText(call, now()) };
	}

	/** Runs `step` after the call's earlier posting and edits. A failure is logged and reported. */
	function queue(call: Call, what: string, step: () => Promise<void>): Promise<void> {
		call.chain = call.chain.then(async () => {
			try {
				await step();
			} catch (error) {
				log.error(
					{ event: "doorbell.post_failed", what, callId: call.callId, err: error },
					"couldn't post or update the doorbell",
				);
				deps.reporter.captureBackground(error, "doorbell");
			}
		});
		return call.chain;
	}

	/** Brings the call's post up to date, if there is one. */
	function refresh(call: Call): Promise<void> {
		return queue(call, "edit", async () => {
			if (!call.post) return;
			await deps.posts.editDoorbell(call.post.channelId, call.post.messageId, message(call));
		});
	}

	function settle(call: Call, outcome: Outcome): Promise<void> {
		if (!better(outcome, call.outcome)) return call.chain;
		call.outcome = outcome;
		call.settledAt ??= now();
		clearTimeout(call.timer);
		call.timer = undefined;
		return refresh(call);
	}

	/** A call Pixel hasn't heard of yet, as of an event other than `ringing`. */
	function track(callId: string, acceptBy: Date): Call {
		let call = calls.get(callId);
		if (!call) {
			call = { callId, acceptBy, chain: Promise.resolve() };
			calls.set(callId, call);
		}
		return call;
	}

	function ring(event: Extract<DoorbellEvent, { type: "ringing" }>): Promise<void> {
		const known = calls.get(event.callId);
		// A second copy, or it was settled before its ringing arrived.
		if (known) return known.chain;
		const call = track(event.callId, event.acceptBy);
		const at = now();
		if (event.acceptBy <= at) {
			call.outcome = { kind: "stopped" };
			call.settledAt = at;
			log.info(
				{ event: "doorbell.ring_late", callId: event.callId },
				"the doorbell rang too long ago to post",
			);
			return call.chain;
		}
		const channelId = deps.settings.channelId;
		if (!channelId || !deps.posts.ready) {
			log.info(
				{
					event: "doorbell.not_posted",
					callId: event.callId,
					why: channelId ? "not ready" : "no channel",
				},
				"the doorbell rang, but isn't posted",
			);
			return call.chain;
		}
		call.timer = setTimeout(
			() => void settle(call, { kind: "stopped" }),
			event.acceptBy.getTime() - at.getTime() + SETTLE_GRACE_MS,
		);
		call.timer.unref?.();
		return queue(call, "post", async () => {
			const sent = await deps.posts.postDoorbell(channelId, message(call));
			call.post = { channelId, messageId: sent.messageId };
			log.info({ event: "doorbell.posted", callId: call.callId }, "posted the doorbell");
			// Something settled it while it was being posted.
			if (call.outcome) {
				await deps.posts.editDoorbell(channelId, sent.messageId, message(call));
			}
		});
	}

	async function onEvent(event: DoorbellEvent): Promise<void> {
		forgetOld();
		switch (event.type) {
			case "ringing":
				return ring(event);
			case "accepted":
				return settle(track(event.callId, event.occurredAt), { kind: "accepted", via: event.via });
			case "missed":
				return settle(track(event.callId, event.occurredAt), {
					kind: "missed",
					reason: event.reason,
				});
			case "busy":
				return settle(track(event.callId, event.occurredAt), { kind: "busy" });
			case "ended":
				return settle(track(event.callId, event.occurredAt), { kind: "ended" });
		}
	}

	function forgetOld(): void {
		const cutoff = now().getTime() - FORGET_AFTER_MS;
		for (const [id, call] of calls) {
			const since = call.settledAt ?? call.acceptBy;
			if (since.getTime() < cutoff) {
				clearTimeout(call.timer);
				calls.delete(id);
			}
		}
	}

	const answer: ActionDefinition = {
		name: DOORBELL_ANSWER_ACTION,
		access: DOORBELL_ACCESS,
		options: [{ name: "call", description: "Which call", type: "string", required: true }],
		handler: async (ctx) => {
			if (!deps.accept) throw new UserFacingError(DOORBELL_MESSAGES.notSetUp);
			const callId = String(ctx.args.call);
			if (!CALL_ID.test(callId)) throw new UserFacingError(DOORBELL_MESSAGES.tooLate);
			const fields = { callId, ...actorLogFields(ctx.principal) };
			const result = await deps.accept.accept(callId, actorRef(ctx.principal));
			const call = calls.get(callId);
			switch (result.kind) {
				case "accepted":
					ctx.logger.info({ event: "doorbell.answered", ...fields }, "answered the doorbell");
					if (call)
						void settle(call, {
							kind: "accepted",
							via: VIA_PIXEL,
							name: ctx.principal.displayName,
						});
					return { reply: { private: true, text: DOORBELL_MESSAGES.onIt } };
				case "already":
					ctx.logger.info(
						{ event: "doorbell.answer_failed", why: "already", via: result.via, ...fields },
						"the doorbell was already answered",
					);
					return {
						reply: {
							private: true,
							text: DOORBELL_MESSAGES.alreadyBy(whoAccepted(result, call?.outcome)),
						},
					};
				case "too-late":
					ctx.logger.info(
						{ event: "doorbell.answer_failed", why: "too-late", ...fields },
						"the doorbell had stopped ringing",
					);
					if (call) void settle(call, { kind: "stopped" });
					return { reply: { private: true, text: DOORBELL_MESSAGES.tooLate } };
				case "failed":
					ctx.logger.error(
						{
							event: "doorbell.answer_failed",
							why: result.why,
							...(result.status ? { status: result.status } : {}),
							...fields,
						},
						"couldn't answer the doorbell",
					);
					deps.reporter.captureBackground(
						new Error(
							`Couldn't accept a doorbell call: ${result.why}${result.status ? ` (HTTP ${result.status})` : ""}`,
						),
						"doorbell",
					);
					return { reply: { private: true, text: DOORBELL_MESSAGES.unreachable } };
			}
		},
	};

	return {
		name: "doorbell",
		actions: [answer],
		start: () => {
			const unsubscribe = deps.events.subscribe(onEvent);
			return () => {
				unsubscribe();
				for (const call of calls.values()) clearTimeout(call.timer);
			};
		},
	};
}
