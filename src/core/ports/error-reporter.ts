import type { Principal } from "../access.ts";

export type ErrorReportContext = {
	command: string;
	feature: string;
	principal: Principal;
};

/** Reports unexpected errors (Sentry in production). */
export type ErrorReporter = {
	capture(error: unknown, context: ErrorReportContext): void;
};

export const nullErrorReporter: ErrorReporter = { capture() {} };
