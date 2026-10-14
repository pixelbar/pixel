import { dirname, relative, resolve, sep } from "node:path";
import type { MarkdownRenderer } from "vitepress";

type Options = {
	/** The GitHub repository, e.g. https://github.com/pixelbar/pixel */
	repo: string;
	/** Absolute path of the repository root. */
	repoRoot: string;
	/** Absolute path of the VitePress source directory (docs/). */
	docsDir: string;
	/** Where the site serves a docs page, given its path in docs/ (e.g. `runbook.md`). */
	sitePath: (file: string) => string;
};

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;

/**
 * The maintainer docs link to files elsewhere in the repository (`../src/…`,
 * `../justfile`, `../.github/workflows/ci.yml`). Those aren't part of the site, so
 * point them at the file on GitHub instead of leaving a dead link.
 */
export function repoLinks(md: MarkdownRenderer, { repo, repoRoot, docsDir, sitePath }: Options): void {
	md.core.ruler.push("pixel_repo_links", (state) => {
		// realPath is where the file really is; path is where a rewrite serves it.
		const file: unknown = state.env?.realPath ?? state.env?.path;
		if (typeof file !== "string") return;
		for (const block of state.tokens) {
			for (const token of block.children ?? []) {
				if (token.type !== "link_open") continue;
				const href = token.attrGet("href");
				if (!href || EXTERNAL.test(href)) continue;

				const [path = "", hash] = href.split("#");
				const target = resolve(dirname(file), decodeURI(path));
				const inDocs = !relative(docsDir, target).startsWith("..");
				if (inDocs) {
					// Pages link to each other by file, so links work on GitHub. The site serves
					// some of them elsewhere (rewrites), so point at where the page really is.
					if (path.endsWith(".md")) {
						const inside = relative(docsDir, target).split(sep).join("/");
						token.attrSet("href", `${sitePath(inside)}${hash ? `#${hash}` : ""}`);
					}
					continue;
				}

				const fromRoot = relative(repoRoot, target).split(sep).join("/");
				if (fromRoot.startsWith("..")) continue;
				const kind = path.endsWith("/") ? "tree" : "blob";
				token.attrSet("href", `${repo}/${kind}/main/${fromRoot}${hash ? `#${hash}` : ""}`);
			}
		}
	});
}
