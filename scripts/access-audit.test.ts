import { describe, expect, it } from "vitest";
import { adminsAudit, auditAttributes, describeAudit, membersAudit } from "./access-audit.ts";

// Obviously fake IDs.
const A = "discord:100000000000000001";
const B = "discord:100000000000000002";
const C = "discord:100000000000000003";

const members = (body: string) => `members:\n${body}`;
const person = (id: string, tier: string, extra = "") =>
	`  - ids: ["${id}"]\n    tier: ${tier}\n${extra}`;

describe("membersAudit", () => {
	it("records a new person, a level change, new capabilities and a removal", () => {
		const before = members(person(A, "member") + person(B, "friend") + person(C, "member"));
		const after = members(
			person(A, "member", "    capabilities: [ha-lights]\n") +
				person(B, "member") +
				person("discord:100000000000000004", "friend"),
		);
		expect(membersAudit(before, after)).toEqual([
			{
				kind: "set-capabilities",
				target: A,
				before: { tier: "member", capabilities: [], revoked: [] },
				after: { tier: "member", capabilities: ["ha-lights"], revoked: [] },
			},
			{
				kind: "set-tier",
				target: B,
				before: { tier: "friend", capabilities: [], revoked: [] },
				after: { tier: "member", capabilities: [], revoked: [] },
			},
			{
				kind: "set-tier",
				target: "discord:100000000000000004",
				before: null,
				after: { tier: "friend", capabilities: [], revoked: [] },
			},
			{
				kind: "remove",
				target: C,
				before: { tier: "member", capabilities: [], revoked: [] },
				after: null,
			},
		]);
	});

	it("ignores a change to a note alone, which isn't access", () => {
		const before = members(person(A, "member", "    note: one\n"));
		const after = members(person(A, "member", "    note: two\n"));
		expect(membersAudit(before, after)).toEqual([]);
	});

	it("records a revocation as a capability change, and shows it", () => {
		const before = members(person(A, "member"));
		const after = members(person(A, "member", "    revoked: [ha-lights]\n"));
		const audit = membersAudit(before, after);
		expect(audit).toEqual([
			{
				kind: "set-capabilities",
				target: A,
				before: { tier: "member", capabilities: [], revoked: [] },
				after: { tier: "member", capabilities: [], revoked: ["ha-lights"] },
			},
		]);
		expect(audit[0] && describeAudit(audit[0])).toBe(
			`  set-capabilities ${A}: member (no capabilities) → member (no capabilities; revoked ha-lights)`,
		);
	});

	it("records a level's capabilities", () => {
		const after = `tiers:\n  member:\n    capabilities: [ha-lights]\n${members(person(A, "member"))}`;
		expect(membersAudit(members(person(A, "member")), after)).toEqual([
			{
				kind: "set-tier-capabilities",
				target: "tier:member",
				before: { capabilities: [] },
				after: { capabilities: ["ha-lights"] },
			},
		]);
	});

	it("treats a file new on the share as everyone added", () => {
		expect(membersAudit(undefined, members(person(A, "member")))).toEqual([
			{
				kind: "set-tier",
				target: A,
				before: null,
				after: { tier: "member", capabilities: [], revoked: [] },
			},
		]);
	});

	it("matches a person by any of their ids", () => {
		const before = members(person(A, "member"));
		const after = members(`  - ids: ["${A}", "${B}"]\n    tier: member\n`);
		expect(membersAudit(before, after)).toEqual([]);
	});
});

describe("adminsAudit", () => {
	const admins = (...ids: string[]) =>
		`admins:\n${ids.map((id) => `  - ids: ["${id}"]\n`).join("")}`;

	it("records admins added and removed", () => {
		expect(adminsAudit(admins(A, B), admins(A, C))).toEqual([
			{ kind: "add-admin", target: C, before: { admin: false }, after: { admin: true } },
			{ kind: "remove-admin", target: B, before: { admin: true }, after: { admin: false } },
		]);
	});

	it("records nothing when the list is the same", () => {
		expect(adminsAudit(admins(A), admins(A))).toEqual([]);
	});

	it("treats a new secret as every admin added", () => {
		expect(adminsAudit(undefined, admins(A)).map((e) => e.kind)).toEqual(["add-admin"]);
	});
});

describe("output", () => {
	it("describes an entry in one line", () => {
		expect(
			describeAudit({
				kind: "set-tier",
				target: A,
				before: null,
				after: { tier: "member", capabilities: ["ha-lights"], revoked: [] },
			}),
		).toBe(`  set-tier ${A}: none → member (ha-lights)`);
		expect(
			describeAudit({
				kind: "add-admin",
				target: A,
				before: { admin: false },
				after: { admin: true },
			}),
		).toBe(`  add-admin ${A}: not admin → admin`);
		expect(
			describeAudit({
				kind: "set-tier-capabilities",
				target: "tier:friend",
				before: { capabilities: [] },
				after: { capabilities: ["workshop"] },
			}),
		).toBe("  set-tier-capabilities tier:friend: no capabilities → workshop");
	});

	it("names the attributes as Pixel's access.changed does, with the Azure account as the user", () => {
		const attrs = auditAttributes(
			{
				kind: "remove",
				target: A,
				before: { tier: "member", capabilities: [], revoked: [] },
				after: null,
			},
			"dev",
			"someone@example.invalid",
		);
		expect(attrs).toEqual({
			event: "access.changed",
			env: "dev",
			user: "azure:someone@example.invalid",
			source: "just-push",
			kind: "remove",
			target: A,
			before: { tier: "member", capabilities: [], revoked: [] },
			after: null,
		});
	});
});
