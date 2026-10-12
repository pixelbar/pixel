<script setup lang="ts">
/**
 * The Pixel mark, drawn as pixel art from the logo. It takes its colours from the
 * --mark-* tokens: in dark it glows like the logo, in light it prints in ink.
 *
 * `animated` adds the hero's motion, all in whole steps: a light runs round the
 * orbits, the particles twinkle and, in dark, the star breathes. Reduced motion
 * turns all of it off.
 */
import { useId } from "vue";
import { MARK_LAYERS, MARK_SECTORS, MARK_SIZE, MARK_SWEEP } from "./pixel-mark";

withDefaults(defineProps<{ animated?: boolean; label?: string }>(), {
	animated: false,
	label: "",
});

const glowId = `px-mark-glow-${useId()}`;
const parts = ["orbit", "particle", "star"] as const;
const layersOf = (part: (typeof parts)[number]) =>
	MARK_LAYERS.filter((layer) => layer.part === part);
</script>

<template>
	<svg
		class="px-mark"
		:class="{ 'px-mark--animated': animated }"
		:viewBox="`0 0 ${MARK_SIZE} ${MARK_SIZE}`"
		shape-rendering="crispEdges"
		:role="label ? 'img' : undefined"
		:aria-label="label || undefined"
		:aria-hidden="label ? undefined : 'true'"
		focusable="false"
		:style="{ '--px-mark-glow': `url(#${glowId})`, '--px-mark-sectors': MARK_SECTORS }"
	>
		<defs>
			<!-- The logo's neon: each pixel's own colour, blurred and laid under it. -->
			<filter :id="glowId" x="-20%" y="-20%" width="140%" height="140%">
				<feGaussianBlur in="SourceGraphic" stdDeviation="1.1" result="blur" />
				<feMerge>
					<feMergeNode in="blur" />
					<feMergeNode in="blur" />
					<feMergeNode in="SourceGraphic" />
				</feMerge>
			</filter>
		</defs>
		<g class="px-mark__art">
			<g v-for="part in parts" :key="part" :class="`px-mark__${part}`">
				<path
					v-for="(layer, i) in layersOf(part)"
					:key="i"
					:d="layer.d"
					:fill="`var(--mark-${layer.color})`"
					:fill-opacity="layer.dim ? 0.55 : undefined"
					:class="layer.twinkle !== undefined ? `px-mark__twinkle-${layer.twinkle}` : undefined"
				/>
			</g>
			<g v-if="animated" class="px-mark__sweep">
				<path
					v-for="(d, i) in MARK_SWEEP"
					:key="i"
					:d="d"
					fill="var(--mark-shine)"
					:style="{ '--i': i }"
				/>
			</g>
		</g>
	</svg>
</template>

<style scoped>
.px-mark {
	display: block;
	width: 100%;
	height: auto;
	overflow: visible;
}

.px-mark__sweep path {
	opacity: 0;
}

@media (prefers-reduced-motion: no-preference) {
	/* A light runs round the orbits, one slice of the circle at a time. */
	.px-mark--animated .px-mark__sweep path {
		animation: px-mark-sweep 2.4s steps(1, end) infinite;
		animation-delay: calc(var(--i) * 2.4s / var(--px-mark-sectors));
	}
	.px-mark--animated .px-mark__twinkle-0 {
		animation: px-mark-twinkle 1.8s steps(1, end) infinite;
	}
	.px-mark--animated .px-mark__twinkle-1 {
		animation: px-mark-twinkle 1.8s steps(1, end) -0.6s infinite;
	}
	.px-mark--animated .px-mark__twinkle-2 {
		animation: px-mark-twinkle 1.8s steps(1, end) -1.2s infinite;
	}
}

@keyframes px-mark-sweep {
	0% {
		opacity: 0.85;
	}
	8.33% {
		opacity: 0.35;
	}
	16.67%,
	100% {
		opacity: 0;
	}
}
@keyframes px-mark-twinkle {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.25;
	}
}
</style>

<style>
/* Theme rules live outside the scoped block so `.dark` on <html> can reach them. */

/* In light the shine is a highlight on ink, not a flash. */
.px-mark__sweep {
	opacity: 0.6;
}
.dark .px-mark__sweep {
	opacity: 1;
}

/* Dark emits: the logo's glow. Light prints: none. */
.dark .px-mark__art {
	filter: var(--px-mark-glow);
}

@media (prefers-reduced-motion: no-preference) {
	.dark .px-mark--animated .px-mark__star {
		animation: px-mark-breathe 2.4s steps(1, end) infinite;
	}
}

@keyframes px-mark-breathe {
	0%,
	100% {
		filter: none;
	}
	50% {
		filter: drop-shadow(0 0 2px var(--mark-shine));
	}
}
</style>
