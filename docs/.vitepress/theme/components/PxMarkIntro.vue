<script setup lang="ts">
/**
 * The Pixel mark's entrance, for the landing page hero: the pixels fly in, it
 * lights up with a burst of sparks, then it glows like `<PxMark animated>`.
 * The animation lives in pixel-mark-intro.ts; it needs the browser, so it
 * starts on mount. The box keeps its square shape before then, so the page
 * doesn't jump.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { createPixelMarkIntro, type PixelMarkIntro } from "./pixel-mark-intro";

const props = withDefaults(defineProps<{ label?: string }>(), { label: "" });

const host = ref<HTMLElement>();
let intro: PixelMarkIntro | undefined;

onMounted(() => {
	if (host.value) intro = createPixelMarkIntro(host.value, props.label);
});
onBeforeUnmount(() => intro?.destroy());
</script>

<template>
	<div ref="host" class="px-mark-intro" />
</template>

<style scoped>
.px-mark-intro {
	width: 100%;
	aspect-ratio: 1;
}

/* The sparks fly a little past the mark, so nothing here clips them. */
.px-mark-intro :deep(.px-mark-intro__svg) {
	display: block;
	width: 100%;
	height: auto;
	overflow: visible;
}
</style>
