/**
 * Stage header: two rows. Pre-rendered logo lines on the left, label/value field columns, clock
 * and date right-aligned. Columns that don't fit are dropped lowest-priority first. With the
 * {@link pixelLogo} (≥180 columns) every field fits from 212 columns; with the text wordmark, from 200.
 */
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { renderCompactPixelText } from "@oh-my-pi/pi-tui/gk/pixel-font";
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

export interface HeaderData {
	/** Pre-rendered logo rows (may contain SGR); rows beyond two are ignored. */
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
const BAR_CELLS = 10;
/** Branch names longer than this are cut with `…` so CTX and HOST keep their columns. */
export const BRANCH_NAME_MAX = 18;
const HOST_MAX = 28;
const CWD_MAX = 28;

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

function renderColumn(col: Column, style: StageStyle): [string, string, number] {
	const labelW = Math.max(...col.cells.map(([l]) => visibleWidth(l)));
	const rows = col.cells.map(([label, value]) =>
		label ? `${style("muted", padEnd(label, labelW))} ${value}` : value,
	);
	while (rows.length < 2) rows.push("");
	const width = Math.max(...rows.map(r => visibleWidth(r)));
	return [padEnd(rows[0]!, width), padEnd(rows[1]!, width), width];
}

interface HeaderParts {
	columns: Column[];
	right0: string;
	right1: string;
	rightW: number;
}

function headerParts(data: HeaderData, style: StageStyle): HeaderParts {
	const { cost, ctx } = data;
	let costValue = style("text", bold(cost.spent));
	if (cost.budget) costValue += style("muted", ` / ${cost.budget}`);
	if (cost.fraction !== undefined) {
		costValue += ` ${gauge(cost.fraction, BAR_CELLS, budgetToken(cost.fraction), style)} ${style("muted", percent(cost.fraction))}`;
	}
	const ctxFraction = ctx.limit > 0 ? ctx.used / ctx.limit : 0;
	const ctxValue = `${style("text", percent(ctxFraction))} ${gauge(ctxFraction, BAR_CELLS, "info", style)} ${style("muted", ctx.label)}`;
	const today = style(data.todayWarning ? "warning" : "text", data.today);
	const costRow2: [string, string] = data.saved ? ["SAVED", style("success", data.saved)] : ["TODAY", today];

	const columns: Column[] = [
		{
			cells: [
				["SESSION", style("text", data.session)],
				["MODE", `${style("accent", "●")} ${style("text", data.mode)}`],
			],
			priority: 5,
		},
		{
			cells: [
				["HOST", style("text", truncateToWidth(data.host, HOST_MAX))],
				["CWD", style("text", cutLeft(data.cwd, CWD_MAX))],
			],
			priority: 1,
		},
		{
			cells: [
				["BRANCH", style("text", data.branch)],
				["UPTIME", style("text", data.uptime)],
			],
			priority: 3,
		},
		{ cells: [[cost.label, costValue], costRow2], priority: 4 },
		{
			cells: data.cache
				? [
						["CTX", ctxValue],
						["CACHE", style("text", data.cache)],
					]
				: [["CTX", ctxValue]],
			priority: 2,
		},
	];

	const dateText = data.saved ? `TODAY ${data.today} · ${data.date}` : data.date;
	const right0 = style("text", bold(data.clock));
	const right1 = data.saved
		? `${style("muted", "TODAY")} ${today} ${style("dim", "·")} ${style("muted", data.date)}`
		: style("muted", data.date);
	const rightW = Math.max(visibleWidth(data.clock), visibleWidth(dateText));
	return { columns, right0, right1, rightW };
}

const plain: StageStyle = (_token, text) => text;

/** Columns needed to show the logo and every field column without dropping any. */
export function headerWidth(data: HeaderData): number {
	const { columns, rightW } = headerParts(data, plain);
	const logoW = Math.max(0, ...data.logo.slice(0, 2).map(l => visibleWidth(l)));
	const parts = [...(logoW > 0 ? [logoW] : []), ...columns.map(c => renderColumn(c, plain)[2])];
	return 1 + parts.reduce((sum, w) => sum + w, 0) + COLUMN_GAP * parts.length + rightW + 1;
}

export function renderHeader(data: HeaderData, width: number, height: number, style: StageStyle): string[] {
	const { columns, right0, right1, rightW } = headerParts(data, style);
	const logoW = Math.max(0, ...data.logo.slice(0, 2).map(l => visibleWidth(l)));
	const rendered = columns.map(c => renderColumn(c, style));

	// Greedy by priority: logo first, then columns. Reserve the leading margin, the right block
	// with its trailing margin, and one gap before it.
	let budget = width - 1 - (rightW + 1) - COLUMN_GAP;
	const showLogo = logoW > 0 && logoW <= budget;
	if (showLogo) budget -= logoW;
	const keep = new Set<number>();
	const byPriority = columns.map((c, i) => ({ p: c.priority, i })).sort((a, b) => b.p - a.p);
	for (const { i } of byPriority) {
		const need = rendered[i]![2] + (showLogo || keep.size > 0 ? COLUMN_GAP : 0);
		if (need <= budget) {
			keep.add(i);
			budget -= need;
		}
	}
	const gap = " ".repeat(COLUMN_GAP);
	const rows: string[] = [];
	for (let r = 0; r < 2; r++) {
		const parts: string[] = showLogo ? [padEnd(data.logo[r] ?? "", logoW)] : [];
		for (let i = 0; i < rendered.length; i++) if (keep.has(i)) parts.push(rendered[i]![r as 0 | 1]);
		let left = ` ${parts.join(gap)}`;
		let right = `${padStart(r === 0 ? right0 : right1, rightW)} `;
		// Column padding is free space too: measure the notice's room from the last visible cell.
		const room = width - visibleWidth(left.trimEnd()) - visibleWidth(right) - 2 * COLUMN_GAP;
		if (r === 1 && data.notice && visibleWidth(data.notice) <= room) {
			left = left.trimEnd();
			right = `${style("warning", data.notice)}${gap}${right}`;
		}
		rows.push(spread(left, right, width));
	}
	return frame(rows, width, height);
}
