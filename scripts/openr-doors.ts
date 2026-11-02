/**
 * Lists the OpenR buildings and doors an env's OpenR account can see, with their IDs,
 * so `OPENR_BUILDING_ID`, `OPENR_DOORS` and `OPENR_GATE_DOOR` can be filled in.
 * Usage: just openr-doors dev  or  just openr-doors prod
 *
 * Logs in with OPENR_EMAIL and OPENR_PASSWORD from that env's file, asks for the code
 * OpenR emails, lists, and logs out again. Read-only: it opens nothing and leaves
 * Pixel's own session alone. The email, password, code and session are never printed.
 */
import { input } from "@inquirer/prompts";
import {
	LIST_LIMIT,
	OpenrClient,
	OpenrError,
	type OpenrSession,
} from "../src/adapters/openr/client.ts";
import { ConfigError, loadOpenrAccount } from "../src/config.ts";
import { collectInventory, formatInventory } from "./openr-doors-lib.ts";
import { loadTarget } from "./target.ts";

const { target, vars } = loadTarget(process.argv.slice(2), "just openr-doors dev|prod");

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

let account: ReturnType<typeof loadOpenrAccount>;
try {
	account = loadOpenrAccount(vars);
} catch (error) {
	if (error instanceof ConfigError) fail(`${error.message}, in ${target}'s env file.`);
	throw error;
}

const client = new OpenrClient({ baseUrl: account.url, timeoutMs: 20_000 });

/** Says what went wrong without anything secret: an OpenrError's message never holds one. */
function explain(error: unknown, what: string): never {
	if (error instanceof OpenrError) {
		fail(
			error.refused
				? `OpenR refused ${what} (HTTP ${error.status}).`
				: `Couldn't ${what === "the code" ? "check the code" : "log in"}: ${error.message}.`,
		);
	}
	throw error;
}

process.stdout.write(`Logging in to OpenR with ${target}'s account…\n`);
let session: OpenrSession;
try {
	const answer = await client.login(account.email, account.password);
	if (answer.kind === "session") {
		session = answer.session;
	} else {
		const code = await input({
			message: "OpenR has emailed a code to the account. Code:",
			validate: (typed) => /^\d{4,10}$/.test(typed.replace(/\s+/g, "")) || "Only digits",
		});
		try {
			session = await client.completeLogin(answer.token, code.replace(/\s+/g, ""));
		} catch (error) {
			explain(error, "the code");
		}
	}
} catch (error) {
	explain(error, "the email or password");
}

try {
	process.stdout.write(`\n${formatInventory(await collectInventory(client, session), LIST_LIMIT)}`);
} finally {
	// Ends only this script's session; Pixel's own stays logged in.
	await client.logout(session).catch(() => {
		process.stderr.write("Couldn't log this session out of OpenR; it expires by itself.\n");
	});
}
