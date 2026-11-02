import type { PlatformActor, Principal } from "../access.ts";

export type ErrorReportContext = {
	command: string;
	feature: string;
	principal: Principal;
};

/** Who an error happened to, as far as it's known: enough to find them by their stable ID. */
export type ErrorReportActor = Pick<
	PlatformActor,
	"platform" | "userId" | "displayName" | "handle"
>;

/** Reports unexpected errors (Sentry in production). */
export type ErrorReporter = {
	/** An error while running a command for a user. */
	capture(error: unknown, context: ErrorReportContext): void;
	/**
	 * An error outside any command — a background job, a platform client, an
	 * external service. `source` names where it came from (e.g. "spaceapi").
	 * Pass `actor` when the error happened because of a particular person (a failure
	 * handling their interaction), so the report names them by ID.
	 */
	captureBackground(error: unknown, source: string, actor?: ErrorReportActor): void;
	/**
	 * Runs `run` with the person and the command attached to everything reported
	 * while it runs, however deep and whichever way it is reported (an exception, a
	 * background error, a breadcrumb or a log line): a failure in Home Assistant or the
	 * role mirror on the way is then traced to who asked. Reporters that can't scope
	 * leave this out and the work simply runs.
	 */
	withContext?<T>(context: ErrorReportContext, run: () => Promise<T>): Promise<T>;
	/**
	 * Leaves a note that is attached to any later error report, so "admin X
	 * changed Y just before this" is visible. Not an audit log: it is sampled
	 * with errors and kept briefly. Keep `data` to IDs and short labels.
	 */
	breadcrumb(category: string, message: string, data?: Record<string, string | number>): void;
	/**
	 * Attaches structured data about an exchange with an outside service (what was
	 * sent, what came back) to the current command, so it shows on any error reported
	 * meanwhile and on the command's trace. The caller has already removed secrets
	 * and capped sizes. Reporters that can't attach leave this out.
	 */
	attach?(source: string, data: Record<string, unknown>): void;
	/**
	 * Counts something that happened (a metric, such as a parking booking), so how
	 * often it's used can be charted. Attributes are short labels to slice by; never
	 * a person's ID or name. Reporters without metrics leave this out.
	 */
	count?(name: string, attributes?: Record<string, string>): void;
};

export const nullErrorReporter: ErrorReporter = {
	capture() {},
	captureBackground() {},
	breadcrumb() {},
};
