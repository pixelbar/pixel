/**
 * Which paths need which expensive CI/CD jobs.
 *
 * Positive allowlists (not a docs denylist). Fail closed only when the base SHA
 * is missing: then both jobs run. An empty change set runs neither.
 *
 * - `check`: `just check` + `just build` (lint, types, tests, compile)
 * - `image`: Docker smoke on PRs; GHCR + Sentry on `main`
 *
 * `src/**` (including tests) is in both: a test-only change still checks and
 * still publishes. `scripts/` and `config/` are check-only (not in the image).
 * `docs/` is neither: the Docs site workflow builds and Biome-lints it.
 *
 * GitHub Actions calls `scripts/ci-paths.sh` before `pnpm install`. Keep the
 * regexes here in sync with that script (the tests exercise both).
 */

/** Paths that need `just check` + `just build`. */
export const CHECK_PATH =
	/^(src\/|scripts\/|content\/|config\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig(.*)?\.json$|biome\.json$|vitest\.config\.|justfile$|\.nvmrc$|\.github\/workflows\/ci\.yml$)/;

/**
 * Paths that change the container image or how it is published.
 * Includes all of `src/` so test-only changes still get a new GHCR image.
 */
export const IMAGE_PATH =
	/^(src\/|content\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig(.*)?\.json$|Dockerfile$|\.dockerignore$|justfile$|\.github\/workflows\/(ci|cd)\.yml$)/;

export type CiPathNeeds = {
	check: boolean;
	image: boolean;
};

export function ciPathNeeds(changedFiles: readonly string[]): CiPathNeeds {
	let check = false;
	let image = false;
	for (const file of changedFiles) {
		if (CHECK_PATH.test(file)) {
			check = true;
		}
		if (IMAGE_PATH.test(file)) {
			image = true;
		}
		if (check && image) {
			break;
		}
	}
	return { check, image };
}
