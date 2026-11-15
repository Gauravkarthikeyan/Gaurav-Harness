/**
 * Chunky 5-row pixel font for the "GAURAV'S HARNESS" wordmark (docs/superpowers/specs/2026-11-15-gk-visual-v2.md §3).
 *
 * Pixels map onto half-block cells (`█ ▀ ▄`): at scale 1 a pixel is 1 column × ½ row (square on a 1:2 cell), at
 * scale 2 it is 2 columns × 1 row. The optional drop shadow is the face shifted ½ row down and `shadowDx` columns
 * right (default 1: diagonal; 0: straight down, which keeps the one-pixel letter gaps clear at scale 1), painted in a
 * darker tone wherever the face is not.
 */
import { BG_RESET, bgAnsi, detectColorMode, FG_RESET, fgAnsi } from "../theme/color";
import { GK_NIGHT } from "../theme/gk-palette";
import type { ColorMode } from "../theme/schema";

export const PIXEL_GLYPH_ROWS = 5;

/** Glyph bitmaps, `X` = pixel on. Every row of a glyph has the glyph's width. */
const GLYPHS: Record<string, readonly string[]> = {
	A: [".XX.", "X..X", "XXXX", "X..X", "X..X"],
	B: ["XXX.", "X..X", "XXX.", "X..X", "XXX."],
	C: [".XXX", "X...", "X...", "X...", ".XXX"],
	D: ["XXX.", "X..X", "X..X", "X..X", "XXX."],
	E: ["XXXX", "X...", "XXX.", "X...", "XXXX"],
	F: ["XXXX", "X...", "XXX.", "X...", "X..."],
	G: [".XXX", "X...", "X.XX", "X..X", ".XXX"],
	H: ["X..X", "X..X", "XXXX", "X..X", "X..X"],
	I: ["XXX", ".X.", ".X.", ".X.", "XXX"],
	J: ["..XX", "...X", "...X", "X..X", ".XX."],
	K: ["X..X", "X.X.", "XX..", "X.X.", "X..X"],
	L: ["X...", "X...", "X...", "X...", "XXXX"],
	M: ["X...X", "XX.XX", "X.X.X", "X...X", "X...X"],
	N: ["X...X", "XX..X", "X.X.X", "X..XX", "X...X"],
	O: [".XX.", "X..X", "X..X", "X..X", ".XX."],
	P: ["XXX.", "X..X", "XXX.", "X...", "X..."],
	Q: [".XX.", "X..X", "X..X", "X.X.", ".X.X"],
	R: ["XXX.", "X..X", "XXX.", "X.X.", "X..X"],
	S: [".XXX", "X...", ".XX.", "...X", "XXX."],
	T: ["XXXXX", "..X..", "..X..", "..X..", "..X.."],
	U: ["X..X", "X..X", "X..X", "X..X", ".XX."],
	V: ["X...X", "X...X", "X...X", ".X.X.", "..X.."],
	W: ["X...X", "X...X", "X.X.X", "XX.XX", "X...X"],
	X: ["X...X", ".X.X.", "..X..", ".X.X.", "X...X"],
	Y: ["X...X", ".X.X.", "..X..", "..X..", "..X.."],
	Z: ["XXXX", "...X", ".XX.", "X...", "XXXX"],
	"0": ["XXXX", "X..X", "X..X", "X..X", "XXXX"],
	"1": [".X.", "XX.", ".X.", ".X.", "XXX"],
	"2": ["XXX.", "...X", ".XX.", "X...", "XXXX"],
	"3": ["XXX.", "...X", ".XX.", "...X", "XXX."],
	"4": ["X..X", "X..X", "XXXX", "...X", "...X"],
	"5": ["XXXX", "X...", "XXX.", "...X", "XXX."],
	"6": [".XX.", "X...", "XXX.", "X..X", ".XX."],
	"7": ["XXXX", "...X", "..X.", ".X..", ".X.."],
	"8": [".XX.", "X..X", ".XX.", "X..X", ".XX."],
	"9": [".XX.", "X..X", ".XXX", "...X", ".XX."],
	"'": ["X", "X", ".", ".", "."],
	".": [".", ".", ".", ".", "X"],
	"-": ["...", "...", "XXX", "...", "..."],
	"<": ["..X", ".X.", "X..", ".X.", "..X"],
	">": ["X..", ".X.", "..X", ".X.", "X.."],
	"/": ["..X", "..X", ".X.", "X..", "X.."],
	" ": ["..", "..", "..", "..", ".."],
};

export interface PixelTextOptions {
	scale: 1 | 2;
	shadow: boolean;
	/** Shadow column offset; defaults to 1. */
	shadowDx?: 0 | 1;
	/** Face and shadow colors (`#rrggbb`). Defaults to gk-night `accent` / `pixelShadow`. */
	colors?: { face: string; shadow: string };
	/** Defaults to the terminal's detected color depth. */
	colorMode?: ColorMode;
}

function glyphFor(char: string): readonly string[] {
	return GLYPHS[char.toUpperCase()] ?? GLYPHS[" "];
}

/** Width in pixels of one glyph (before scaling); unknown characters are a space. */
export function pixelGlyphWidth(char: string): number {
	return glyphFor(char)[0].length;
}

/** Terminal columns `renderPixelText` produces for `text`. */
export function pixelTextWidth(text: string, scale: 1 | 2, shadow: boolean, shadowDx: 0 | 1 = 1): number {
	const chars = [...text];
	if (chars.length === 0) return 0;
	const pixels = chars.reduce((sum, char) => sum + pixelGlyphWidth(char), 0) + chars.length - 1;
	return pixels * scale + (shadow ? shadowDx : 0);
}

/** Terminal rows `renderPixelText` produces. */
export function pixelTextRows(scale: 1 | 2, shadow: boolean): number {
	return Math.ceil((PIXEL_GLYPH_ROWS * scale + (shadow ? 1 : 0)) / 2);
}

const enum Sub {
	Empty = 0,
	Face = 1,
	Shadow = 2,
}

/**
 * Render `text` as pixel-font lines. Every line has the same visible width (`pixelTextWidth`) and carries its own
 * SGR state, so lines can be placed independently; colors reset at each line end.
 */
export function renderPixelText(text: string, opts: PixelTextOptions): string[] {
	const { scale, shadow } = opts;
	const rows = pixelTextRows(scale, shadow);
	const chars = [...text];
	if (chars.length === 0) return Array.from({ length: rows }, () => "");

	// Face bitmap in pixels, one gap column between glyphs.
	const glyphs = chars.map(glyphFor);
	const pixelWidth = glyphs.reduce((sum, glyph) => sum + glyph[0].length, 0) + glyphs.length - 1;
	const face: boolean[][] = Array.from({ length: PIXEL_GLYPH_ROWS }, () => new Array<boolean>(pixelWidth).fill(false));
	let x0 = 0;
	for (const glyph of glyphs) {
		for (let y = 0; y < PIXEL_GLYPH_ROWS; y++) {
			const row = glyph[y];
			for (let x = 0; x < row.length; x++) if (row[x] === "X") face[y][x0 + x] = true;
		}
		x0 += glyph[0].length + 1;
	}

	// Sub-cell grid: 1 column × ½ row per sub-cell.
	const dx = shadow ? (opts.shadowDx ?? 1) : 0;
	const dy = shadow ? 1 : 0;
	const subWidth = pixelWidth * scale + dx;
	const subHeight = PIXEL_GLYPH_ROWS * scale + dy;
	const faceAt = (x: number, y: number): boolean =>
		x >= 0 && y >= 0 && x < pixelWidth * scale && y < PIXEL_GLYPH_ROWS * scale && face[(y / scale) | 0][(x / scale) | 0];
	const subAt = (x: number, y: number): Sub => {
		if (y >= subHeight) return Sub.Empty;
		if (faceAt(x, y)) return Sub.Face;
		if (shadow && faceAt(x - dx, y - dy)) return Sub.Shadow;
		return Sub.Empty;
	};

	const mode = opts.colorMode ?? detectColorMode();
	const colors = opts.colors ?? { face: GK_NIGHT.accent, shadow: GK_NIGHT.pixelShadow };
	const faceFg = fgAnsi(colors.face, mode);
	const shadowFg = fgAnsi(colors.shadow, mode);
	const shadowBg = bgAnsi(colors.shadow, mode);

	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		let line = "";
		let fg = "";
		let bg = "";
		const paint = (nextFg: string, nextBg: string, glyph: string): void => {
			if (nextBg !== bg) {
				line += nextBg || BG_RESET;
				bg = nextBg;
			}
			if (nextFg && nextFg !== fg) {
				line += nextFg;
				fg = nextFg;
			}
			line += glyph;
		};
		for (let x = 0; x < subWidth; x++) {
			const top = subAt(x, row * 2);
			const bottom = subAt(x, row * 2 + 1);
			if (top === Sub.Empty && bottom === Sub.Empty) paint("", "", " ");
			else if (top === bottom) paint(top === Sub.Face ? faceFg : shadowFg, "", "█");
			else if (bottom === Sub.Empty) paint(top === Sub.Face ? faceFg : shadowFg, "", "▀");
			else if (top === Sub.Empty) paint(bottom === Sub.Face ? faceFg : shadowFg, "", "▄");
			else paint(faceFg, shadowBg, top === Sub.Face ? "▀" : "▄");
		}
		if (fg) line += FG_RESET;
		if (bg) line += BG_RESET;
		lines.push(line);
	}
	return lines;
}
