/**
 * BUILD SUCCESSFUL / BUILD FAILED finale (docs/superpowers/specs/2026-11-15-gkharness-design.md §5.9).
 *
 * Success: a full-screen green block-letter headline with a ~2.5 s particle burst from the center (static with
 * motion off), then a summary card. Failure: an honest, static red BUILD FAILED listing what failed and the
 * failing command's last output lines. Any key skips the burst; any key closes the card.
 *
 * `renderFinaleFrame` is pure: the same state, size and time give the same rows. Every row is exactly `width`
 * visible columns, painted on the palette's `paneBg`. `playFinale` shows it as a full-screen overlay.
 */
import type { SetupUiHost } from "../setup/scenes/types";
import { detectColorMode, FG_RESET, fgAnsi } from "../theme/color";
import { GK_NIGHT, type GkPalette } from "../theme/gk-palette";
import type { ColorMode } from "../theme/schema";
import type { Component } from "../tui";
import { Canvas, clip, cols } from "./canvas";
import { pixelTextRows, pixelTextWidth, renderPixelText } from "./pixel-font";

/** Particle burst length with motion on. */
export const FINALE_BURST_MS = 2500;
/** Motionless headline: shown this long before the summary card unless a key skips it. */
export const FINALE_STATIC_MS = 1200;
const TICK_MS = 33;
const PARTICLES = 110;
/** Pixel headlines need this much room; narrower screens get bold text. */
const PIXEL_MIN_COLS = 60;
const MARGIN = 2;
const CARD_MAX_WIDTH = 72;
const OUTPUT_LINES = 10;

export interface FinaleRow {
	readonly label: string;
	readonly value: string;
}

export interface FinaleFailure {
	/** What failed, e.g. `W-02 @linus` or `bun test`. */
	readonly label: string;
	readonly detail?: string;
}

export type FinaleResult =
	| {
			readonly kind: "success";
			/** One line under the headline, e.g. `bun test passed in 4.2s`. */
			readonly caption?: string;
			/** Summary card rows (duration, cost, files changed, verify command + time). */
			readonly rows: readonly FinaleRow[];
	  }
	| {
			readonly kind: "failure";
			readonly caption?: string;
			readonly failures: readonly FinaleFailure[];
			/** Failing command's output; the last {@link OUTPUT_LINES} lines are shown. */
			readonly output?: readonly string[];
			/** Title over the output block, e.g. the command. */
			readonly outputTitle?: string;
	  };

export type FinalePhase = "headline" | "summary";

export interface FinaleState {
	readonly result: FinaleResult;
	readonly phase: FinalePhase;
	/** False renders without particles. */
	readonly motion?: boolean;
	readonly palette?: GkPalette;
	readonly colorMode?: ColorMode;
}

type HeadlineForm = { kind: "pixel"; scale: 1 | 2; lines: readonly string[] } | { kind: "text" };

/** Scale 1 drops its shadow straight down so the one-column letter gaps stay clear (like the header logo). */
function shadowDx(scale: 1 | 2): 0 | 1 {
	return scale === 1 ? 0 : 1;
}

/** Largest headline form that fits: one line at scale 2, two lines at scale 2, then scale 1, then bold text. */
export function headlineForm(text: string, width: number, height: number): HeadlineForm {
	if (width < PIXEL_MIN_COLS) return { kind: "text" };
	const words = text.split(" ");
	const split = words.length > 1 ? [words.slice(0, -1).join(" "), words.at(-1)!] : [text];
	for (const scale of [2, 1] as const) {
		for (const lines of [[text], split]) {
			const wide = Math.max(...lines.map(line => pixelTextWidth(line, scale, true, shadowDx(scale))));
			const tall = lines.length * pixelTextRows(scale, true) + lines.length - 1;
			if (wide + MARGIN * 2 <= width && tall + 6 <= height) return { kind: "pixel", scale, lines };
		}
	}
	return { kind: "text" };
}

function headlineRows(form: HeadlineForm): number {
	if (form.kind === "text") return 1;
	return form.lines.length * pixelTextRows(form.scale, true) + form.lines.length - 1;
}

/** Draw the headline centered with its first row at `top`; returns the rows used. */
function drawHeadline(
	canvas: Canvas,
	top: number,
	text: string,
	form: HeadlineForm,
	face: string,
	shadow: string,
): number {
	if (form.kind === "text") {
		const shown = clip(text, canvas.width);
		const left = Math.max(0, Math.floor((canvas.width - cols(shown)) / 2));
		canvas.putRaw(left, top, `\x1b[1m${fgAnsi(face, canvas.colorMode)}${shown}${FG_RESET}\x1b[22m`, cols(shown));
		return 1;
	}
	const rows = pixelTextRows(form.scale, true);
	form.lines.forEach((line, index) => {
		const width = pixelTextWidth(line, form.scale, true, shadowDx(form.scale));
		const left = Math.floor((canvas.width - width) / 2);
		const rendered = renderPixelText(line, {
			scale: form.scale,
			shadow: true,
			shadowDx: shadowDx(form.scale),
			colors: { face, shadow },
			colorMode: canvas.colorMode,
		});
		rendered.forEach((row, r) => canvas.putRaw(left, top + index * (rows + 1) + r, row, width));
	});
	return headlineRows(form);
}

/** Deterministic PRNG so every frame at a given time is the same. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Particle {
	angle: number;
	/** Rows per ms at launch. */
	speed: number;
	/** Fraction of the burst this particle lives. */
	life: number;
	color: 0 | 1 | 2;
}

const BURST: readonly Particle[] = (() => {
	const rand = mulberry32(0x6b67);
	return Array.from({ length: PARTICLES }, () => ({
		angle: rand() * Math.PI * 2,
		speed: 0.004 + rand() * 0.014,
		life: 0.45 + rand() * 0.55,
		color: Math.floor(rand() * 3) as 0 | 1 | 2,
	}));
})();

/** Particles radiate from the center, slow down, fall a little and fade through ✦ * + · before going out. */
function drawBurst(canvas: Canvas, tMs: number, palette: GkPalette): void {
	const progress = tMs / FINALE_BURST_MS;
	if (progress >= 1) return;
	const cx = canvas.width / 2;
	const cy = canvas.height / 2;
	const colors = [palette.success, palette.accent, palette.accentStrong];
	for (const p of BURST) {
		const age = progress / p.life;
		if (age >= 1) continue;
		// Distance eases out; columns are half as tall as rows, so x travels twice as far.
		const reach = p.speed * FINALE_BURST_MS * (1 - (1 - Math.min(1, progress * 1.6)) ** 2) * 0.6;
		const x = Math.round(cx + Math.cos(p.angle) * reach * 2);
		const y = Math.round(cy + Math.sin(p.angle) * reach + progress * progress * 4);
		const glyph = age < 0.25 ? "✦" : age < 0.5 ? "*" : age < 0.75 ? "+" : "·";
		canvas.put(x, y, glyph, colors[p.color]);
	}
}

function footer(canvas: Canvas, text: string, palette: GkPalette): void {
	canvas.center(canvas.height - 1, clip(text, canvas.width - 2), palette.dim);
}

/** Bordered card centered at `top`: `label  value` rows. Returns rows used. */
function drawCard(
	canvas: Canvas,
	top: number,
	title: string,
	rows: readonly FinaleRow[],
	palette: GkPalette,
	maxRows: number,
): number {
	const width = Math.min(CARD_MAX_WIDTH, canvas.width - 2);
	if (width < 12 || maxRows < 3) return 0;
	const left = Math.floor((canvas.width - width) / 2);
	const inner = width - 4;
	const labelCols = Math.min(18, Math.max(0, ...rows.map(r => cols(r.label))) + 2);
	const shown = rows.slice(0, Math.max(0, maxRows - 2));
	const head = clip(` ${title} `, inner);
	canvas.put(left, top, `┌─${head}${"─".repeat(Math.max(0, width - 3 - cols(head)))}┐`, palette.border);
	canvas.put(left + 2, top, head, palette.text);
	shown.forEach((row, i) => {
		const y = top + 1 + i;
		canvas.put(left, y, "│", palette.border);
		canvas.put(left + width - 1, y, "│", palette.border);
		canvas.put(left + 2, y, clip(row.label, labelCols - 1), palette.muted);
		canvas.put(left + 2 + labelCols, y, clip(row.value, inner - labelCols), palette.text);
	});
	canvas.put(left, top + 1 + shown.length, `└${"─".repeat(width - 2)}┘`, palette.border);
	return shown.length + 2;
}

function renderSuccess(canvas: Canvas, state: FinaleState, tMs: number, palette: GkPalette): void {
	const result = state.result as Extract<FinaleResult, { kind: "success" }>;
	const text = "BUILD SUCCESSFUL";
	if (state.phase === "headline") {
		if (state.motion !== false) drawBurst(canvas, tMs, palette);
		const form = headlineForm(text, canvas.width, canvas.height);
		const block = headlineRows(form) + (result.caption ? 2 : 0);
		const top = Math.max(0, Math.floor((canvas.height - block) / 2));
		const used = drawHeadline(canvas, top, text, form, palette.success, palette.diffAddBg);
		if (result.caption) canvas.center(top + used + 1, clip(result.caption, canvas.width - 2), palette.muted);
		footer(canvas, "any key to continue", palette);
		return;
	}
	// Summary: the headline one size down above the card.
	const form = headlineForm(text, Math.min(canvas.width, 100), Math.floor(canvas.height / 2));
	const cardRows = result.rows.length + 2;
	const block = headlineRows(form) + 2 + cardRows;
	const top = Math.max(0, Math.floor((canvas.height - 1 - block) / 2));
	const used = drawHeadline(canvas, top, text, form, palette.success, palette.diffAddBg);
	drawCard(
		canvas,
		top + used + 2,
		result.caption ?? "summary",
		result.rows,
		palette,
		canvas.height - 1 - (top + used + 2),
	);
	footer(canvas, "any key to close", palette);
}

function renderFailure(canvas: Canvas, state: FinaleState, palette: GkPalette): void {
	const result = state.result as Extract<FinaleResult, { kind: "failure" }>;
	const text = "BUILD FAILED";
	const output = (result.output ?? []).slice(-OUTPUT_LINES);
	const outputRows = output.length > 0 ? output.length + 3 : 0;
	const listRows = result.failures.length + (result.caption ? 2 : 0);
	const room = canvas.height - 2;
	const form = headlineForm(text, canvas.width, Math.max(0, room - listRows - outputRows + 6));
	const block = headlineRows(form) + 1 + listRows + outputRows;
	let y = Math.max(0, Math.floor((room - block) / 2));
	y += drawHeadline(canvas, y, text, form, palette.error, palette.diffRemoveBg) + 1;
	if (result.caption) {
		canvas.center(y, clip(result.caption, canvas.width - 2), palette.muted);
		y += 2;
	}
	const width = Math.min(CARD_MAX_WIDTH, canvas.width - 2);
	const left = Math.floor((canvas.width - width) / 2);
	for (const failure of result.failures) {
		if (y >= room) break;
		canvas.put(left, y, "✗", palette.error);
		const label = clip(failure.label, width - 2);
		canvas.put(left + 2, y, label, palette.text);
		if (failure.detail) {
			const at = left + 2 + cols(label) + 2;
			canvas.put(at, y, clip(failure.detail, left + width - at), palette.muted);
		}
		y++;
	}
	if (output.length > 0 && y + 3 <= room) {
		y++;
		const title = clip(` ${result.outputTitle ?? "output"} · last ${output.length} lines `, width - 4);
		canvas.put(left, y, `┌─${title}${"─".repeat(Math.max(0, width - 3 - cols(title)))}┐`, palette.border);
		canvas.put(left + 2, y, title, palette.muted);
		y++;
		for (const line of output) {
			if (y >= room) break;
			canvas.put(left, y, "│", palette.border);
			canvas.put(left + width - 1, y, "│", palette.border);
			canvas.put(left + 2, y, clip(line.replace(/\t/g, "  "), width - 4), palette.muted);
			y++;
		}
		if (y < room + 1) canvas.put(left, y, `└${"─".repeat(width - 2)}┘`, palette.border);
	}
	footer(canvas, "any key to close", palette);
}

/** One finale frame: exactly `height` rows of exactly `width` columns. */
export function renderFinaleFrame(state: FinaleState, width: number, height: number, tMs: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const h = Math.max(1, Math.floor(height));
	const palette = state.palette ?? GK_NIGHT;
	const canvas = new Canvas(w, h, palette.paneBg, state.colorMode ?? detectColorMode());
	if (state.result.kind === "success") renderSuccess(canvas, state, Math.max(0, tMs), palette);
	else renderFailure(canvas, state, palette);
	return canvas.lines();
}

/** Terminal reports that are not keypresses (SGR mouse, focus in/out). */
function isTerminalReport(data: string): boolean {
	return data.startsWith("\x1b[<") || data === "\x1b[I" || data === "\x1b[O";
}

export interface FinaleOptions {
	readonly motion: boolean;
	readonly palette?: GkPalette;
	readonly now?: () => number;
}

class FinaleComponent implements Component {
	#phase: FinalePhase;
	#startedAt = 0;
	#timer: NodeJS.Timeout | undefined;
	readonly #done = Promise.withResolvers<void>();
	readonly #now: () => number;

	constructor(
		readonly ctx: SetupUiHost,
		readonly result: FinaleResult,
		readonly options: FinaleOptions,
	) {
		this.#now = options.now ?? (() => performance.now());
		this.#phase = "headline";
	}

	run(): Promise<void> {
		this.#startedAt = this.#now();
		if (this.result.kind === "success") {
			const hold = this.options.motion ? FINALE_BURST_MS : FINALE_STATIC_MS;
			this.#timer = setInterval(
				() => {
					if (this.#now() - this.#startedAt >= hold) this.#toSummary();
					else if (this.options.motion) this.ctx.ui.requestRender();
				},
				this.options.motion ? TICK_MS : 100,
			);
		}
		this.ctx.ui.requestRender();
		return this.#done.promise;
	}

	#toSummary(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#phase = "summary";
		this.ctx.ui.requestRender();
	}

	handleInput(data: string): void {
		if (isTerminalReport(data)) return;
		if (this.result.kind === "success" && this.#phase === "headline") this.#toSummary();
		else this.dispose();
	}

	render(width: number): readonly string[] {
		return renderFinaleFrame(
			{ result: this.result, phase: this.#phase, motion: this.options.motion, palette: this.options.palette },
			width,
			Math.max(1, this.ctx.ui.terminal.rows),
			this.#now() - this.#startedAt,
		);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#done.resolve();
	}
}

/** Play the finale full-screen; resolves once the user closes it (focus returns where it was). */
export async function playFinale(ctx: SetupUiHost, result: FinaleResult, options: FinaleOptions): Promise<void> {
	const component = new FinaleComponent(ctx, result, options);
	const overlay = ctx.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		await component.run();
	} finally {
		component.dispose();
		overlay.hide();
	}
}
