/**
 * Casting Board (spec §5.4): the approval step before a crew plan spends anything. One row per item —
 * item → worker name → model → skills → est cost — and a footer with the total against the
 * conductor-only baseline. Keys: Enter approve · e change a row's model (roster only) · x drop a row ·
 * r reject with a note · a approve and auto-approve later plans · ↑↓ select. Over the run budget, Enter
 * needs a `!` first.
 */
import { type Component, extractPrintableText, matchesKey, visibleWidth } from "@oh-my-pi/pi-tui";
import type { CrewApproval, CrewApprovalRequest } from "../crew-tools";
import type { Assignment, CastResult, WorkItem } from "../router";
import { estimateCostUsd } from "../roster";
import { fit, padEnd, padStart, type StageStyle, spread } from "../stage/widgets/common";
import type { RosterEntry } from "../types";

/** `plan` for subscription-covered models, `$0.00` style otherwise; never `NaN`. */
export function formatUsd(n: number, planIncluded = false): string {
	if (planIncluded) return "plan";
	if (!Number.isFinite(n) || n <= 0) return "$0.00";
	if (n < 0.01) return "<$0.01";
	return `$${n.toFixed(2)}`;
}

function itemCost(entry: Pick<RosterEntry, "planIncluded" | "cost">, item: WorkItem): number {
	return entry.planIncluded ? 0 : estimateCostUsd(entry.cost, item.size);
}

/** `-92%` savings of `total` against `baseline`; `+15%` when it costs more; `–` without a baseline. */
export function savingsLabel(total: number, baseline: number): string {
	if (!(baseline > 0)) return "–";
	const pct = Math.round(((baseline - total) / baseline) * 100);
	return pct >= 0 ? `−${pct}%` : `+${-pct}%`;
}

type Mode = { kind: "rows" } | { kind: "pick"; index: number } | { kind: "note"; text: string };

export interface CastingBoardOptions {
	style?: StageStyle;
	onChange?(): void;
}

const plain: StageStyle = (_token, text) => text;
/** Visible rows of the model picker. */
const PICK_ROWS = 12;

export class CastingBoard implements Component {
	readonly result: Promise<CrewApproval>;
	readonly #request: CrewApprovalRequest;
	readonly #style: StageStyle;
	readonly #onChange: (() => void) | undefined;
	readonly #resolve: (approval: CrewApproval) => void;
	#rows: Assignment[];
	#selected = 0;
	#mode: Mode = { kind: "rows" };
	#armed = false;
	#settled = false;

	constructor(request: CrewApprovalRequest, options: CastingBoardOptions = {}) {
		this.#request = request;
		this.#style = options.style ?? plain;
		this.#onChange = options.onChange;
		this.#rows = request.cast.assignments.map(a => ({ ...a }));
		const { promise, resolve } = Promise.withResolvers<CrewApproval>();
		this.result = promise;
		this.#resolve = resolve;
	}

	/** The cast as edited so far (drops and model changes applied, totals re-scored). */
	cast(): CastResult {
		const items = new Map(this.#request.items.map(item => [item.id, item]));
		const conductor = this.#request.conductor;
		let totalEstUsd = 0;
		let baselineEstUsd = 0;
		for (const row of this.#rows) {
			totalEstUsd += row.estCostUsd;
			const item = items.get(row.itemId);
			if (item) baselineEstUsd += itemCost(conductor, item);
		}
		const max = this.#request.maxRunUsd;
		return {
			assignments: this.#rows.map(a => ({ ...a })),
			totalEstUsd,
			baselineEstUsd,
			overBudget: max !== undefined && totalEstUsd > max,
		};
	}

	invalidate(): void {}

	#finish(approval: CrewApproval): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#resolve(approval);
	}

	/** Abort from outside (tool cancelled): resolves as a rejection. */
	cancel(note = "Cancelled before approval."): void {
		this.#finish({ approved: false, note });
	}

	#changed(): void {
		this.#onChange?.();
	}

	/** Enabled roster, cheapest first for the selected row's item. */
	#roster(): RosterEntry[] {
		const row = this.#rows[this.#selected];
		const item = row ? this.#item(row.itemId) : undefined;
		const enabled = this.#request.roster.filter(entry => entry.enabled);
		if (!item) return enabled;
		return enabled.sort(
			(a, b) => itemCost(a, item) - itemCost(b, item) || a.tier - b.tier || a.selector.localeCompare(b.selector),
		);
	}

	#item(itemId: string): WorkItem | undefined {
		return this.#request.items.find(item => item.id === itemId);
	}

	handleInput(data: string): void {
		if (this.#settled) return;
		const mode = this.#mode;
		if (mode.kind === "note") {
			if (matchesKey(data, "enter")) this.#finish({ approved: false, note: mode.text });
			else if (matchesKey(data, "escape")) this.#mode = { kind: "rows" };
			else if (matchesKey(data, "backspace")) this.#mode = { kind: "note", text: mode.text.slice(0, -1) };
			else {
				const typed = extractPrintableText(data);
				if (typed) this.#mode = { kind: "note", text: mode.text + typed };
			}
			this.#changed();
			return;
		}
		if (mode.kind === "pick") {
			const roster = this.#roster();
			if (matchesKey(data, "up")) this.#mode = { kind: "pick", index: Math.max(0, mode.index - 1) };
			else if (matchesKey(data, "down"))
				this.#mode = { kind: "pick", index: Math.min(roster.length - 1, mode.index + 1) };
			else if (matchesKey(data, "escape")) this.#mode = { kind: "rows" };
			else if (matchesKey(data, "enter")) {
				const entry = roster[mode.index];
				const row = this.#rows[this.#selected];
				const item = row ? this.#item(row.itemId) : undefined;
				if (entry && row && item) {
					this.#rows[this.#selected] = {
						itemId: row.itemId,
						selector: entry.selector,
						tier: entry.tier,
						estCostUsd: itemCost(entry, item),
						planIncluded: entry.planIncluded,
						reason: "chosen on the Casting Board",
					};
					this.#armed = false;
				}
				this.#mode = { kind: "rows" };
			}
			this.#changed();
			return;
		}
		if (matchesKey(data, "up")) this.#selected = Math.max(0, this.#selected - 1);
		else if (matchesKey(data, "down")) this.#selected = Math.min(this.#rows.length - 1, this.#selected + 1);
		else if (matchesKey(data, "enter")) {
			if (this.#rows.length === 0) return;
			const cast = this.cast();
			if (cast.overBudget && !this.#armed) return;
			this.#finish({ approved: true, cast });
		} else if (matchesKey(data, "escape")) {
			this.#finish({ approved: false, note: "Rejected on the Casting Board without a note." });
		} else {
			const key = extractPrintableText(data);
			if (key === "!") this.#armed = !this.#armed;
			else if (key === "e" && this.#rows.length > 0) {
				const current = this.#rows[this.#selected]?.selector;
				this.#mode = {
					kind: "pick",
					index: Math.max(
						0,
						this.#roster().findIndex(e => e.selector === current),
					),
				};
			} else if (key === "x" && this.#rows.length > 0) {
				this.#rows.splice(this.#selected, 1);
				this.#selected = Math.min(this.#selected, Math.max(0, this.#rows.length - 1));
				this.#armed = false;
			} else if (key === "r") this.#mode = { kind: "note", text: "" };
			else if (key === "a") {
				const cast = this.cast();
				if (cast.overBudget && !this.#armed) return;
				if (this.#rows.length > 0) this.#finish({ approved: true, cast, autoApprove: true });
			} else return;
		}
		this.#changed();
	}

	render(width: number): string[] {
		if (width < 4) return [];
		const s = this.#style;
		const inner = width - 4;
		const cast = this.cast();
		const req = this.#request;
		const out: string[] = [];
		const b = (t: string) => s("borderAccent", t);
		const line = (content: string) => `${b("│")} ${fit(content, inner)} ${b("│")}`;
		const title = ` CASTING BOARD · plan #${req.planNumber} · ${this.#rows.length} item${this.#rows.length === 1 ? "" : "s"} `;
		const note = ` est ${formatUsd(cast.totalEstUsd)} · ${savingsLabel(cast.totalEstUsd, cast.baselineEstUsd)} vs baseline `;
		const fill = Math.max(0, width - 3 - visibleWidth(title) - visibleWidth(note) - 1);
		out.push(
			visibleWidth(title) + visibleWidth(note) + 4 <= width
				? `${b("┌─")}${s("accent", title)}${b("─".repeat(fill))}${s("muted", note)}${b("─┐")}`
				: `${b("┌─")}${s("accent", fit(title, width - 4))}${b("─┐")}`,
		);

		const items = new Map(req.items.map(item => [item.id, item]));
		const itemW = Math.max(
			12,
			...this.#rows.map(r => visibleWidth(`${r.itemId} ${items.get(r.itemId)?.title ?? ""}`)),
		);
		const nameW = Math.max(6, ...this.#rows.map(r => visibleWidth(req.names[r.itemId] ?? "") + 1));
		const modelW = Math.max(5, ...this.#rows.map(r => visibleWidth(`${r.selector} t${r.tier}`)));
		const skillW = Math.max(6, ...this.#rows.map(r => visibleWidth((items.get(r.itemId)?.skills ?? []).join(","))));
		const costW = 7;
		const columns = (cells: [string, number][]) => cells.map(([t, w]) => padEnd(t, w)).join("  ");
		const budgetForItem = Math.max(12, inner - 2 - nameW - modelW - skillW - costW - 8);
		const iw = Math.min(itemW, budgetForItem);

		if (this.#mode.kind === "pick") {
			const row = this.#rows[this.#selected];
			const item = row ? items.get(row.itemId) : undefined;
			out.push(line(s("text", `Model for ${row?.itemId ?? ""} ${item?.title ?? ""} · roster only`)));
			const roster = this.#roster();
			const pickIndex = this.#mode.index;
			const pickW = Math.max(7, ...roster.map(entry => visibleWidth(entry.selector) + 2));
			out.push(
				line(
					s(
						"dim",
						columns([
							["  MODEL", pickW],
							["TIER", 4],
							["STRENGTHS", 24],
							["EST", costW],
						]),
					),
				),
			);
			const start = Math.max(0, Math.min(pickIndex - Math.floor(PICK_ROWS / 2), roster.length - PICK_ROWS));
			roster.slice(start, start + PICK_ROWS).forEach((entry, offset) => {
				const picked = start + offset === pickIndex;
				const est = item ? formatUsd(itemCost(entry, item), entry.planIncluded) : "";
				const text = columns([
					[`${picked ? "▸" : " "} ${entry.selector}`, pickW],
					[`t${entry.tier}`, 4],
					[entry.strengths.join(",") || "general", 24],
					[padStart(est, costW), costW],
				]);
				out.push(line(picked ? s("accent", text) : s("text", text)));
			});
			out.push(line(s("dim", roster.length > PICK_ROWS ? `${pickIndex + 1}/${roster.length} models` : "")));
			out.push(
				line(
					this.#hints([
						["⏎", "use model"],
						["↑↓", "move"],
						["esc", "back"],
					]),
				),
			);
		} else {
			out.push(
				line(
					s(
						"dim",
						`  ${columns([
							["ITEM", iw],
							["WORKER", nameW],
							["MODEL", modelW],
							["SKILLS", skillW],
							[padStart("EST", costW), costW],
						])}`,
					),
				),
			);
			if (this.#rows.length === 0) out.push(line(s("muted", "  every row dropped · r to reject, esc to cancel")));
			this.#rows.forEach((row, i) => {
				const item = items.get(row.itemId);
				const picked = i === this.#selected;
				const label = fit(`${row.itemId} ${item?.title ?? ""}`, iw);
				const cells = [
					s(picked ? "accent" : "text", padEnd(label, iw)),
					s("agent1", padEnd(`@${req.names[row.itemId] ?? "?"}`, nameW)),
					s("text", padEnd(row.selector, modelW - 3)) + s("dim", ` t${row.tier}`),
					s("muted", padEnd((item?.skills ?? []).join(","), skillW)),
					s("text", padStart(formatUsd(row.estCostUsd, row.planIncluded), costW)),
				];
				out.push(line(`${picked ? s("accent", "▸") : " "} ${cells.join("  ")}`));
				if (picked) {
					const deps = item?.dependsOn.length ? ` · after ${item.dependsOn.join(" ")}` : "";
					const scope = item?.scope.length ? ` · scope ${item.scope.join(" ")}` : " · read-only";
					out.push(line(s("dim", `    ${row.reason}${scope}${deps}`)));
				}
			});
			out.push(line(""));
			const max = req.maxRunUsd;
			const budget = max !== undefined ? ` · budget ${formatUsd(max)}` : "";
			const total = `${s("text", `total ${formatUsd(cast.totalEstUsd)}`)}${s("muted", ` est vs ${formatUsd(cast.baselineEstUsd)} conductor-only (${req.conductor.selector})${budget}`)}`;
			const saved =
				cast.baselineEstUsd > 0 && cast.totalEstUsd <= cast.baselineEstUsd
					? s(
							"success",
							`saves ${formatUsd(cast.baselineEstUsd - cast.totalEstUsd)} (${savingsLabel(cast.totalEstUsd, cast.baselineEstUsd)})`,
						)
					: cast.baselineEstUsd > 0
						? s(
								"warning",
								`costs ${formatUsd(cast.totalEstUsd - cast.baselineEstUsd)} more than the conductor alone`,
							)
						: "";
			out.push(line(spread(total, saved, inner)));
			if (cast.overBudget) {
				out.push(
					line(
						this.#armed
							? s(
									"warning",
									`over budget by ${formatUsd(cast.totalEstUsd - (max ?? 0))} · confirmed, ⏎ to approve anyway`,
								)
							: s(
									"error",
									`over budget by ${formatUsd(cast.totalEstUsd - (max ?? 0))} · press ! then ⏎ to approve anyway`,
								),
					),
				);
			}
			if (this.#mode.kind === "note") {
				out.push(line(`${s("warning", "reject note ❯")} ${s("text", this.#mode.text)}${s("accent", "█")}`));
				out.push(
					line(
						this.#hints([
							["⏎", "send to conductor"],
							["esc", "back"],
						]),
					),
				);
			} else {
				out.push(
					line(
						this.#hints([
							["⏎", "approve"],
							["e", "model"],
							["x", "drop"],
							["r", "reject"],
							["a", "auto-approve"],
							["↑↓", "row"],
						]),
					),
				);
			}
		}
		out.push(b(`└${"─".repeat(width - 2)}┘`));
		return out;
	}

	#hints(pairs: [string, string][]): string {
		const s = this.#style;
		return pairs.map(([key, label]) => `${s("accent", key)} ${s("muted", label)}`).join("  ");
	}
}
