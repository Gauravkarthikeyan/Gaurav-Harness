/**
 * Transcript blocks: timestamped event lines with a right-aligned metric column, inline diff
 * blocks with line numbers and add/del backgrounds, and the crew plan table card.
 */
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import {
	fit,
	frame,
	glyph,
	padEnd,
	padStart,
	type StageStyle,
	type StageToken,
	type StateGlyph,
	spread,
	styleMetric,
} from "./common";

export interface TranscriptEvent {
	/** `HH:MM:SS`. */
	time: string;
	glyph: StateGlyph;
	text: string;
	/** Right-aligned, e.g. `142L 0.2s`, `+12 −3`, `→ pane 0.3`. `+N`/`−N` words are colored. */
	metric?: string;
	/** Extra rows indented under the text column. */
	continuation?: readonly string[];
}

export function eventRows(events: readonly TranscriptEvent[], width: number, style: StageStyle): string[] {
	const rows: string[] = [];
	for (const ev of events) {
		const textToken: StageToken = ev.glyph === "thinking" ? "muted" : "text";
		const left = `${style("dim", ev.time)} ${glyph(ev.glyph, style)} ${style(textToken, ev.text)}`;
		rows.push(spread(left, ev.metric ? styleMetric(ev.metric, style) : "", width));
		const indent = " ".repeat(visibleWidth(ev.time) + 1);
		for (const line of ev.continuation ?? []) rows.push(fit(`${indent}${style("muted", line)}`, width));
	}
	return rows;
}

export function renderEventLines(
	events: readonly TranscriptEvent[],
	width: number,
	height: number,
	style: StageStyle,
): string[] {
	return frame(eventRows(events, width, style), width, height);
}

export interface DiffLine {
	kind: "ctx" | "add" | "del";
	lineNo?: number;
	text: string;
}

export interface DiffBlock {
	lines: readonly DiffLine[];
	/** Left indent in columns; defaults to 4. */
	indent?: number;
}

export function diffRows(diff: DiffBlock, width: number, style: StageStyle): string[] {
	const indent = " ".repeat(diff.indent ?? 4);
	const numW = Math.max(2, ...diff.lines.map(l => (l.lineNo === undefined ? 0 : String(l.lineNo).length)));
	return diff.lines.map(line => {
		const num = style("dim", padStart(line.lineNo === undefined ? "" : String(line.lineNo), numW));
		if (line.kind === "ctx") return fit(`${indent}${num}    ${style("muted", line.text)}`, width);
		const [sign, fg, bg]: [string, StageToken, StageToken] =
			line.kind === "add" ? ["+", "success", "diffAddBg"] : ["−", "error", "diffDelBg"];
		return style(bg, fit(`${indent}${num}  ${style(fg, sign)} ${style("text", line.text)}`, width));
	});
}

export function renderDiffBlock(diff: DiffBlock, width: number, height: number, style: StageStyle): string[] {
	return frame(diffRows(diff, width, style), width, height);
}

export type PlanState = "running" | "queued" | "done" | "failed";

export interface PlanRow {
	id: string;
	/** Without `@`. */
	owner: string;
	ownerToken?: StageToken;
	model: string;
	scope: string;
	state: PlanState;
	/** e.g. `run 1:12`, `← W-01 W-02`, `done $0.00`. */
	stateText: string;
}

export interface PlanTable {
	/** e.g. `PLAN #1 · 4 items · 2 waves`. */
	title: string;
	/** Right side of the top border, e.g. `−88% vs baseline`. */
	note?: string;
	rows: readonly PlanRow[];
}

interface PlanColumn {
	head: string;
	cell: (row: PlanRow) => [text: string, token: StageToken];
	/** Dropped first (highest number) when the card is narrow. */
	drop: number;
}

const PLAN_COLUMNS: PlanColumn[] = [
	{ head: "ID", cell: r => [r.id, "text"], drop: 0 },
	{ head: "OWNER", cell: r => [`@${r.owner}`, r.ownerToken ?? "text"], drop: 2 },
	{ head: "MODEL", cell: r => [r.model, "muted"], drop: 0 },
	{ head: "SCOPE", cell: r => [r.scope, "muted"], drop: 1 },
];

const STATE_MIN = 12;

/** `┌─ title ───── note ─┐`; the note drops first, then the title truncates. */
function planBorderTop(title: string, note: string | undefined, width: number, style: StageStyle): string {
	const inner = width - 2;
	let titleText = title;
	if (visibleWidth(titleText) + 3 > inner) titleText = inner > 3 ? truncateToWidth(title, inner - 3) : "";
	const headW = titleText ? visibleWidth(titleText) + 3 : 0;
	const noteText = note && headW + visibleWidth(note) + 3 <= inner ? note : "";
	const tailW = noteText ? visibleWidth(noteText) + 3 : 0;
	const b = (s: string) => style("border", s);
	const head = titleText ? `${b("─ ")}${style("text", titleText)}${b(" ")}` : "";
	const tail = noteText ? `${b(" ")}${style("muted", noteText)}${b(" ─")}` : "";
	return `${b("┌")}${head}${b("─".repeat(inner - headW - tailW))}${tail}${b("┐")}`;
}

export function planRows(plan: PlanTable, width: number, style: StageStyle): string[] {
	if (width < 4) return [];
	const inner = width - 4; // "│ " + content + " │"
	const widths = PLAN_COLUMNS.map(c =>
		Math.max(visibleWidth(c.head), ...plan.rows.map(r => visibleWidth(c.cell(r)[0]))),
	);
	const active = PLAN_COLUMNS.map((_, i) => i);
	const used = () => active.reduce((n, i) => n + widths[i]! + 2, 0);
	for (const level of [2, 1]) {
		if (used() + STATE_MIN <= inner) break;
		const k = active.findIndex(i => PLAN_COLUMNS[i]!.drop === level);
		if (k >= 0) active.splice(k, 1);
	}
	const side = style("border", "│");
	const line = (content: string) => `${side} ${fit(content, inner)} ${side}`;
	const out = [planBorderTop(plan.title, plan.note, width, style)];
	out.push(line(style("dim", active.map(i => padEnd(PLAN_COLUMNS[i]!.head, widths[i]! + 2)).join("") + "STATE")));
	for (const row of plan.rows) {
		const cells = active.map(i => {
			const [text, token] = PLAN_COLUMNS[i]!.cell(row);
			return style(token, padEnd(text, widths[i]! + 2));
		});
		const stateToken: StageToken = row.state === "done" ? "success" : row.state === "failed" ? "error" : "muted";
		out.push(line(`${cells.join("")}${glyph(row.state, style)} ${style(stateToken, row.stateText)}`));
	}
	out.push(style("border", `└${"─".repeat(width - 2)}┘`));
	return out;
}

export function renderPlanTable(plan: PlanTable, width: number, height: number, style: StageStyle): string[] {
	return frame(planRows(plan, width, style), width, height);
}

export type TranscriptBlock =
	| { kind: "event"; event: TranscriptEvent }
	| { kind: "diff"; diff: DiffBlock }
	| { kind: "plan"; plan: PlanTable };

/** All blocks in order, tail-anchored: when they overflow `height`, the newest rows stay visible. */
export function renderTranscript(
	blocks: readonly TranscriptBlock[],
	width: number,
	height: number,
	style: StageStyle,
): string[] {
	const rows: string[] = [];
	for (const block of blocks) {
		if (block.kind === "event") rows.push(...eventRows([block.event], width, style));
		else if (block.kind === "diff") rows.push(...diffRows(block.diff, width, style));
		else rows.push(...planRows(block.plan, width, style));
	}
	return frame(rows.slice(Math.max(0, rows.length - height)), width, height);
}
