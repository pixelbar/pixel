import type { Logger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import { OpenrClient } from "./client.ts";
import { OpenrConnection } from "./connection.ts";

export { APP_VERSION, OpenrClient, OpenrError, type OpenrSession } from "./client.ts";
export { OpenrConnection } from "./connection.ts";

export type OpenrSetup = {
	url: string;
	buildingId: string;
	email: string;
	password: string;
};

/**
 * Pixel's connection to OpenR, or undefined when OpenR isn't configured (then `/openr`
 * says it isn't set up and `/park` says to open the gate the usual way). Nothing is
 * sent until an admin logs in, or a saved session is refreshed once `start()` runs.
 */
export function createOpenr(deps: {
	openr: OpenrSetup | undefined;
	/** Where the session is saved across restarts. */
	sessionFile: string;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground">;
	fetch?: typeof globalThis.fetch;
}): OpenrConnection | undefined {
	if (!deps.openr) {
		deps.logger.info({ event: "openr.unconfigured" }, "OpenR isn't configured");
		return undefined;
	}
	const { url, buildingId, email, password } = deps.openr;
	return new OpenrConnection({
		api: new OpenrClient({ baseUrl: url, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
		email,
		password,
		buildingId,
		file: deps.sessionFile,
		logger: deps.logger,
		reporter: deps.reporter,
	});
}
