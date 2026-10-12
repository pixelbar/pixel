<script setup lang="ts">
/**
 * Draws a ```mermaid fence in the browser, in Pixel's colours. It redraws when the
 * theme changes. Mermaid is loaded only on pages that have a diagram.
 */
import { useData } from "vitepress";
import { computed, onMounted, ref, watch } from "vue";

const props = defineProps<{ code: string }>();
const source = computed(() => decodeURIComponent(props.code));
const svg = ref("");
const failed = ref(false);
const { isDark } = useData();
let count = 0;

function token(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function draw(): Promise<void> {
	try {
		const { default: mermaid } = await import("mermaid");
		// Mermaid sizes boxes by measuring text, so the fonts must be in first.
		await document.fonts.ready;
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: "strict",
			theme: "base",
			fontFamily: token("--font-sans"),
			themeVariables: {
				darkMode: isDark.value,
				background: token("--bg"),
				fontFamily: token("--font-sans"),
				fontSize: "14px",
				primaryColor: token("--surface"),
				primaryTextColor: token("--ink"),
				primaryBorderColor: token("--border-strong"),
				secondaryColor: token("--surface-raised"),
				secondaryTextColor: token("--ink"),
				secondaryBorderColor: token("--border-strong"),
				tertiaryColor: token("--bg"),
				tertiaryTextColor: token("--ink"),
				tertiaryBorderColor: token("--border"),
				lineColor: token("--ink-muted"),
				textColor: token("--ink"),
				mainBkg: token("--surface"),
				nodeBorder: token("--border-strong"),
				clusterBkg: token("--bg"),
				clusterBorder: token("--border"),
				titleColor: token("--ink"),
				edgeLabelBackground: token("--surface-raised"),
				actorBkg: token("--surface"),
				actorBorder: token("--border-strong"),
				actorTextColor: token("--ink"),
				signalColor: token("--ink-muted"),
				signalTextColor: token("--ink"),
				noteBkgColor: token("--surface-raised"),
				noteTextColor: token("--ink"),
				noteBorderColor: token("--border-strong"),
			},
			flowchart: { curve: "linear" },
		});
		count += 1;
		const id = `px-mermaid-${Math.random().toString(36).slice(2)}-${count}`;
		const result = await mermaid.render(id, source.value);
		svg.value = result.svg;
		failed.value = false;
	} catch {
		// Show the source rather than a broken diagram.
		failed.value = true;
	}
}

onMounted(draw);
watch(isDark, draw);
</script>

<template>
	<figure class="px-mermaid">
		<div v-if="svg && !failed" class="px-mermaid__svg" v-html="svg" />
		<pre v-else class="px-mermaid__source"><code>{{ source }}</code></pre>
	</figure>
</template>

<style scoped>
.px-mermaid {
	margin: var(--space-6) 0;
	padding: var(--space-4);
	background: var(--surface);
	border: 1px solid var(--border);
	overflow-x: auto;
}
.px-mermaid__svg :deep(svg) {
	display: block;
	max-width: 100%;
	height: auto;
	margin: 0 auto;
}
.px-mermaid__svg :deep(rect),
.px-mermaid__svg :deep(.label-container) {
	rx: 0;
	ry: 0;
}
/* Labels were measured outside the doc, so keep the doc's paragraph styles off them. */
.px-mermaid__svg :deep(p) {
	margin: 0;
	line-height: 1.5;
	font-size: inherit;
}
.px-mermaid__source {
	margin: 0;
	font: 400 14px/22px var(--font-mono);
	color: var(--ink-muted);
	white-space: pre;
}
</style>
