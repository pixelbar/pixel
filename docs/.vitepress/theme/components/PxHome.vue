<script setup lang="ts">
/** The landing page. Copy follows the design system's voice: plain, friendly, exact. */
import { withBase } from "vitepress";
import PxMark from "./PxMark.vue";
import PxSpectrum from "./PxSpectrum.vue";
import PxStatus from "./PxStatus.vue";
import PxTierBadge from "./PxTierBadge.vue";

const features = [
	{
		eyebrow: "Space",
		title: "Is the space open?",
		body: "/status reads the switch in the space and tells you whether Pixelbar is open, and for how long.",
		link: "/commands#status",
	},
	{
		eyebrow: "Events",
		title: "What's coming up?",
		body: "/events lists what's on at Pixelbar, from the Discord server's scheduled events.",
		link: "/commands#events",
	},
	{
		eyebrow: "Info",
		title: "How do I join?",
		body: "/info gives short answers about Pixelbar: where it is, visiting, membership and the house rules.",
		link: "/commands#info",
	},
	{
		eyebrow: "Announcements",
		title: "Know when it opens",
		body: "Pixel posts in Discord when the space opens and closes, and can toot it on Mastodon too.",
		link: "/guide/#announcements",
	},
	{
		eyebrow: "Home",
		title: "Lights, switches and doors",
		body: "Friends and members can check and change the Home Assistant devices they're allowed to use.",
		link: "/commands#home-assistant",
	},
	{
		eyebrow: "Scheduling",
		title: "Posts on a schedule",
		body: "People with the schedule-posts capability can schedule messages and polls, once or on a repeat.",
		link: "/commands#scheduled-posts",
	},
];

const tiers = [
	{ tier: "guest", text: "Everyone. Ask about the space, what's on and Pixelbar itself." },
	{
		tier: "friend",
		text: "A paid friend-of-Pixelbar membership. Adds Home Assistant devices opened to friends.",
	},
	{
		tier: "member",
		text: "A paid Pixelbar membership. Adds closing time, and doors with a capability.",
	},
	{ tier: "admin", text: "Pixel's operators. Manage levels, capabilities and Pixel itself." },
] as const;
</script>

<template>
	<div class="px-home">
		<section class="hero">
			<div class="hero__words">
				<p class="eyebrow">Pixelbar hackerspace · Rotterdam</p>
				<h1 class="hero__name">Pixel</h1>
				<p class="hero__lead">
					The assistant bot for the Pixelbar hackerspace. Ask whether the space is open, see
					what's on and get answers about Pixelbar, right in Discord.
				</p>
				<PxStatus />
				<div class="hero__actions">
					<a class="px-btn px-btn--primary" :href="withBase('/commands')">See the commands</a>
					<a class="px-btn px-btn--secondary" :href="withBase('/guide/')">Get started</a>
				</div>
			</div>
			<div class="hero__art">
				<PxMark animated label="The Pixel mark: a pixel star with rainbow orbits" />
			</div>
		</section>

		<PxSpectrum />

		<section class="section">
			<h2 class="heading">What Pixel does</h2>
			<div class="cards">
				<article v-for="feature in features" :key="feature.title" class="px-card">
					<p class="px-card__eyebrow">{{ feature.eyebrow }}</p>
					<h3 class="px-card__title">{{ feature.title }}</h3>
					<p class="px-card__body">{{ feature.body }}</p>
					<a class="px-link" :href="withBase(feature.link)">Read more</a>
				</article>
			</div>
		</section>

		<section class="section split">
			<div>
				<h2 class="heading">Try it in Discord</h2>
				<p class="lead">
					Type <code class="px-inline-code">/</code> in the Pixelbar Discord and pick a command.
					Replies that are about you are private: only you can see them.
				</p>
				<a class="px-link" :href="withBase('/guide/')">How to use Pixel</a>
			</div>
			<div class="px-code">
				<div class="px-code__bar"><span>Discord</span><span>Slash commands</span></div>
				<pre><span class="px-c-cmd">/status</span>                    <span class="px-c-cmt"># is Pixelbar open right now?</span>
<span class="px-c-cmd">/events</span>                    <span class="px-c-cmt"># what's coming up</span>
<span class="px-c-cmd">/info</span> <span class="px-c-opt">topic:</span><span class="px-c-val">membership</span>     <span class="px-c-cmt"># how to join</span>
<span class="px-c-cmd">/whoami</span>                    <span class="px-c-cmt"># your tier and Discord ID</span>
<span class="px-c-cmd">/help</span>                      <span class="px-c-cmt"># what you can use</span></pre>
			</div>
		</section>

		<section class="section">
			<h2 class="heading">Who can do what</h2>
			<p class="lead">
				What you can do depends on your tier. Some commands also need a capability, which an
				admin gives to one person at a time.
			</p>
			<ul class="tiers">
				<li v-for="row in tiers" :key="row.tier">
					<PxTierBadge :tier="row.tier" />
					<span>{{ row.text }}</span>
				</li>
			</ul>
			<a class="px-link" :href="withBase('/guide/tiers')">Tiers and capabilities</a>
		</section>

		<section class="section">
			<h2 class="heading">Run it, build it</h2>
			<div class="cards cards--two">
				<article class="px-card">
					<p class="px-card__eyebrow">Maintainers</p>
					<h3 class="px-card__title">Keeping Pixel running</h3>
					<p class="px-card__body">
						The runbook covers access lists, moderation, deploys, secrets and what to do when
						Pixel is down.
					</p>
					<a class="px-link" :href="withBase('/maintainers/runbook')">Operations runbook</a>
				</article>
				<article class="px-card">
					<p class="px-card__eyebrow">Contributors</p>
					<h3 class="px-card__title">How Pixel is built</h3>
					<p class="px-card__body">
						TypeScript on Node.js, one dispatcher for every command, and tiers from two files.
						The source is on GitHub.
					</p>
					<a class="px-link" :href="withBase('/maintainers/architecture')">Architecture</a>
				</article>
			</div>
		</section>

		<PxSpectrum />
	</div>
</template>

<style scoped>
.px-home {
	--gutter: var(--space-4);
	max-width: calc(1152px + 2 * var(--gutter));
	margin: 0 auto;
	padding: 0 var(--gutter);
}
@media (min-width: 640px) {
	.px-home {
		--gutter: var(--space-12);
	}
}

.eyebrow {
	margin: 0 0 var(--space-3);
	color: var(--spectrum-magenta);
	font: 500 12px/16px var(--font-mono);
	letter-spacing: 0.08em;
	text-transform: uppercase;
}

.hero {
	display: grid;
	gap: var(--space-8);
	align-items: center;
	padding: var(--space-12) 0 var(--space-12);
}
@media (min-width: 960px) {
	.hero {
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		padding: var(--space-16) 0;
	}
}
.hero__name {
	margin: 0;
	font: 600 72px/72px var(--font-display);
	letter-spacing: -0.01em;
	color: var(--ink);
}
@media (min-width: 960px) {
	.hero__name {
		font-size: 120px;
		line-height: 112px;
	}
}
.hero__lead {
	max-width: 540px;
	margin: var(--space-4) 0 var(--space-6);
	font-size: 18px;
	line-height: 30px;
	color: var(--ink-muted);
}
.hero__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-3);
	margin-top: var(--space-8);
}
.hero__art {
	max-width: 480px;
	width: 100%;
	justify-self: center;
}

.px-home > .px-spectrum {
	margin: 0 calc(var(--gutter) * -1);
}

.section {
	padding: var(--space-12) 0;
}
.heading {
	margin: 0 0 var(--space-8);
	font: 500 28px/32px var(--font-display);
	color: var(--ink);
}
.lead {
	max-width: 720px;
	margin: calc(var(--space-8) * -0.5) 0 var(--space-6);
	font-size: 18px;
	line-height: 30px;
	color: var(--ink-muted);
}

.cards {
	display: grid;
	gap: var(--space-6);
}
@media (min-width: 640px) {
	.cards {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
}
@media (min-width: 960px) {
	.cards {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}
	.cards--two {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
}
.px-card__title {
	letter-spacing: 0;
}

.split {
	display: grid;
	gap: var(--space-8);
	align-items: center;
}
@media (min-width: 960px) {
	.split {
		grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
	}
}
.split > * {
	min-width: 0;
}
.split .lead {
	margin-top: 0;
}

.tiers {
	display: grid;
	gap: var(--space-3);
	margin: 0 0 var(--space-6);
	padding: 0;
	list-style: none;
}
.tiers li {
	display: grid;
	grid-template-columns: 104px 1fr;
	gap: var(--space-4);
	align-items: center;
	color: var(--ink);
}
.tiers .px-tier {
	justify-self: start;
}

.px-home > .px-spectrum:last-child {
	margin-top: var(--space-4);
}
</style>
