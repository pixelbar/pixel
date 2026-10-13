#!/usr/bin/env bash
# Which expensive CI/CD jobs this change needs (positive allowlists).
# Outputs check= and image= for GitHub Actions (and stdout).
# Fail closed: missing/unknown base SHA → both true. Empty change set → both false.
# Keep CHECK_RE / IMAGE_RE in sync with scripts/ci-paths.ts.
set -euo pipefail

# Keep in sync with CHECK_PATH / IMAGE_PATH in scripts/ci-paths.ts
CHECK_RE='^(src/|scripts/|content/|config/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig(.*)?\.json$|biome\.json$|vitest\.config\.|justfile$|\.nvmrc$|\.github/workflows/ci\.yml$)'
IMAGE_RE='^(src/|content/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig(.*)?\.json$|Dockerfile$|\.dockerignore$|justfile$|\.github/workflows/(ci|cd)\.yml$)'

write_out() {
	local check="$1"
	local image="$2"
	if [ -n "${GITHUB_OUTPUT:-}" ]; then
		{
			echo "check=${check}"
			echo "image=${image}"
		} >> "${GITHUB_OUTPUT}"
	fi
	echo "check=${check}"
	echo "image=${image}"
}

run_both() {
	write_out true true
	if [ -n "${1:-}" ]; then
		echo "CI paths: check+image (${1})."
	else
		echo "CI paths: check+image."
	fi
}

decide() {
	local -a paths=("$@")
	local check=false
	local image=false
	local f

	if [ "${#paths[@]}" -eq 0 ]; then
		write_out false false
		echo "CI paths: none (empty change set)."
		return 0
	fi

	for f in "${paths[@]}"; do
		if printf '%s\n' "${f}" | grep -Eq "${CHECK_RE}"; then
			check=true
		fi
		if printf '%s\n' "${f}" | grep -Eq "${IMAGE_RE}"; then
			image=true
		fi
		if [ "${check}" = true ] && [ "${image}" = true ]; then
			break
		fi
	done

	write_out "${check}" "${image}"
	echo "CI paths: check=${check} image=${image}."
}

paths=()

if [ "${1:-}" = "--stdin" ]; then
	while IFS= read -r line || [ -n "${line}" ]; do
		[ -z "${line}" ] && continue
		paths+=("${line}")
	done
	decide "${paths[@]+"${paths[@]}"}"
	exit 0
fi

BASE_SHA="${BASE_SHA:-}"
if [ -z "${BASE_SHA}" ] || [ "${BASE_SHA}" = "0000000000000000000000000000000000000000" ]; then
	run_both "no base SHA"
	exit 0
fi
if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
	run_both "base SHA not in this clone"
	exit 0
fi

while IFS= read -r line || [ -n "${line}" ]; do
	[ -z "${line}" ] && continue
	paths+=("${line}")
done < <(git diff --name-only --no-renames "${BASE_SHA}")

decide "${paths[@]+"${paths[@]}"}"
