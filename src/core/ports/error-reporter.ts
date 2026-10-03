import type { Principal } from "../access.ts";

export type ErrorReportContext = {
	command: string;
	feature: string;
	principal: Principal;
};

/** Reports unexpected errors (Sentry in production). */
export type ErrorReporter = {
	/** An error while running a command for a user. */
	capture(error: unknown, context: ErrorReportContext): void;
	/**
	 * An error outside any command — a background job, a platform client, an
	 * external service. `source` names where it came from (e.g. "spaceapi").
	 */
	captureBackground(error: unknown, source: string): void;
	/**
	 * Leaves a note that is attached to any later error report, so "admin X
	 * changed Y just before this" is visible. Not an audit log: it is sampled
	 * with errors and kept briefly. Keep `data` to IDs and short labels.
	 */
	breadcrumb(category: string, message: string, data?: Record<string, string | number>): void;
};

export const nullErrorReporter: ErrorReporter = {
	capture() {},
	captureBackground() {},
	breadcrumb() {},
};
