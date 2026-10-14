/**
 * Which env `just register`, `just command-access` and `just ha-devices` act on.
 * The just recipe loads `.env.dev` or `.env.prod`; this check stops a prod
 * token being used on the Pixel Dev guild (and the reverse).
 */
export type RegisterTarget = "dev" | "prod";

export function parseRegisterTarget(argv: readonly string[]): RegisterTarget {
	const target = argv[0];
	if ((target === "dev" || target === "prod") && argv.length === 1) return target;
	throw new Error(
		"Expected dev or prod (just register dev|prod, just command-access dev|prod, just ha-devices dev|prod)",
	);
}

export function assertRegisterEnv(
	target: RegisterTarget,
	pixelEnv: "local" | "dev" | "prod",
): void {
	if (target === "prod" && pixelEnv !== "prod") {
		throw new Error(
			"Refusing prod: PIXEL_ENV is not prod. .env.prod must set PIXEL_ENV=prod. Never copy the Pixel Dev token.",
		);
	}
	if (target === "dev" && pixelEnv === "prod") {
		throw new Error("Refusing dev: PIXEL_ENV=prod. dev is the Pixel Dev / test guild only.");
	}
}
