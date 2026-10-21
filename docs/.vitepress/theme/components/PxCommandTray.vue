<script setup lang="ts">
/**
 * A pretend Discord message box with its slash-command picker, showing what you
 * see when you type one of Pixel's commands. It types a query, filters the list,
 * steps the selection down it, then moves on to the next query. Everything moves
 * in whole steps. With reduced motion it shows one query, still.
 *
 * Give it a `query` and it's a still picture instead: that query typed, the list
 * filtered to it and one row selected. Use that in the docs, with a `caption`.
 *
 * Names and descriptions are the ones Pixel registers with Discord
 * (src/features/). Admin commands are left out on purpose.
 */
import { withBase } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

type Command = { name: string; description: string };

const props = withDefaults(
	defineProps<{
		/** What gets typed, in order. Each one ends with the list filtered to it. */
		queries?: string[];
		/** Most rows the picker shows at once. */
		rows?: number;
		/** A still picture of this one query, with no animation. */
		query?: string;
		/** In a still picture, which row is selected (-1 for none). */
		selected?: number;
		/** Shown under a still picture; read out instead of the picture either way. */
		caption?: string;
	}>(),
	{
		queries: () => ["/status", "/ha", "/info", "/schedule", "/events"],
		rows: 5,
		query: undefined,
		selected: 0,
		caption: undefined,
	},
);

const COMMANDS: readonly Command[] = [
	{
		name: "/fishbot say",
		description: "Try a classic Fishbot phrase (start typing for suggestions)",
	},
	{ name: "/fishbot trout", description: "Give someone a harmless slap with a large trout" },
	{ name: "/fishbot feed", description: "Feed Fishbot hundreds and thousands" },
	{ name: "/fishbot pet", description: "Give Fishbot a friendly stroke" },
	{ name: "/fishbot cookie", description: "Sneak a cookie away from Fishbot" },
	{ name: "/help", description: "List the commands you can use" },
	{ name: "/status", description: "Is Pixelbar open right now?" },
	{ name: "/events", description: "See what's coming up at Pixelbar" },
	{
		name: "/info",
		description: "Find out about Pixelbar: where, how to join, house rules and more",
	},
	{ name: "/whoami", description: "See what Pixel knows about you" },
	{ name: "/ping", description: "Check that Pixel is alive" },
	{
		name: "/feedback",
		description:
			"Send feedback to Pixel's maintainers. Your message and username may be made public",
	},
	{ name: "/closing-time", description: "Post the closing-time reminder" },
	{ name: "/ha list", description: "The devices you may use, and their state" },
	{ name: "/ha status", description: "The live state of one device" },
	{ name: "/ha set", description: "Change a device, such as switching a light on or off" },
	{ name: "/ha open", description: "Unlock a door" },
	{ name: "/schedule message", description: "Schedule a message" },
	{ name: "/schedule poll", description: "Schedule a poll" },
	{ name: "/schedule list", description: "See every scheduled post" },
	{ name: "/schedule edit", description: "Edit one of your scheduled posts before it goes out" },
	{ name: "/schedule preview", description: "See exactly what a scheduled post will look like" },
];

const root = ref<HTMLElement>();
const still = props.query !== undefined;
const typed = ref(props.query ?? props.queries[1] ?? props.queries[0] ?? "/");
const selected = ref(still ? props.selected : 0);

/** Like Discord: any word of the command that starts with what's typed. */
const matches = computed(() => {
	const query = typed.value.replace(/^\//, "").trim().toLowerCase();
	if (!query) return COMMANDS.slice(0, props.rows);
	return COMMANDS.filter((command) =>
		command.name
			.slice(1)
			.toLowerCase()
			.split(" ")
			.some((_, i, words) => words.slice(i).join(" ").startsWith(query)),
	).slice(0, props.rows);
});

const heading = computed(() =>
	typed.value.length > 1 ? `Commands matching ${typed.value}` : "Commands",
);

// ---------- The animation: a small script of timed steps ----------

const TYPE_MS = 110;
const DELETE_MS = 40;
const STEP_MS = 700;
const HOLD_MS = 1400;

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let observer: IntersectionObserver | undefined;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		timer = setTimeout(resolve, ms);
	});
}

async function play(): Promise<void> {
	if (running) return;
	running = true;
	let index = 0;
	while (running) {
		const query = props.queries[index % props.queries.length] ?? "/";
		// Type it, one character at a time.
		for (let n = 1; n <= query.length && running; n++) {
			typed.value = query.slice(0, n);
			selected.value = 0;
			await wait(TYPE_MS);
		}
		// Step the selection down the list, as the arrow keys would.
		for (let row = 0; row < matches.value.length && running; row++) {
			selected.value = row;
			await wait(row === 0 ? HOLD_MS : STEP_MS);
		}
		await wait(HOLD_MS / 2);
		// Clear it back to the slash.
		while (typed.value.length > 1 && running) {
			typed.value = typed.value.slice(0, -1);
			selected.value = 0;
			await wait(DELETE_MS);
		}
		index++;
	}
}

function stop(): void {
	running = false;
	if (timer) clearTimeout(timer);
}

onMounted(() => {
	if (still || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	// Only animate while it's on screen.
	observer = new IntersectionObserver(([entry]) => {
		if (entry?.isIntersecting) void play();
		else stop();
	});
	if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
	stop();
	observer?.disconnect();
});

const avatar = withBase("/pixel-mark-96.png");
</script>

<template>
	<figure ref="root" class="px-tray" :class="{ 'px-tray--still': still }">
		<figcaption class="px-tray__caption" :class="{ 'px-tray__caption--shown': still && caption }">
			<template v-if="caption">{{ caption }}</template>
			<template v-else>
				Typing a slash in Discord lists Pixel's commands, such as /status, /ha, /info and
				/schedule, with a short description of each.
			</template>
		</figcaption>
		<div class="px-tray__frame" aria-hidden="true">
			<div class="px-tray__picker">
				<p class="px-tray__heading">{{ heading }}</p>
				<ul class="px-tray__list">
					<li
						v-for="(command, i) in matches"
						:key="command.name"
						class="px-tray__row"
						:class="{ 'px-tray__row--selected': i === selected }"
					>
						<img class="px-tray__avatar" :src="avatar" alt="" width="40" height="40" />
						<span class="px-tray__text">
							<span class="px-tray__name">{{ command.name }}</span>
							<span class="px-tray__description">{{ command.description }}</span>
						</span>
						<span class="px-tray__app">Pixel</span>
					</li>
				</ul>
			</div>
			<div class="px-tray__input">
				<span class="px-tray__plus">+</span>
				<span class="px-tray__typed">{{ typed }}<span class="px-tray__caret" /></span>
			</div>
		</div>
	</figure>
</template>

<style scoped>
.px-tray {
	margin: 0;
	display: flex;
	flex-direction: column-reverse;
}
.px-tray--still {
	margin: var(--space-6) 0;
}
.px-tray--still .px-tray__frame {
	min-height: 0;
}
.px-tray__caption {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}
.px-tray__caption--shown {
	position: static;
	width: auto;
	height: auto;
	clip-path: none;
	white-space: normal;
	margin-top: var(--space-2);
	color: var(--ink-muted);
	font-size: 14px;
	line-height: 20px;
}

/* Fixed height so the page never jumps: the picker grows up from the input. */
.px-tray__frame {
	display: flex;
	flex-direction: column;
	justify-content: flex-end;
	gap: var(--space-2);
	min-height: 456px;
	padding: var(--space-4);
	background: var(--bg);
	box-shadow: var(--shadow-card);
	border: 1px solid var(--border);
}

.px-tray__picker {
	padding: var(--space-3) var(--space-2) var(--space-2);
	background: var(--surface);
	border: 1px solid var(--border);
}
.px-tray__heading {
	margin: 0 var(--space-2) var(--space-2);
	color: var(--ink-faint);
	font: 500 12px/16px var(--font-mono);
	letter-spacing: 0.08em;
	text-transform: uppercase;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.px-tray__list {
	margin: 0;
	padding: 0;
	list-style: none;
}
.px-tray__row {
	margin: 0;
	display: grid;
	grid-template-columns: 40px minmax(0, 1fr) auto;
	gap: var(--space-3);
	align-items: center;
	padding: var(--space-2);
}
.px-tray__row--selected {
	background: var(--surface-raised);
	box-shadow: inset 4px 0 0 var(--spectrum-magenta);
}
.px-tray__avatar {
	display: block;
	width: 40px;
	height: 40px;
	background: var(--void);
}
.px-tray__text {
	display: grid;
	min-width: 0;
}
.px-tray__name {
	color: var(--ink);
	font: 600 16px/22px var(--font-sans);
}
.px-tray__description {
	color: var(--ink-muted);
	font-size: 14px;
	line-height: 20px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.px-tray__app {
	color: var(--ink-faint);
	font-size: 14px;
}

.px-tray__input {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	padding: var(--space-3) var(--space-4);
	background: var(--surface);
	border: 1px solid var(--border-strong);
}
.px-tray__plus {
	display: grid;
	place-items: center;
	width: 24px;
	height: 24px;
	background: var(--ink-faint);
	color: var(--surface);
	font: 600 18px/1 var(--font-mono);
}
.px-tray__typed {
	color: var(--ink);
	font: 400 16px/24px var(--font-sans);
	white-space: pre;
}
.px-tray__caret {
	display: inline-block;
	width: 2px;
	height: 20px;
	margin-left: 1px;
	vertical-align: -4px;
	background: var(--ink);
}
@media (prefers-reduced-motion: no-preference) {
	.px-tray__caret {
		animation: px-tray-blink 1s steps(1, end) infinite;
	}
}
.px-tray--still .px-tray__caret {
	animation: none;
}
@keyframes px-tray-blink {
	50% {
		opacity: 0;
	}
}

@media (max-width: 480px) {
	.px-tray__frame {
		padding: var(--space-2);
	}
	.px-tray__app {
		display: none;
	}
	.px-tray__row {
		grid-template-columns: 32px minmax(0, 1fr);
	}
	.px-tray__avatar {
		width: 32px;
		height: 32px;
	}
}
</style>
