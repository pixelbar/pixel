<script setup lang="ts">
/** The lowest tier a command needs. The word is always shown; colour only repeats it. */
import { computed } from "vue";

const props = defineProps<{ tier: "guest" | "friend" | "member" | "admin" }>();
const label = computed(() => props.tier.charAt(0).toUpperCase() + props.tier.slice(1));
</script>

<template>
	<span class="px-tier" :class="`px-tier--${tier}`">{{ label }}</span>
</template>
