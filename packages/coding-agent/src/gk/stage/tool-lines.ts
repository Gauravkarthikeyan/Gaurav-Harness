/**
 * Tool-call records and their one-line Stage form (spec §5.12 rule 1): `03:05:04 ✓ read src/auth/session.ts  212L 0.2s`.
 * Records come from live `tool_execution_*` events or, for a resumed session, from the transcript messages.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { DiffBlock, DiffLine, TranscriptEvent } from "./widgets/transcript-lines";

export interface ToolRecord {
	id: string;
	name: string;
	args: Record<string, unknown>;
	intent?: string;
	/** Agent that made the call; `null` = the main session. */
	agentId: string | null;
	startedAt: number;
	endedAt: number | null;
	isError: boolean;
	/** Latest text of the partial or final result. */
	output: string;
	details: unknown;
}

function str(args: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

/** Text of a tool result frame (`{ content: [{ type: "text", text }] }`). */
export function resultText(result: unknown): string {
	if (!isRecord(result) || !Array.isArray(result.content)) return "";
	let out = "";
	for (const part of result.content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") out += part.text;
	}
	return out;
}

/** `HH:MM:SS` local time. */
export function clockTime(ms: number): string {
	const d = new Date(ms);
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}

/** `0.2s`, `12s`, `1:12`. */
export function formatDuration(ms: number): string {
	const s = Math.max(0, ms) / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 60) return `${Math.round(s)}s`;
	const total = Math.floor(s);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** `0:06` elapsed clock for running badges. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const sec = String(total % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const URL_RE = /^https?:\/\//i;

export function isWebCall(record: Pick<ToolRecord, "name" | "args">): boolean {
	if (record.name === "web_search" || record.name === "fetch") return true;
	if (record.name === "read") return URL_RE.test(str(record.args, "path", "url") ?? "");
	return false;
}

export function isEditCall(name: string): boolean {
	return name === "edit" || name === "write" || name === "ast_edit";
}

/** The shell command of a `bash` call, first line only. */
export function commandOf(record: Pick<ToolRecord, "args">): string {
	return (str(record.args, "command", "cmd", "script") ?? "").split("\n")[0]!.trim();
}

/** Exit code from bash result details, when reported. */
export function exitCodeOf(details: unknown): number | null {
	if (!isRecord(details)) return null;
	return typeof details.exitCode === "number" ? details.exitCode : null;
}

/** Target file path of an edit/write call. */
export function editPathOf(record: Pick<ToolRecord, "args" | "details">): string | undefined {
	const direct = str(record.args, "path", "file_path");
	if (direct) return direct;
	for (const key of ["edits", "files"]) {
		const list = record.args[key];
		if (Array.isArray(list)) for (const entry of list) if (isRecord(entry) && typeof entry.path === "string") return entry.path;
	}
	if (isRecord(record.details) && Array.isArray(record.details.perFileResults)) {
		const first = record.details.perFileResults[0];
		if (isRecord(first) && typeof first.path === "string") return first.path;
	}
	return undefined;
}

/** Unified diff text an edit reported (`+12|text`, `-12|text`, ` 12|text` rows). */
export function diffTextOf(details: unknown): string {
	if (!isRecord(details)) return "";
	if (typeof details.diff === "string" && details.diff) return details.diff;
	if (Array.isArray(details.perFileResults)) {
		return details.perFileResults
			.map(f => (isRecord(f) && typeof f.diff === "string" ? f.diff : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

const DIFF_ROW = /^([+\- ])\s*(\d+)?\s*[|│]?(.*)$/;

/** Parse diff rows into hunks (a gap in line numbers or an ellipsis row starts a new hunk). */
export function parseDiffHunks(diff: string): DiffLine[][] {
	const hunks: DiffLine[][] = [];
	let current: DiffLine[] = [];
	let lastNo: number | undefined;
	for (const raw of diff.split("\n")) {
		if (raw === "") continue;
		if (raw.startsWith("@@") || /^\s*(\.\.\.|…)\s*$/.test(raw)) {
			if (current.length > 0) hunks.push(current);
			current = [];
			lastNo = undefined;
			continue;
		}
		const m = DIFF_ROW.exec(raw);
		if (!m) continue;
		const kind: DiffLine["kind"] = m[1] === "+" ? "add" : m[1] === "-" ? "del" : "ctx";
		const lineNo = m[2] !== undefined ? Number(m[2]) : undefined;
		if (lineNo !== undefined && lastNo !== undefined && lineNo > lastNo + 1 && current.length > 0) {
			hunks.push(current);
			current = [];
		}
		if (lineNo !== undefined) lastNo = lineNo;
		current.push({ kind, lineNo, text: m[3] ?? "" });
	}
	if (current.length > 0) hunks.push(current);
	return hunks;
}

export function diffStat(diff: string): { add: number; del: number } {
	let add = 0;
	let del = 0;
	for (const hunk of parseDiffHunks(diff)) {
		for (const line of hunk) {
			if (line.kind === "add") add++;
			else if (line.kind === "del") del++;
		}
	}
	return { add, del };
}

export function diffMetric(stat: { add: number; del: number }): string {
	return [stat.add ? `+${stat.add}` : "", stat.del ? `−${stat.del}` : ""].filter(Boolean).join(" ");
}

export function latestHunk(diff: string): { block: DiffBlock; index: number; count: number } | undefined {
	const hunks = parseDiffHunks(diff);
	if (hunks.length === 0) return undefined;
	return { block: { lines: hunks[hunks.length - 1]!, indent: 1 }, index: hunks.length, count: hunks.length };
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.replace(/\n+$/, "").split("\n").length;
}

function quoteArg(value: string): string {
	return `"${value.length > 40 ? `${value.slice(0, 39)}…` : value}"`;
}

/** Main text of the one-line form: `read src/x.ts`, `grep "fetch(" src/`, `bash bun test`. */
export function toolLabel(record: Pick<ToolRecord, "name" | "args">): string {
	const { name, args } = record;
	switch (name) {
		case "read":
			return `${isWebCall(record) ? "web" : "read"} ${str(args, "path", "url") ?? ""}`.trim();
		case "grep":
		case "search": {
			const pattern = str(args, "pattern", "query");
			const where = str(args, "path", "paths", "glob");
			return ["grep", pattern ? quoteArg(pattern) : "", where ?? ""].filter(Boolean).join(" ");
		}
		case "find":
		case "glob":
			return `${name} ${str(args, "pattern", "path", "query") ?? ""}`.trim();
		case "bash":
			return `bash ${commandOf(record)}`.trim();
		case "web_search":
			return `web ${quoteArg(str(args, "query") ?? "")}`;
		case "fetch":
			return `web ${str(args, "url") ?? ""}`.trim();
		case "edit":
		case "write":
		case "ast_edit":
			return `${name} ${editPathOf({ args, details: undefined }) ?? ""}`.trim();
		case "task": {
			const agent = str(args, "agent", "subagent_type");
			const what = str(args, "description", "title", "prompt");
			return ["spawn", agent ? `@${agent}` : "", what ? what.split("\n")[0]! : ""].filter(Boolean).join(" ");
		}
		default: {
			const first = Object.values(args).find(v => typeof v === "string" && v.trim() !== "") as string | undefined;
			return first ? `${name} ${first.split("\n")[0]}` : name;
		}
	}
}

export interface ToolLineContext {
	now: number;
	/** Pane label of the call's own tile while it is on the Stage (`0.3`), for `→ pane 0.3`. */
	paneOf?: (toolCallId: string) => string | undefined;
}

/** Right-aligned metric column. */
export function toolMetric(record: ToolRecord, ctx: ToolLineContext): string {
	const running = record.endedAt === null;
	const dur = formatDuration((record.endedAt ?? ctx.now) - record.startedAt);
	if (running) {
		const pane = ctx.paneOf?.(record.id);
		return pane ? `→ pane ${pane}` : "";
	}
	switch (record.name) {
		case "read":
			return isWebCall(record) ? dur : `${countLines(record.output)}L ${dur}`;
		case "grep":
		case "search": {
			const hits = record.output.split("\n").filter(l => l.trim() !== "").length;
			return `${hits} hits ${dur}`;
		}
		case "bash": {
			const code = exitCodeOf(record.details) ?? (record.isError ? 1 : 0);
			return `exit ${code} · ${dur}`;
		}
		case "edit":
		case "ast_edit":
			return diffMetric(diffStat(diffTextOf(record.details))) || dur;
		case "write": {
			const content = str(record.args, "content");
			return content ? `+${countLines(content)}` : dur;
		}
		default:
			return dur;
	}
}

/** The transcript event row for one call. */
export function toolEvent(record: ToolRecord, ctx: ToolLineContext): TranscriptEvent {
	const failed = record.endedAt !== null && (record.isError || (record.name === "bash" && (exitCodeOf(record.details) ?? 0) !== 0));
	return {
		time: clockTime(record.startedAt),
		glyph: record.endedAt === null ? "running" : failed ? "failed" : "done",
		text: toolLabel(record),
		metric: toolMetric(record, ctx),
	};
}
