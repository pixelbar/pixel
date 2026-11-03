<script setup lang="ts">
/**
 * A still picture of a form Pixel opens (a Discord modal): its title and fields, each
 * with its label and hint, in the order Pixel shows them. Copy the labels, hints and
 * choices from the feature (src/features/). Fields show their placeholder or a
 * made-up value; a radio group shows its choices with one picked.
 *
 * The caption is shown under the picture and read out instead of it.
 */
type Field = {
	label: string;
	hint?: string;
	kind: "text" | "paragraph" | "picker" | "radio";
	/** For text: the placeholder, or a value when `filled`. For a picker: what's picked. */
	value?: string;
	filled?: boolean;
	/** For a radio group: its choices, and which one is picked. */
	choices?: string[];
	picked?: string;
	optional?: boolean;
};

const props = defineProps<{ title: string; fields: Field[]; submit?: string; caption: string }>();
const { title, fields, caption } = props;
const submit = props.submit ?? "Submit";
</script>

<template>
	<figure class="px-modal">
		<div class="px-modal__frame" aria-hidden="true">
			<div class="px-modal__box">
				<p class="px-modal__title">{{ title }}</p>
				<div v-for="field in fields" :key="field.label" class="px-modal__field">
					<p class="px-modal__label">
						{{ field.label }}<span v-if="!field.optional" class="px-modal__required"> *</span>
					</p>
					<p v-if="field.hint" class="px-modal__hint">{{ field.hint }}</p>
					<div v-if="field.kind === 'radio'" class="px-modal__choices">
						<span v-for="choice in field.choices ?? []" :key="choice" class="px-modal__choice">
							<span
								class="px-modal__dot"
								:class="{ 'px-modal__dot--picked': choice === field.picked }"
							/>{{ choice }}
						</span>
					</div>
					<span
						v-else
						class="px-modal__input"
						:class="{
							'px-modal__input--paragraph': field.kind === 'paragraph',
							'px-modal__input--filled': field.filled || field.kind === 'picker',
						}"
					>
						<span>{{ field.value }}</span>
						<span v-if="field.kind === 'picker'" class="px-modal__chevron">▾</span>
					</span>
				</div>
				<div class="px-modal__actions">
					<span class="px-modal__cancel">Cancel</span>
					<span class="px-modal__submit">{{ submit }}</span>
				</div>
			</div>
		</div>
		<figcaption class="px-modal__caption">{{ caption }}</figcaption>
	</figure>
</template>

<style scoped>
.px-modal {
	margin: var(--space-6) 0;
}
.px-modal__frame {
	padding: var(--space-6) var(--space-4);
	background: var(--bg);
	border: 1px solid var(--border);
	box-shadow: var(--shadow-card);
}
.px-modal__box {
	max-width: 440px;
	margin: 0 auto;
	padding: var(--space-4);
	display: grid;
	gap: var(--space-4);
	background: var(--surface);
	border: 1px solid var(--border-strong);
}
.px-modal__title {
	margin: 0;
	color: var(--ink);
	font: 600 18px/24px var(--font-sans);
}
.px-modal__field {
	display: grid;
	gap: var(--space-1);
}
.px-modal__label {
	margin: 0;
	color: var(--ink);
	font: 600 14px/20px var(--font-sans);
}
.px-modal__required {
	color: var(--status-danger);
}
.px-modal__hint {
	margin: 0;
	color: var(--ink-muted);
	font-size: 13px;
	line-height: 18px;
}
.px-modal__input {
	display: flex;
	justify-content: space-between;
	gap: var(--space-2);
	padding: var(--space-2) var(--space-3);
	background: var(--bg);
	border: 1px solid var(--border);
	color: var(--ink-faint);
	font-size: 14px;
	line-height: 20px;
}
.px-modal__input--filled {
	color: var(--ink);
}
.px-modal__input--paragraph {
	min-height: 80px;
	align-items: flex-start;
}
.px-modal__chevron {
	color: var(--ink-faint);
	font-family: var(--font-mono);
}
.px-modal__choices {
	display: grid;
	gap: var(--space-1);
}
.px-modal__choice {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--ink);
	font-size: 14px;
	line-height: 20px;
}
.px-modal__dot {
	width: 12px;
	height: 12px;
	border: 2px solid var(--border-strong);
}
.px-modal__dot--picked {
	background: var(--core);
	border-color: var(--core);
}
.px-modal__actions {
	display: flex;
	justify-content: flex-end;
	gap: var(--space-2);
}
.px-modal__cancel,
.px-modal__submit {
	padding: var(--space-1) var(--space-3);
	font: 500 14px/24px var(--font-sans);
}
.px-modal__cancel {
	color: var(--ink);
}
.px-modal__submit {
	background: var(--core);
	color: var(--on-core);
}
.px-modal__caption {
	margin-top: var(--space-2);
	color: var(--ink-muted);
	font-size: 14px;
	line-height: 20px;
}

@media (max-width: 480px) {
	.px-modal__frame {
		padding: var(--space-2);
	}
}
</style>
