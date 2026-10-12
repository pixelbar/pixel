<script setup lang="ts">
/**
 * Whether Pixelbar is open, read live from the SpaceAPI the way `/status` does.
 * The word is always written; the dot only repeats it. If the SpaceAPI can't be
 * read from the browser, it says so instead of guessing.
 */
import { onMounted, ref } from "vue";

const SPACEAPI = "https://spaceapi.pixelbar.nl/";

type State = "checking" | "open" | "closed" | "unknown";
const state = ref<State>("checking");
const since = ref<string>();

function forHowLong(lastChange: number): string | undefined {
	const minutes = Math.floor((Date.now() / 1000 - lastChange) / 60);
	if (!Number.isFinite(minutes) || minutes < 0) return undefined;
	if (minutes < 60) return `for ${Math.max(minutes, 1)} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `for ${hours}h`;
	return `for ${Math.floor(hours / 24)} days`;
}

onMounted(async () => {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		const response = await fetch(SPACEAPI, { signal: controller.signal });
		clearTimeout(timer);
		const body: unknown = await response.json();
		const reading = (body as { state?: { open?: unknown; lastchange?: unknown } }).state;
		if (typeof reading?.open !== "boolean") {
			state.value = "unknown";
			return;
		}
		state.value = reading.open ? "open" : "closed";
		if (typeof reading.lastchange === "number") since.value = forHowLong(reading.lastchange);
	} catch {
		state.value = "unknown";
	}
});
</script>

<template>
	<span
		class="px-status"
		:class="{ 'px-status--open': state === 'open', 'px-status--closed': state === 'closed' }"
		role="status"
		aria-live="polite"
	>
		<template v-if="state === 'checking'">Checking…</template>
		<template v-else-if="state === 'open'">Pixelbar is open <small v-if="since">{{ since }}</small></template>
		<template v-else-if="state === 'closed'">Pixelbar is closed <small v-if="since">{{ since }}</small></template>
		<template v-else>Status unknown <small>ask <code>/status</code> in Discord</small></template>
	</span>
</template>
