# AGENTS.md: the website

Guidance for AI coding agents (and humans) working on Pixel's website in `docs/`. It's a landing page and documentation built with [VitePress](https://vitepress.dev) 1.x, themed with the **Pixel design system**.

For the bot itself, see the [root `AGENTS.md`](../AGENTS.md). Its rules still apply to anything the site says about the bot.

## Stay in scope

- **Site work only touches `docs/`.** Don't change `src/`, `config/`, `infra/` or the bot's `package.json` and lockfile in the same change. If the site needs a fact the code doesn't give it, ask; don't change the bot to suit the site.
- **The only exceptions:** the `docs-*` recipes in `justfile`, the docs entries in `.gitignore`, the `docs/**` overrides in `biome.json`, and a `CHANGELOG.md` entry.
- **The maintainer docs are separate.** `architecture.md`, `identity-and-access.md`, `infra.md`, `home-assistant.md`, `runbook.md`, `discord-command-visibility.md` and `adr/` belong to the bot. Edit them only when the bot changes, following the root `AGENTS.md`. A site change never rewrites them to fit the theme.

## Commands

Always go through `just`, from the repository root:

```sh
just docs-install    # install the site's dependencies (its own lockfile)
just docs-dev        # local server with hot reload, http://localhost:5173
just docs-build      # static build into docs/.vitepress/dist; must pass before a change is done
just docs-preview    # serve the last build
just docs-tailnet    # build and share on your tailnet with `tailscale serve` (never Funnel)
just lint            # Biome, which also checks docs/
```

`docs/` is its own pnpm project (`pnpm-workspace.yaml`, `pnpm-lock.yaml`), so nothing here reaches the bot's image. Never add the site's dependencies to the root `package.json`, and never add `docs` to the root workspace.

## Layout

```
docs/
  index.md                  # landing page: layout home, renders <PxHome />
  guide/                    # for people using Pixel: index.md (getting started), tiers.md
  commands.md               # every command as a <PxCommand> card, grouped by tier
  maintainers/index.md      # overview of the maintainer docs (the only new file there)
  *.md, adr/*.md            # the maintainer docs, served at /maintainers/… via rewrites
  public/                   # logo sizes and icons, served as-is
  .vitepress/
    config.ts               # site config: nav, sidebar, rewrites, markdown plugins
    markdown/               # markdown-it plugins: repo links, mermaid, {{ }} escaping
    theme/
      index.ts              # extends the default theme, registers components, imports fonts
      styles/tokens.css     # the design system's tokens as CSS variables
      styles/vitepress.css  # VitePress's variables and classes mapped onto the tokens
      styles/components.css # the design system's px- component classes
      shiki.ts              # code colours from the spectrum
      components/Px*.vue    # landing page, mark, command card, tier badge, status, mermaid
      components/pixel-mark.ts  # the mark as pixel-art paths (generated from the logo)
```

## The design system

The **Pixel** design system is the source of truth for colour, type, spacing, depth, motion and voice. This theme is a copy of it.

- **Change the design system first, then mirror it here.** `tokens.css` mirrors `tokens.json` value for value (light on `:root`, dark on `.dark`). `components.css` mirrors the design system's `bundle.css`. `shiki.ts` repeats the spectrum values. Keep all three in step.
- **Use tokens, never raw values.** No hex, rgb or pixel sizes outside `tokens.css` and `shiki.ts`. Use spacing from the 4px grid (`--space-*`).
- **Pixels are square.** `--radius-0` everywhere. Only inline code and kbd get `--radius-1`, and only the status dot is round. `vitepress.css` forces square corners across the default theme, so don't fight it.
- **The spectrum is for meaning and moments:** tiers, states, syntax and the `<PxSpectrum>` divider. Never body text, big backgrounds or gradients.
- **Dark emits, light prints.** Dark glows (`--glow-*`); light uses hard offset shadows (`--shadow-card`, `--shadow-lift`). Check both themes.
- **Motion is short and stepped** (`--step`, 80ms `steps(2)`). Respect `prefers-reduced-motion`.
- **Colour is never the only signal.** States and tiers always carry a word.
- **The logo has two versions.** Dark uses the original (`public/pixel-mark.png`, `-96.png`) on its black `--void` tile. Light uses the pixel-art mark printed on paper (`public/pixel-mark-light.svg`, `.png`, `-96.png`): a white star centre (`--mark-core`), the orbits in the `--mark-*` colours, no glow. Don't recolour, redraw or crop either by hand.
- **`<PxMark>`** draws the mark from `pixel-mark.ts` with the `--mark-*` tokens, so it follows the theme: neon with a glow in dark, graphic-strength colours without glow in light. `animated` (the hero) adds stepped motion: a shine runs round the orbits, particles twinkle and, in dark, the star breathes. Reduced motion turns it all off. The `--mark-*` light values are for artwork only (3:1), never for text.
- **`pixel-mark.ts` is generated** by tracing the logo onto a 64 × 64 grid. Don't hand-edit its paths; if the logo changes, regenerate it and the light assets together.
- **Fonts are self-hosted** through `@fontsource` (Pixelify Sans, IBM Plex Sans, IBM Plex Mono). Don't add Google Fonts or other third-party requests: visitors' browsers shouldn't contact anyone else (GDPR).
- **No AI tropes:** no blue-purple gradients, emoji cards or left-border cards.

## Writing

- **Voice:** plain, friendly, exact. English, sentence case, "you" for the reader. The site describes Pixel in the third person ("Pixel posts when the space opens").
- **No emoji in the interface.**
- **Commands are code, as Discord shows them:** `/ha set device: state:`, `/info [topic:]`. Required options end in a colon; optional ones go in brackets.
- **Every command shows its lowest tier and its reply.** Use `<PxCommand>` with the tier from the command's `access.minTier`, `reply="private"` or `"public"` from `private: true`, and any `capability` in `caps`. Copy names, options and descriptions from `src/features/`, not from memory. Admin commands get a short table only; never describe admin internals.
- **Don't invent facts.** Behaviour comes from the code and the maintainer docs. Facts about Pixelbar (prices, opening times, rules) are linked on [pixelbar.nl](https://pixelbar.nl), not restated.
- **The repository is public.** No secrets, tokens, door codes, real Discord IDs, people's names, Home Assistant URLs or the space's device names, not even as examples. Use obviously fake values.

## Markdown and components

- **Pages are Vue templates.** `{{` in prose and code spans is escaped for you (`markdown/escape-mustache.ts`). Inside raw HTML you write yourself, use `<code v-pre>`.
- **Components are registered globally** in `theme/index.ts`: `PxCommand`, `PxCommandTray`, `PxTierBadge`, `PxSpectrum`, `PxStatus`, `PxMark`, `PxMermaid`, `PxHome`. A new one goes in `theme/components/`, is registered there, uses only the `px-` classes and tokens, and works in both themes and at 390px wide.
- **Custom containers** (`::: tip`, `::: info`, `::: warning`, `::: danger`) are styled as Pixel callouts. Use at most one per section.
- **Mermaid** fences render through `<PxMermaid>` in the theme's colours. Mermaid only loads on pages that have a diagram.
- **Links:** link between site pages with root paths (`/commands`, `/guide/tiers`). In the maintainer docs, relative links to files outside `docs/` become GitHub links at build time (`markdown/repo-links.ts`).
- **`PxCommandTray`** is a pretend Discord message box with the slash-command picker, animated in steps (reduced motion shows it still). In the docs use it still: `<PxCommandTray query="/ha" :selected="2" caption="…" />` shows that query typed, the list filtered to it, one row selected and a caption under it. Its list of names and descriptions copies what Pixel registers in `src/features/`: when a command or its description changes there, change it here too. Keep admin commands out of it.
- **`PxStatus`** reads `https://spaceapi.pixelbar.nl/` in the visitor's browser. If that fails, it says the status is unknown; it never guesses.

## Adding pages

- **A guide page:** add it under `guide/`, then add it to the `"/"` sidebar in `config.ts`.
- **A maintainer doc:** add it at the root of `docs/` (where the bot's links expect it), add its name to `MAINTAINER_DOCS`, and add it to the `/maintainers/` sidebar and to `maintainers/index.md`.
- **An ADR:** `adr/NNNN-title.md` is rewritten automatically. Add it to the "Decisions" sidebar group and to the table in `maintainers/index.md`.
- **Don't move** the existing maintainer docs: `AGENTS.md`, the README and the code link to them at `docs/*.md`.
- **Files that aren't pages** (like this one) go in `srcExclude` in `config.ts`.

## Dependencies

- **Keep them minimal:** VitePress, Vue, Mermaid and the three `@fontsource` packages. Explain any addition in the PR.
- **Pin exact versions** (no `^` or `~`), at least two weeks old.
- **Install with `just docs-install`** and commit `docs/pnpm-lock.yaml`. Never commit `node_modules/`, `.vitepress/cache/` or `.vitepress/dist/`.

## Before you call a change done

1. `just docs-build` passes with no dead links. Don't silence it with `ignoreDeadLinks`; fix the link.
2. `just lint` passes. Don't hand-format: Biome does that (tabs, double quotes).
3. Look at what you changed in **both** themes and at phone width (390px), with no sideways scrolling. Code blocks and tables scroll inside themselves.
4. Text holds 4.5:1 on its background in both themes, and focus shows the `--focus` ring.
5. Add a `CHANGELOG.md` entry under `## [Unreleased]` if people using or running Pixel would notice the change. A pure styling or typo fix to the site can use the `skip-changelog` label.
