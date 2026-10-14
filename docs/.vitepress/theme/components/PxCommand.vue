<script setup lang="ts">
/**
 * One slash command: its signature, the lowest tier, how it replies, what it needs
 * and its options. The description goes in the default slot (markdown works).
 */
import { computed, onBeforeUnmount, ref } from "vue";
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

const REPLY = {
	public: {
		label: "Public reply",
		hint: "Everyone in the channel sees the reply, and that you used the command.",
	},
	private: {
		label: "Private reply",
		hint: "Only you see the reply.",
	},
} as const;

const parts = computed<Part[]>(() =>
	props.sig.split(/\s+/).map((text) => ({
		text,
		kind: text.startsWith("[") ? "optional" : text.endsWith(":") ? "opt" : "cmd",
	})),
);

/** The command without its options, as you'd type it: `/ha set`. */
const name = computed(() =>
	parts.value
		.filter((part) => part.kind === "cmd")
		.map((part) => part.text)
		.join(" "),
);

const id = computed(() =>
	name.value
		.split(" ")
		.join("-")
		.replace(/^\//, "")
		.replace(/[^a-z0-9-]/gi, ""),
);

const caps = computed(() => props.caps ?? []);

const copyState = ref<"idle" | "copied" | "failed">("idle");
let resetTimer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
	try {
		await navigator.clipboard.writeText(name.value);
		copyState.value = "copied";
	} catch {
		copyState.value = "failed";
	}
	clearTimeout(resetTimer);
	resetTimer = setTimeout(() => {
		copyState.value = "idle";
	}, 2000);
}

onBeforeUnmount(() => clearTimeout(resetTimer));
</script>

<template>
	<article :id="id" class="px-command">
		<div class="px-command__head">
			<code class="px-command__sig">
				<span v-for="(part, i) in parts" :key="i" :class="CLASSES[part.kind]">{{
					i > 0 ? ` ${part.text}` : part.text
				}}</span>
			</code>
			<div class="px-command__actions">
				<button
					type="button"
					class="px-btn px-btn--ghost px-btn--sm px-command__copy"
					:aria-label="`Copy ${name}`"
					@click="copy"
				>
					{{ copyState === "copied" ? "Copied" : copyState === "failed" ? "Couldn't copy" : "Copy" }}
				</button>
				<PxTierBadge :tier="tier" />
			</div>
		</div>
		<div class="px-command__desc"><slot /></div>
		<div class="px-command__meta">
			<span class="px-chip px-chip--marked" :class="`px-chip--${reply}`" :title="REPLY[reply].hint">{{
				REPLY[reply].label
			}}</span>
			<span
				v-if="caps.length > 0"
				class="px-chip px-chip--marked px-chip--cap"
				title="A capability an admin grants on top of your tier. Any one of these will do."
				>Needs {{ caps.join(" or ") }}</span
			>
			<span v-if="autocomplete" class="px-chip">Autocomplete</span>
			<span v-if="form" class="px-chip">Opens a form</span>
		</div>
		<dl v-if="options && Object.keys(options).length > 0" class="px-command__opts">
			<template v-for="(text, opt) in options" :key="opt">
				<dt>{{ opt }}</dt>
				<dd>{{ text }}</dd>
			</template>
		</dl>
		<span class="px-visually-hidden" aria-live="polite">{{
			copyState === "copied" ? `Copied ${name}` : copyState === "failed" ? `Couldn't copy ${name}` : ""
		}}</span>
	</article>
</template>
