/**
 * The `access.changed` audit for a hand edit sent with `just push`: what changed between
 * the live `members.yaml` / `admins.yaml` and the pushed ones, in the shape Pixel's
 * `AccessStore` logs, so Sentry Logs has one history whoever made the change.
 *
 * Tier and capabilities only: notes are free text about a person and stay out of logs,
 * so a change to a note alone isn't an access change.
 */
import { parseAdmins, parseMembers } from "../src/services/access-config.ts";

type Summary = { tier: string; capabilities: string[]; revoked: string[] };

export type AuditEntry = {
	kind:
		| "set-tier"
		| "set-capabilities"
		| "remove"
		| "set-tier-capabilities"
		| "add-admin"
		| "remove-admin";
	target: string;
	before: Summary | { capabilities: string[] } | { admin: boolean } | null;
	after: Summary | { capabilities: string[] } | { admin: boolean } | null;
};

type Person = { ids: string[]; tier: string; capabilities?: string[]; revoked?: string[] };

const summarise = (p: Person): Summary => ({
	tier: p.tier,
	capabilities: p.capabilities ?? [],
	revoked: p.revoked ?? [],
});
const sameList = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((x, i) => x === b[i]);
const overlaps = (a: readonly string[], b: readonly string[]) => a.some((id) => b.includes(id));
const targetOf = (ids: readonly string[]) => ids.join(",");

/** Each person, level and admin whose access differs. `before` undefined means a new file. */
export function membersAudit(before: string | undefined, after: string): AuditEntry[] {
	const old = before === undefined ? undefined : parseMembers(before, "members.yaml (live)");
	const next = parseMembers(after, "members.yaml");
	const out: AuditEntry[] = [];
	const matched = new Set<Person>();
	for (const person of next.members) {
		const prior = old?.members.find((p) => overlaps(p.ids, person.ids));
		if (prior) matched.add(prior);
		const a = summarise(person);
		if (prior === undefined) {
			out.push({ kind: "set-tier", target: targetOf(person.ids), before: null, after: a });
			continue;
		}
		const b = summarise(prior);
		if (b.tier !== a.tier)
			out.push({ kind: "set-tier", target: targetOf(person.ids), before: b, after: a });
		else if (!sameList(b.capabilities, a.capabilities) || !sameList(b.revoked, a.revoked))
			out.push({ kind: "set-capabilities", target: targetOf(person.ids), before: b, after: a });
	}
	for (const prior of old?.members ?? []) {
		if (!matched.has(prior))
			out.push({
				kind: "remove",
				target: targetOf(prior.ids),
				before: summarise(prior),
				after: null,
			});
	}
	for (const tier of ["friend", "member"] as const) {
		const b = old?.tiers[tier] ?? [];
		const a = next.tiers[tier];
		if (!sameList(b, a)) {
			out.push({
				kind: "set-tier-capabilities",
				target: `tier:${tier}`,
				before: { capabilities: [...b] },
				after: { capabilities: [...a] },
			});
		}
	}
	return out;
}

/** Each admin added or removed. */
export function adminsAudit(before: string | undefined, after: string): AuditEntry[] {
	const old = before === undefined ? [] : parseAdmins(before, "admins.yaml (live)");
	const next = parseAdmins(after, "admins.yaml");
	const added = next.filter((ids) => !old.some((o) => overlaps(o, ids)));
	const removed = old.filter((ids) => !next.some((n) => overlaps(n, ids)));
	return [
		...added.map(
			(ids): AuditEntry => ({
				kind: "add-admin",
				target: targetOf(ids),
				before: { admin: false },
				after: { admin: true },
			}),
		),
		...removed.map(
			(ids): AuditEntry => ({
				kind: "remove-admin",
				target: targetOf(ids),
				before: { admin: true },
				after: { admin: false },
			}),
		),
	];
}

const show = (side: AuditEntry["before"]) => {
	if (side === null) return "none";
	if ("admin" in side) return side.admin ? "admin" : "not admin";
	const caps = side.capabilities.length > 0 ? side.capabilities.join(",") : "no capabilities";
	if (!("tier" in side)) return caps;
	const revoked = side.revoked.length > 0 ? `; revoked ${side.revoked.join(",")}` : "";
	return `${side.tier} (${caps}${revoked})`;
};

/** One line for the push summary. */
export function describeAudit(entry: AuditEntry): string {
	return `  ${entry.kind} ${entry.target}: ${show(entry.before)} → ${show(entry.after)}`;
}

/** The Sentry log attributes for one entry, named as Pixel's `access.changed` names them. */
export function auditAttributes(
	entry: AuditEntry,
	env: string,
	operator: string,
): Record<string, unknown> {
	return {
		event: "access.changed",
		env,
		user: `azure:${operator}`,
		source: "just-push",
		kind: entry.kind,
		target: entry.target,
		before: entry.before,
		after: entry.after,
	};
}
