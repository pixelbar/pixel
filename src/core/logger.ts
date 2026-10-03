/** The subset of a structured logger the core depends on. pino satisfies it. */
export type Logger = {
	debug(obj: object, msg?: string): void;
	info(obj: object, msg?: string): void;
	warn(obj: object, msg?: string): void;
	error(obj: object, msg?: string): void;
	child(bindings: Record<string, unknown>): Logger;
};

export const silentLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	child() {
		return silentLogger;
	},
};
