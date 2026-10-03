/**
 * An error whose message is safe and useful to show to the user, for example
 * invalid input. Not reported to Sentry.
 */
export class UserFacingError extends Error {
	override name = "UserFacingError";
}
