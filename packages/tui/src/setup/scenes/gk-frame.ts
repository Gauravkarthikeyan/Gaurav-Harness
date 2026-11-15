/**
 * gk-night chrome shared by the setup wizard's cell-grid frames (docs/superpowers/specs/2026-11-15-gk-visual-v2.md):
 * black page, gold pixel wordmark, light-box panels and the key-hint bar. Lines are pre-styled ANSI; `paintPage`
 * rebases every reset onto the page background so scene bodies styled with the active theme keep the black page.
 */
import { BG_RESET, bgAnsi, detectColorMode, FG_RESET, fgAnsi } from "../../theme/color";
import { GK_NIGHT } from "../../theme/gk-palette";
import type { ColorMode } from "../../theme/schema";
import { padToWidth } from "../../render/utils";
import { truncateToWidth, visibleWidth } from "../../utils";
import { pixelTextWidth, renderPixelText } from "../../gk/pixel-font";

export const GK_WORDMARK = "GAURAV'S HARNESS";
export const GK_SETUP_VERSION = "gk-code 0.1.0";
const RESET = "\x1b[0m";

let colorMode: ColorMode | undefined;
function mode(): ColorMode {
	colorMode ??= detectColorMode();
	return colorMode;
}

export type GkToken = "text" | "muted" | "dim" | "accent" | "border" | "success" | "error" | "warning";

/** Paint `text` in a gk-night token. */
export function gk(token: GkToken, text: string): string {
	return `${fgAnsi(GK_NIGHT[token], mode())}${text}${FG_RESET}`;
}

/** Pad every line to `width` on the page background; `band` rows (key-hint bar) use the panel band. */
export function paintPage(
	lines: readonly string[],
	width: number,
	height: number,
	bandRows: ReadonlySet<number> = new Set(),
): string[] {
	const out: string[] = [];
	for (let y = 0; y < height; y++) {
		const bg = bgAnsi(bandRows.has(y) ? GK_NIGHT.panel : GK_NIGHT.paneBg, mode());
		const line = padToWidth(truncateToWidth(lines[y] ?? "", width), width);
		out.push(`${bg}${line.replaceAll(RESET, `${RESET}${bg}`).replaceAll(BG_RESET, bg)}${RESET}`);
	}
	return out;
}

/** The wordmark rows for `width`: scale-1 pixel font when it fits with a 2-col margin, else one text row. */
export function wordmarkLines(width: number): string[] {
	if (pixelTextWidth(GK_WORDMARK, 1, true) + 4 <= width) {
		return renderPixelText(GK_WORDMARK, {
			scale: 1,
			shadow: true,
			colors: { face: GK_NIGHT.accent, shadow: GK_NIGHT.pixelShadow },
			colorMode: mode(),
		});
	}
	return [gk("accent", `</> ${GK_WORDMARK}`)];
}

/** `left` and `right` on one row of `width`, `right` flush right; `left` is cut first. */
export function spread(left: string, right: string, width: number): string {
	const room = width - visibleWidth(right);
	if (room <= 0) return truncateToWidth(right, width);
	const head = truncateToWidth(left, Math.max(0, room - 1));
	return `${head}${" ".repeat(Math.max(0, room - visibleWidth(head)))}${right}`;
}

/** Key-hint bar: keys in gold, labels muted, `gk-code <version>` dim at the right; hints drop from the end to fit. */
export function hintBar(hints: ReadonlyArray<readonly [key: string, label: string]>, width: number): string {
	const right = `${gk("dim", GK_SETUP_VERSION)} `;
	let shown = hints.length;
	const build = (count: number): string =>
		` ${hints
			.slice(0, count)
			.map(([key, label]) => `${gk("accent", key)} ${gk("muted", label)}`)
			.join("   ")}`;
	while (shown > 0 && visibleWidth(build(shown)) + visibleWidth(right) + 1 > width) shown--;
	return spread(build(shown), right, width);
}

/**
 * A light-box panel `width` columns wide: `title` in the top edge, `body` rows padded inside with one column of
 * padding, exactly `height` rows tall (rows past the body are blank, extra body rows are dropped).
 */
export function panel(title: string, body: readonly string[], width: number, height: number, focused = true): string[] {
	const edge: GkToken = focused ? "accent" : "border";
	const inner = Math.max(0, width - 4);
	const label = title ? ` ${truncateToWidth(title, Math.max(0, width - 6))} ` : "";
	const top = `${gk(edge, "┌─")}${gk("text", label)}${gk(edge, `${"─".repeat(Math.max(0, width - 3 - visibleWidth(label)))}┐`)}`;
	const rows = [top];
	for (let i = 0; i < height - 2; i++) {
		const content = padToWidth(truncateToWidth(body[i] ?? "", inner), inner);
		rows.push(`${gk(edge, "│")} ${content} ${gk(edge, "│")}`);
	}
	rows.push(gk(edge, `└${"─".repeat(Math.max(0, width - 2))}┘`));
	return rows;
}
