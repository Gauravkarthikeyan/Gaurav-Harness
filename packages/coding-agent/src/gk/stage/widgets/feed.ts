/**
 * Live agent pane body (visual v2 §4 worker panes): the agent's feed rendered tail-first.
 * - thinking streams dim italic under `▸ thinking`, then collapses to `▸ thought 6.2s · 1.1k tok`;
 * - reply text streams behind an accent bar;
 * - tool calls show as they start: write/edit stream their content (line-numbered, highlighted,
 *   tail-following) or diff, bash its live output tail unless it has its own pane, the rest one line;
 * - nested subagents render as an inset `parent › child` box with their own last lines.
 * Every row is exactly `width` columns.
 */
import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { getLanguageFromPath } from "@oh-my-pi/pi-tui/lang-from-path";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { FeedEntry, FeedThinking } from "../live-feed";
import {
	clockTime,
	diffTextOf,
	editPathOf,
	formatDuration,
	latestHunk,
	type ToolRecord,
	toolEvent,
} from "../tool-lines";
import { fit, glyph, padStart, type StageStyle, type StageToken, type StateGlyph, spread } from "./common";
import { type DiffLine, diffRows, eventRows } from "./transcript-lines";

/** `HH:MM:SS ✓ ` — event text column. */
const TEXT_COL = 11;
const CODE_INDENT = 6;
/** Tiled-pane caps; a zoomed pane (`expanded`) shows everything. */
const THINK_ROWS = 4;
const TEXT_ROWS = 6;
const CODE_ROWS = 12;
const BASH_ROWS = 4;
const DIFF_ROWS = 8;
const NESTED_ROWS = 3;

export interface NestedView {
	/** `linus › scout`. */
	label: string;
	token: StageToken;
	model?: string;
	glyph: StateGlyph;
	/** Right side of the inset header, e.g. `0:09 · $0.004`. */
	metric: string;
	entries: readonly FeedEntry[];
}

export interface FeedOptions {
	now: number;
	style: StageStyle;
	/** Rows wanted from the tail (rendering stops once covered); default all. */
	limit?: number;
	/** Zoomed pane: full thinking, full text, taller code tails. */
	expanded?: boolean;
	/** Syntax highlighter (omp's native one in the host); plain text without it. */
	highlight?: (code: string, lang: string | undefined) => string[];
	/** Pane label of a call's own tile (`0.3`), for bash calls shown elsewhere. */
	paneOf?: (toolCallId: string) => string | undefined;
	/** Inset view of a nested subagent; `undefined` hides it (it has its own pane). */
	nested?: (agentId: string) => NestedView | undefined;
}

function compactTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function tail<T>(items: readonly T[], n: number | undefined): readonly T[] {
	return n === undefined || items.length <= n ? items : items.slice(items.length - n);
}

function wrap(text: string, width: number): string[] {
	return text
		.replace(/\t/g, "  ")
		.split("\n")
		.flatMap(line => (line.trim() === "" ? [""] : wrapTextWithAnsi(line, Math.max(1, width))));
}

function thinkingRows(entry: FeedThinking, width: number, opts: FeedOptions): string[] {
	const s = opts.style;
	const time = clockTime(entry.startedAt);
	const done = entry.endedAt !== null;
	const elapsed = formatDuration((entry.endedAt ?? opts.now) - entry.startedAt);
	const tokens = Math.ceil(entry.text.length / 4);
	const summary = done ? `thought ${elapsed}${tokens > 0 ? ` · ${compactTokens(tokens)} tok` : ""}` : "thinking";
	const rows = eventRows([{ time, glyph: "thinking", text: summary, metric: done ? undefined : elapsed }], width, s);
	if (done && !opts.expanded) return rows;
	const lines = wrap(entry.text.trim(), width - TEXT_COL).filter((line, i, all) => line !== "" || i < all.length - 1);
	const pad = " ".repeat(TEXT_COL);
	for (const line of tail(lines, opts.expanded ? undefined : THINK_ROWS)) {
		rows.push(`${pad}${s("dim", `\x1b[3m${line}\x1b[23m`)}`);
	}
	return rows;
}

function textRows(text: string, at: number, width: number, opts: FeedOptions): string[] {
	const s = opts.style;
	const lines = wrap(text.trim(), width - TEXT_COL);
	if (lines.length === 0) return [];
	const shown = tail(lines, opts.expanded ? undefined : TEXT_ROWS);
	const bar = s("accent", "│");
	return shown.map((line, i) => {
		const lead = i === 0 ? s("dim", clockTime(at)) : " ".repeat(8);
		return `${lead} ${bar} ${s("text", line)}`;
	});
}

/** Line-numbered code tail (`  40  router.get(…)`), highlighted when a highlighter is given. */
function codeRows(content: string, path: string | undefined, max: number, width: number, opts: FeedOptions): string[] {
	const s = opts.style;
	const lines = content.replace(/\t/g, "  ").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	const first = Math.max(0, lines.length - max);
	const shown = lines.slice(first);
	const lang = path ? getLanguageFromPath(path) : undefined;
	const painted = opts.highlight ? opts.highlight(shown.join("\n"), lang) : shown.map(l => s("text", l));
	const numW = Math.max(2, String(lines.length).length);
	const indent = " ".repeat(CODE_INDENT);
	return shown.map((_, i) =>
		fit(`${indent}${s("dim", padStart(String(first + i + 1), numW))}  ${painted[i] ?? ""}`, width),
	);
}

function diffLinesOf(text: string, plainIsAdd: boolean): DiffLine[] {
	const out: DiffLine[] = [];
	for (const line of text.replace(/\t/g, "  ").split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) out.push({ kind: "add", text: line.slice(1) });
		else if (line.startsWith("-") && !line.startsWith("---")) out.push({ kind: "del", text: line.slice(1) });
		else out.push({ kind: plainIsAdd ? "add" : "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
	}
	return out;
}

/** What an edit call is about to change, from its (possibly partial) args. */
function editPreview(args: Record<string, unknown>): DiffLine[] {
	const lines: DiffLine[] = [];
	const pair = (entry: Record<string, unknown>) => {
		const before = entry.old_string ?? entry.oldText ?? entry.old_text;
		const after = entry.new_string ?? entry.newText ?? entry.new_text;
		if (typeof before === "string") for (const t of before.split("\n")) lines.push({ kind: "del", text: t });
		if (typeof after === "string") for (const t of after.split("\n")) lines.push({ kind: "add", text: t });
		const body = entry.diff ?? entry.content ?? entry.replacement;
		if (typeof body === "string") lines.push(...diffLinesOf(body, !/^[+\- ]/m.test(body)));
	};
	if (typeof args.input === "string") lines.push(...diffLinesOf(args.input, false));
	pair(args);
	for (const key of ["edits", "files"]) {
		const list = args[key];
		if (Array.isArray(list)) for (const entry of list) if (isRecord(entry)) pair(entry);
	}
	return lines;
}

/** Rows under a call's one-liner: streaming content, diff or output tail. */
export function toolBodyRows(record: ToolRecord, width: number, opts: FeedOptions): string[] {
	const s = opts.style;
	const running = record.endedAt === null;
	const codeMax = opts.expanded ? Number.MAX_SAFE_INTEGER : CODE_ROWS;
	switch (record.name) {
		case "write": {
			const content = record.args.content;
			if (!running || typeof content !== "string" || content === "") return [];
			return codeRows(content, editPathOf(record), codeMax, width, opts);
		}
		case "edit":
		case "ast_edit": {
			if (running) {
				const preview = tail(editPreview(record.args), codeMax);
				return preview.length > 0 ? diffRows({ lines: preview, indent: CODE_INDENT }, width, s) : [];
			}
			if (record.isError) return [];
			const hunk = latestHunk(diffTextOf(record.details));
			if (!hunk) return [];
			const rows = diffRows({ ...hunk.block, indent: CODE_INDENT }, width, s);
			return opts.expanded ? rows : rows.slice(0, DIFF_ROWS);
		}
		case "bash": {
			if (!running || opts.paneOf?.(record.id) || !record.output) return [];
			const lines = record.output
				.replace(/\n+$/, "")
				.split("\n")
				.map(l => l.slice(l.lastIndexOf("\r") + 1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
			const pad = " ".repeat(TEXT_COL);
			return tail(lines, opts.expanded ? undefined : BASH_ROWS).map(l => fit(`${pad}${s("muted", l)}`, width));
		}
		default:
			return [];
	}
}

function insetRows(view: NestedView, width: number, opts: FeedOptions): string[] {
	const s = opts.style;
	// `  │ body │`: two-column indent, border, one-column padding each side.
	const inner = width - 4;
	const bodyW = inner - 2;
	if (bodyW < 4) return [];
	const head = `${s(view.token, view.label)}${view.model ? s("muted", ` · ${view.model}`) : ""}`;
	const right = `${glyph(view.glyph, s)} ${s("muted", view.metric)}`;
	const body = feedRows(view.entries, bodyW, { ...opts, expanded: false, limit: NESTED_ROWS, nested: undefined });
	const side = s("border", "│");
	const row = (text: string) => `  ${side} ${text} ${side}`;
	return [
		`  ${s("border", `┌${"─".repeat(inner)}┐`)}`,
		row(spread(head, right, bodyW)),
		...body.slice(Math.max(0, body.length - NESTED_ROWS)).map(row),
		`  ${s("border", `└${"─".repeat(inner)}┘`)}`,
	];
}

function entryRows(entry: FeedEntry, width: number, opts: FeedOptions): string[] {
	switch (entry.kind) {
		case "thinking":
			return thinkingRows(entry, width, opts);
		case "text":
			return textRows(entry.text, entry.at, width, opts);
		case "tool":
			return [
				...eventRows([toolEvent(entry.record, { now: opts.now, paneOf: opts.paneOf })], width, opts.style),
				...toolBodyRows(entry.record, width, opts),
			];
		case "agent": {
			const view = opts.nested?.(entry.agentId);
			return view ? insetRows(view, width, opts) : [];
		}
	}
}

/** The feed's rows, oldest first; renders newest-first and stops once `limit` rows are covered. */
export function feedRows(entries: readonly FeedEntry[], width: number, opts: FeedOptions): string[] {
	if (width <= 0) return [];
	const limit = opts.limit ?? Number.POSITIVE_INFINITY;
	const chunks: string[][] = [];
	let total = 0;
	for (let i = entries.length - 1; i >= 0 && total < limit; i--) {
		const rows = entryRows(entries[i]!, width, opts);
		chunks.push(rows);
		total += rows.length;
	}
	const out: string[] = [];
	for (let i = chunks.length - 1; i >= 0; i--) for (const row of chunks[i]!) out.push(fit(row, width));
	return out;
}
