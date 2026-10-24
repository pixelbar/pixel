/**
 * The Pixel mark's entrance, as in the launch video: its pixels fly in and snap
 * together on the grid, it lights up with a burst of sparks, then it keeps
 * glowing while a light runs round the orbits, the particles twinkle and, in
 * dark, the star breathes. `<PxMarkIntro>` wraps it for the landing page.
 *
 * It draws the same art as `<PxMark>` (pixel-mark.ts) into one <svg>, coloured
 * from the --mark-* tokens, with sparks from --spectrum-*. Dark emits, light
 * prints: it glows only while <html> has `.dark`, and follows the theme switch.
 *
 * Motion is in whole steps on a 30 fps clock. It plays the first time it
 * scrolls into view and pauses while off screen. Reduced motion shows the
 * finished mark, still.
 */
import { MARK_LAYERS, MARK_SECTORS, MARK_SIZE, MARK_SWEEP, type MarkColor } from "./pixel-mark";

const SVG = "http://www.w3.org/2000/svg";
const FPS = 30;
const SPECTRUM = ["cyan", "blue", "violet", "magenta", "red", "orange", "yellow", "green"] as const;

/** Frames one pixel takes to fly in. */
const FLIGHT = 16;
/** The light round the orbits: 2.4 s, as on `<PxMark animated>`. */
const SWEEP_CYCLE = 72;
const SPARKS = 36;
const SPARK_LIFE = 30;

export type PixelMarkIntro = { play(): void; destroy(): void };

type Pixel = {
	x: number;
	y: number;
	color: MarkColor;
	dim: boolean;
	delay: number;
	fromX: number;
	fromY: number;
};

/** Deterministic pseudo-random in [0, 1), so every visit looks the same. */
function rand(seed: number): number {
	const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return x - Math.floor(x);
}

/** Every pixel of the mark, with where it flies in from and when it sets off. */
const PIXELS: Pixel[] = (() => {
	const out: Pixel[] = [];
	let seed = 1;
	for (const layer of MARK_LAYERS) {
		for (const m of layer.d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
			const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
			for (let i = 0; i < w; i++) {
				const dx = x + i - 32;
				const dy = y - 32;
				const angle = Math.atan2(dy, dx) + (rand(seed + 7) - 0.5) * 1.2;
				const reach = 18 + rand(seed + 3) * 40;
				out.push({
					x: x + i,
					y,
					color: layer.color,
					dim: layer.dim,
					delay: Math.sqrt(dx * dx + dy * dy) * 0.55 + rand(seed) * 6,
					fromX: Math.cos(angle) * reach,
					fromY: Math.sin(angle) * reach,
				});
				seed++;
			}
		}
	}
	return out;
})();

/** Every pixel is home: switch to the lighter, path-based art. */
const SETTLED = Math.ceil(Math.max(...PIXELS.map((p) => p.delay)) + FLIGHT);
/** The mark lights up: the glow surges and sparks fly out. */
const IGNITE = SETTLED + 2;
/** The entrance is over; only the idle loop is left. */
const DONE = IGNITE + SPARK_LIFE + 4;

function el(
	name: string,
	attrs: Record<string, string | number> = {},
	parent?: Element,
): SVGElement {
	const node = document.createElementNS(SVG, name);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
	parent?.appendChild(node);
	return node;
}

let instances = 0;

/** Build the mark into `host` (it fills the host's width) and play it. */
export function createPixelMarkIntro(host: HTMLElement, label = ""): PixelMarkIntro {
	const id = `px-mark-intro-${++instances}`;
	const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const dark = () => document.documentElement.classList.contains("dark");

	const svg = el("svg", {
		viewBox: `0 0 ${MARK_SIZE} ${MARK_SIZE}`,
		"shape-rendering": "crispEdges",
		focusable: "false",
		...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }),
	});
	svg.setAttribute("class", "px-mark-intro__svg");

	// The logo's neon: its own colours, blurred and laid underneath.
	const defs = el("defs", {}, svg);
	const near = el(
		"filter",
		{ id: `${id}-near`, x: "-30%", y: "-30%", width: "160%", height: "160%" },
		defs,
	);
	el("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 1.1, result: "b" }, near);
	const merge = el("feMerge", {}, near);
	el("feMergeNode", { in: "b" }, merge);
	el("feMergeNode", { in: "b" }, merge);
	const wide = el(
		"filter",
		{ id: `${id}-wide`, x: "-50%", y: "-50%", width: "200%", height: "200%" },
		defs,
	);
	el("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 4 }, wide);
	const glowArt = el("g", { id: `${id}-art` }, defs);

	const glowWide = el("use", { href: `#${id}-art`, filter: `url(#${id}-wide)`, opacity: 0 }, svg);
	const glowNear = el("use", { href: `#${id}-art`, filter: `url(#${id}-near)`, opacity: 0 }, svg);
	const art = el("g", {}, svg);
	const sweep = el("g", {}, svg);
	const sparks = el("g", {}, svg);

	// Two versions of the art: one square per pixel for the flight, paths once settled.
	const flying = PIXELS.map((p) =>
		el("rect", {
			width: 1,
			height: 1,
			fill: `var(--mark-${p.color})`,
			"fill-opacity": p.dim ? 0.55 : 1,
			opacity: 0,
		}),
	);
	const settled: SVGElement[] = [];
	const star: SVGElement[] = [];
	const twinkle: SVGElement[][] = [[], [], []];
	for (const layer of MARK_LAYERS) {
		const path = el("path", {
			d: layer.d,
			fill: `var(--mark-${layer.color})`,
			"fill-opacity": layer.dim ? 0.55 : 1,
		});
		settled.push(path);
		if (layer.part === "star") star.push(path);
		if (layer.twinkle !== undefined) twinkle[layer.twinkle]?.push(path);
	}
	const sweepPaths = MARK_SWEEP.map((d) =>
		el("path", { d, fill: "var(--mark-shine)", opacity: 0 }, sweep),
	);
	const sparkRects = Array.from({ length: SPARKS }, (_, i) =>
		el("rect", { fill: `var(--spectrum-${SPECTRUM[i % SPECTRUM.length]})`, opacity: 0 }, sparks),
	);

	function showSettled(): void {
		art.replaceChildren(...settled);
		glowArt.replaceChildren(...settled.map((n) => n.cloneNode()));
	}

	/** Draw frame `f` of the 30 fps clock. */
	function draw(f: number): void {
		// The flight: whole grid steps, never a glide.
		if (f < SETTLED) {
			if (art.firstChild !== flying[0]) {
				art.replaceChildren(...flying);
				glowArt.replaceChildren();
			}
			PIXELS.forEach((p, i) => {
				const node = flying[i] as SVGElement;
				const k = (f - p.delay) / FLIGHT;
				if (k <= 0) {
					node.setAttribute("opacity", "0");
					return;
				}
				const e = k >= 1 ? 1 : 1 - (1 - k) ** 3;
				const s = k < 0.5 ? 0.5 : 1;
				node.setAttribute("opacity", "1");
				node.setAttribute("x", String(Math.round(p.x + p.fromX * (1 - e)) + (1 - s) / 2));
				node.setAttribute("y", String(Math.round(p.y + p.fromY * (1 - e)) + (1 - s) / 2));
				node.setAttribute("width", String(s));
				node.setAttribute("height", String(s));
			});
		} else if (art.firstChild !== settled[0]) {
			showSettled();
		}

		// Ignition: in dark the glow comes up with a surge; sparks fly out in both themes.
		const glow = dark() && f >= SETTLED;
		const since = f - IGNITE;
		const surge =
			since >= 0 && since < 10 ? ([1, 0.9, 0.75, 0.6, 0.55][Math.floor(since / 2)] ?? 0.5) : 0.5;
		glowWide.setAttribute("opacity", String(glow ? surge : 0));
		glowNear.setAttribute("opacity", String(glow ? 1 : 0));
		sparkRects.forEach((r, i) => {
			if (since < 0 || since > SPARK_LIFE) {
				r.setAttribute("opacity", "0");
				return;
			}
			const k = (Math.floor(since / 2) * 2) / SPARK_LIFE;
			const e = 1 - (1 - k) ** 3;
			const a = (i / SPARKS) * Math.PI * 2 + rand(i + 50) * 0.4;
			const dist = 66 * (0.5 + rand(i * 3 + 50) * 0.5) * e;
			const size = Math.max(0.5, 2 * (1 - k * 0.7));
			r.setAttribute("x", String(Math.round(32 + Math.cos(a) * dist) - size / 2));
			r.setAttribute("y", String(Math.round(32 + Math.sin(a) * dist) - size / 2));
			r.setAttribute("width", String(size));
			r.setAttribute("height", String(size));
			r.setAttribute("opacity", k > 0.8 ? "0.4" : "1");
		});

		// Once lit: the light runs round the orbits, particles twinkle, the star breathes.
		const lit = f > IGNITE + 2;
		const sector = SWEEP_CYCLE / MARK_SECTORS;
		sweepPaths.forEach((path, i) => {
			const phase = (((f - i * sector) % SWEEP_CYCLE) + SWEEP_CYCLE) % SWEEP_CYCLE;
			path.setAttribute(
				"opacity",
				!lit ? "0" : phase < sector ? "0.85" : phase < sector * 2 ? "0.35" : "0",
			);
		});
		// In light the shine is a highlight on ink, not a flash.
		sweep.setAttribute("opacity", glow ? "1" : "0.6");
		twinkle.forEach((paths, group) => {
			const on = !lit || (f + group * 18) % 54 < 27;
			for (const path of paths) path.setAttribute("opacity", on ? "1" : "0.25");
		});
		const breathe = glow && lit && Math.floor(f / 36) % 2 === 1;
		for (const path of star)
			path.style.filter = breathe ? "drop-shadow(0 0 2px var(--mark-shine))" : "";
	}

	// ---------- The clock ----------

	let raf = 0;
	let started = 0;
	let frame = -1;
	let seen = false;

	function tick(now: number): void {
		if (!started) started = now;
		const f = Math.floor(((now - started) / 1000) * FPS);
		if (f !== frame) {
			frame = f;
			draw(f);
		}
		raf = requestAnimationFrame(tick);
	}

	function stop(): void {
		cancelAnimationFrame(raf);
		raf = 0;
	}

	function play(): void {
		stop();
		if (reduced) {
			draw(DONE);
			return;
		}
		started = 0;
		frame = -1;
		raf = requestAnimationFrame(tick);
	}

	/** Pick the idle loop up where it left off. */
	function resume(): void {
		const at = frame;
		raf = requestAnimationFrame((now) => {
			started = now - (at / FPS) * 1000;
			tick(now);
		});
	}

	const observer = new IntersectionObserver(([entry]) => {
		if (!entry) return;
		if (entry.isIntersecting && !seen) {
			seen = true;
			play();
		} else if (entry.isIntersecting && !raf && !reduced) {
			resume();
		} else if (!entry.isIntersecting && frame > DONE) {
			stop();
		}
	});

	host.appendChild(svg);
	draw(-1);
	observer.observe(host);

	return {
		play,
		destroy() {
			stop();
			observer.disconnect();
			svg.remove();
		},
	};
}
