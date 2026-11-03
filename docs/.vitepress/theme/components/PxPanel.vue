<script setup lang="ts">
/**
 * A still picture of one of Pixel's private replies with buttons and menus: what you
 * see after running a command that opens a panel (`/schedule`, `/park`). The text
 * and controls copy what the command really shows (src/features/), with made-up
 * channels, spots and times. `**bold**` in a line is shown bold; nothing else is
 * markdown.
 *
 * The caption is shown under the picture and read out instead of it.
 */
import { withBase } from "vitepress";

type Button = {
	label: string;
	style?: "primary" | "secondary" | "success" | "danger";
	disabled?: boolean;
};
type Select = { select: string };
type Field = { name: string; value: string; inline?: boolean };
type Embed = { title?: string; lines?: string[]; fields?: Field[] };

const props = defineProps<{
	/** The command that opened it, as typed: `/park`. */
	command: string;
	/** Message text above the embeds, such as the post a draft will make. */
	content?: string[];
	embeds?: Embed[];
	/** Rows of buttons, or one menu each. */
	rows?: (Button | Select)[][];
	caption: string;
}>();

type Part = { text: string; bold: boolean };

/** Splits a line on `**`, so every other part is bold. */
function parts(line: string): Part[] {
	return line.split("**").map((text, i) => ({ text, bold: i % 2 === 1 }));
}

const isSelect = (control: Button | Select): control is Select => "select" in control;

const avatar = withBase("/pixel-mark-96.png");
// Read once, so the template stays simple.
const { command, content, embeds, rows, caption } = props;
</script>

<template>
	<figure class="px-panel">
		<div class="px-panel__frame" aria-hidden="true">
			<p class="px-panel__used">
				<span class="px-panel__you">You</span> used <span class="px-panel__command">{{ command }}</span>
			</p>
			<div class="px-panel__message">
				<img class="px-panel__avatar" :src="avatar" alt="" width="40" height="40" />
				<div class="px-panel__body">
					<p class="px-panel__author">
						<span class="px-panel__name">Pixel</span>
						<span class="px-panel__app">App</span>
					</p>
					<p v-for="(line, i) in content ?? []" :key="`c${i}`" class="px-panel__text">
						<template v-for="(part, j) in parts(line)" :key="j">
							<strong v-if="part.bold">{{ part.text }}</strong>
							<template v-else>{{ part.text }}</template>
						</template>
					</p>
					<div v-for="(embed, i) in embeds ?? []" :key="`e${i}`" class="px-panel__embed">
						<p v-if="embed.title" class="px-panel__title">{{ embed.title }}</p>
						<p
							v-for="(line, j) in embed.lines ?? []"
							:key="j"
							class="px-panel__line"
							:class="{ 'px-panel__line--gap': line === '' }"
						>
							<template v-for="(part, k) in parts(line)" :key="k">
								<strong v-if="part.bold">{{ part.text }}</strong>
								<template v-else>{{ part.text }}</template>
							</template>
						</p>
						<dl v-if="embed.fields" class="px-panel__fields">
							<div
								v-for="field in embed.fields"
								:key="field.name"
								class="px-panel__field"
								:class="{ 'px-panel__field--inline': field.inline }"
							>
								<dt>{{ field.name }}</dt>
								<dd>{{ field.value }}</dd>
							</div>
						</dl>
					</div>
					<div v-for="(row, i) in rows ?? []" :key="`r${i}`" class="px-panel__row">
						<template v-for="(control, j) in row" :key="j">
							<span v-if="isSelect(control)" class="px-panel__select">
								<span>{{ control.select }}</span>
								<span class="px-panel__chevron">▾</span>
							</span>
							<span
								v-else
								class="px-panel__button"
								:class="[
									`px-panel__button--${control.style ?? 'secondary'}`,
									{ 'px-panel__button--disabled': control.disabled },
								]"
								>{{ control.label }}</span
							>
						</template>
					</div>
					<p class="px-panel__only">Only you can see this · Dismiss message</p>
				</div>
			</div>
		</div>
		<figcaption class="px-panel__caption">{{ caption }}</figcaption>
	</figure>
</template>

<style scoped>
.px-panel {
	margin: var(--space-6) 0;
}
.px-panel__frame {
	padding: var(--space-4);
	background: var(--bg);
	border: 1px solid var(--border);
	box-shadow: var(--shadow-card);
}
.px-panel__used {
	margin: 0 0 var(--space-2) 52px;
	color: var(--ink-faint);
	font-size: 14px;
	line-height: 20px;
}
.px-panel__you,
.px-panel__command {
	color: var(--ink-muted);
	font-weight: 600;
}
.px-panel__message {
	display: grid;
	grid-template-columns: 40px minmax(0, 1fr);
	gap: var(--space-3);
}
.px-panel__avatar {
	display: block;
	width: 40px;
	height: 40px;
	background: var(--void);
}
.px-panel__body {
	display: grid;
	gap: var(--space-2);
	min-width: 0;
}
.px-panel__author {
	margin: 0;
	display: flex;
	align-items: center;
	gap: var(--space-2);
}
.px-panel__name {
	color: var(--ink);
	font: 600 16px/22px var(--font-sans);
}
.px-panel__app {
	padding: 0 var(--space-1);
	background: var(--surface-raised);
	color: var(--ink-muted);
	font: 500 12px/16px var(--font-mono);
	text-transform: uppercase;
}
.px-panel__text {
	margin: 0;
	color: var(--ink);
	font-size: 15px;
	line-height: 22px;
}
.px-panel__embed {
	max-width: 520px;
	padding: var(--space-3) var(--space-4);
	background: var(--surface);
	border: 1px solid var(--border);
}
.px-panel__title {
	margin: 0 0 var(--space-1);
	color: var(--ink);
	font: 600 15px/22px var(--font-sans);
}
.px-panel__line {
	margin: 0;
	color: var(--ink-muted);
	font-size: 14px;
	line-height: 20px;
}
.px-panel__line strong,
.px-panel__text strong {
	color: var(--ink);
	font-weight: 600;
}
.px-panel__line--gap {
	height: var(--space-2);
}
.px-panel__fields {
	margin: var(--space-2) 0 0;
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2) var(--space-6);
}
.px-panel__field {
	flex: 1 1 100%;
}
.px-panel__field--inline {
	flex: 0 1 auto;
}
.px-panel__field dt {
	color: var(--ink);
	font: 600 13px/18px var(--font-sans);
}
.px-panel__field dd {
	margin: 0;
	color: var(--ink-muted);
	font-size: 14px;
	line-height: 20px;
}
.px-panel__row {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}
.px-panel__button {
	padding: var(--space-1) var(--space-3);
	font: 500 14px/24px var(--font-sans);
	white-space: nowrap;
}
.px-panel__button--primary {
	background: var(--core);
	color: var(--on-core);
}
.px-panel__button--secondary {
	background: var(--surface-raised);
	color: var(--ink);
	border: 1px solid var(--border-strong);
}
.px-panel__button--success {
	background: var(--status-success);
	color: var(--on-spectrum);
}
.px-panel__button--danger {
	background: var(--status-danger);
	color: var(--on-spectrum);
}
.px-panel__button--disabled {
	opacity: 0.45;
}
.px-panel__select {
	flex: 1 1 100%;
	max-width: 520px;
	display: flex;
	justify-content: space-between;
	gap: var(--space-2);
	padding: var(--space-2) var(--space-3);
	background: var(--surface);
	border: 1px solid var(--border-strong);
	color: var(--ink-muted);
	font-size: 14px;
	line-height: 20px;
}
.px-panel__chevron {
	color: var(--ink-faint);
	font-family: var(--font-mono);
}
.px-panel__only {
	margin: 0;
	color: var(--ink-faint);
	font-size: 12px;
	line-height: 16px;
}
.px-panel__caption {
	margin-top: var(--space-2);
	color: var(--ink-muted);
	font-size: 14px;
	line-height: 20px;
}

@media (max-width: 480px) {
	.px-panel__frame {
		padding: var(--space-2);
	}
	.px-panel__used {
		margin-left: 0;
	}
	.px-panel__message {
		grid-template-columns: minmax(0, 1fr);
	}
	.px-panel__avatar {
		display: none;
	}
	.px-panel__button {
		white-space: normal;
	}
}
</style>
