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

/**
 * What the conductor alone would have spent on this run: the actual crew spend repriced at the
 * conductor's rates when known, else the conductor-only estimate. `undefined` for a plan-priced conductor.
 */
export function conductorOnlyUsd(summary: CrewRunSummary): number | undefined {
	if (summary.baselinePlan) return undefined;
	return summary.conductorEquivUsd ?? summary.baselineEstUsd;
}

/** The verdict line: savings, the overrun stated plainly, or no claim at all for a plan-priced conductor. */
export function payslipVerdict(summary: CrewRunSummary): { text: string; saved: boolean | undefined } {
	const actual = summary.actualUsd;
	if (summary.baselinePlan) {
		return {
			text: `Crew spent ${formatUsd(actual)}. The conductor${summary.conductor ? ` (${summary.conductor})` : ""} is on a plan, so there is no dollar baseline to compare.`,
			saved: undefined,
		};
	}
	const baseline = conductorOnlyUsd(summary) ?? 0;
	if (!(baseline > 0))
		return { text: `Spent ${formatUsd(actual)}; no conductor-only figure to compare.`, saved: undefined };
	const diff = baseline - actual;
	// Under half a cent either way (e.g. the crew ran on the conductor's own model): no savings claim.
	if (Math.abs(diff) < 0.005) {
		return {
			text: `Same cost as the conductor alone (≈${formatUsd(baseline)}); the crew ran at the conductor's rates.`,
			saved: undefined,
		};
	}
	if (diff >= 0) {
		return {
			text: `You saved ${formatUsd(diff)} (${Math.round((diff / baseline) * 100)}%) vs the conductor alone (≈${formatUsd(baseline)}).`,
			saved: true,
		};
	}
	return {
		text: `This run cost ${formatUsd(-diff)} more than the conductor alone would have (≈${formatUsd(baseline)}).`,
		saved: false,
	};
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
	// The model column gives way first so the cost column is never cut.
	const fixed = idW + nameW + 11 + 6 + 8 + 2 * 5;
	const modelW = Math.max(5, Math.min(Math.max(...summary.items.map(i => i.selector.length)), inner - fixed));
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
					s("muted", padEnd(fit(item.selector, modelW), modelW)),
					s(token, padEnd(`${glyph} ${label}`, 11)),
					s("muted", padStart(item.durationMs > 0 ? formatDuration(item.durationMs) : "–", 6)),
					s("text", padStart(formatUsd(item.costUsd), 8)),
				].join("  "),
			),
		);
	}
	out.push(line(s("border", "─".repeat(inner))));
	const est = summary.crewEstUsd !== undefined ? ` (est ${formatUsd(summary.crewEstUsd)})` : "";
	const conductorOnly = conductorOnlyUsd(summary);
	const baselineText = summary.baselinePlan
		? " · conductor on a plan"
		: ` · conductor-only est ${formatUsd(summary.baselineEstUsd)}${
				summary.conductorEquivUsd !== undefined ? ` · same work at its rates ≈${formatUsd(conductorOnly ?? 0)}` : ""
			}`;
	out.push(line(`${s("text", `actual ${formatUsd(summary.actualUsd)}`)}${s("muted", `${est}${baselineText}`)}`));
	const verdict = payslipVerdict(summary);
	out.push(line(s(verdict.saved === true ? "success" : verdict.saved === false ? "warning" : "muted", verdict.text)));
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
