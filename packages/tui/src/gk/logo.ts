/**
 * The GK lockup for full-screen launch screens: the `</>` badge left of the pixel "GAURAV'S HARNESS" wordmark
 * (docs/superpowers/specs/2026-11-15-gk-visual-v2.md §2). Picks the largest form that fits the width.
 */
import type { GkPalette } from "../theme/gk-palette";
import type { Canvas } from "./canvas";
import { pixelTextRows, pixelTextWidth, renderPixelText } from "./pixel-font";

export const WORDMARK = "GAURAV'S HARNESS";
const BADGE = ["┌───┐", "│</>│", "└───┘"] as const;
const BADGE_WIDTH = 5;
const BADGE_GAP = 2;
const MARGIN = 2;

export type LogoForm = "pixel2" | "pixel1" | "pixel1-bare" | "text";

export interface LogoLayout {
	readonly form: LogoForm;
	readonly width: number;
	readonly rows: number;
}

/** Largest lockup that fits `width` columns with a margin on each side. */
export function logoLayout(width: number): LogoLayout {
	const scale2 = pixelTextWidth(WORDMARK, 2, true);
	const scale1 = pixelTextWidth(WORDMARK, 1, true);
	const badged = (wordmark: number): number => BADGE_WIDTH + BADGE_GAP + wordmark;
	if (badged(scale2) + MARGIN * 2 <= width)
		return { form: "pixel2", width: badged(scale2), rows: pixelTextRows(2, true) };
	if (badged(scale1) + MARGIN * 2 <= width)
		return { form: "pixel1", width: badged(scale1), rows: pixelTextRows(1, true) };
	if (scale1 + MARGIN <= width) return { form: "pixel1-bare", width: scale1, rows: pixelTextRows(1, true) };
	return { form: "text", width: `</> ${WORDMARK}`.length, rows: 1 };
}

/** Draw the lockup horizontally centered with its first row at `top`. */
export function drawLogo(canvas: Canvas, top: number, layout: LogoLayout, palette: GkPalette): void {
	const left = Math.floor((canvas.width - layout.width) / 2);
	if (layout.form === "text") {
		canvas.put(left, top, "</>", palette.accent);
		canvas.put(left + 4, top, WORDMARK, palette.accent);
		return;
	}
	const scale = layout.form === "pixel2" ? 2 : 1;
	const lines = renderPixelText(WORDMARK, {
		scale,
		shadow: true,
		colors: { face: palette.accent, shadow: palette.pixelShadow },
		colorMode: canvas.colorMode,
	});
	const wordmarkWidth = pixelTextWidth(WORDMARK, scale, true);
	let x = left;
	if (layout.form !== "pixel1-bare") {
		const badgeTop = top + Math.floor((layout.rows - BADGE.length) / 2);
		canvas.put(x, badgeTop, BADGE[0], palette.dim);
		canvas.put(x, badgeTop + 1, "│", palette.dim);
		canvas.put(x + 1, badgeTop + 1, "</>", palette.accent);
		canvas.put(x + 4, badgeTop + 1, "│", palette.dim);
		canvas.put(x, badgeTop + 2, BADGE[2], palette.dim);
		x += BADGE_WIDTH + BADGE_GAP;
	}
	lines.forEach((line, row) => {
		canvas.putRaw(x, top + row, line, wordmarkWidth);
	});
}
