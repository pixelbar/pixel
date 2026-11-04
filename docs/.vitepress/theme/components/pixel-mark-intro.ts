/**
 * The Pixel mark's entrance, as in the launch video. `<PxMarkIntro>` wraps it
 * for the landing page.
 *
 * Dark uses the original logo (public/pixel-mark.png), light its version
 * printed on paper (public/pixel-mark-light.png). A mosaic of the logo's own
 * pixels flies in and snaps together on a 64 × 64 grid, sharpens in steps
 * (64, 128, 256) into the logo itself, and lights up with a surge and a burst
 * of sparks. After that a light runs round the orbits and the star breathes,
 * both drawn from the logo's own pixels. Dark emits (the effects add light);
 * light prints (they deepen the ink). It follows the theme switch.
 *
 * Motion is in whole steps on a 30 fps clock. It plays the first time it
 * scrolls into view and pauses while off screen. Reduced motion shows the
 * finished mark, still.
 */
import { MARK_LAYERS, MARK_SECTORS, MARK_SIZE, MARK_SWEEP } from "./pixel-mark";

const FPS = 30;
const GRID = MARK_SIZE; // the mosaic and the pixel art share the 64 × 64 grid
const SPECTRUM = ["cyan", "blue", "violet", "magenta", "red", "orange", "yellow", "green"] as const;

/** Frames one pixel takes to fly in. */
const FLIGHT = 16;
/** The light round the orbits: 2.4 s, as on `<PxMark animated>`. */
const SWEEP_CYCLE = 72;
const SPARKS = 36;
const SPARK_LIFE = 30;
/** How far past the mark the canvas reaches, as a share of the mark, for the sparks. */
const BLEED = 0.3;
/** Resolution of the cached glow masks: they're soft, so they needn't be full size. */
const MASK = 256;

export type PixelMarkIntro = { play(): void; destroy(): void };

/** One square of the mosaic: where it lands, its colour, and its flight. */
type Tile = {
	x: number;
	y: number;
	color: string;
	alpha: number;
	delay: number;
	fromX: number;
	fromY: number;
};

/** Deterministic pseudo-random in [0, 1), so every visit looks the same. */
function rand(seed: number): number {
	const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return x - Math.floor(x);
}

/** Give each tile a direction to fly in from and a start, later the further from the star. */
function launch(x: number, y: number, seed: number): Pick<Tile, "delay" | "fromX" | "fromY"> {
	const dx = x - GRID / 2;
	const dy = y - GRID / 2;
	const angle = Math.atan2(dy, dx) + (rand(seed + 7) - 0.5) * 1.2;
	const reach = 18 + rand(seed + 3) * 40;
	return {
		delay: Math.sqrt(dx * dx + dy * dy) * 0.55 + rand(seed) * 6,
		fromX: Math.cos(angle) * reach,
		fromY: Math.sin(angle) * reach,
	};
}

/** The original, shrunk to `size` × `size` (the browser averages each square). */
function shrink(image: HTMLImageElement, size: number): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = size;
	c.height = size;
	const ctx = c.getContext("2d");
	if (ctx) {
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(image, 0, 0, size, size);
	}
	return c;
}

/**
 * Every inked square of the logo at 64 × 64, in its own colour. The original
 * is lit on black; the paper version is ink on transparent.
 */
function photoTiles(small: HTMLCanvasElement, paper: boolean): Tile[] {
	const data = small.getContext("2d")?.getImageData(0, 0, GRID, GRID).data;
	const out: Tile[] = [];
	if (!data) return out;
	let seed = 1;
	for (let y = 0; y < GRID; y++) {
		for (let x = 0; x < GRID; x++) {
			const i = (y * GRID + x) * 4;
			const [r, g, b, a] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
			if (paper ? a < 20 : Math.max(r, g, b) < 20) continue;
			out.push({ x, y, color: `rgb(${r} ${g} ${b})`, alpha: a / 255, ...launch(x, y, seed++) });
		}
	}
	return out;
}

/** The logo seen only through `shape` (in grid units), softened: a glow to lay on top. */
function maskedGlow(image: HTMLImageElement, shape: Path2D, ink: string): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = MASK;
	c.height = MASK;
	const ctx = c.getContext("2d");
	if (!ctx) return c;
	ctx.filter = `blur(${MASK / 128}px)`;
	ctx.scale(MASK / GRID, MASK / GRID);
	ctx.fillStyle = ink;
	ctx.fill(shape);
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.filter = "none";
	ctx.globalCompositeOperation = "source-in";
	ctx.drawImage(image, 0, 0, MASK, MASK);
	return c;
}

/** The logo, blurred: the surge when it lights up. */
function bloom(image: HTMLImageElement): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = MASK;
	c.height = MASK;
	const ctx = c.getContext("2d");
	if (ctx) {
		ctx.filter = `blur(${MASK / 40}px)`;
		ctx.drawImage(image, 0, 0, MASK, MASK);
	}
	return c;
}

/** Build the mark into `host` (it fills the host's width) and play it when it's seen. */
export function createPixelMarkIntro(
	host: HTMLElement,
	options: { src: string; lightSrc: string; label?: string },
): PixelMarkIntro {
	const isDark = () => document.documentElement.classList.contains("dark");
	const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const styles = getComputedStyle(document.documentElement);
	const token = (name: string) => styles.getPropertyValue(name).trim();

	const canvas = document.createElement("canvas");
	canvas.className = "px-mark-intro__canvas";
	if (options.label) {
		canvas.setAttribute("role", "img");
		canvas.setAttribute("aria-label", options.label);
	} else {
		canvas.setAttribute("aria-hidden", "true");
	}
	const ctx = canvas.getContext("2d");

	// ---------- What gets drawn ----------

	type Version = {
		image: HTMLImageElement;
		tiles: Tile[];
		steps: HTMLCanvasElement[];
		sweep: HTMLCanvasElement[];
		star: HTMLCanvasElement;
		bloom: HTMLCanvasElement;
	};
	const versions: { dark?: Version; light?: Version } = {};
	const starShape = new Path2D();
	for (const layer of MARK_LAYERS)
		if (layer.part === "star") starShape.addPath(new Path2D(layer.d));

	async function load(theme: "dark" | "light", src: string): Promise<void> {
		const image = new Image();
		image.src = src;
		await image.decode();
		const steps = [GRID, GRID * 2, GRID * 4].map((size) => shrink(image, size));
		versions[theme] = {
			image,
			tiles: photoTiles(steps[0] as HTMLCanvasElement, theme === "light"),
			steps,
			sweep: MARK_SWEEP.map((d) => maskedGlow(image, new Path2D(d), token("--mark-shine"))),
			star: maskedGlow(image, starShape, token("--mark-shine")),
			bloom: bloom(image),
		};
	}
	const ready = Promise.all([load("dark", options.src), load("light", options.lightSrc)]);

	// The entrance's timing depends on how far the last tile flies.
	const lastLanding = (tiles: Tile[]) =>
		Math.ceil(Math.max(0, ...tiles.map((t) => t.delay)) + FLIGHT);

	// ---------- Drawing ----------

	let px = 0; // device pixels per grid unit
	let pad = 0; // device pixels from the canvas edge to the mark

	function resize(): void {
		const size = host.clientWidth;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const full = Math.round(size * (1 + 2 * BLEED) * dpr);
		if (canvas.width !== full) {
			canvas.width = full;
			canvas.height = full;
		}
		px = (size * dpr) / GRID;
		pad = size * BLEED * dpr;
	}

	/** Draw `source` over the mark's square. */
	function cover(
		source: CanvasImageSource,
		alpha = 1,
		smooth = true,
		mode: GlobalCompositeOperation = "source-over",
	): void {
		if (!ctx) return;
		ctx.globalAlpha = alpha;
		ctx.globalCompositeOperation = mode;
		ctx.imageSmoothingEnabled = smooth;
		ctx.drawImage(source, pad, pad, px * GRID, px * GRID);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
	}

	function drawTiles(tiles: Tile[], f: number): void {
		if (!ctx) return;
		for (const t of tiles) {
			const k = (f - t.delay) / FLIGHT;
			if (k <= 0) continue;
			const e = k >= 1 ? 1 : 1 - (1 - k) ** 3;
			const s = k < 0.5 ? 0.5 : 1;
			// Whole grid steps, never a glide.
			const gx = Math.round(t.x + t.fromX * (1 - e)) + (1 - s) / 2;
			const gy = Math.round(t.y + t.fromY * (1 - e)) + (1 - s) / 2;
			ctx.globalAlpha = t.alpha;
			ctx.fillStyle = t.color;
			const x0 = Math.round(pad + gx * px);
			const y0 = Math.round(pad + gy * px);
			ctx.fillRect(
				x0,
				y0,
				Math.round(pad + (gx + s) * px) - x0,
				Math.round(pad + (gy + s) * px) - y0,
			);
		}
		ctx.globalAlpha = 1;
	}

	function drawSparks(since: number): void {
		if (!ctx || since < 0 || since > SPARK_LIFE) return;
		const k = (Math.floor(since / 2) * 2) / SPARK_LIFE;
		const e = 1 - (1 - k) ** 3;
		ctx.globalAlpha = k > 0.8 ? 0.4 : 1;
		for (let i = 0; i < SPARKS; i++) {
			const a = (i / SPARKS) * Math.PI * 2 + rand(i + 50) * 0.4;
			const dist = GRID * 0.75 * (0.5 + rand(i * 3 + 50) * 0.5) * e;
			const size = Math.max(0.5, 1.5 * (1 - k * 0.7));
			ctx.fillStyle = token(`--spectrum-${SPECTRUM[i % SPECTRUM.length]}`);
			const gx = Math.round(GRID / 2 + Math.cos(a) * dist) - size / 2;
			const gy = Math.round(GRID / 2 + Math.sin(a) * dist) - size / 2;
			ctx.fillRect(pad + gx * px, pad + gy * px, size * px, size * px);
		}
		ctx.globalAlpha = 1;
	}

	/** Which orbit sector is lit, and how brightly, at frame `f`. */
	function sweepAt(f: number, i: number): number {
		const sector = SWEEP_CYCLE / MARK_SECTORS;
		const phase = (((f - i * sector) % SWEEP_CYCLE) + SWEEP_CYCLE) % SWEEP_CYCLE;
		return phase < sector ? 0.85 : phase < sector * 2 ? 0.35 : 0;
	}

	/** The logo, flown in as a mosaic, sharpened in steps, then lit. */
	function draw(f: number): void {
		const dark = isDark();
		const photo = dark ? versions.dark : versions.light;
		if (!ctx || !photo) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		// Dark adds light; light deepens the ink, and more gently.
		const glow: GlobalCompositeOperation = dark ? "lighter" : "multiply";
		const strength = dark ? 1 : 0.6;
		const landed = lastLanding(photo.tiles);
		const ignite = landed + 9;
		if (f < landed) {
			drawTiles(photo.tiles, f);
			return;
		}
		if (f < ignite) {
			// 64, 128, 256, then the original: three frames each.
			const step = photo.steps[Math.min(2, Math.floor((f - landed) / 3))] as HTMLCanvasElement;
			cover(step, 1, false);
			return;
		}
		cover(photo.image);
		const since = f - ignite;
		const surge =
			since >= 0 && since < 10 ? ([0.9, 0.7, 0.5, 0.3, 0.15][Math.floor(since / 2)] ?? 0) : 0;
		if (surge) cover(photo.bloom, surge * strength, true, glow);
		drawSparks(since);
		if (since > 2 && !reduced) {
			photo.sweep.forEach((sector, i) => {
				const a = sweepAt(f, i);
				if (a) cover(sector, a * strength, true, glow);
			});
			if (Math.floor(f / 36) % 2 === 1) cover(photo.star, 0.35 * strength, true, glow);
		}
	}

	// ---------- The clock ----------

	let raf = 0;
	let started = 0;
	let frame = -1;
	let seen = false;
	const DONE = 200; // well past the entrance

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
		void ready.then(() => {
			resize();
			if (reduced) {
				draw(DONE);
				return;
			}
			started = 0;
			frame = -1;
			raf = requestAnimationFrame(tick);
		});
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
		} else if (entry.isIntersecting && !raf && seen && !reduced) {
			resume();
		} else if (!entry.isIntersecting && frame > DONE) {
			stop();
		}
	});
	const sizer = new ResizeObserver(() => {
		resize();
		if (frame >= 0 || reduced) draw(reduced ? DONE : frame);
	});

	host.appendChild(canvas);
	resize();
	observer.observe(host);
	sizer.observe(host);

	return {
		play,
		destroy() {
			stop();
			observer.disconnect();
			sizer.disconnect();
			canvas.remove();
		},
	};
}
