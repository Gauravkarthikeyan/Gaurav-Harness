/**
 * GK launch mode picker (docs/superpowers/specs/2026-11-15-gk-visual-v2.md §5.2): the lockup, a Solo and an
 * Orchestra card with a factual description and live facts, and a key-hint bar. The focused card has the gold
 * border. `renderModePicker` is pure; `pickerKey` maps one input chunk to an action.
 */
import { matchesKey } from "../keys";
import { detectColorMode } from "../theme/color";
import { GK_NIGHT, type GkPalette } from "../theme/gk-palette";
import type { ColorMode } from "../theme/schema";
import { Canvas, clip, cols } from "./canvas";
import { drawLogo, logoLayout } from "./logo";
import { SPLASH_AUTHOR } from "./splash-frame";

export type LaunchChoice = "solo" | "orchestra";

export interface PickerFact {
	readonly key: string;
	readonly value: string;
	/** `warn` renders the value with the `!` glyph in the warning hue. */
	readonly tone?: "warn";
}

export interface ModePickerState {
	readonly focused: LaunchChoice;
	/** The previous launch's choice, tagged `last used` on its card. */
	readonly last?: LaunchChoice;
	readonly solo: readonly PickerFact[];
	readonly orchestra: readonly PickerFact[];
	readonly version: string;
	readonly palette?: GkPalette;
	readonly colorMode?: ColorMode;
}

export type PickerAction =
	| { readonly type: "focus"; readonly choice: LaunchChoice }
	| { readonly type: "start"; readonly choice: LaunchChoice }
	| { readonly type: "quit" };

export const MODE_DESCRIPTIONS: Readonly<Record<LaunchChoice, string>> = {
	solo: "One agent with the full toolset (read, edit, run) in a single session.",
	orchestra: "A read-only conductor plans the work; roster models build it in parallel panes on the Stage.",
};

const TITLES: Readonly<Record<LaunchChoice, string>> = { solo: "Solo", orchestra: "Orchestra" };
const HOTKEYS: Readonly<Record<LaunchChoice, string>> = { solo: "s", orchestra: "o" };
const CARD_MAX_WIDTH = 56;
const CARD_GAP = 3;
const FACT_KEY_COLS = 11;

/** Map one input chunk to a picker action; `null` ignores it. */
export function pickerKey(focused: LaunchChoice, data: string): PickerAction | null {
	if (matchesKey(data, "ctrl+c")) return { type: "quit" };
	if (matchesKey(data, "enter") || matchesKey(data, "return")) return { type: "start", choice: focused };
	if (data === "s" || data === "S") return { type: "start", choice: "solo" };
	if (data === "o" || data === "O") return { type: "start", choice: "orchestra" };
	if (matchesKey(data, "left") || data === "h") return { type: "focus", choice: "solo" };
	if (matchesKey(data, "right") || data === "l") return { type: "focus", choice: "orchestra" };
	if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
		return { type: "focus", choice: focused === "solo" ? "orchestra" : "solo" };
	}
	return null;
}

/** Greedy word wrap to `width` columns; words longer than a line are clipped. */
function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (!word) continue;
		if (!line) line = word;
		else if (cols(line) + 1 + cols(word) <= width) line += ` ${word}`;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line) lines.push(line);
	return lines.map(entry => clip(entry, width));
}

interface CardModel {
	readonly choice: LaunchChoice;
	readonly description: string[];
	readonly facts: readonly PickerFact[];
}

export function renderModePicker(state: ModePickerState, width: number, height: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const h = Math.max(1, Math.floor(height));
	const palette = state.palette ?? GK_NIGHT;
	const canvas = new Canvas(w, h, palette.paneBg, state.colorMode ?? detectColorMode());

	const cardWidth = Math.max(12, Math.min(CARD_MAX_WIDTH, Math.floor((w - 4 - CARD_GAP) / 2)));
	const inner = cardWidth - 4;
	const cards: CardModel[] = (["solo", "orchestra"] as const).map(choice => ({
		choice,
		description: wrap(MODE_DESCRIPTIONS[choice], inner),
		facts: state[choice],
	}));
	const descRows = Math.max(...cards.map(card => card.description.length));
	const factRows = Math.max(...cards.map(card => card.facts.length));
	const cardHeight = 2 + 1 + descRows + 1 + factRows + 1;

	// Bottom: author line, blank, key-hint bar.
	const bottomRows = 3;
	const logo = logoLayout(w);
	const gap = h >= 34 ? 3 : 1;
	const block = logo.rows + gap + cardHeight;
	const room = h - bottomRows;
	let y = Math.max(0, Math.floor((room - block) / 2));
	if (logo.rows + y <= room) drawLogo(canvas, y, logo, palette);
	y += logo.rows + gap;

	const left = Math.floor((w - (cardWidth * 2 + CARD_GAP)) / 2);
	cards.forEach((card, index) => {
		const cardX = left + index * (cardWidth + CARD_GAP);
		drawCard(canvas, cardX, y, cardWidth, cardHeight, 3 + descRows, card, state, palette);
	});

	if (h >= 3) canvas.center(h - 3, clip(SPLASH_AUTHOR, w - 2), palette.dim);
	drawHints(canvas, h - 1, state.version, palette);
	return canvas.lines();
}

function drawCard(
	canvas: Canvas,
	x: number,
	y: number,
	width: number,
	height: number,
	/** Row offset of the first fact, shared by both cards so their facts line up. */
	factsOffset: number,
	card: CardModel,
	state: ModePickerState,
	palette: GkPalette,
): void {
	const focused = state.focused === card.choice;
	const border = focused ? palette.borderFocus : palette.border;
	const inner = width - 2;

	// Top edge: `┌─ Title · last used ───── s ─┐`.
	const hotkey = ` ${HOTKEYS[card.choice]} `;
	const titleRoom = Math.max(0, inner - 1 - cols(hotkey) - 1 - 2);
	const lastTag = state.last === card.choice ? " · last used" : "";
	const title = clip(` ${TITLES[card.choice]}`, titleRoom);
	const tag = clip(lastTag, Math.max(0, titleRoom - cols(title)));
	canvas.put(x, y, `┌─${" ".repeat(inner - 1)}┐`, border);
	const fillStart = x + 2 + cols(title) + cols(tag) + 1;
	const fillEnd = x + width - 2 - cols(hotkey);
	canvas.put(x + 2, y, title, focused ? palette.accent : palette.muted);
	canvas.put(x + 2 + cols(title), y, tag, palette.dim);
	canvas.put(x + 2 + cols(title) + cols(tag), y, " ", border);
	canvas.put(fillStart, y, "─".repeat(Math.max(0, fillEnd - fillStart)), border);
	canvas.put(fillEnd, y, hotkey, focused ? palette.accent : palette.muted);
	canvas.put(x + width - 2, y, "─", border);

	for (let row = 1; row < height - 1; row++) {
		canvas.put(x, y + row, "│", border);
		canvas.put(x + width - 1, y + row, "│", border);
	}
	canvas.put(x, y + height - 1, `└${"─".repeat(inner)}┘`, border);

	let row = y + 2;
	for (const line of card.description) {
		canvas.put(x + 2, row++, line, focused ? palette.text : palette.muted);
	}
	row = y + factsOffset;
	for (const fact of card.facts) {
		canvas.put(x + 2, row, clip(fact.key, FACT_KEY_COLS - 1), palette.dim);
		const valueRoom = width - 4 - FACT_KEY_COLS;
		if (fact.tone === "warn") {
			canvas.put(x + 2 + FACT_KEY_COLS, row, "!", palette.warning);
			canvas.put(x + 4 + FACT_KEY_COLS, row, clip(fact.value, valueRoom - 2), palette.warning);
		} else {
			canvas.put(x + 2 + FACT_KEY_COLS, row, clip(fact.value, valueRoom), focused ? palette.text : palette.muted);
		}
		row++;
	}
}

/** Key-hint bar on the `panel` band: keys in accent, labels muted, version right. */
function drawHints(canvas: Canvas, y: number, version: string, palette: GkPalette): void {
	if (y < 0) return;
	canvas.fillRow(y, palette.panel);
	const hints: Array<[string, string]> = [
		["← →", "choose"],
		["⏎", "start"],
		["s", "solo"],
		["o", "orchestra"],
		["^C", "quit"],
	];
	const right = `gk-code ${version}`;
	const limit = canvas.width - cols(right) - 3;
	let x = 1;
	for (const [key, label] of hints) {
		const span = cols(key) + 1 + cols(label);
		if (x + span > limit) break;
		canvas.put(x, y, key, palette.accent);
		canvas.put(x + cols(key) + 1, y, label, palette.muted);
		x += span + 3;
	}
	if (cols(right) + 2 <= canvas.width) canvas.put(canvas.width - cols(right) - 1, y, right, palette.dim);
}
