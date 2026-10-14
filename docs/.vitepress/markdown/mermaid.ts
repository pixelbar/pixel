import type { MarkdownRenderer } from "vitepress";

/**
 * ```mermaid fences become a <PxMermaid> component, which draws the diagram in
 * the browser with Pixel's colours. The source travels URI-encoded so Vue never
 * reads braces in it as template syntax.
 */
export function mermaidFence(md: MarkdownRenderer): void {
	const fence = md.renderer.rules.fence;
	md.renderer.rules.fence = (tokens, idx, options, env, self) => {
		const token = tokens[idx];
		if (token && token.info.trim() === "mermaid") {
			return `<PxMermaid code="${encodeURIComponent(token.content)}" />`;
		}
		return fence ? fence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
	};
}
