<script setup lang="ts">
/**
 * One slash command: its signature, the lowest tier, how it replies, what it needs
 * and its options. The description goes in the default slot (markdown works).
 */
import { computed } from "vue";
import PxTierBadge from "./PxTierBadge.vue";

const props = defineProps<{
	/** As Discord shows it: `/ha set device: state:`, `/info [topic:]` */
	sig: string;
	tier: "guest" | "friend" | "member" | "admin";
	reply: "private" | "public";
	/** Capabilities the command needs on top of the tier (any one of them). */
	caps?: string[];
	autocomplete?: boolean;
	/** Opens a form (a Discord modal) for long text. */
	form?: boolean;
	/** Option name (with its colon) → what it does. */
	options?: Record<string, string>;
}>();

type Part = { text: string; kind: "cmd" | "opt" | "optional" };

const CLASSES: Record<Part["kind"], string> = {
	cmd: "px-c-cmd",
	opt: "px-c-opt",
	optional: "px-c-opt-optional",
};

const parts = computed<Part[]>(() =>
	props.sig.split(/\s+/).map((text) => ({
		text,
		kind: text.startsWith("[") ? "optional" : text.endsWith(":") ? "opt" : "cmd",
	})),
);

const id = computed(() =>
	props.sig
		.split(/\s+/)
		.filter((word) => !word.endsWith(":") && !word.startsWith("["))
		.join("-")
		.replace(/^\//, "")
		.replace(/[^a-z0-9-]/gi, ""),
);
</script>

<template>
	<article :id="id" class="px-command">
		<div class="px-command__head">
			<code class="px-command__sig">
				<span v-for="(part, i) in parts" :key="i" :class="CLASSES[part.kind]">{{
					i > 0 ? ` ${part.text}` : part.text
				}}</span>
			</code>
			<PxTierBadge :tier="tier" />
		</div>
		<div class="px-command__desc"><slot /></div>
		<div class="px-command__meta">
			<span class="px-chip">{{ reply === "private" ? "Private reply" : "Public reply" }}</span>
			<span v-if="autocomplete" class="px-chip">Autocomplete</span>
			<span v-if="form" class="px-chip">Opens a form</span>
			<span v-for="cap in caps ?? []" :key="cap" class="px-chip">{{ cap }}</span>
		</div>
		<dl v-if="options && Object.keys(options).length > 0" class="px-command__opts">
			<template v-for="(text, name) in options" :key="name">
				<dt>{{ name }}</dt>
				<dd>{{ text }}</dd>
			</template>
		</dl>
	</article>
</template>
