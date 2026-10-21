import { describe, expect, it, vi } from "vitest";
import { isGroup, isSubgroup } from "../../core/command.ts";
import { type Revbank, RevbankError } from "../../core/ports/revbank.ts";
import { context, IDS, principal } from "../../testing/fixtures.ts";
import { createRevbankFeature, REVBANK_LINK_ADMIN } from "./index.ts";

const request = "10000000-0000-4000-8000-000000000001";
const api = () => ({
	status: vi.fn().mockResolvedValue({ state: "unlinked" }),
	request: vi.fn().mockResolvedValue({ state: "pending", nick: "Example", requestId: request }),
	unlink: vi.fn().mockResolvedValue(undefined),
	balance: vi.fn().mockResolvedValue({ balanceCents: 850, updatedAt: "2026-10-21T10:00:00Z" }),
	history: vi.fn().mockResolvedValue({
		updatedAt: "2026-10-21T10:00:00Z",
		transactions: [
			{
				id: "2",
				at: "2026-10-21T09:00:00Z",
				amountCents: -150,
				balanceCents: 850,
				description: "Cola *test*",
			},
		],
	}),
	review: vi.fn().mockResolvedValue({ state: "linked", nick: "Example" }),
	decide: vi.fn().mockResolvedValue(undefined),
	revoke: vi.fn().mockResolvedValue(undefined),
});
function setup(client: Revbank | undefined = api()) {
	const feature = createRevbankFeature({ api: client, timezone: "UTC" });
	const command = (name: string, management = false) => {
		const group = feature.commands?.[0];
		if (!group || !isGroup(group)) throw new Error("Missing group");
		const manage = group.subcommands.find((c) => c.name === "manage");
		if (!manage || !isSubgroup(manage)) throw new Error("Missing manage subgroup");
		const command = (management ? manage.subcommands : group.subcommands).find(
			(c) => c.name === name,
		);
		if (!command || isSubgroup(command)) throw new Error("Missing command");
		return command;
	};
	return { feature, command };
}
const ctx = () =>
	context({
		principal: principal("member", { userId: IDS.member }),
		users: { user: { id: IDS.friend, displayName: "Untrusted name", isBot: false } },
	});

describe("RevBank commands", () => {
	it("marks every command private and gates managers with an explicit capability", () => {
		const { feature } = setup();
		for (const group of feature.commands ?? []) {
			if (!isGroup(group)) throw new Error("Expected group");
			for (const command of group.subcommands) {
				for (const runnable of isSubgroup(command) ? command.subcommands : [command]) {
					expect(runnable.private).toBe(true);
				}
			}
		}
		expect(feature.commands).toHaveLength(1);
		const root = feature.commands?.[0];
		if (!root || !isGroup(root)) throw new Error("Missing root");
		expect(root.subcommands.find((c) => c.name === "manage")?.access).toEqual({
			minTier: "member",
			capability: REVBANK_LINK_ADMIN.name,
		});
	});
	it("shows unlinked, pending and linked status without interpreting nicknames", async () => {
		const client = api();
		const { command } = setup(client);
		expect((await command("status").handler(ctx())).text).toContain("No RevBank");
		client.status.mockResolvedValueOnce({ state: "pending", nick: "test*", requestId: request });
		expect((await command("status").handler(ctx())).text).toContain(request);
		client.status.mockResolvedValueOnce({ state: "linked", nick: "test*" });
		expect((await command("status").handler(ctx())).text).toContain("test\\*");
		client.status.mockResolvedValueOnce({ state: "linked" });
		await command("status").handler(ctx());
		client.status.mockResolvedValueOnce({ state: "pending" });
		await command("status").handler(ctx());
	});
	it("uses the caller's immutable ID for linking, balances, history and unlink", async () => {
		const client = api();
		const { command } = setup(client);
		await command("link").handler({ ...ctx(), args: { nick: "Example" } });
		expect(client.request).toHaveBeenCalledWith(`discord:${IDS.member}`, "Example");
		expect((await command("balance").handler(ctx())).text).toBe(
			"Your RevBank balance: **€8.50**\nBackup: 21 Oct 2026, 10:00.",
		);
		expect(
			(await command("transactions").handler(ctx())).embeds?.[0]?.fields?.[0]?.value,
		).toContain("Cola \\*test\\*");
		client.history.mockResolvedValueOnce({ updatedAt: "2026-10-21T10:00:00Z", transactions: [] });
		expect((await command("transactions").handler(ctx())).embeds?.[0]?.description).toContain(
			"No confirmed",
		);
		await command("unlink").handler(ctx());
		for (const mock of [client.balance, client.history, client.unlink])
			expect(mock).toHaveBeenCalledWith(`discord:${IDS.member}`);
	});
	it.each([undefined, "", "-cash", "../file", "someone else", "x".repeat(65), 42])(
		"refuses invalid nick %s before calling the service",
		async (nick) => {
			const client = api();
			const { command } = setup(client);
			await expect(command("link").handler({ ...ctx(), args: { nick } })).rejects.toThrow(
				"Enter a RevBank",
			);
			expect(client.request).not.toHaveBeenCalled();
		},
	);
	it("manages the chosen ID and exact request, without reading financial data", async () => {
		const client = api();
		const { command } = setup(client);
		await command("review", true).handler(ctx());
		await command("approve", true).handler({ ...ctx(), args: { request } });
		await command("reject", true).handler({ ...ctx(), args: { request } });
		await command("revoke", true).handler(ctx());
		expect(client.review).toHaveBeenCalledWith(`discord:${IDS.member}`, `discord:${IDS.friend}`);
		expect(client.decide).toHaveBeenCalledWith(
			`discord:${IDS.member}`,
			`discord:${IDS.friend}`,
			request,
			true,
		);
		expect(client.decide).toHaveBeenCalledWith(
			`discord:${IDS.member}`,
			`discord:${IDS.friend}`,
			request,
			false,
		);
		expect(client.revoke).toHaveBeenCalledWith(`discord:${IDS.member}`, `discord:${IDS.friend}`);
		expect(client.balance).not.toHaveBeenCalled();
	});
	it("requires a person and a valid request ID", async () => {
		const { command } = setup();
		await expect(command("review", true).handler(context())).rejects.toThrow("Choose a person");
		await expect(
			command("review", true).handler({
				...ctx(),
				users: { user: { id: IDS.friend, displayName: "bot", isBot: true } },
			}),
		).rejects.toThrow("Choose a person");
		for (const request of [undefined, "bad", 3])
			await expect(
				command("approve", true).handler({ ...ctx(), args: { request } }),
			).rejects.toThrow("request ID");
	});
	it.each(["unavailable", "not-linked", "denied", "conflict"] as const)(
		"returns private, safe %s errors",
		async (code) => {
			const client = api();
			client.balance.mockRejectedValueOnce(new RevbankError(code));
			const reply = await setup(client).command("balance").handler(ctx());
			expect(reply.private).toBe(true);
			expect(reply.text).toBeTruthy();
		},
	);
	it("propagates unexpected programming errors and handles disabled config", async () => {
		const client = api();
		client.balance.mockRejectedValueOnce(new Error("bug"));
		await expect(setup(client).command("balance").handler(ctx())).rejects.toThrow("bug");
		const feature = createRevbankFeature({ api: undefined, timezone: "UTC" });
		const group = feature.commands?.[0];
		if (!group || !isGroup(group)) throw new Error("group");
		const command = group.subcommands[0];
		if (!command || isSubgroup(command)) throw new Error("command");
		expect(await command.handler(ctx())).toEqual({
			text: "RevBank isn't set up here.",
			private: true,
		});
	});
});
