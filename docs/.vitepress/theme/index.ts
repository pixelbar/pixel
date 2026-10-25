/**
 * The Pixel theme: VitePress's default theme dressed in the Pixel design system.
 * Square pixels on a 4px grid, the logo's spectrum for meaning, dark emits and
 * light prints.
 */
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import PxCommand from "./components/PxCommand.vue";
import PxCommandTray from "./components/PxCommandTray.vue";
import PxHome from "./components/PxHome.vue";
import PxMark from "./components/PxMark.vue";
import PxMarkIntro from "./components/PxMarkIntro.vue";
import PxMermaid from "./components/PxMermaid.vue";
import PxSpectrum from "./components/PxSpectrum.vue";
import PxStatus from "./components/PxStatus.vue";
import PxTierBadge from "./components/PxTierBadge.vue";
// Fonts are self-hosted (no request to Google from a visitor's browser).
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/400-italic.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/pixelify-sans/500.css";
import "@fontsource/pixelify-sans/600.css";
import "./styles/tokens.css";
import "./styles/vitepress.css";
import "./styles/components.css";

export default {
	extends: DefaultTheme,
	enhanceApp({ app }) {
		app.component("PxCommand", PxCommand);
		app.component("PxCommandTray", PxCommandTray);
		app.component("PxHome", PxHome);
		app.component("PxMark", PxMark);
		app.component("PxMarkIntro", PxMarkIntro);
		app.component("PxMermaid", PxMermaid);
		app.component("PxSpectrum", PxSpectrum);
		app.component("PxStatus", PxStatus);
		app.component("PxTierBadge", PxTierBadge);
	},
} satisfies Theme;
