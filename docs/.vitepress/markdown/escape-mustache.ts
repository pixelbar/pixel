import type { MarkdownRenderer } from "vitepress";

/**
 * VitePress compiles every page as a Vue template, so `{{` in prose would be read
 * as a Vue expression. The maintainer docs talk about Pixel's own `{{date}}`
 * tokens in text and in code spans. Text gets the braces as entities (they look
 * the same and Vue leaves them alone); code spans get `v-pre`. Fenced code blocks
 * are already safe.
 */
export function escapeMustache(md: MarkdownRenderer): void {
	const text = md.renderer.rules.text;
	md.renderer.rules.text = (tokens, idx, options, env, self) => {
		const html = text ? text(tokens, idx, options, env, self) : (tokens[idx]?.content ?? "");
		return html.replaceAll("{{", "&#123;&#123;").replaceAll("}}", "&#125;&#125;");
	};

	const codeInline = md.renderer.rules.code_inline;
	md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
		const html = codeInline ? codeInline(tokens, idx, options, env, self) : "";
		return html.replace(/^<code/, "<code v-pre");
	};
}
