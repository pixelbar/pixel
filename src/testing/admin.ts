import type { PlatformActor } from "../core/access.ts";
import type { ResolvedUser } from "../core/command.ts";
import type { ActionOutcome, Dispatcher } from "../core/dispatcher.ts";
import type { Reply } from "../core/reply.ts";
import { ADMIN_ACTIONS } from "../features/admin/panel.ts";
import { actor } from "./fixtures.ts";

/** What the admin subcommands were called, before `/admin` became one panel. */
export type AdminOp =
	| "status"
	| "reload"
	| "whois"
	| "set-level"
	| "sync"
	| "grant"
	| "grant-all"
	| "revoke"
	| "grant-level"
	| "revoke-level"
	| "list";

/**
 * Runs what an old `/admin` subcommand did, the way the panel does it now: `/admin`
 * for the status, and otherwise the action its button or form runs. A person is
 * looked up on a form (`whois`); after that their panel holds their ID and name, so
 * the actions get those. The reply is the action's (the operation's reply on top).
 */
export async function runAdmin(
	dispatcher: Dispatcher,
	op: AdminOp,
	args: Record<string, string>,
	target?: ResolvedUser,
	as: Partial<PlatformActor> = {
		userId: "100000000000000001",
		displayName: "Ada",
		handle: "ada_l",
	},
): Promise<{ reply: Reply; private: boolean; outcome?: ActionOutcome }> {
	const who = actor(as);
	const held: Record<string, string> = target
		? {
				"user-id": target.id,
				"user-name": target.displayName,
				...(target.handle ? { "user-handle": target.handle } : {}),
			}
		: {};
	const go = async (
		action: string,
		actionArgs: Record<string, string>,
		users?: Record<string, ResolvedUser>,
	) => {
		const outcome = await dispatcher.act({
			actor: who,
			action,
			args: actionArgs,
			...(users ? { users } : {}),
		});
		const reply: Reply = outcome.kind === "form" ? { private: true } : outcome.reply;
		return { reply, private: reply.private ?? false, outcome };
	};
	switch (op) {
		case "status":
			return dispatcher.dispatch({ actor: who, command: "admin", args: {} });
		case "reload":
			return go(ADMIN_ACTIONS.reload, {});
		case "whois":
			return go(
				ADMIN_ACTIONS.person,
				target ? { user: target.id } : {},
				target ? { user: target } : undefined,
			);
		case "set-level":
			return go(ADMIN_ACTIONS.levelSet, { ...held, ...args });
		case "sync":
			return target ? go(ADMIN_ACTIONS.syncPerson, held) : go(ADMIN_ACTIONS.syncAll, {});
		case "grant":
			return go(ADMIN_ACTIONS.grant, { ...held, ...args });
		case "revoke":
			return go(ADMIN_ACTIONS.revoke, { ...held, ...args });
		case "grant-all":
			return go(ADMIN_ACTIONS.grantAll, { ...held, ...args });
		case "grant-level":
			return go(ADMIN_ACTIONS.levelGrant, args);
		case "revoke-level":
			return go(ADMIN_ACTIONS.levelRevoke, args);
		case "list":
			return target
				? go(ADMIN_ACTIONS.personCapabilities, held)
				: go(ADMIN_ACTIONS.section, { section: "capabilities" });
	}
}
