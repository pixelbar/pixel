#!/usr/bin/env bash
# Hash the files a CI job depends on, so the job can skip when that exact set
# of files already passed (.github/actions/ci-inputs looks the hash up).
#
# Usage: scripts/ci-inputs.sh [--list] <filter> [extra-file...]
#   <filter>      a list in .github/path-filters.yml
#   extra-file    more files to include (the workflow that runs the job)
#   --list        print the matched files instead of the hash
#
# Patterns are git glob pathspecs: `*` stays inside one directory, `**`
# crosses them, and a leading `!` excludes. The hash covers each file's path,
# mode and committed content (what git has, not unstaged edits), plus the
# filter file, this script and the CI actions, so changing any of them reruns
# every job.
set -euo pipefail

filters=".github/path-filters.yml"
list=false
if [ "${1:-}" = "--list" ]; then
	list=true
	shift
fi
filter="${1:?usage: ci-inputs.sh [--list] <filter> [extra-file...]}"
shift

# The filter file is plain `name:` keys with `- "pattern"` lists under them.
patterns="$(awk -v want="${filter}" '
	/^[A-Za-z0-9_-]+:[[:space:]]*(#.*)?$/ { current = substr($0, 1, index($0, ":") - 1); next }
	/^[^[:space:]#]/ { current = "" }
	current == want && /^[[:space:]]+-[[:space:]]/ {
		line = $0
		sub(/^[[:space:]]+-[[:space:]]+/, "", line)
		sub(/[[:space:]]+#.*$/, "", line)
		gsub(/^"|"$/, "", line)
		print line
	}
' "${filters}")"

if [ -z "${patterns}" ]; then
	echo "ci-inputs: no filter named ${filter} in ${filters}" >&2
	exit 1
fi

pathspecs=(":(literal)${filters}" ":(literal)scripts/ci-inputs.sh" ":(glob).github/actions/**")
while IFS= read -r pattern; do
	case "${pattern}" in
	"!"*) pathspecs+=(":(glob,exclude)${pattern#!}") ;;
	*) pathspecs+=(":(glob)${pattern}") ;;
	esac
done <<<"${patterns}"
for extra in "$@"; do
	pathspecs+=(":(literal)${extra}")
done

if "${list}"; then
	git ls-files -- "${pathspecs[@]}"
else
	{
		echo "${filter}"
		git ls-files -s -- "${pathspecs[@]}"
	} | git hash-object --stdin
fi
