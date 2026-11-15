/**
 * Ctrl+K command palette (gk-night): a centered overlay with a search row, up to 12 ranked items and a key-hint
 * footer. Selected row on `selectedBg` with the label in accent; kind label muted at the right, shortcut dim.
 */
import { type Component, extractPrintableText, matchesKey, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../../modes/types";
import {
	collectPaletteItems,
	loadPaletteSessions,
	type PaletteItem,
	rankPalette,
	recentPaletteIds,
	rememberPaletteRun,
} from "../palette-sources";

export const PALETTE_MAX_ROWS = 12;
const PALETTE_WIDTH = 96;

const KIND_LABELS: Readonly<Record<PaletteItem["kind"], string>> = {
	command: "command",
	skill: "skill",
	mcp: "mcp",
	model: "model",
	setting: "setting",
	session: "session",
	key: "key",
};

function cut(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const chars = [...text];
	let out = "";
	for (const char of chars) {
		if (visibleWidth(out + char) > width - 1) break;
		out += char;
	}
	return `${out}…`;
}

export interface CommandPaletteOptions {
	onRun(item: PaletteItem): void;
	onClose(): void;
}

export class CommandPalette implements Component {
	readonly #items: readonly PaletteItem[];
	readonly #recent: () => readonly string[];
	readonly #options: CommandPaletteOptions;
	#query = "";
	#selected = 0;
	#ranked: PaletteItem[];

	constructor(items: readonly PaletteItem[], recent: () => readonly string[], options: CommandPaletteOptions) {
		this.#items = items;
		this.#recent = recent;
		this.#options = options;
		this.#ranked = rankPalette(items, "", recent());
	}

	invalidate(): void {}

	#setQuery(query: string): void {
		this.#query = query;
		this.#selected = 0;
		this.#ranked = rankPalette(this.#items, query, this.#recent());
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+k")) {
			this.#options.onClose();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const item = this.#ranked[this.#selected];
			if (item) this.#options.onRun(item);
			return;
		}
		const total = this.#ranked.length;
		if (matchesKey(data, "up")) {
			if (total) this.#selected = (this.#selected - 1 + total) % total;
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "tab")) {
			if (total) this.#selected = (this.#selected + 1) % total;
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.#query) this.#setQuery([...this.#query].slice(0, -1).join(""));
			return;
		}
		const printable = extractPrintableText(data);
		if (printable !== undefined && (this.#query || printable.trim())) this.#setQuery(this.#query + printable);
	}

	render(width: number): string[] {
		const boxWidth = Math.max(24, Math.min(width, PALETTE_WIDTH));
		const inner = boxWidth - 4;
		const edge = (text: string) => theme.fg("borderAccent", text);
		const row = (content: string) => {
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(content)));
			return `${edge("│")} ${content}${pad} ${edge("│")}`;
		};
		const title = " palette ";
		const lines = [
			`${edge("┌─")}${theme.fg("text", title)}${edge(`${"─".repeat(Math.max(0, boxWidth - 3 - title.length))}┐`)}`,
		];
		const query = this.#query ? theme.fg("text", this.#query) : theme.fg("dim", "command, skill, model, setting…");
		lines.push(row(`${theme.fg("accent", "❯")} ${query}`));
		lines.push(row(theme.fg("borderMuted", "─".repeat(inner))));

		if (this.#ranked.length === 0) {
			lines.push(
				row(
					theme.fg(
						"muted",
						cut(`No match for "${this.#query}". Try a command, skill, model or setting name.`, inner),
					),
				),
			);
		} else {
			const total = this.#ranked.length;
			const first = Math.max(
				0,
				Math.min(this.#selected - Math.floor(PALETTE_MAX_ROWS / 2), total - PALETTE_MAX_ROWS),
			);
			for (let index = first; index < Math.min(total, first + PALETTE_MAX_ROWS); index++) {
				const item = this.#ranked[index]!;
				const selected = index === this.#selected;
				const kind = KIND_LABELS[item.kind];
				const shortcut = item.shortcut ? `${item.shortcut}  ` : "";
				const right = `${shortcut}${kind}`;
				const labelWidth = Math.min(Math.max(16, Math.floor(inner * 0.4)), inner - right.length - 4);
				const label = cut(item.label, labelWidth);
				const detailWidth = Math.max(0, inner - 2 - labelWidth - 2 - right.length - 1);
				const detail = cut(item.detail, detailWidth);
				const left = `${selected ? theme.fg("accent", "▸ ") : "  "}${selected ? theme.fg("accent", label) : theme.fg("text", label)}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))}  ${theme.fg("muted", detail)}`;
				const gap = " ".repeat(Math.max(1, inner - visibleWidth(left) - right.length));
				const content = `${left}${gap}${shortcut ? theme.fg("dim", shortcut) : ""}${theme.fg("muted", kind)}`;
				lines.push(
					selected
						? `${edge("│")} ${theme.bg("selectedBg", `${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}`)} ${edge("│")}`
						: row(content),
				);
			}
		}
		lines.push(row(""));
		lines.push(
			row(
				`${theme.fg("accent", "⏎")} ${theme.fg("muted", "run")}   ${theme.fg("accent", "↑↓")} ${theme.fg("muted", "select")}   ${theme.fg("accent", "esc")} ${theme.fg("muted", "close")}`,
			),
		);
		lines.push(edge(`└${"─".repeat(boxWidth - 2)}┘`));
		return lines;
	}
}

/** Open the palette over the transcript; Enter runs the item after the overlay closes. */
export async function showCommandPalette(ctx: InteractiveModeContext): Promise<void> {
	// Recent sessions are one source among seven: a listing failure drops them, logged, and the palette opens.
	await loadPaletteSessions(ctx).catch(error =>
		logger.warn("gk palette: recent sessions unavailable", { error: String(error) }),
	);
	const close = () => {
		handle.hide();
		ctx.ui.setFocus(ctx.editor);
		ctx.ui.requestRender();
	};
	const palette = new CommandPalette(collectPaletteItems(ctx), recentPaletteIds, {
		onClose: close,
		onRun: item => {
			close();
			rememberPaletteRun(item.id);
			item.run().catch(error => ctx.showError(error instanceof Error ? error.message : String(error)));
		},
	});
	const handle = ctx.ui.showOverlay(palette, { anchor: "center", width: PALETTE_WIDTH, maxHeight: "90%" });
	ctx.ui.setFocus(palette);
	ctx.ui.requestRender();
}
