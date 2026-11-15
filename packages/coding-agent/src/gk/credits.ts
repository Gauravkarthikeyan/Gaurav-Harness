/**
 * Credits card for `/credits` and `gk-code --credits`. This is the one surface that names the upstream projects:
 * their MIT licenses require the attribution.
 */
import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { detectColorMode, FG_RESET, fgAnsi } from "@oh-my-pi/pi-tui/theme/color";
import { GK_NIGHT } from "@oh-my-pi/pi-tui/theme/gk-palette";
import { GK_VERSION } from "./brand";

export type CreditsToken = "accent" | "text" | "muted" | "border";
export type CreditsStyle = (token: CreditsToken, text: string) => string;

const plain: CreditsStyle = (_token, text) => text;

type Row = readonly [CreditsToken, string] | null;

const ROWS: readonly Row[] = [
	null,
	["accent", "GAURAV'S HARNESS"],
	["muted", `gk-code ${GK_VERSION}`],
	null,
	["text", "by Gaurav Karthikeyan · github.com/Gauravkarthikeyan"],
	["text", "gauravkarthik22@gmail.com"],
	null,
	["muted", "built on oh-my-pi by Can Bölük, from Mario Zechner's Pi · MIT"],
	null,
];

const PAD = 2;
const MIN_WIDTH = 12;
const NATURAL_WIDTH = Math.max(...ROWS.map(row => (row ? visibleWidth(row[1]) : 0))) + 2 * PAD + 2;

/** Greedy word wrap; a word longer than the line is hard-cut. */
function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		let rest = word;
		while (visibleWidth(rest) > width) {
			if (line) {
				lines.push(line);
				line = "";
			}
			const chars = [...rest];
			lines.push(chars.slice(0, width).join(""));
			rest = chars.slice(width).join("");
		}
		if (!rest) continue;
		if (!line) line = rest;
		else if (visibleWidth(line) + 1 + visibleWidth(rest) <= width) line += ` ${rest}`;
		else {
			lines.push(line);
			line = rest;
		}
	}
	if (line) lines.push(line);
	return lines;
}

/** The boxed credits card, every row exactly the card width (≤ `width`). */
export function creditsLines(width: number, style: CreditsStyle = plain): string[] {
	const cardWidth = Math.max(MIN_WIDTH, Math.min(width, NATURAL_WIDTH));
	const inner = cardWidth - 2 - 2 * PAD;
	const side = style("border", "│");
	const margin = " ".repeat(PAD);
	const out = [style("border", `┌${"─".repeat(cardWidth - 2)}┐`)];
	for (const row of ROWS) {
		const texts = row ? wrap(row[1], inner) : [""];
		for (const text of texts) {
			const fill = " ".repeat(inner - visibleWidth(text));
			const body = row && text ? style(row[0], text) : text;
			out.push(`${side}${margin}${body}${fill}${margin}${side}`);
		}
	}
	out.push(style("border", `└${"─".repeat(cardWidth - 2)}┘`));
	return out;
}

/** The card as transcript content for `/credits`, indented one column. */
export class CreditsCard implements Component {
	constructor(readonly style: CreditsStyle) {}

	render(width: number): string[] {
		return creditsLines(width - 1, this.style).map(line => ` ${line}`);
	}
}

/** `gk-code --credits` output; gk-night colors when stdout is a terminal. */
export function formatCreditsOutput(width: number, color: boolean): string {
	const mode = detectColorMode();
	const style: CreditsStyle = color ? (token, text) => `${fgAnsi(GK_NIGHT[token], mode)}${text}${FG_RESET}` : plain;
	return `${creditsLines(width, style).join("\n")}\n`;
}
