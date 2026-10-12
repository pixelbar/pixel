<script setup lang="ts">
/** The logo's eight hues as solid blocks, in the order they go round the mark. */
defineProps<{ stepped?: boolean }>();
</script>

<template>
	<div class="px-spectrum" :class="{ 'px-spectrum--stepped': stepped }" role="presentation">
		<span v-for="n in 8" :key="n" />
	</div>
</template>
