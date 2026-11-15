/**
 * Fixed-size cell canvas for the full-screen GK launch screens (splash, mode picker).
 *
 * Every cell is one terminal column; callers only place single-width glyphs. Pre-rendered ANSI runs (the pixel
 * wordmark) are blitted as opaque segments of a known width. `lines()` returns rows of exactly `width` visible
 * columns, each painted on `bg` and self-contained (SGR state resets at every line end).
 */
import { BG_RESET, bgAnsi, FG_RESET, fgAnsi } from "../theme/color";
import type { ColorMode } from "../theme/schema";

interface RawSegment {
	readonly x: number;
	readonly width: number;
	readonly ansi: string;
}

export class Canvas {
	readonly #chars: string[][];
	readonly #fg: (string | undefined)[][];
	readonly #rowBg: (string | undefined)[];
	readonly #raw: RawSegment[][];

	constructor(
		readonly width: number,
		readonly height: number,
		readonly bg: string,
		readonly colorMode: ColorMode,
	) {
		this.#chars = Array.from({ length: height }, () => new Array<string>(width).fill(" "));
		this.#fg = Array.from({ length: height }, () => new Array<string | undefined>(width).fill(undefined));
		this.#rowBg = new Array<string | undefined>(height).fill(undefined);
		this.#raw = Array.from({ length: height }, () => []);
	}

	/** Place `text` (single-width glyphs) at column `x`; anything outside the canvas is clipped. */
	put(x: number, y: number, text: string, fg?: string): void {
		if (y < 0 || y >= this.height) return;
		let col = x;
		for (const char of text) {
			if (col >= this.width) return;
			if (col >= 0) {
				this.#chars[y][col] = char;
				this.#fg[y][col] = fg;
			}
			col++;
		}
	}

	/** Place `text` centered on the row. */
	center(y: number, text: string, fg?: string): void {
		this.put(Math.floor((this.width - [...text].length) / 2), y, text, fg);
	}

	/** Paint a whole row's background (for bars such as the key-hint row). */
	fillRow(y: number, bg: string): void {
		if (y >= 0 && y < this.height) this.#rowBg[y] = bg;
	}

	/**
	 * Blit a pre-rendered ANSI run of `width` visible columns. It must fit inside the canvas; runs that do not
	 * are dropped rather than cut mid-escape. `BG_RESET` inside the run is rebased onto the row background.
	 */
	putRaw(x: number, y: number, ansi: string, width: number): void {
		if (y < 0 || y >= this.height || x < 0 || x + width > this.width) return;
		this.#raw[y].push({ x, width, ansi });
	}

	lines(): string[] {
		const out: string[] = [];
		for (let y = 0; y < this.height; y++) {
			const bgSgr = bgAnsi(this.#rowBg[y] ?? this.bg, this.colorMode);
			const raws = [...this.#raw[y]].sort((a, b) => a.x - b.x);
			let line = bgSgr;
			let fg: string | undefined;
			let rawIndex = 0;
			for (let x = 0; x < this.width;) {
				const raw = raws[rawIndex];
				if (raw && raw.x === x) {
					line += raw.ansi.replaceAll(BG_RESET, bgSgr);
					line += FG_RESET + bgSgr;
					fg = undefined;
					x += raw.width;
					rawIndex++;
					continue;
				}
				const char = this.#chars[y][x];
				const color = this.#fg[y][x];
				if (char !== " " && color !== undefined && color !== fg) {
					line += fgAnsi(color, this.colorMode);
					fg = color;
				}
				line += char;
				x++;
			}
			out.push(`${line}${FG_RESET}${BG_RESET}`);
		}
		return out;
	}
}

/** `text` cut to `max` columns with a trailing `…` when it does not fit. */
export function clip(text: string, max: number): string {
	if (max <= 0) return "";
	const chars = [...text];
	if (chars.length <= max) return text;
	return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** Column count of single-width `text`. */
export function cols(text: string): number {
	return [...text].length;
}
