import { actorLogFields, actorRef } from "../../core/access.ts";
import type { SubcommandDefinition, SubgroupDefinition } from "../../core/command.ts";
import { formatDuration, formatUntil } from "../../core/format.ts";
import type { DoorSystem, DoorSystemStatus, LoginStep } from "../../core/ports/door-system.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { Reply } from "../../core/reply.ts";
import type { OpenrDoor } from "../openr/index.ts";

/**
 * `/admin openr`: logs Pixel in to OpenR and shows how its session is doing. Pixel logs
 * in with its own account (`OPENR_EMAIL`, `OPENR_PASSWORD`); OpenR then emails a code to
 * that account, which an admin passes back with `/admin openr code`. From then on Pixel
 * keeps the session alive by itself. Admins only, private, and logged.
 */

export type OpenrAdminDeps = {
	/** Undefined when OpenR isn't configured. */
	system: DoorSystem | undefined;
	doors: readonly OpenrDoor[];
	gateDoor: string | undefined;
	reporter: Pick<ErrorReporter, "breadcrumb">;
	now: () => Date;
};

const NOT_SET_UP: Reply = {
	text: "OpenR isn't configured here (`OPENR_BUILDING_ID`, `OPENR_EMAIL` and `OPENR_PASSWORD`).",
	private: true,
};

/** A code as OpenR emails it: digits, maybe typed with spaces. */
const CODE = /^\d{4,10}$/;

export function createOpenrSubgroup(deps: OpenrAdminDeps): SubgroupDefinition {
	const admin = { minTier: "admin" } as const;

	const status: SubcommandDefinition = {
		name: "status",
		description: "Whether Pixel is logged in to OpenR",
		access: admin,
		private: true,
		handler: async () => {
			if (!deps.system) return NOT_SET_UP;
			const doors = deps.doors.map((d) => d.name).join(", ") || "none";
			return {
				text: [
					describeOpenr(deps.system.status(), deps.now()),
					`Doors for \`/openr open\`: ${doors}`,
					`Parking gate: ${deps.gateDoor === undefined ? "not set" : "set"}`,
				].join("\n"),
				private: true,
			};
		},
	};

	const login: SubcommandDefinition = {
		name: "login",
		description: "Log Pixel in to OpenR (it emails a code)",
		access: admin,
		private: true,
		placeholder: { text: "Logging in…", private: true },
		handler: async ({ principal, logger }) => {
			if (!deps.system) return NOT_SET_UP;
			const step = await deps.system.startLogin();
			logger.warn(
				{ event: "openr.login_started", result: describeStep(step), ...actorLogFields(principal) },
				"an admin started an OpenR login",
			);
			deps.reporter.breadcrumb("openr.login", describeStep(step), { user: actorRef(principal) });
			return { text: loginReply(step, deps.now()), private: true };
		},
	};

	const code: SubcommandDefinition = {
		name: "code",
		description: "Finish the OpenR login with the emailed code",
		access: admin,
		private: true,
		placeholder: { text: "Checking the code…", private: true },
		options: [
			{
				name: "code",
				description: "The code OpenR emailed",
				type: "string",
				required: true,
			},
		],
		handler: async ({ args, principal, logger }) => {
			if (!deps.system) return NOT_SET_UP;
			// Never logged: it's a secret until it's used.
			const typed = String(args.code ?? "").replace(/\s+/g, "");
			if (!CODE.test(typed)) {
				return { text: "That doesn't look like OpenR's code: it's only digits.", private: true };
			}
			const step = await deps.system.completeLogin(typed);
			logger.warn(
				{
					event: "openr.login_completed",
					result: describeStep(step),
					...actorLogFields(principal),
				},
				"an admin entered an OpenR login code",
			);
			deps.reporter.breadcrumb("openr.code", describeStep(step), { user: actorRef(principal) });
			return { text: loginReply(step, deps.now()), private: true };
		},
	};

	const logout: SubcommandDefinition = {
		name: "logout",
		description: "Log Pixel out of OpenR",
		access: admin,
		private: true,
		handler: async ({ principal, logger }) => {
			if (!deps.system) return NOT_SET_UP;
			await deps.system.logout();
			logger.warn(
				{ event: "openr.logged_out", ...actorLogFields(principal) },
				"an admin logged Pixel out of OpenR",
			);
			deps.reporter.breadcrumb("openr.logout", "logged out", { user: actorRef(principal) });
			return {
				text: "Pixel is logged out of OpenR and can't open any door. Log in again with `/admin openr login`.",
				private: true,
			};
		},
	};

	return {
		name: "openr",
		description: "OpenR login for the doors (admins only)",
		access: admin,
		subcommands: [status, login, code, logout],
	};
}

/** One line about Pixel's OpenR session, for `/admin openr status` and `/admin status`. */
export function describeOpenr(status: DoorSystemStatus, now: Date): string {
	switch (status.state) {
		case "logged-in": {
			const lines = [
				`OpenR: logged in, session ends ${formatUntil(status.sessionUntil.getTime() - now.getTime())} unless refreshed`,
			];
			if (status.refreshFailingSince) {
				lines.push(
					`⚠️ Refreshing has failed since ${formatAgo(now, status.refreshFailingSince)}: OpenR may be down.`,
				);
			}
			return lines.join("\n");
		}
		case "awaiting-code":
			return `OpenR: waiting for the emailed code (\`/admin openr code\`) for another ${formatDuration(status.codeUntil.getTime() - now.getTime())}`;
		case "logged-out":
			return status.endedAt
				? `OpenR: **logged out**: OpenR ended the session ${formatAgo(now, status.endedAt)}. Log in with \`/admin openr login\`.`
				: "OpenR: **logged out**. Log in with `/admin openr login`.";
	}
}

function loginReply(step: LoginStep, now: Date): string {
	switch (step.step) {
		case "code-sent":
			return `OpenR has emailed a code to Pixel's account. Pass it on with \`/admin openr code\` (Pixel waits ${formatDuration(step.codeUntil.getTime() - now.getTime())} for it).`;
		case "logged-in":
			return `Pixel is logged in to OpenR and can open doors. It keeps the session going by itself (it ends ${formatUntil(step.sessionUntil.getTime() - now.getTime())} unless refreshed).`;
		case "refused":
			if (step.why === "credentials") {
				return "OpenR refused Pixel's email or password. Check the `openr-email` and `openr-password` secrets.";
			}
			if (step.why === "code") {
				return "OpenR didn't accept that code. Check it, or start again with `/admin openr login`.";
			}
			return "There's no login waiting for a code, or it timed out. Start with `/admin openr login`.";
		case "failed":
			return "⚠️ Couldn't reach OpenR, or it answered something unexpected. Try again in a moment; the logs say more.";
	}
}

function describeStep(step: LoginStep): string {
	return step.step === "refused" ? `refused-${step.why}` : step.step;
}

function formatAgo(now: Date, then: Date): string {
	const minutes = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}
