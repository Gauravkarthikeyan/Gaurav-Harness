/**
 * Payslip (spec §5.4): the card appended to the transcript when a crew run ends. One row per employee
 * (item, name, model, state, time, cost), then actual spend against the conductor-only estimate. When
 * the crew cost more than the estimate it says so plainly.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import type { CrewItemState, CrewRunSummary } from "../crew-runtime";
import { formatDuration } from "../stage/tool-lines";
import { fit, padEnd, padStart, type StageStyle, type StageToken } from "../stage/widgets/common";
import { formatUsd } from "./casting-board";

const STATE: Record<CrewItemState, [glyph: string, label: string, token: StageToken]> = {
	done: ["✓", "done", "success"],
	failed: ["✗", "failed", "error"],
	cancelled: ["✗", "cancelled", "warning"],
	running: ["●", "running", "accent"],
	waiting: ["○", "waiting", "muted"],
};

const plain: StageStyle = (_token, text) => text;

/** The verdict line: savings, or the overrun stated plainly. */
export function payslipVerdict(actual: number, baseline: number): string {
	if (!(baseline > 0)) return `Spent ${formatUsd(actual)}; no conductor-only estimate to compare.`;
	const diff = baseline - actual;
	if (diff >= 0) return `You saved ${formatUsd(diff)} (${Math.round((diff / baseline) * 100)}%)`;
	return `This run cost ${formatUsd(-diff)} more than the conductor alone (est ${formatUsd(baseline)}).`;
}

export function renderPayslip(summary: CrewRunSummary, width: number, style: StageStyle = plain): string[] {
	if (width < 8) return [];
	const s = style;
	const inner = width - 4;
	const b = (t: string) => s("accent", t);
	const line = (content: string) => `${b("│")} ${fit(content, inner)} ${b("│")}`;
	const totalMs = summary.items.reduce((max, item) => Math.max(max, item.durationMs), 0);
	const title = ` PAYSLIP · ${summary.runId} · ${summary.status} `;
	const note = ` ${summary.items.length} worker${summary.items.length === 1 ? "" : "s"} · ${formatDuration(totalMs)} `;
	const fill = width - 4 - title.length - note.length;
	const out = [
		fill >= 0
			? `${b("┌─")}${s("accent", title)}${b("─".repeat(fill))}${s("muted", note)}${b("─┐")}`
			: `${b("┌─")}${s("accent", fit(title, width - 4))}${b("─┐")}`,
	];
	const idW = Math.max(4, ...summary.items.map(i => i.itemId.length));
	const nameW = Math.max(6, ...summary.items.map(i => i.name.length + 1));
	const modelW = Math.max(5, ...summary.items.map(i => i.selector.length));
	const head = [
		padEnd("ITEM", idW),
		padEnd("WORKER", nameW),
		padEnd("MODEL", modelW),
		padEnd("STATE", 11),
		padStart("TIME", 6),
		padStart("COST", 8),
	];
	out.push(line(s("dim", head.join("  "))));
	for (const item of summary.items) {
		const [glyph, label, token] = STATE[item.state];
		out.push(
			line(
				[
					s("text", padEnd(item.itemId, idW)),
					s("agent1", padEnd(`@${item.name}`, nameW)),
					s("muted", padEnd(item.selector, modelW)),
					s(token, padEnd(`${glyph} ${label}`, 11)),
					s("muted", padStart(item.durationMs > 0 ? formatDuration(item.durationMs) : "–", 6)),
					s("text", padStart(formatUsd(item.costUsd), 8)),
				].join("  "),
			),
		);
	}
	out.push(line(s("border", "─".repeat(inner))));
	out.push(
		line(
			`${s("text", `actual ${formatUsd(summary.actualUsd)}`)}${s("muted", ` · conductor-only estimate ${formatUsd(summary.baselineEstUsd)}`)}`,
		),
	);
	const saved = summary.baselineEstUsd > 0 && summary.actualUsd <= summary.baselineEstUsd;
	out.push(line(s(saved ? "success" : "warning", payslipVerdict(summary.actualUsd, summary.baselineEstUsd))));
	out.push(b(`└${"─".repeat(width - 2)}┘`));
	return out;
}

/** Transcript block for a finished run; caps at 110 columns so it reads as a card. */
export class PayslipComponent implements Component {
	constructor(
		readonly summary: CrewRunSummary,
		readonly style: StageStyle = plain,
	) {}

	render(width: number): string[] {
		return renderPayslip(this.summary, Math.min(width, 110), this.style);
	}

	invalidate(): void {}
}
