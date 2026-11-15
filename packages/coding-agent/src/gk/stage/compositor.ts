/**
 * Stage compositor: a full-screen cell grid that tiles blit their rendered rows into. Cells carry
 * the active SGR state, so colors never bleed between tiles and every output row has exactly
 * `width` columns. Non-SGR escapes (cursor moves, OSC, APC) are dropped.
 *
 * SGR is normalized per cell (one slot per attribute), so a row costs one short sequence per style
 * change however many escapes its source lines carried. A base style (the Stage's `paneBg`) fills
 * every cell whose own foreground/background is unset, so nothing shows the terminal default.
 */
import { getSegmenter, replaceTabs, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Rect } from "./layout";

export interface Cell {
	/** Grapheme, or `""` for the right half of a wide grapheme. */
	ch: string;
	/** Normalized SGR sequence for this cell (base style included); `""` = terminal default. */
	sgr: string;
}

const RESET = "\x1b[0m";

/** One slot per SGR attribute; `""` = unset. */
interface SgrSlots {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: string;
	blink: boolean;
	inverse: boolean;
	hidden: boolean;
	strike: boolean;
	overline: boolean;
	fg: string;
	bg: string;
	ulColor: string;
}

function emptySlots(): SgrSlots {
	return {
		bold: false,
		dim: false,
		italic: false,
		underline: "",
		blink: false,
		inverse: false,
		hidden: false,
		strike: false,
		overline: false,
		fg: "",
		bg: "",
		ulColor: "",
	};
}

/** Apply SGR `params` (the text between `ESC[` and `m`) to `s` in place. */
function applySgr(s: SgrSlots, params: string): void {
	const parts = params === "" ? ["0"] : params.split(";");
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		// Colon forms (`38:2::r:g:b`, `4:3`) are one self-contained token.
		const colon = p.indexOf(":");
		const code = Number(colon >= 0 ? p.slice(0, colon) : p || "0");
		if (code === 38 || code === 48 || code === 58) {
			let color = p;
			if (colon < 0) {
				const mode = parts[i + 1];
				const n = mode === "5" ? 2 : mode === "2" ? 4 : 0;
				color = parts.slice(i, i + 1 + n).join(";");
				i += n;
			}
			if (code === 38) s.fg = color;
			else if (code === 48) s.bg = color;
			else s.ulColor = color;
			continue;
		}
		if (code === 0) Object.assign(s, emptySlots());
		else if (code === 1) s.bold = true;
		else if (code === 2) s.dim = true;
		else if (code === 3) s.italic = true;
		else if (code === 4) s.underline = p;
		else if (code === 5 || code === 6) s.blink = true;
		else if (code === 7) s.inverse = true;
		else if (code === 8) s.hidden = true;
		else if (code === 9) s.strike = true;
		else if (code === 21) s.underline = "21";
		else if (code === 22) s.bold = s.dim = false;
		else if (code === 23) s.italic = false;
		else if (code === 24) s.underline = "";
		else if (code === 25) s.blink = false;
		else if (code === 27) s.inverse = false;
		else if (code === 28) s.hidden = false;
		else if (code === 29) s.strike = false;
		else if (code === 39) s.fg = "";
		else if (code === 49) s.bg = "";
		else if (code === 53) s.overline = true;
		else if (code === 55) s.overline = false;
		else if (code === 59) s.ulColor = "";
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) s.fg = p;
		else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) s.bg = p;
	}
}

/** One SGR sequence for `s`, unset colors falling back to `base`; `""` when nothing is set. */
function serializeSgr(s: SgrSlots, base: SgrSlots | undefined): string {
	const out: string[] = [];
	if (s.bold) out.push("1");
	if (s.dim) out.push("2");
	if (s.italic) out.push("3");
	if (s.underline) out.push(s.underline);
	if (s.blink) out.push("5");
	if (s.inverse) out.push("7");
	if (s.hidden) out.push("8");
	if (s.strike) out.push("9");
	if (s.overline) out.push("53");
	const fg = s.fg || base?.fg || "";
	const bg = s.bg || base?.bg || "";
	if (fg) out.push(fg);
	if (bg) out.push(bg);
	if (s.ulColor) out.push(s.ulColor);
	return out.length > 0 ? `\x1b[${out.join(";")}m` : "";
}

/** Parse a run of SGR sequences (e.g. a theme color opener) into slots. */
function parseSgrRun(seq: string): SgrSlots {
	const s = emptySlots();
	for (const m of seq.matchAll(/\x1b\[([0-9;:]*)m/g)) applySgr(s, m[1]!);
	return s;
}

/** Index just past the escape sequence starting at `i` (which holds ESC). */
function escapeEnd(line: string, i: number): number {
	const kind = line[i + 1];
	if (kind === "[") {
		let j = i + 2;
		while (j < line.length) {
			const code = line.charCodeAt(j);
			j++;
			if (code >= 0x40 && code <= 0x7e) break;
		}
		return j;
	}
	if (kind === "]" || kind === "_" || kind === "P" || kind === "^") {
		let j = i + 2;
		while (j < line.length) {
			if (line[j] === "\x07") return j + 1;
			if (line[j] === "\x1b" && line[j + 1] === "\\") return j + 2;
			j++;
		}
		return j;
	}
	return Math.min(line.length, i + 2);
}

export class CellBuffer {
	readonly width: number;
	readonly height: number;
	readonly #ch: string[];
	readonly #sgr: string[];
	readonly #base: SgrSlots | undefined;
	/** Serialized default style (the base alone). */
	readonly #blank: string;

	/** `base`: SGR (e.g. a background color opener) every cell falls back to for unset fg/bg. */
	constructor(width: number, height: number, base = "") {
		this.width = Math.max(0, Math.floor(width));
		this.height = Math.max(0, Math.floor(height));
		this.#base = base ? parseSgrRun(base) : undefined;
		this.#blank = serializeSgr(emptySlots(), this.#base);
		this.#ch = new Array<string>(this.width * this.height).fill(" ");
		this.#sgr = new Array<string>(this.width * this.height).fill(this.#blank);
	}

	cell(x: number, y: number): Cell | undefined {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
		const i = y * this.width + x;
		return { ch: this.#ch[i], sgr: this.#sgr[i] };
	}

	/** Fill a rect with one narrow character; `sgr` is raw SGR (normalized against the base). */
	fill(rect: Rect, ch = " ", sgr = ""): void {
		const style = sgr ? serializeSgr(parseSgrRun(sgr), this.#base) : this.#blank;
		for (let y = rect.y; y < rect.y + rect.h; y++) {
			for (let x = rect.x; x < rect.x + rect.w; x++) this.#put(x, y, ch, style, 1);
		}
	}

	clear(): void {
		this.#ch.fill(" ");
		this.#sgr.fill(this.#blank);
	}

	/**
	 * Write `lines[i]` into row `rect.y + i`, clipped to `rect` and the buffer. Each row of the rect is
	 * fully painted: short lines are padded with base-style blanks, a wide grapheme that would
	 * cross the right edge becomes a blank, and missing lines blank their row.
	 */
	blit(lines: readonly string[], rect: Rect): void {
		const right = Math.min(rect.x + rect.w, this.width);
		const segmenter = getSegmenter();
		for (let r = 0; r < rect.h; r++) {
			const y = rect.y + r;
			if (y < 0 || y >= this.height) continue;
			const line = replaceTabs(lines[r] ?? "");
			let col = rect.x;
			const slots = emptySlots();
			let active = this.#blank;
			let i = 0;
			outer: while (i < line.length && col < right) {
				if (line.charCodeAt(i) === 0x1b) {
					const end = escapeEnd(line, i);
					if (line[i + 1] === "[" && line[end - 1] === "m") {
						applySgr(slots, line.slice(i + 2, end - 1));
						active = serializeSgr(slots, this.#base);
					}
					i = end;
					continue;
				}
				let runEnd = line.indexOf("\x1b", i);
				if (runEnd < 0) runEnd = line.length;
				for (const { segment } of segmenter.segment(line.slice(i, runEnd))) {
					const code = segment.charCodeAt(0);
					if (code < 0x20 || code === 0x7f) continue;
					const gw = visibleWidth(segment);
					if (gw <= 0) continue;
					if (col + gw > right) break outer;
					if (col >= 0) this.#put(col, y, segment, active, gw);
					else if (col + gw > 0) this.#put(0, y, " ", this.#blank, 1);
					col += gw;
				}
				i = runEnd;
			}
			for (; col < right; col++) if (col >= 0) this.#put(col, y, " ", this.#blank, 1);
		}
	}

	/** Rows as strings: exactly `width` columns each, SGR reset at every style change and row end. */
	toLines(): string[] {
		const out: string[] = [];
		for (let y = 0; y < this.height; y++) {
			let row = "";
			let cur = "";
			for (let x = 0; x < this.width; x++) {
				const i = y * this.width + x;
				const ch = this.#ch[i];
				if (ch === "") continue;
				const sgr = this.#sgr[i];
				if (sgr !== cur) {
					if (cur) row += RESET;
					row += sgr;
					cur = sgr;
				}
				row += ch;
			}
			if (cur) row += RESET;
			out.push(row);
		}
		return out;
	}

	#put(x: number, y: number, ch: string, sgr: string, width: number): void {
		if (y < 0 || y >= this.height || x < 0 || x + width > this.width) return;
		const base = y * this.width;
		// Breaking a wide grapheme from either side leaves a blank where its other half was.
		if (this.#ch[base + x] === "" && x > 0) this.#ch[base + x - 1] = " ";
		const after = x + width;
		if (after < this.width && this.#ch[base + after] === "") this.#ch[base + after] = " ";
		this.#ch[base + x] = ch;
		this.#sgr[base + x] = sgr;
		for (let k = 1; k < width; k++) {
			this.#ch[base + x + k] = "";
			this.#sgr[base + x + k] = sgr;
		}
	}
}

export type FramePart = "border" | "title" | "badge" | "status";

/** Styles one frame part; theme tokens are chosen by the caller. Identity by default. */
export type FrameStyle = (part: FramePart, text: string) => string;

export interface FrameOptions {
	/** Top-left title, e.g. `0.1 W-01 · GET /hello route`. Truncated with an ellipsis. */
	title?: string;
	/** Right-aligned text in the top border, e.g. `@ada`. Dropped first when space runs out. */
	badge?: string;
	/** Bottom statusline row inside the frame. */
	status?: string;
	style?: FrameStyle;
}

/** Pane label in tmux style: `0.<index> <title>`. */
export function paneTitle(index: number, title: string): string {
	return `0.${index} ${title}`;
}

/**
 * Draw a rounded box-drawing frame around `rect` and return the content rect inside it
 * (minus the statusline row when `status` is given).
 */
export function drawFrame(buffer: CellBuffer, rect: Rect, options: FrameOptions = {}): Rect {
	const style: FrameStyle = options.style ?? ((_part, text) => text);
	const { x, y, w, h } = rect;
	if (w < 2 || h < 2) return { x, y, w: 0, h: 0 };
	const inner = w - 2;

	// Top: ╭─ title ───── badge ─╮
	const avail = w - 4;
	let top = style("border", "╭");
	if (avail <= 0) {
		top += style("border", "─".repeat(inner));
	} else {
		let badge = options.badge ? truncateToWidth(options.badge, Math.max(0, avail - 2)) : "";
		let badgeW = badge ? visibleWidth(badge) + 2 : 0;
		const titleRaw = options.title ?? "";
		if (badge && titleRaw && avail - badgeW < 5) {
			badge = "";
			badgeW = 0;
		}
		const titleMax = avail - badgeW - 2;
		const title = titleRaw && titleMax > 0 ? truncateToWidth(titleRaw, titleMax) : "";
		const titleW = title ? visibleWidth(title) + 2 : 0;
		top += style("border", "─");
		if (title) top += `${style("border", " ")}${style("title", title)}${style("border", " ")}`;
		top += style("border", "─".repeat(Math.max(0, avail - titleW - badgeW)));
		if (badge) top += `${style("border", " ")}${style("badge", badge)}${style("border", " ")}`;
		top += style("border", "─");
	}
	top += style("border", "╮");
	buffer.blit([top], { x, y, w, h: 1 });

	const side = style("border", "│");
	for (let r = 1; r < h - 1; r++) {
		buffer.blit([side], { x, y: y + r, w: 1, h: 1 });
		buffer.blit([side], { x: x + w - 1, y: y + r, w: 1, h: 1 });
	}
	buffer.blit([style("border", `╰${"─".repeat(inner)}╯`)], { x, y: y + h - 1, w, h: 1 });

	let contentH = h - 2;
	if (options.status !== undefined && contentH >= 2) {
		contentH -= 1;
		buffer.blit([style("status", truncateToWidth(options.status, inner))], {
			x: x + 1,
			y: y + h - 2,
			w: inner,
			h: 1,
		});
	}
	return { x: x + 1, y: y + 1, w: inner, h: contentH };
}
