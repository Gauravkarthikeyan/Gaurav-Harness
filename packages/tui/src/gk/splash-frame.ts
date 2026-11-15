/**
 * GK launch splash (docs/superpowers/specs/2026-11-15-gk-visual-v2.md §5.1): a rotating dot-wireframe globe with
 * one orbit ring, the pixel wordmark, a live startup checklist with a progress bar, and a footer.
 *
 * `renderSplashFrame` is pure: the same state, size and time give the same rows. Every row is exactly `width`
 * visible columns, painted on the palette's `paneBg`.
 */
import { detectColorMode } from "../theme/color";
import { GK_NIGHT, type GkPalette } from "../theme/gk-palette";
import type { ColorMode } from "../theme/schema";
import { Canvas, clip, cols } from "./canvas";
import { drawLogo, logoLayout } from "./logo";

export type SplashCheckState = "pending" | "ok" | "warn" | "off" | "fail";

export interface SplashCheck {
	readonly id: string;
	/** Row name, e.g. `providers`. */
	readonly label: string;
	readonly state: SplashCheckState;
	/** Headline result, e.g. `6 connected`. */
	readonly value?: string;
	/** Secondary detail, e.g. the provider names. */
	readonly detail?: string;
}

export interface SplashState {
	readonly checks: readonly SplashCheck[];
	/** GK Code's version, e.g. `0.1.0`. */
	readonly version: string;
	/** Host line for the top row, e.g. `darwin arm64 · pid 48190`. */
	readonly host?: string;
	/** False renders the motionless frame: fixed globe angle, no spinner. */
	readonly motion?: boolean;
	readonly palette?: GkPalette;
	readonly colorMode?: ColorMode;
}

export const SPLASH_AUTHOR = "by Gaurav Karthikeyan · github.com/Gauravkarthikeyan";
/** Globe angle of the motionless frame (radians about the vertical axis). */
const STATIC_ANGLE = 0.6;
const SPIN_RAD_PER_MS = 0.0009;
const RING_RAD_PER_MS = -0.0005;
const TILT = 0.38;
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const LIST_MAX_WIDTH = 76;
const LABEL_COLS = 14;
const VALUE_COLS = 18;

/** Settled share of the checks in `[0, 1]`; an empty list counts as done. */
export function splashProgress(checks: readonly SplashCheck[]): number {
	if (checks.length === 0) return 1;
	return checks.filter(check => check.state !== "pending").length / checks.length;
}

/** The footer as one row (`left … right`) or, when that does not fit, the author above the version. */
function footerRows(width: number, version: string): { left: string; right: string; stacked: boolean } {
	const right = `gk-code ${version} · any key to skip`;
	const stacked = cols(SPLASH_AUTHOR) + cols(right) + 4 > width;
	return { left: SPLASH_AUTHOR, right, stacked };
}

export function renderSplashFrame(state: SplashState, width: number, height: number, tMs: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const h = Math.max(1, Math.floor(height));
	const palette = state.palette ?? GK_NIGHT;
	const canvas = new Canvas(w, h, palette.paneBg, state.colorMode ?? detectColorMode());
	const motion = state.motion !== false;
	const t = motion ? Math.max(0, tMs) : 0;

	// Fixed rows: top status, footer (1 or 2), and the content blocks below the globe.
	const footer = footerRows(w, state.version);
	const footerHeight = footer.stacked ? 2 : 1;
	const logo = logoLayout(w);
	const listRows = state.checks.length;
	const roomy = h >= 34;
	const gap = roomy ? 2 : 1;
	const below = gap + logo.rows + gap + listRows + 1 + 1; // logo, list, gap, bar
	const avail = h - 1 - footerHeight - 1;
	const globeRows = Math.max(0, Math.min(Math.round(h * 0.42), avail - below));
	const contentRows = globeRows + below;
	let y = 1 + Math.max(0, Math.floor((avail - contentRows) / 2));

	// Top status row: what is booting, on what.
	const hostText = state.host ? ` · ${state.host}` : "";
	canvas.put(1, 0, clip(`gk-code boot${hostText}`, Math.max(0, w - 12)), palette.dim);
	const size = `${w}×${h}`;
	if (cols(size) + 2 < w) canvas.put(w - cols(size) - 1, 0, size, palette.dim);

	if (globeRows >= 5) drawGlobe(canvas, y, globeRows, motion ? t : null, palette);
	y += globeRows + gap;

	if (logo.rows + y <= h - footerHeight) drawLogo(canvas, y, logo, palette);
	y += logo.rows + gap;

	const listWidth = Math.min(LIST_MAX_WIDTH, w - 4);
	const listLeft = Math.max(0, Math.floor((w - listWidth) / 2));
	const spinner = motion ? SPINNER[Math.floor(t / 80) % SPINNER.length] : "●";
	for (const check of state.checks) {
		drawCheck(canvas, listLeft, y, listWidth, check, spinner, palette);
		y++;
	}
	y++;
	drawBar(canvas, listLeft, y, listWidth, state.checks, palette);

	// Footer.
	if (footer.stacked) {
		canvas.put(1, h - 2, clip(footer.left, w - 2), palette.dim);
		const right = clip(footer.right, w - 2);
		canvas.put(w - cols(right) - 1, h - 1, right, palette.dim);
	} else {
		canvas.put(1, h - 1, footer.left, palette.dim);
		canvas.put(w - cols(footer.right) - 1, h - 1, footer.right, palette.dim);
	}
	return canvas.lines();
}

function drawCheck(
	canvas: Canvas,
	left: number,
	y: number,
	width: number,
	check: SplashCheck,
	spinner: string,
	palette: GkPalette,
): void {
	const glyph =
		check.state === "ok"
			? { char: "✓", color: palette.success }
			: check.state === "warn"
				? { char: "!", color: palette.warning }
				: check.state === "fail"
					? { char: "✗", color: palette.error }
					: check.state === "off"
						? { char: "○", color: palette.dim }
						: { char: spinner, color: palette.accent };
	canvas.put(left, y, glyph.char, glyph.color);
	const labelColor = check.state === "pending" || check.state === "off" ? palette.muted : palette.text;
	canvas.put(left + 2, y, clip(check.label, LABEL_COLS - 1), labelColor);
	const valueLeft = left + 2 + LABEL_COLS;
	const value = check.state === "pending" ? (check.value ?? "probing") : (check.value ?? "");
	const valueColor =
		check.state === "pending" || check.state === "off"
			? palette.dim
			: check.state === "warn"
				? palette.warning
				: check.state === "fail"
					? palette.error
					: palette.text;
	canvas.put(valueLeft, y, clip(value, VALUE_COLS - 1), valueColor);
	const detailLeft = valueLeft + VALUE_COLS;
	if (check.detail && detailLeft < left + width) {
		canvas.put(detailLeft, y, clip(check.detail, left + width - detailLeft), palette.dim);
	}
}

/** Thin progress bar: settled share in accent `━`, the rest in dim `─`, then `n/m`. */
function drawBar(
	canvas: Canvas,
	left: number,
	y: number,
	width: number,
	checks: readonly SplashCheck[],
	palette: GkPalette,
): void {
	const settled = checks.filter(check => check.state !== "pending").length;
	const count = `${settled}/${checks.length}`;
	const barWidth = Math.max(0, width - cols(count) - 1);
	const filled = Math.round(splashProgress(checks) * barWidth);
	canvas.put(left, y, "━".repeat(filled), palette.accent);
	canvas.put(left + filled, y, "─".repeat(barWidth - filled), palette.border);
	canvas.put(left + barWidth + 1, y, count, palette.muted);
}

interface Dot {
	x: number;
	y: number;
	z: number;
	shade: number;
}

/**
 * Dot wireframe globe (latitude rings + meridians) rotating about its vertical axis, tilted toward the viewer,
 * with one inclined orbit ring and a satellite. Orthographic projection, z-buffered per cell; shade is depth plus
 * a key light from the upper left, mapped dim → muted → accent (accent only on the lit front cap).
 */
function drawGlobe(canvas: Canvas, top: number, rows: number, t: number | null, palette: GkPalette): void {
	const ry = (rows - 1) / 2;
	const rx = ry * 2; // terminal cells are about twice as tall as wide
	const cx = (canvas.width - 1) / 2;
	const cy = top + ry;
	const angle = t === null ? STATIC_ANGLE : STATIC_ANGLE + t * SPIN_RAD_PER_MS;
	const ringAngle = t === null ? 0 : t * RING_RAD_PER_MS;
	const cosA = Math.cos(angle);
	const sinA = Math.sin(angle);
	const cosT = Math.cos(TILT);
	const sinT = Math.sin(TILT);
	// Key light from the upper left, toward the viewer (unit vector).
	const lightLen = Math.hypot(-0.45, 0.55, 0.7);
	const light = [-0.45 / lightLen, 0.55 / lightLen, 0.7 / lightLen] as const;

	const depth = new Map<number, Dot>();
	const plot = (px: number, py: number, pz: number, shade: number): void => {
		const col = Math.round(cx + px * rx);
		const row = Math.round(cy - py * ry);
		if (row < top || row >= top + rows || col < 0 || col >= canvas.width) return;
		const key = row * canvas.width + col;
		const prev = depth.get(key);
		if (!prev || pz > prev.z) depth.set(key, { x: col, y: row, z: pz, shade });
	};
	/** `dense` false thins the far hemisphere to every other sample so the near side reads first. */
	const sphere = (lat: number, lon: number, dense: boolean): void => {
		const x0 = Math.cos(lat) * Math.cos(lon);
		const y0 = Math.sin(lat);
		const z0 = Math.cos(lat) * Math.sin(lon);
		const x1 = x0 * cosA + z0 * sinA;
		const z1 = -x0 * sinA + z0 * cosA;
		const y2 = y0 * cosT - z1 * sinT;
		const z2 = y0 * sinT + z1 * cosT;
		if (z2 < -0.05 && !dense) return;
		const lambert = Math.max(0, x1 * light[0] + y2 * light[1] + z2 * light[2]);
		plot(x1, y2, z2, 0.55 * ((z2 + 1) / 2) + 0.45 * lambert);
	};

	// Sample spacing in unit-sphere terms: about every other column along rings, every row along meridians.
	const step = 2.1 / rx;
	for (let i = 1; i < 6; i++) {
		const lat = -Math.PI / 2 + (i * Math.PI) / 6;
		const n = Math.max(8, Math.round((2 * Math.PI * Math.cos(lat)) / step));
		for (let k = 0; k < n; k++) sphere(lat, (k / n) * 2 * Math.PI, k % 2 === 0);
	}
	const meridians = 12;
	const mSteps = Math.max(8, Math.round(Math.PI * ry));
	for (let m = 0; m < meridians; m++) {
		const lon = (m / meridians) * 2 * Math.PI;
		for (let k = 1; k < mSteps; k++) sphere(-Math.PI / 2 + (k / mSteps) * Math.PI, lon, k % 2 === 0);
	}

	// Orbit ring: radius 1.45 in its own plane, inclined and slightly rolled; hidden where the globe covers it.
	const ringRadius = 1.45;
	const incline = 0.3;
	const roll = -0.28;
	const ringN = Math.max(24, Math.round((2 * Math.PI * ringRadius) / step));
	const ringPoint = (phase: number): [number, number, number] => {
		const x0 = ringRadius * Math.cos(phase);
		const z0 = ringRadius * Math.sin(phase);
		const y1 = -z0 * Math.sin(incline);
		const z1 = z0 * Math.cos(incline);
		return [x0 * Math.cos(roll) - y1 * Math.sin(roll), x0 * Math.sin(roll) + y1 * Math.cos(roll), z1];
	};
	const hidden = (x: number, y: number, z: number): boolean => z < 0 && x * x + y * y < 1;
	for (let k = 0; k < ringN; k++) {
		const [x, y, z] = ringPoint(ringAngle + (k / ringN) * 2 * Math.PI);
		if (!hidden(x, y, z)) plot(x, y, z, 0.2 + 0.3 * ((z / ringRadius + 1) / 2));
	}

	for (const dot of depth.values()) {
		const [char, color] =
			dot.shade > 0.76
				? ["•", palette.accent]
				: dot.shade > 0.58
					? ["•", palette.muted]
					: dot.shade > 0.36
						? ["·", palette.muted]
						: ["·", palette.dim];
		canvas.put(dot.x, dot.y, char, color);
	}

	const [sx, sy, sz] = ringPoint(ringAngle * 3.1 + 1.2);
	if (!hidden(sx, sy, sz)) {
		const col = Math.round(cx + sx * rx);
		const row = Math.round(cy - sy * ry);
		if (row >= top && row < top + rows) canvas.put(col, row, "●", palette.accentStrong);
	}
}
