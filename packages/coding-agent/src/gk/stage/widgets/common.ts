/**
 * Shared primitives for Stage widgets. Widgets are pure: data in, exactly `height` rows of exactly
 * `width` visible columns out. All color goes through the `StageStyle` callback so widgets stay
 * theme-agnostic and testable with an identity style.
 */
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

export type AgentToken = "agent1" | "agent2" | "agent3" | "agent4" | "agent5" | "agent6";

export type StageToken =
	| "accent"
	| "text"
	| "muted"
	| "dim"
	| "border"
	| "borderAccent"
	| "success"
	| "error"
	| "warning"
	| "info"
	| AgentToken
	| "diffAddBg"
	| "diffDelBg"
	/** Lifted bar (status row), key caps, active tab — backgrounds. */
	| "surfaceBg"
	| "badgeBg"
	| "selectedBg";

export type StageStyle = (token: StageToken, text: string) => string;

/** Bold for the few places the spec allows it (active tab, headline values, clock). */
export function bold(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

export function strike(text: string): string {
	return `\x1b[9m${text}\x1b[29m`;
}

/** Roster-order agent hue, 0-based; wraps after six. The conductor uses `accent` instead. */
export function agentToken(index: number): AgentToken {
	return `agent${(((index % 6) + 6) % 6) + 1}` as AgentToken;
}

/** Truncate (with `…`) and pad to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, undefined, true);
}

export function padEnd(text: string, width: number): string {
	const w = visibleWidth(text);
	return w >= width ? text : text + " ".repeat(width - w);
}

export function padStart(text: string, width: number): string {
	const w = visibleWidth(text);
	return w >= width ? text : " ".repeat(width - w) + text;
}

/** Left and right on one row; the right side wins and the left side is truncated to make room. */
export function spread(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rw = visibleWidth(right);
	if (!right) return fit(left, width);
	if (rw >= width) return fit(right, width);
	const leftMax = width - rw - 1;
	const l = visibleWidth(left) > leftMax ? truncateToWidth(left, leftMax) : left;
	const gap = width - visibleWidth(l) - rw;
	return fit(l + " ".repeat(gap) + right, width);
}

/** Fit every row to `width`, cut to `height`, pad with blank rows. */
export function frame(rows: readonly string[], width: number, height: number): string[] {
	const out: string[] = [];
	const blank = " ".repeat(Math.max(0, width));
	for (let i = 0; i < height; i++) out.push(i < rows.length ? fit(rows[i]!, width) : blank);
	return out;
}

export interface Segment {
	text: string;
	/** Higher survives longer when the row is too narrow. Defaults to 0. */
	priority?: number;
}

/**
 * Join segments with `sep`, dropping the lowest-priority segments (rightmost first on ties)
 * until the row fits `width`.
 */
export function joinSegments(segments: readonly Segment[], sep: string, width: number): string {
	const kept = segments.map((s, i) => ({ ...s, i }));
	const sepW = visibleWidth(sep);
	const total = () => kept.reduce((n, s) => n + visibleWidth(s.text), 0) + sepW * Math.max(0, kept.length - 1);
	while (kept.length > 1 && total() > width) {
		let drop = 0;
		for (let k = 1; k < kept.length; k++) {
			if ((kept[k]!.priority ?? 0) <= (kept[drop]!.priority ?? 0)) drop = k;
		}
		kept.splice(drop, 1);
	}
	return kept.map(s => s.text).join(sep);
}

/** `▕██▁▁▁▁▏` gauge with `cells` inner cells; filled part in `token`, the rest dim. */
export function gauge(fraction: number, cells: number, token: StageToken, style: StageStyle): string {
	const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
	const filled = Math.round(f * cells);
	return (
		style("dim", "▕") +
		(filled > 0 ? style(token, "█".repeat(filled)) : "") +
		(cells - filled > 0 ? style("dim", "▁".repeat(cells - filled)) : "") +
		style("dim", "▏")
	);
}

export function percent(fraction: number): string {
	return `${Math.round((Number.isFinite(fraction) ? fraction : 0) * 100)}%`;
}

export type StateGlyph =
	| "done"
	| "running"
	| "queued"
	| "failed"
	| "skill"
	| "thinking"
	| "warning"
	| "prompt"
	| "spawn";

const GLYPHS: Record<StateGlyph, [string, StageToken]> = {
	done: ["✓", "success"],
	running: ["●", "accent"],
	queued: ["○", "muted"],
	failed: ["✗", "error"],
	skill: ["◆", "info"],
	thinking: ["▸", "dim"],
	warning: ["!", "warning"],
	prompt: ["❯", "accent"],
	spawn: ["→", "info"],
};

export function glyphChar(state: StateGlyph): string {
	return GLYPHS[state][0];
}

export function glyph(state: StateGlyph, style: StageStyle): string {
	const [ch, token] = GLYPHS[state];
	return style(token, ch);
}

/** Color `+N` words green and `−N`/`-N` words red; everything else dim. */
export function styleMetric(metric: string, style: StageStyle): string {
	return metric
		.split(/(\s+)/)
		.map(part => {
			if (!part || /^\s+$/.test(part)) return part;
			if (/^\+\d/.test(part)) return style("success", part);
			if (/^[−-]\d/.test(part)) return style("error", part);
			return style("dim", part);
		})
		.join("");
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/** Sparkline of the last `cells` values scaled to `max` (default: max of the window). Left-padded with blanks. */
export function sparkline(values: readonly number[], cells: number, max?: number): string {
	if (cells <= 0) return "";
	const window = values.slice(-cells);
	const top = max ?? window.reduce((m, v) => Math.max(m, v), 0);
	let out = " ".repeat(cells - window.length);
	for (const v of window) {
		if (!Number.isFinite(v) || top <= 0) {
			out += BLOCKS[0];
			continue;
		}
		const idx = Math.round((Math.min(Math.max(v, 0), top) / top) * (BLOCKS.length - 1));
		out += BLOCKS[idx];
	}
	return out;
}
