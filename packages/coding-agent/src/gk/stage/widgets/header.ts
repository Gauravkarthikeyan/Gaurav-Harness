/**
 * Stage header. Pre-rendered logo lines on the left, label/value field columns, clock and date
 * right-aligned. Columns that don't fit are dropped lowest-priority first. From 200 columns the
 * full 3-row {@link fullPixelLogo} sits beside 3 field rows; 180–199 columns use the 2-row
 * {@link pixelLogo}; narrower headers a text wordmark. Every field fits in each case at 212 / 200.
 */
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { renderCompactPixelText, renderPixelText } from "@oh-my-pi/pi-tui/gk/pixel-font";
import type { ColorMode } from "@oh-my-pi/pi-tui/theme/schema";
import { bold, frame, gauge, padEnd, padStart, percent, type StageStyle, spread } from "./common";

export const LOGO_TEXT = "GAURAV'S HARNESS";

/** `</>` badge box beside the compact 2-row pixel "GAURAV'S HARNESS": 36 columns × 2 rows. */
export function pixelLogo(
	style: StageStyle,
	colors?: { face: string; shadow: string },
	colorMode?: ColorMode,
): [string, string] {
	const word = renderCompactPixelText(LOGO_TEXT, { colors, colorMode });
	return [`${style("accent", "│</>│")} ${word[0]}`, `${style("accent", "╰───╯")} ${word[1]}`];
}

/** `</>` badge box beside the scale-1 5-row pixel wordmark with a straight drop shadow: 82 columns × 3 rows. */
export function fullPixelLogo(
	style: StageStyle,
	colors?: { face: string; shadow: string },
	colorMode?: ColorMode,
): [string, string, string] {
	const word = renderPixelText(LOGO_TEXT, { scale: 1, shadow: true, shadowDx: 0, colors, colorMode });
	const badge = ["┌───┐", "│</>│", "└───┘"];
	return [0, 1, 2].map(i => `${style("accent", badge[i]!)} ${word[i] ?? ""}`) as [string, string, string];
}

export interface HeaderData {
	/** Pre-rendered logo rows (may contain SGR); rows beyond the header's field rows are ignored. */
	logo: readonly string[];
	session: string;
	/** e.g. `ORCHESTRA` or `SOLO`; drawn after an accent `●`. */
	mode: string;
	host: string;
	cwd: string;
	/** e.g. `main ↑2 ✱4 ?1`. */
	branch: string;
	/** e.g. `00:14:22 · pid 48190`. */
	uptime: string;
	cost: {
		/** `RUN` in orchestra, `SESSION` in solo. */
		label: "RUN" | "SESSION";
		/** e.g. `$0.42`. */
		spent: string;
		/** e.g. `$2.00`; with `fraction` this draws the budget bar. */
		budget?: string;
		/** spent / budget, 0..1+. */
		fraction?: number;
		/** e.g. `1.2m tok · 345 calls`: after the amount on a 2-row header, its own USAGE row on a 3-row one. */
		usage?: string;
	};
	/** e.g. `−88% vs opus-only est $3.51`. When set it takes the row under cost and TODAY moves beside the date. */
	saved?: string;
	/** e.g. `$1.84 · 6 runs`. */
	today: string;
	/** Today's spend reached `gk.budget.dailyUsd`: TODAY is drawn in the warning colour. */
	todayWarning?: boolean;
	/** Warning text (the daily-budget notice) drawn whole in row 2's free space before the date, or not at all. */
	notice?: string;
	ctx: { used: number; limit: number; label: string };
	/** e.g. `81% hit · ttft 1.2s`. */
	cache?: string;
	/** e.g. `03:11:42`. */
	clock: string;
	/** e.g. `SUN 15 NOV`. */
	date: string;
}

interface Column {
	cells: [label: string, value: string][];
	priority: number;
}

const COLUMN_GAP = 2;
/** Gauge cells on the 2-row header; the 3-row one draws shorter gauges to fit beside the full pixel logo. */
const BAR_CELLS = 10;
const BAR_CELLS_3ROW = 6;
/** Branch names longer than this are cut with `…` so CTX and HOST keep their columns. */
export const BRANCH_NAME_MAX = 18;
const HOST_MAX = 28;
const HOST_MAX_3ROW = 22;
const CWD_MAX = 28;

/** `host · arch`, dropping ` · arch` before cutting the hostname when it is wider than `max`. */
function hostLabel(host: string, max: number): string {
	if (visibleWidth(host) <= max) return host;
	return truncateToWidth(host.split(" · ")[0]!, max);
}

/** `main ↑2 ±7`: the branch cut to {@link BRANCH_NAME_MAX} columns, commits ahead, and changed + untracked files. */
export function formatBranch(name: string, ahead: number, dirty: number): string {
	let label = truncateToWidth(name, BRANCH_NAME_MAX);
	if (ahead > 0) label += ` ↑${ahead}`;
	if (dirty > 0) label += ` ±${dirty}`;
	return label;
}

/** Keep the tail of a path: `…/Developer/Gk-code`. */
function cutLeft(text: string, max: number): string {
	if (visibleWidth(text) <= max) return text;
	const chars = [...text];
	let tail = "";
	for (let i = chars.length - 1; i >= 0 && visibleWidth(chars[i] + tail) <= max - 1; i--) tail = chars[i] + tail;
	return `…${tail}`;
}

function budgetToken(fraction: number): "success" | "warning" | "error" {
	if (fraction >= 1) return "error";
	if (fraction >= 0.8) return "warning";
	return "success";
}

function renderColumn(col: Column, style: StageStyle, fieldRows: number): { rows: string[]; width: number } {
	const labelW = Math.max(...col.cells.map(([l]) => visibleWidth(l)));
	const rows = col.cells.map(([label, value]) =>
		label ? `${style("muted", padEnd(label, labelW))} ${value}` : value,
	);
	while (rows.length < fieldRows) rows.push("");
	const width = Math.max(...rows.map(r => visibleWidth(r)));
	return { rows: rows.map(r => padEnd(r, width)), width };
}

interface HeaderParts {
	columns: Column[];
	right: string[];
	rightW: number;
}

/**
 * 2 rows: SESSION/MODE · HOST/CWD · BRANCH/UPTIME · cost/TODAY · CTX/CACHE.
 * 3 rows (beside the full pixel logo): SESSION/MODE/UPTIME · BRANCH/HOST/CWD · cost/TODAY/USAGE · CTX/CACHE.
 */
function headerParts(data: HeaderData, style: StageStyle, fieldRows: 2 | 3): HeaderParts {
	const { cost, ctx } = data;
	const barCells = fieldRows === 3 ? BAR_CELLS_3ROW : BAR_CELLS;
	let costValue = style("text", bold(cost.spent));
	if (cost.budget) costValue += style("muted", ` / ${cost.budget}`);
	if (cost.fraction !== undefined) {
		costValue += ` ${gauge(cost.fraction, barCells, budgetToken(cost.fraction), style)} ${style("muted", percent(cost.fraction))}`;
	}
	const usageRow = fieldRows === 3 && cost.usage !== undefined && !data.saved;
	if (cost.usage && !usageRow) costValue += style("muted", ` · ${cost.usage}`);
	const ctxFraction = ctx.limit > 0 ? ctx.used / ctx.limit : 0;
	const ctxValue = `${style("text", percent(ctxFraction))} ${gauge(ctxFraction, barCells, "info", style)} ${style("muted", ctx.label)}`;
	const today = style(data.todayWarning ? "warning" : "text", data.today);
	const session: [string, string] = ["SESSION", style("text", data.session)];
	const mode: [string, string] = ["MODE", `${style("accent", "●")} ${style("text", data.mode)}`];
	const host: [string, string] = [
		"HOST",
		style("text", hostLabel(data.host, fieldRows === 3 ? HOST_MAX_3ROW : HOST_MAX)),
	];
	const cwd: [string, string] = ["CWD", style("text", cutLeft(data.cwd, CWD_MAX))];
	const branch: [string, string] = ["BRANCH", style("text", data.branch)];
	const uptime: [string, string] = ["UPTIME", style("text", data.uptime)];
	const ctxCells: [string, string][] = data.cache
		? [
				["CTX", ctxValue],
				["CACHE", style("text", data.cache)],
			]
		: [["CTX", ctxValue]];

	let columns: Column[];
	// A 3-row cost column has room for TODAY next to SAVED, so TODAY only moves beside the date on 2 rows.
	const todayBesideDate = data.saved !== undefined && fieldRows === 2;
	if (fieldRows === 3) {
		const costCells: [string, string][] = [[cost.label, costValue]];
		if (data.saved) costCells.push(["SAVED", style("success", data.saved)]);
		costCells.push(["TODAY", today]);
		if (usageRow) costCells.push(["USAGE", style("muted", cost.usage!)]);
		columns = [
			{ cells: [session, mode, uptime], priority: 5 },
			{ cells: [branch, host, cwd], priority: 3 },
			{ cells: costCells, priority: 4 },
			{ cells: ctxCells, priority: 2 },
		];
	} else {
		const costRow2: [string, string] = data.saved ? ["SAVED", style("success", data.saved)] : ["TODAY", today];
		columns = [
			{ cells: [session, mode], priority: 5 },
			{ cells: [host, cwd], priority: 1 },
			{ cells: [branch, uptime], priority: 3 },
			{ cells: [[cost.label, costValue], costRow2], priority: 4 },
			{ cells: ctxCells, priority: 2 },
		];
	}

	const dateText = todayBesideDate ? `TODAY ${data.today} · ${data.date}` : data.date;
	const right = [
		style("text", bold(data.clock)),
		todayBesideDate
			? `${style("muted", "TODAY")} ${today} ${style("dim", "·")} ${style("muted", data.date)}`
			: style("muted", data.date),
	];
	while (right.length < fieldRows) right.push("");
	const rightW = Math.max(visibleWidth(data.clock), visibleWidth(dateText));
	return { columns, right, rightW };
}

const plain: StageStyle = (_token, text) => text;

function logoWidth(data: HeaderData, fieldRows: number): number {
	return Math.max(0, ...data.logo.slice(0, fieldRows).map(l => visibleWidth(l)));
}

/** Columns needed to show the logo and every field column without dropping any. */
export function headerWidth(data: HeaderData, fieldRows: 2 | 3 = 2): number {
	const { columns, rightW } = headerParts(data, plain, fieldRows);
	const logoW = logoWidth(data, fieldRows);
	const parts = [...(logoW > 0 ? [logoW] : []), ...columns.map(c => renderColumn(c, plain, fieldRows).width)];
	return 1 + parts.reduce((sum, w) => sum + w, 0) + COLUMN_GAP * parts.length + rightW + 1;
}

/** Render the header's field rows (2, or 3 beside the full pixel logo), framed to `width` × `height`. */
export function renderHeader(
	data: HeaderData,
	width: number,
	height: number,
	style: StageStyle,
	fieldRows: 2 | 3 = 2,
): string[] {
	const { columns, right, rightW } = headerParts(data, style, fieldRows);
	const logoW = logoWidth(data, fieldRows);
	const rendered = columns.map(c => renderColumn(c, style, fieldRows));

	// Greedy by priority: logo first, then columns. Reserve the leading margin, the right block
	// with its trailing margin, and one gap before it.
	let budget = width - 1 - (rightW + 1) - COLUMN_GAP;
	const showLogo = logoW > 0 && logoW <= budget;
	if (showLogo) budget -= logoW;
	const keep = new Set<number>();
	const byPriority = columns.map((c, i) => ({ p: c.priority, i })).sort((a, b) => b.p - a.p);
	for (const { i } of byPriority) {
		const need = rendered[i]!.width + (showLogo || keep.size > 0 ? COLUMN_GAP : 0);
		if (need <= budget) {
			keep.add(i);
			budget -= need;
		}
	}
	const gap = " ".repeat(COLUMN_GAP);
	const rows: string[] = [];
	for (let r = 0; r < fieldRows; r++) {
		const parts: string[] = showLogo ? [padEnd(data.logo[r] ?? "", logoW)] : [];
		for (let i = 0; i < rendered.length; i++) if (keep.has(i)) parts.push(rendered[i]!.rows[r]!);
		let left = ` ${parts.join(gap)}`;
		let rightCell = `${padStart(right[r]!, rightW)} `;
		// Column padding is free space too: measure the notice's room from the last visible cell.
		const room = width - visibleWidth(left.trimEnd()) - visibleWidth(rightCell) - 2 * COLUMN_GAP;
		if (r === fieldRows - 1 && data.notice && visibleWidth(data.notice) <= room) {
			left = left.trimEnd();
			rightCell = `${style("warning", data.notice)}${gap}${rightCell}`;
		}
		rows.push(spread(left, rightCell, width));
	}
	return frame(rows, width, height);
}
