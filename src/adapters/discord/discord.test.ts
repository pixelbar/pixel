import { ApplicationCommandOptionType, InteractionContextType, MessageFlags } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchResult } from "../../core/dispatcher.ts";
import { command } from "../../testing/fixtures.ts";
import { optionsToArgs } from "./args.ts";
import { toSlashCommand } from "./commands.ts";
import { renderEdit, renderReply, truncate } from "./render.ts";
import { type Respondable, type RespondOptions, respond } from "./respond.ts";

describe("toSlashCommand", () => {
	it("maps a command and its options to guild-only slash command JSON", () => {
		const json = toSlashCommand(
			command({
				name: "info",
				description: "Info",
				options: [
					{
						name: "topic",
						description: "Topic",
						type: "string",
						required: true,
						choices: ["hours"],
					},
					{ name: "count", description: "Count", type: "integer" },
					{ name: "loud", description: "Loud", type: "boolean" },
				],
			}),
		);
		expect(json).toMatchObject({
			name: "info",
			description: "Info",
			contexts: [InteractionContextType.Guild],
			options: [
				{
					name: "topic",
					type: ApplicationCommandOptionType.String,
					required: true,
					choices: [{ name: "hours", value: "hours" }],
				},
				{ name: "count", type: ApplicationCommandOptionType.Integer, required: false },
				{ name: "loud", type: ApplicationCommandOptionType.Boolean, required: false },
			],
		});
	});
});

describe("toSlashCommand without options", () => {
	it("emits an empty option list", () => {
		expect(toSlashCommand(command()).options).toEqual([]);
	});
});

describe("optionsToArgs", () => {
	it("keeps primitive values and ignores other option types", () => {
		expect(
			optionsToArgs([
				{ name: "a", type: ApplicationCommandOptionType.String, value: "x" },
				{ name: "b", type: ApplicationCommandOptionType.Integer, value: 2 },
				{ name: "c", type: ApplicationCommandOptionType.Boolean, value: false },
				{ name: "u", type: ApplicationCommandOptionType.User, value: "100000000000000001" },
			]),
		).toEqual({ a: "x", b: 2, c: false });
	});
});

describe("renderReply", () => {
	it("always disables mentions", () => {
		expect(renderReply({ text: "@everyone hi" }, false).allowedMentions).toEqual({ parse: [] });
	});

	it("marks private replies ephemeral", () => {
		expect(renderReply({ text: "x" }, true).flags).toBe(MessageFlags.Ephemeral);
		expect(renderReply({ text: "x" }, false).flags).toBeUndefined();
	});

	it("never sends an empty message", () => {
		expect(renderReply({}, false).content).toBe("Done.");
	});

	it("omits content for embed-only replies", () => {
		const payload = renderReply({ embeds: [{ title: "T" }] }, false);
		expect(payload.content).toBeUndefined();
		expect(payload.embeds?.[0]?.title).toBe("T");
	});

	it("renders embed description, url and inline fields", () => {
		const payload = renderReply(
			{
				embeds: [
					{
						title: "T",
						description: "D",
						url: "https://pixelbar.nl",
						fields: [{ name: "n", value: "v", inline: true }],
					},
				],
			},
			false,
		);
		expect(payload.embeds?.[0]).toMatchObject({
			title: "T",
			description: "D",
			url: "https://pixelbar.nl",
			fields: [{ name: "n", value: "v", inline: true }],
		});
	});

	it("enforces Discord's length limits", () => {
		const payload = renderReply(
			{
				text: "x".repeat(3000),
				embeds: [{ title: "t".repeat(300), fields: [{ name: "n", value: "v".repeat(2000) }] }],
			},
			false,
		);
		expect(payload.content).toHaveLength(2000);
		expect(payload.embeds?.[0]?.title).toHaveLength(256);
		expect(payload.embeds?.[0]?.fields?.[0]?.value).toHaveLength(1024);
	});

	it("truncate adds an ellipsis only when needed", () => {
		expect(truncate("abc", 3)).toBe("abc");
		expect(truncate("abcd", 3)).toBe("ab…");
	});

	it("maps accents to embed colours, defaulting to the brand colour", () => {
		const payload = renderReply(
			{
				embeds: [
					{ title: "a" },
					{ title: "b", accent: "positive" },
					{ title: "c", accent: "negative" },
				],
			},
			false,
		);
		const [brand, positive, negative] = payload.embeds?.map((e) => e.color) ?? [];
		expect(new Set([brand, positive, negative]).size).toBe(3);
		expect(
			renderReply({ embeds: [{ title: "x", accent: "brand" }] }, false).embeds?.[0]?.color,
		).toBe(brand);
	});
});

describe("renderEdit", () => {
	it("clears content when the new reply is embed-only", () => {
		expect(renderEdit({ embeds: [{ title: "T" }] })).toMatchObject({
			content: null,
			embeds: [expect.objectContaining({ title: "T" })],
		});
	});

	it("clears embeds when the new reply is text-only", () => {
		expect(renderEdit({ text: "hi" })).toEqual({
			content: "hi",
			embeds: [],
			allowedMentions: { parse: [] },
		});
	});

	it("never produces an empty message", () => {
		expect(renderEdit({}).content).toBe("Done.");
	});
});

describe("respond", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function fakeInteraction() {
		return {
			reply: vi.fn(async () => {}),
			deferReply: vi.fn(async () => {}),
			editReply: vi.fn(async () => {}),
			followUp: vi.fn(async () => {}),
			deleteReply: vi.fn(async () => {}),
		} satisfies Respondable;
	}

	function delayed(result: DispatchResult, ms: number): () => Promise<DispatchResult> {
		return () => new Promise((resolve) => setTimeout(() => resolve(result), ms));
	}

	const publicResult: DispatchResult = { reply: { text: "hi" }, private: false };
	const privateResult: DispatchResult = { reply: { text: "secret" }, private: true };

	it("replies directly when work is fast", async () => {
		const i = fakeInteraction();
		const done = respond(i, {
			defaultPrivate: false,
			deferAfterMs: 1500,
			work: delayed(publicResult, 100),
		});
		await vi.advanceTimersByTimeAsync(100);
		await done;
		expect(i.deferReply).not.toHaveBeenCalled();
		expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "hi" }));
	});

	it("defers, then edits, when work is slow", async () => {
		const i = fakeInteraction();
		const done = respond(i, {
			defaultPrivate: true,
			deferAfterMs: 1500,
			work: delayed(privateResult, 2000),
		});
		await vi.advanceTimersByTimeAsync(2000);
		await done;
		expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "secret" }));
		expect(i.reply).not.toHaveBeenCalled();
	});

	it("never leaks a private result into a public deferred reply", async () => {
		const i = fakeInteraction();
		const done = respond(i, {
			defaultPrivate: false,
			deferAfterMs: 1500,
			work: delayed(privateResult, 2000),
		});
		await vi.advanceTimersByTimeAsync(2000);
		await done;
		expect(i.editReply).not.toHaveBeenCalled();
		expect(i.deleteReply).toHaveBeenCalled();
		expect(i.followUp).toHaveBeenCalledWith(
			expect.objectContaining({ content: "secret", flags: MessageFlags.Ephemeral }),
		);
	});

	describe("with a placeholder", () => {
		const checking: DispatchResult = {
			reply: { embeds: [{ title: "Checking…" }] },
			private: false,
		};
		const statusResult: DispatchResult = {
			reply: { embeds: [{ title: "🟢 Pixelbar is open" }] },
			private: false,
		};

		function pendingThen(
			pending: DispatchResult,
			result: DispatchResult,
			ms: number,
			pendingAfterMs = 0,
		): RespondOptions["work"] {
			return async (showPending) => {
				await new Promise((r) => setTimeout(r, pendingAfterMs));
				await showPending(pending);
				await new Promise((r) => setTimeout(r, ms));
				return result;
			};
		}

		it("posts the placeholder straight away, then edits it into the result", async () => {
			const i = fakeInteraction();
			const done = respond(i, {
				defaultPrivate: false,
				deferAfterMs: 1500,
				work: pendingThen(checking, statusResult, 3000),
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(i.reply).toHaveBeenCalledWith(
				expect.objectContaining({ embeds: [expect.objectContaining({ title: "Checking…" })] }),
			);
			await vi.advanceTimersByTimeAsync(3000);
			await done;
			// The placeholder acknowledged the interaction, so no deferral is needed.
			expect(i.deferReply).not.toHaveBeenCalled();
			expect(i.editReply).toHaveBeenCalledWith({
				content: null,
				embeds: [expect.objectContaining({ title: "🟢 Pixelbar is open" })],
				allowedMentions: { parse: [] },
			});
		});

		it("replaces the placeholder's embed when the result is text-only", async () => {
			const i = fakeInteraction();
			const done = respond(i, {
				defaultPrivate: false,
				deferAfterMs: 1500,
				work: pendingThen(checking, publicResult, 10),
			});
			await vi.advanceTimersByTimeAsync(10);
			await done;
			expect(i.editReply).toHaveBeenCalledWith(
				expect.objectContaining({ content: "hi", embeds: [] }),
			);
		});

		it("moves a private result out of a public placeholder", async () => {
			const i = fakeInteraction();
			const done = respond(i, {
				defaultPrivate: false,
				deferAfterMs: 1500,
				work: pendingThen(checking, privateResult, 10),
			});
			await vi.advanceTimersByTimeAsync(10);
			await done;
			expect(i.editReply).not.toHaveBeenCalled();
			expect(i.deleteReply).toHaveBeenCalled();
			expect(i.followUp).toHaveBeenCalledWith(
				expect.objectContaining({ content: "secret", flags: MessageFlags.Ephemeral }),
			);
		});

		it("shows the placeholder inside an earlier deferral", async () => {
			const i = fakeInteraction();
			const done = respond(i, {
				defaultPrivate: false,
				deferAfterMs: 1500,
				work: pendingThen(checking, statusResult, 10, 2000),
			});
			await vi.advanceTimersByTimeAsync(2010);
			await done;
			expect(i.deferReply).toHaveBeenCalledOnce();
			expect(i.reply).not.toHaveBeenCalled();
			expect(i.editReply).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ embeds: [expect.objectContaining({ title: "Checking…" })] }),
			);
			expect(i.editReply).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					embeds: [expect.objectContaining({ title: "🟢 Pixelbar is open" })],
				}),
			);
		});
	});
});
