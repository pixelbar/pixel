<script setup lang="ts">
/**
 * The Pixel mark's entrance, for the landing page hero. In dark it's the
 * original logo (public/pixel-mark.png) flying in as a mosaic of its own
 * pixels and sharpening into itself; in light it's the printed pixel art.
 * The animation lives in pixel-mark-intro.ts; it needs the browser, so it
 * starts on mount. The box keeps its square shape before then, so the page
 * doesn't jump.
 */
import { withBase } from "vitepress";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { createPixelMarkIntro, type PixelMarkIntro } from "./pixel-mark-intro";

const props = withDefaults(defineProps<{ label?: string }>(), { label: "" });

const host = ref<HTMLElement>();
let intro: PixelMarkIntro | undefined;

onMounted(() => {
	if (host.value) {
		intro = createPixelMarkIntro(host.value, {
			src: withBase("/pixel-mark.png"),
			label: props.label,
		});
	}
});
onBeforeUnmount(() => intro?.destroy());
</script>

<template>
	<div ref="host" class="px-mark-intro" />
</template>

<style scoped>
.px-mark-intro {
	position: relative;
	width: 100%;
	aspect-ratio: 1;
}

/* The canvas reaches 30% past the mark on every side, for the sparks. */
.px-mark-intro :deep(.px-mark-intro__canvas) {
	position: absolute;
	left: -30%;
	top: -30%;
	width: 160%;
	height: 160%;
	pointer-events: none;
}
</style>

<style>
/* Dark: the original sits on its black tile; screen lets the page show through the black. */
.dark .px-mark-intro__canvas {
	mix-blend-mode: screen;
}
</style>
