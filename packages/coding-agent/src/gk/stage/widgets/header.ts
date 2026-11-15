/**
 * Stage header: two rows. Pre-rendered logo lines on the left, label/value field columns, clock
 * and date right-aligned. Columns that don't fit are dropped lowest-priority first.
 */
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { bold, frame, gauge, padEnd, padStart, percent, type StageStyle, spread } from "./common";

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

const COLUMN_GAP = 3;
const BAR_CELLS = 10;

function budgetToken(fraction: number): "success" | "warning" | "error" {
	if (fraction >= 1) return "error";
	if (fraction >= 0.8) return "warning";
	return "success";
}

function renderColumn(col: Column, style: StageStyle): [string, string, number] {
	const labelW = Math.max(...col.cells.map(([l]) => visibleWidth(l)));
	const rows = col.cells.map(([label, value]) => (label ? `${style("dim", padEnd(label, labelW))} ${value}` : value));
	while (rows.length < 2) rows.push("");
	const width = Math.max(...rows.map(r => visibleWidth(r)));
	return [padEnd(rows[0]!, width), padEnd(rows[1]!, width), width];
}

export function renderHeader(data: HeaderData, width: number, height: number, style: StageStyle): string[] {
	const { cost, ctx } = data;
	let costValue = style("text", bold(cost.spent));
	if (cost.budget) costValue += style("muted", ` / ${cost.budget}`);
	if (cost.fraction !== undefined) {
		costValue += ` ${gauge(cost.fraction, BAR_CELLS, budgetToken(cost.fraction), style)} ${style("muted", percent(cost.fraction))}`;
	}
	const ctxFraction = ctx.limit > 0 ? ctx.used / ctx.limit : 0;
	const ctxValue = `${style("text", percent(ctxFraction))} ${gauge(ctxFraction, BAR_CELLS, "info", style)} ${style("muted", ctx.label)}`;
	const costRow2: [string, string] = data.saved
		? ["SAVED", style("success", data.saved)]
		: ["TODAY", style("text", data.today)];

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
				["HOST", style("text", data.host)],
				["CWD", style("text", data.cwd)],
			],
			priority: 1,
		},
		{
			cells: [
				["BRANCH", style("text", data.branch)],
				["UPTIME", style("muted", data.uptime)],
			],
			priority: 3,
		},
		{ cells: [[cost.label, costValue], costRow2], priority: 4 },
		{
			cells: data.cache
				? [
						["CTX", ctxValue],
						["CACHE", style("muted", data.cache)],
					]
				: [["CTX", ctxValue]],
			priority: 2,
		},
	];

	const dateText = data.saved ? `TODAY ${data.today} · ${data.date}` : data.date;
	const right0 = style("text", bold(data.clock));
	const right1 = data.saved
		? `${style("dim", "TODAY")} ${style("text", data.today)} ${style("dim", "·")} ${style("muted", data.date)}`
		: style("muted", data.date);
	const rightW = Math.max(visibleWidth(data.clock), visibleWidth(dateText));

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
		const right = `${padStart(r === 0 ? right0 : right1, rightW)} `;
		rows.push(spread(` ${parts.join(gap)}`, right, width));
	}
	return frame(rows, width, height);
}
