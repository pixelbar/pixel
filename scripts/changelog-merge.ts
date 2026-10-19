/**
 * Resolve a CHANGELOG.md merge conflict by keeping both sides' [Unreleased]
 * entries, when that is clearly right. The CLI is merge-changelog.ts.
 *
 * `branch` is the side being merged in (a PR), `main` the side it lands on.
 * The result is main's file with the branch's [Unreleased] changes applied:
 * entries it added go at the end of their section (a section is created in
 * the Keep a Changelog order if main has none), and entries it removed or
 * reworded are removed only if main still has them unchanged. Anything else
 * (both sides edited the same entry, an entry that main has since released,
 * duplicated or unknown section headings, text that isn't a list entry, or
 * both sides changing the released versions) is left for a person.
 *
 * A release on main between the two is fine: its [Unreleased] is then empty
 * (or new), and the branch's added entries land there, not in the version
 * that was cut.
 */
import { CHANGELOG_SECTIONS, type ChangelogSection, parseChangelog } from "./changelog.ts";

export type ChangelogMergeInput = {
	/** The common ancestor. */
	base: string;
	/** The side being merged in (the PR branch). */
	branch: string;
	/** The side it lands on (main). */
	main: string;
};

export type ChangelogMergeResult = { ok: true; text: string } | { ok: false; reason: string };

type Sections = Map<ChangelogSection, string[]>;

class Unmergeable extends Error {}

const UNRELEASED_HEADING = "## [Unreleased]";
const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;
const ENTRY_START = /^[-*]\s+\S/;

export function mergeChangelogs({ base, branch, main }: ChangelogMergeInput): ChangelogMergeResult {
	try {
		for (const [side, text] of [
			["base", base],
			["branch", branch],
			["main", main],
		] as const) {
			if (CONFLICT_MARKER.test(text))
				throw new Unmergeable(`The ${side} side has conflict markers.`);
		}
		if (branch === main || branch === base) return { ok: true, text: main };
		if (main === base) return { ok: true, text: branch };

		const [b, br, m] = [base, branch, main].map(parse) as [Parsed, Parsed, Parsed];
		const preamble = pick(b.preamble, br.preamble, m.preamble, "the text above [Unreleased]");
		const released = pick(b.rest, br.rest, m.rest, "the released versions");
		const links = pick(b.links, br.links, m.links, "the links at the bottom");

		const result = cloneSections(m.sections);
		for (const [section, entries] of b.sections) {
			const kept = br.sections.get(section) ?? [];
			for (const entry of entries) {
				if (kept.includes(entry)) continue;
				// The branch removed or reworded it. Only safe if main didn't touch it.
				const onMain = result.get(section) ?? [];
				const at = onMain.indexOf(entry);
				if (at === -1) {
					throw new Unmergeable(
						`The branch changed or removed an [Unreleased] ${section} entry that main also changed or has released: ${preview(entry)}`,
					);
				}
				onMain.splice(at, 1);
			}
		}
		for (const [section, entries] of br.sections) {
			const before = b.sections.get(section) ?? [];
			for (const entry of entries) {
				if (before.includes(entry)) continue;
				const onMain = result.get(section) ?? [];
				if (!onMain.includes(entry)) onMain.push(entry);
				result.set(section, onMain);
			}
		}

		return {
			ok: true,
			text: `${preamble}${UNRELEASED_HEADING}\n\n${renderSections(result)}${released}${links}`,
		};
	} catch (error) {
		if (error instanceof Unmergeable) return { ok: false, reason: error.message };
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

type Parsed = { preamble: string; sections: Sections; rest: string; links: string };

function parse(text: string): Parsed {
	const doc = parseChangelog(text);
	return { ...doc, sections: parseSections(doc.unreleased) };
}

/** The [Unreleased] body as sections of whole entries (a bullet and its indented lines). */
export function parseSections(body: string): Sections {
	const sections: Sections = new Map();
	let current: string[] | undefined;
	let entry: string[] | undefined;
	const flush = () => {
		if (entry && current) {
			while (entry.at(-1) === "") entry.pop();
			current.push(entry.join("\n"));
		}
		entry = undefined;
	};
	for (const line of body.split("\n")) {
		if (line.startsWith("#")) {
			flush();
			const name = /^### (\S.*?)\s*$/.exec(line)?.[1];
			if (!name || !isSection(name)) {
				throw new Unmergeable(
					`[Unreleased] has a heading that isn't a Keep a Changelog section: ${preview(line)}`,
				);
			}
			if (sections.has(name)) throw new Unmergeable(`[Unreleased] has ### ${name} twice.`);
			current = [];
			sections.set(name, current);
			continue;
		}
		if (ENTRY_START.test(line)) {
			flush();
			if (!current) throw new Unmergeable("[Unreleased] has an entry outside a ### section.");
			entry = [line.trimEnd()];
			continue;
		}
		if (line.trim() === "") {
			entry?.push("");
			continue;
		}
		if (entry && /^\s/.test(line)) {
			entry.push(line.trimEnd());
			continue;
		}
		throw new Unmergeable(`[Unreleased] has text that isn't a list entry: ${preview(line)}`);
	}
	flush();
	return sections;
}

function renderSections(sections: Sections): string {
	const blocks = CHANGELOG_SECTIONS.flatMap((name) => {
		const entries = sections.get(name) ?? [];
		return entries.length === 0 ? [] : [`### ${name}\n\n${entries.join("\n")}\n\n`];
	});
	return blocks.join("");
}

/** A three-way pick for a part only one side may change. */
function pick(base: string, branch: string, main: string, what: string): string {
	if (branch === base || branch === main) return main;
	if (main === base) return branch;
	throw new Unmergeable(`Both sides changed ${what}.`);
}

function cloneSections(sections: Sections): Sections {
	return new Map([...sections].map(([name, entries]) => [name, [...entries]]));
}

function isSection(value: string): value is ChangelogSection {
	return (CHANGELOG_SECTIONS as readonly string[]).includes(value);
}

function preview(text: string): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
