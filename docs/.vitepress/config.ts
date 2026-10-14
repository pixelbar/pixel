import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { escapeMustache } from "./markdown/escape-mustache";
import { mermaidFence } from "./markdown/mermaid";
import { repoLinks } from "./markdown/repo-links";
import { pixelDark, pixelLight } from "./theme/shiki";

const REPO = "https://github.com/pixelbar/pixel";
const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(docsDir, "..");

/** Pixel's own version, shown in the nav. The site still builds without it. */
function pixelVersion(): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}
const version = pixelVersion();

/**
 * Where the site is served from. GitHub Pages serves a project site under
 * /<repo>/, so the Pages workflow sets DOCS_BASE; locally it's the root.
 */
const base = normaliseBase(process.env.DOCS_BASE);
function normaliseBase(value: string | undefined): string {
	const trimmed = (value ?? "").replace(/^\/+|\/+$/g, "");
	return trimmed ? `/${trimmed}/` : "/";
}

/**
 * The maintainer docs stay where they are in `docs/` (AGENTS.md and the README link
 * to them there) and are served under /maintainers/ on the site.
 */
const MAINTAINER_DOCS = [
	"architecture",
	"identity-and-access",
	"infra",
	"home-assistant",
	"runbook",
	"discord-command-visibility",
];

export default defineConfig({
	base,
	lang: "en",
	title: "Pixel",
	titleTemplate: ":title · Pixel",
	description: "Pixel is the assistant bot for the Pixelbar hackerspace in Rotterdam.",
	cleanUrls: true,
	// Notes for people and agents working on the site, not pages.
	srcExclude: ["AGENTS.md"],
	lastUpdated: true,
	// Follow the system on the first visit, then remember the person's choice.
	appearance: true,

	rewrites: {
		...Object.fromEntries(MAINTAINER_DOCS.map((name) => [`${name}.md`, `maintainers/${name}.md`])),
		"adr/:file": "maintainers/adr/:file",
	},

	head: [
		["link", { rel: "icon", type: "image/png", href: `${base}favicon.png` }],
		["link", { rel: "apple-touch-icon", href: `${base}apple-touch-icon.png` }],
		["meta", { name: "theme-color", content: "#06060b" }],
		["meta", { property: "og:type", content: "website" }],
		["meta", { property: "og:title", content: "Pixel" }],
		[
			"meta",
			{ property: "og:description", content: "The assistant bot for the Pixelbar hackerspace." },
		],
		["meta", { property: "og:image", content: `${base}pixel-mark.png` }],
	],

	markdown: {
		theme: { light: pixelLight, dark: pixelDark },
		config(md) {
			md.use(escapeMustache);
			md.use(mermaidFence);
			md.use(repoLinks, { repo: REPO, repoRoot, docsDir });
		},
	},

	vite: {
		// Mermaid is big, but it's split out and only loaded on pages with a diagram.
		build: { chunkSizeWarningLimit: 1600 },
		// `just docs-tailnet-dev` proxies the dev server through `tailscale serve`, which
		// keeps the *.ts.net Host. Only machines on the tailnet can reach those names.
		server: { allowedHosts: [".ts.net"] },
	},

	themeConfig: {
		// The logo on its black tile in dark; the pixel-art mark printed in ink in light.
		logo: { light: "/pixel-mark-light-96.png", dark: "/pixel-mark-96.png", alt: "" },
		siteTitle: "Pixel",

		nav: [
			{ text: "Guide", link: "/guide/", activeMatch: "^/guide/" },
			{ text: "Commands", link: "/commands" },
			{ text: "Maintainers", link: "/maintainers/", activeMatch: "^/maintainers/" },
			...(version ? [{ text: `v${version}`, link: `${REPO}/blob/main/CHANGELOG.md` }] : []),
		],

		sidebar: {
			"/maintainers/": [
				{
					text: "Maintainers",
					items: [
						{ text: "Overview", link: "/maintainers/" },
						{ text: "Architecture", link: "/maintainers/architecture" },
						{ text: "Identity and access", link: "/maintainers/identity-and-access" },
						{ text: "Infrastructure", link: "/maintainers/infra" },
						{ text: "Home Assistant", link: "/maintainers/home-assistant" },
						{ text: "Operations runbook", link: "/maintainers/runbook" },
						{ text: "Hiding commands in Discord", link: "/maintainers/discord-command-visibility" },
					],
				},
				{
					text: "Decisions",
					collapsed: false,
					items: [
						{
							text: "0001 · Ports and adapters",
							link: "/maintainers/adr/0001-ports-and-adapters",
						},
						{
							text: "0002 · YAML access lists",
							link: "/maintainers/adr/0002-yaml-access-lists",
						},
						{ text: "0003 · No database", link: "/maintainers/adr/0003-no-database" },
						{
							text: "0004 · Azure Container Apps",
							link: "/maintainers/adr/0004-azure-container-apps",
						},
						{ text: "0005 · Sentry and pino", link: "/maintainers/adr/0005-sentry-and-pino" },
						{
							text: "0008 · Terraform bootstrap",
							link: "/maintainers/adr/0008-terraform-bootstrap",
						},
						{ text: "0009 · Container Apps dev", link: "/maintainers/adr/0009-container-apps-dev" },
						{ text: "0010 · Temporary GHCR CD", link: "/maintainers/adr/0010-ghcr-cd" },
						{ text: "0011 · Home Assistant", link: "/maintainers/adr/0011-home-assistant" },
						{ text: "0012 · Prod environment", link: "/maintainers/adr/0012-prod-environment" },
						{ text: "0013 · Release workflow", link: "/maintainers/adr/0013-release-workflow" },
						{
							text: "0014 · Release registers commands",
							link: "/maintainers/adr/0014-release-registers-commands",
						},
					],
				},
			],
			"/": [
				{
					text: "Guide",
					items: [
						{ text: "Getting started", link: "/guide/" },
						{ text: "Tiers and capabilities", link: "/guide/tiers" },
					],
				},
				{
					text: "Reference",
					items: [{ text: "Commands", link: "/commands" }],
				},
			],
		},

		outline: { level: [2, 3], label: "On this page" },
		search: { provider: "local" },
		socialLinks: [{ icon: "github", link: REPO }],
		editLink: {
			pattern: `${REPO}/edit/main/docs/:path`,
			text: "Edit this page on GitHub",
		},
		docFooter: { prev: "Previous", next: "Next" },
		footer: {
			message: 'A <a href="https://pixelbar.nl">Pixelbar</a> community project.',
			copyright: "Pixelbar hackerspace, Rotterdam",
		},
	},
});
