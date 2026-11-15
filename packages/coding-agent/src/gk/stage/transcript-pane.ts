/**
 * Pane 0.0: omp's own transcript blocks and composer chrome, laid out inside a pane instead of the
 * terminal. Tool cards become one line each (unless omp's "expand tools" is on); user prompts become
 * `HH:MM:SS ❯ text`; assistant replies keep omp's markdown render behind an accent bar; every other block
 * (notices, errors, usage rows, dialogs in the transcript) renders exactly as omp draws it. The
 * composer roots (editor, HUD rows) render below at the pane width, unchanged, so input, autocomplete and
 * selectors behave as they do inline; the Stage's pane statusline and mode line sit under them.
 */
import { type Component, CURSOR_MARKER, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { HostStyle } from "./style";
import { clockTime, type ToolLineContext, type ToolRecord, toolEvent } from "./tool-lines";
import { eventRows } from "./widgets/transcript-lines";

/** Duck-typed views of the omp blocks the pane restyles (getters marked `gk:` in pi-tui). */
interface ToolBlock {
	readonly gkToolCallIds: readonly string[];
}
interface PromptBlock {
	readonly gkPrompt: { text: string; timestamp: number | undefined };
}

function isToolBlock(component: Component): component is Component & ToolBlock {
	return Array.isArray((component as Partial<ToolBlock>).gkToolCallIds);
}

function isPromptBlock(component: Component): component is Component & PromptBlock {
	return typeof (component as Partial<PromptBlock>).gkPrompt === "object";
}

export interface TranscriptPaneInput {
	/** Transcript blocks in order (omp's `TranscriptContainer` children). */
	blocks: readonly Component[];
	/** Composer roots drawn under the transcript (editor, HUD rows). */
	chrome: readonly Component[];
	/** Pre-rendered rows pinned under the composer (the pane statusline + mode line). */
	status?: readonly string[];
	/** Tool record for a call id; `undefined` falls back to omp's own card. */
	tool: (id: string) => ToolRecord | undefined;
	/** Rows that replace a call's one-liner (Orchestra: `crew_plan` + the PLAN table); `undefined` keeps it. */
	toolRows?: (record: ToolRecord, width: number) => string[] | undefined;
	/** Rows under a call's one-liner while it streams (write content, edit preview, bash output). */
	toolBody?: (record: ToolRecord, width: number) => string[];
	/** Assistant-message blocks get the accent bar. */
	isAssistant: (component: Component) => boolean;
	/** omp's "expand tools" toggle: draw full cards instead of one-liners. */
	expandTools: boolean;
	/** Rows scrolled up from the live tail. */
	scroll: number;
	lineContext: ToolLineContext;
	/** First-seen time per block, for blocks with no timestamp of their own. */
	seenAt: (component: Component) => number;
	style: HostStyle;
}

export interface TranscriptPaneOutput {
	rows: string[];
	/** Hardware cursor (row, col) inside the pane, from the focused editor's marker. */
	cursor: { row: number; col: number } | null;
	/** Largest useful scroll offset at this size. */
	maxScroll: number;
}

const TEXT_INDENT = 11; // `HH:MM:SS ✓ ` — event text column

function trimBlank(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && visibleWidth(rows[start]!) === 0) start++;
	while (end > start && visibleWidth(rows[end - 1]!) === 0) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

/** Rows of one block and whether it is a one-liner (no blank separator around it). */
function blockRows(component: Component, width: number, input: TranscriptPaneInput): { rows: readonly string[]; compact: boolean } {
	const { style } = input;
	if (isToolBlock(component) && !input.expandTools) {
		const rows: string[] = [];
		for (const id of component.gkToolCallIds) {
			const record = input.tool(id);
			if (!record) continue;
			const custom = input.toolRows?.(record, width);
			if (custom) rows.push(...custom);
			else {
				rows.push(...eventRows([toolEvent(record, input.lineContext)], width, style));
				if (record.endedAt === null && input.toolBody) rows.push(...input.toolBody(record, width));
			}
		}
		if (rows.length > 0) return { rows, compact: true };
	}
	if (isPromptBlock(component)) {
		const { text, timestamp } = component.gkPrompt;
		const lines = text.replace(/\s+$/, "").split("\n");
		const time = clockTime(timestamp ?? input.seenAt(component));
		const rows = eventRows([{ time, glyph: "prompt", text: lines[0] ?? "" }], width, style);
		for (const line of lines.slice(1)) {
			rows.push(truncateToWidth(`${" ".repeat(TEXT_INDENT)}${style("text", line)}`, width));
		}
		return { rows, compact: true };
	}
	if (input.isAssistant(component)) {
		const inner = Math.max(1, width - TEXT_INDENT);
		const body = trimBlank(component.render(inner));
		const bar = `${" ".repeat(TEXT_INDENT - 2)}${style("accent", "│")} `;
		return { rows: body.map(row => `${bar}${row}`), compact: false };
	}
	return { rows: trimBlank(component.render(width)), compact: false };
}

/**
 * Composer roots plus pinned status rows, cut to the last `height` rows; the editor's cursor marker is
 * stripped and reported as a (row, col) inside the returned rows.
 */
export function composerRows(
	roots: readonly Component[],
	status: readonly string[] | undefined,
	width: number,
	height: number,
): { rows: string[]; cursor: { row: number; col: number } | null } {
	let rows: string[] = [];
	for (const root of roots) rows.push(...root.render(width));
	if (status) rows.push(...status);
	if (rows.length > height) rows = rows.slice(rows.length - height);
	let cursor: { row: number; col: number } | null = null;
	for (let i = 0; i < rows.length; i++) {
		const at = rows[i]!.indexOf(CURSOR_MARKER);
		if (at < 0) continue;
		const row = rows[i]!;
		cursor ??= { row: i, col: visibleWidth(row.slice(0, at)) };
		rows[i] = row.split(CURSOR_MARKER).join("");
	}
	return { rows, cursor };
}

/**
 * Lay out the pane: composer chrome pinned to the bottom, transcript tail above it, `scroll` rows up.
 * Blocks render newest-first and stop once the visible window is covered, so a long session costs
 * only what is on screen.
 */
export function renderTranscriptPane(input: TranscriptPaneInput, width: number, height: number): TranscriptPaneOutput {
	if (width <= 0 || height <= 0) return { rows: [], cursor: null, maxScroll: 0 };
	const composed = composerRows(input.chrome, input.status, width, height);
	const chrome = composed.rows;
	const cursor = composed.cursor ? { row: height - chrome.length + composed.cursor.row, col: composed.cursor.col } : null;
	const room = height - chrome.length;
	const need = room + Math.max(0, input.scroll);
	const tail: string[] = [];
	let belowCompact: boolean | undefined;
	for (let i = input.blocks.length - 1; i >= 0 && tail.length < need + 1; i--) {
		const { rows, compact } = blockRows(input.blocks[i]!, width, input);
		if (rows.length === 0) continue;
		if (belowCompact !== undefined && !(compact && belowCompact)) tail.unshift("");
		tail.unshift(...rows);
		belowCompact = compact;
	}
	const maxScroll = Math.max(0, tail.length - room);
	const scroll = Math.min(Math.max(0, input.scroll), maxScroll);
	const end = tail.length - scroll;
	const visible = tail.slice(Math.max(0, end - room), end);
	const pad = Array.from({ length: room - visible.length }, () => "");
	return { rows: [...visible, ...pad, ...chrome], cursor, maxScroll };
}
