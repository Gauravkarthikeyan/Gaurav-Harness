/**
 * Casting Board (spec §5.4): the approval step before a crew plan spends anything. One row per item —
 * item → worker name → model → skills → est cost, with the casting reason under it — and a footer with
 * the total against the conductor-only baseline. The crew policy shows on top.
 *
 * Keys: ⏎ approve · e model picker · x drop a row · p open-weight only for this run · r / esc reject
 * with a note · a approve and auto-approve later plans · ↑↓ select. Over the run budget, ⏎ needs a `!`.
 * Picker: type to search · ^o open-weight only · ^p provider · ^t tier · ^a roster/all connected.
 */
import { type Component, extractPrintableText, matchesKey, visibleWidth } from "@oh-my-pi/pi-tui";
import type { CrewApproval, CrewApprovalRequest } from "../crew-tools";
import {
	type Assignment,
	type CastResult,
	conductorBaseline,
	describePolicy,
	entryCost,
	type WorkItem,
} from "../router";
import { fit, padEnd, padStart, type StageStyle, spread } from "../stage/widgets/common";
import type { CrewPolicy, RosterEntry, Tier } from "../types";

/** `plan` for subscription-covered models, `$0.00` style otherwise; never `NaN`. */
export function formatUsd(n: number, planIncluded = false): string {
	if (planIncluded) return "plan";
	if (!Number.isFinite(n) || n <= 0) return "$0.00";
	if (n < 0.01) return "<$0.01";
	return `$${n.toFixed(2)}`;
}

/** `-92%` savings of `total` against `baseline`; `+15%` when it costs more; `–` without a baseline. */
export function savingsLabel(total: number, baseline: number): string {
	if (!(baseline > 0)) return "–";
	const pct = Math.round(((baseline - total) / baseline) * 100);
	return pct >= 0 ? `−${pct}%` : `+${-pct}%`;
}

/** `1.0M` / `200k` context label. */
function ctxLabel(tokens: number | undefined): string {
	if (!tokens) return "";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	return `${Math.round(tokens / 1000)}k`;
}

export interface PickerFilter {
	query: string;
	openWeightOnly: boolean;
	provider: string | undefined;
	tier: Tier | undefined;
	/** Include connected models switched off in the roster. */
	all: boolean;
}

/** Picker rows for `item`: filtered by `filter`, cheapest first. Pure, for tests and the board. */
export function pickerModels(
	roster: readonly RosterEntry[],
	item: WorkItem | undefined,
	filter: PickerFilter,
): RosterEntry[] {
	const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
	const rows = roster.filter(entry => {
		if (!filter.all && !entry.enabled) return false;
		if (filter.openWeightOnly && !entry.openWeight) return false;
		if (filter.provider && entry.provider !== filter.provider) return false;
		if (filter.tier !== undefined && entry.tier !== filter.tier) return false;
		const hay = entry.selector.toLowerCase();
		return words.every(word => hay.includes(word));
	});
	return rows.sort(
		(a, b) =>
			(item ? entryCost(a, item.size) - entryCost(b, item.size) : 0) ||
			a.tier - b.tier ||
			a.selector.localeCompare(b.selector),
	);
}

type Mode = { kind: "rows" } | ({ kind: "pick"; index: number } & PickerFilter) | { kind: "note"; text: string };

export interface CastingBoardOptions {
	style?: StageStyle;
	onChange?(): void;
}

const plain: StageStyle = (_token, text) => text;
/** Visible rows of the model picker. */
const PICK_ROWS = 12;
const BOARD_REASON = "chosen on the Casting Board";

export class CastingBoard implements Component {
	readonly result: Promise<CrewApproval>;
	readonly #request: CrewApprovalRequest;
	readonly #style: StageStyle;
	readonly #onChange: (() => void) | undefined;
	readonly #resolve: (approval: CrewApproval) => void;
	#rows: Assignment[];
	#policy: CrewPolicy;
	#selected = 0;
	#mode: Mode = { kind: "rows" };
	#armed = false;
	#settled = false;
	#notice: string | undefined;

	constructor(request: CrewApprovalRequest, options: CastingBoardOptions = {}) {
		this.#request = request;
		this.#style = options.style ?? plain;
		this.#onChange = options.onChange;
		this.#rows = request.cast.assignments.map(a => ({ ...a }));
		this.#policy = { ...(request.policy ?? {}) };
		const { promise, resolve } = Promise.withResolvers<CrewApproval>();
		this.result = promise;
		this.#resolve = resolve;
	}

	/** The cast as edited so far (drops and model changes applied, totals re-scored). */
	cast(): CastResult {
		const items = new Map(this.#request.items.map(item => [item.id, item]));
		let totalEstUsd = 0;
		const kept: WorkItem[] = [];
		for (const row of this.#rows) {
			totalEstUsd += row.estCostUsd;
			const item = items.get(row.itemId);
			if (item) kept.push(item);
		}
		const baseline = conductorBaseline(kept, this.#request.conductor);
		const max = this.#request.maxRunUsd;
		return {
			assignments: this.#rows.map(a => ({ ...a })),
			totalEstUsd,
			baselineEstUsd: baseline.usd,
			baselinePlan: baseline.plan,
			overBudget: max !== undefined && totalEstUsd > max,
		};
	}

	/** The policy for this run (the request's, with `p` toggles applied). */
	policy(): CrewPolicy {
		return { ...this.#policy };
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

	#item(itemId: string): WorkItem | undefined {
		return this.#request.items.find(item => item.id === itemId);
	}

	/** Rows Gaurav changed by hand, for the conductor on approve or reject. */
	#edits(): Array<{ itemId: string; selector: string }> {
		return this.#rows
			.filter(row => row.reason === BOARD_REASON)
			.map(row => ({ itemId: row.itemId, selector: row.selector }));
	}

	#dropped(): string[] {
		const kept = new Set(this.#rows.map(row => row.itemId));
		return this.#request.cast.assignments.map(a => a.itemId).filter(id => !kept.has(id));
	}

	#reject(note: string): void {
		const edits = this.#edits();
		const dropped = this.#dropped();
		this.#finish({
			approved: false,
			note,
			...(edits.length > 0 ? { edits } : {}),
			...(dropped.length > 0 ? { dropped } : {}),
		});
	}

	#approve(autoApprove: boolean): void {
		if (this.#rows.length === 0) return;
		const cast = this.cast();
		if (cast.overBudget && !this.#armed) return;
		const policyChanged = JSON.stringify(this.#policy) !== JSON.stringify(this.#request.policy ?? {});
		this.#finish({
			approved: true,
			cast,
			...(autoApprove ? { autoApprove: true } : {}),
			...(policyChanged ? { policy: this.policy() } : {}),
		});
	}

	/** `p`: flip open-weight-only for this run and re-cast every kept row that was not hand-picked. */
	#toggleOpenWeight(): void {
		const recast = this.#request.recast;
		if (!recast) {
			this.#notice = "re-casting is unavailable here";
			return;
		}
		const next: CrewPolicy = { ...this.#policy, openWeightOnly: !this.#policy.openWeightOnly };
		try {
			const cast = recast(next);
			const byItem = new Map(cast.assignments.map(a => [a.itemId, a]));
			this.#rows = this.#rows.map(row => {
				const fresh = byItem.get(row.itemId);
				const keepPick =
					row.reason === BOARD_REASON && (!next.openWeightOnly || this.#entry(row.selector)?.openWeight);
				return keepPick || !fresh ? row : { ...fresh };
			});
			this.#policy = next;
			this.#notice = next.openWeightOnly ? "open-weight only for this run" : "open-weight filter off for this run";
			this.#armed = false;
		} catch (error) {
			this.#notice = (error instanceof Error ? error.message : String(error)).split("\n")[0];
		}
	}

	#entry(selector: string): RosterEntry | undefined {
		return this.#request.roster.find(entry => entry.selector === selector);
	}

	#picker(mode: Extract<Mode, { kind: "pick" }>): RosterEntry[] {
		const row = this.#rows[this.#selected];
		return pickerModels(this.#request.roster, row ? this.#item(row.itemId) : undefined, mode);
	}

	handleInput(data: string): void {
		if (this.#settled) return;
		const mode = this.#mode;
		if (mode.kind === "note") {
			if (matchesKey(data, "enter")) this.#reject(mode.text);
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
			this.#handlePick(mode, data);
			this.#changed();
			return;
		}
		this.#notice = undefined;
		if (matchesKey(data, "up")) this.#selected = Math.max(0, this.#selected - 1);
		else if (matchesKey(data, "down")) this.#selected = Math.min(this.#rows.length - 1, this.#selected + 1);
		else if (matchesKey(data, "enter")) this.#approve(false);
		else if (matchesKey(data, "escape")) this.#mode = { kind: "note", text: "" };
		else {
			const key = extractPrintableText(data);
			if (key === "!") this.#armed = !this.#armed;
			else if (key === "e" && this.#rows.length > 0) this.#openPicker();
			else if (key === "x" && this.#rows.length > 0) {
				this.#rows.splice(this.#selected, 1);
				this.#selected = Math.min(this.#selected, Math.max(0, this.#rows.length - 1));
				this.#armed = false;
			} else if (key === "p") this.#toggleOpenWeight();
			else if (key === "r") this.#mode = { kind: "note", text: "" };
			else if (key === "a") this.#approve(true);
			else return;
		}
		this.#changed();
	}

	#openPicker(): void {
		const current = this.#rows[this.#selected]?.selector;
		const mode: Extract<Mode, { kind: "pick" }> = {
			kind: "pick",
			index: 0,
			query: "",
			openWeightOnly: this.#policy.openWeightOnly === true,
			provider: undefined,
			tier: undefined,
			all: false,
		};
		mode.index = Math.max(
			0,
			this.#picker(mode).findIndex(entry => entry.selector === current),
		);
		this.#mode = mode;
	}

	#handlePick(mode: Extract<Mode, { kind: "pick" }>, data: string): void {
		const list = this.#picker(mode);
		const refilter = (patch: Partial<PickerFilter>) => {
			this.#mode = { ...mode, ...patch, index: 0 };
		};
		if (matchesKey(data, "up")) this.#mode = { ...mode, index: Math.max(0, mode.index - 1) };
		else if (matchesKey(data, "down")) this.#mode = { ...mode, index: Math.min(list.length - 1, mode.index + 1) };
		else if (matchesKey(data, "escape")) this.#mode = { kind: "rows" };
		else if (matchesKey(data, "ctrl+o")) refilter({ openWeightOnly: !mode.openWeightOnly });
		else if (matchesKey(data, "ctrl+a")) refilter({ all: !mode.all });
		else if (matchesKey(data, "ctrl+t"))
			refilter({ tier: mode.tier === undefined ? 1 : mode.tier === 3 ? undefined : ((mode.tier + 1) as Tier) });
		else if (matchesKey(data, "ctrl+p")) {
			const providers = [...new Set(this.#request.roster.map(entry => entry.provider))].sort();
			const at = mode.provider ? providers.indexOf(mode.provider) : -1;
			refilter({ provider: providers[at + 1] });
		} else if (matchesKey(data, "backspace")) refilter({ query: mode.query.slice(0, -1) });
		else if (matchesKey(data, "enter")) {
			const entry = list[mode.index];
			const row = this.#rows[this.#selected];
			const item = row ? this.#item(row.itemId) : undefined;
			if (entry && row && item) {
				this.#rows[this.#selected] = {
					itemId: row.itemId,
					selector: entry.selector,
					tier: entry.tier,
					estCostUsd: entryCost(entry, item.size),
					planIncluded: entry.planIncluded,
					reason: BOARD_REASON,
				};
				this.#armed = false;
			}
			this.#mode = { kind: "rows" };
		} else {
			const typed = extractPrintableText(data);
			if (typed) refilter({ query: mode.query + typed });
		}
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
		const verb = req.addingTo ? `adding to ${req.addingTo}` : `plan #${req.planNumber}`;
		const title = ` CASTING BOARD · ${verb} · ${this.#rows.length} item${this.#rows.length === 1 ? "" : "s"} `;
		const vs = cast.baselinePlan
			? "conductor on plan"
			: `${savingsLabel(cast.totalEstUsd, cast.baselineEstUsd)} vs baseline`;
		const note = ` est ${formatUsd(cast.totalEstUsd)} · ${vs} `;
		const fill = Math.max(0, width - 3 - visibleWidth(title) - visibleWidth(note) - 1);
		out.push(
			visibleWidth(title) + visibleWidth(note) + 4 <= width
				? `${b("┌─")}${s("accent", title)}${b("─".repeat(fill))}${s("muted", note)}${b("─┐")}`
				: `${b("┌─")}${s("accent", fit(title, width - 4))}${b("─┐")}`,
		);
		out.push(
			line(
				`${s("dim", "policy ")}${s(this.#policy.openWeightOnly ? "success" : "text", describePolicy(this.#policy))}`,
			),
		);

		const items = new Map(req.items.map(item => [item.id, item]));
		const nameW = Math.max(6, ...this.#rows.map(r => visibleWidth(req.names[r.itemId] ?? "") + 1));
		const modelW = Math.max(5, ...this.#rows.map(r => visibleWidth(`${r.selector} t${r.tier}`)));
		const skillW = Math.max(6, ...this.#rows.map(r => visibleWidth((items.get(r.itemId)?.skills ?? []).join(","))));
		const costW = 7;
		const columns = (cells: [string, number][]) => cells.map(([t, w]) => padEnd(t, w)).join("  ");
		const itemW = Math.max(
			12,
			...this.#rows.map(r => visibleWidth(`${r.itemId} ${items.get(r.itemId)?.title ?? ""}`)),
		);
		const iw = Math.min(itemW, Math.max(12, inner - 2 - nameW - modelW - skillW - costW - 8));

		if (this.#mode.kind === "pick") this.#renderPicker(this.#mode, out, line, costW, columns);
		else {
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
				const open = this.#entry(row.selector)?.openWeight;
				const cells = [
					s(picked ? "accent" : "text", padEnd(label, iw)),
					s("agent1", padEnd(`@${req.names[row.itemId] ?? "?"}`, nameW)),
					s(open ? "success" : "text", padEnd(row.selector, modelW - 3)) + s("dim", ` t${row.tier}`),
					s("muted", padEnd((item?.skills ?? []).join(","), skillW)),
					s("text", padStart(formatUsd(row.estCostUsd, row.planIncluded), costW)),
				];
				out.push(line(`${picked ? s("accent", "▸") : " "} ${cells.join("  ")}`));
				const deps = picked && item?.dependsOn.length ? ` · after ${item.dependsOn.join(" ")}` : "";
				const scope = picked ? (item?.scope.length ? ` · scope ${item.scope.join(" ")}` : " · read-only") : "";
				out.push(line(s("dim", `    ${row.reason}${scope}${deps}`)));
			});
			out.push(line(""));
			this.#renderFooter(cast, out, line, inner);
		}
		out.push(b(`└${"─".repeat(width - 2)}┘`));
		return out;
	}

	#renderFooter(cast: CastResult, out: string[], line: (content: string) => string, inner: number): void {
		const s = this.#style;
		const req = this.#request;
		const max = req.maxRunUsd;
		const budget = max !== undefined ? ` · budget ${formatUsd(max)}` : "";
		const baselineText = cast.baselinePlan
			? ` · conductor ${req.conductor.selector} is on a plan (no $ baseline)`
			: ` est vs ${formatUsd(cast.baselineEstUsd)} conductor-only (${req.conductor.selector})`;
		const total = `${s("text", `total ${formatUsd(cast.totalEstUsd)}`)}${s("muted", `${baselineText}${budget}`)}`;
		const saved = cast.baselinePlan
			? ""
			: cast.baselineEstUsd > 0 && cast.totalEstUsd <= cast.baselineEstUsd
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
			const over = formatUsd(cast.totalEstUsd - (max ?? 0));
			out.push(
				line(
					this.#armed
						? s("warning", `over budget by ${over} · confirmed, ⏎ to approve anyway`)
						: s("error", `over budget by ${over} · press ! then ⏎ to approve anyway`),
				),
			);
		}
		if (this.#notice) out.push(line(s("warning", this.#notice)));
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
						["p", this.#policy.openWeightOnly ? "any weights" : "open-weight only"],
						["r", "reject"],
						["a", "auto-approve"],
						["↑↓", "row"],
					]),
				),
			);
		}
	}

	#renderPicker(
		mode: Extract<Mode, { kind: "pick" }>,
		out: string[],
		line: (content: string) => string,
		costW: number,
		columns: (cells: [string, number][]) => string,
	): void {
		const s = this.#style;
		const row = this.#rows[this.#selected];
		const item = row ? this.#item(row.itemId) : undefined;
		const list = this.#picker(mode);
		const filters = [
			mode.openWeightOnly ? "open-weight only" : "any weights",
			mode.provider ? `provider ${mode.provider}` : "any provider",
			mode.tier !== undefined ? `tier ${mode.tier}` : "any tier",
			mode.all ? "all connected" : "roster only",
		].join(" · ");
		out.push(line(s("text", `Model for ${row?.itemId ?? ""} ${item?.title ?? ""}`)));
		out.push(line(`${s("accent", "search ❯")} ${s("text", mode.query)}${s("accent", "█")}  ${s("muted", filters)}`));
		const pickW = Math.max(7, ...list.map(entry => visibleWidth(entry.selector) + 2));
		out.push(
			line(
				s(
					"dim",
					columns([
						["  MODEL", pickW],
						["TIER", 4],
						["OPEN", 4],
						["CTX", 5],
						["$IN/$OUT", 11],
						["STRENGTHS", 22],
						["EST", costW],
					]),
				),
			),
		);
		if (list.length === 0) out.push(line(s("muted", "  no model matches these filters")));
		const start = Math.max(0, Math.min(mode.index - Math.floor(PICK_ROWS / 2), list.length - PICK_ROWS));
		list.slice(start, start + PICK_ROWS).forEach((entry, offset) => {
			const picked = start + offset === mode.index;
			const est = item ? formatUsd(entryCost(entry, item.size), entry.planIncluded) : "";
			const price = entry.planIncluded ? "plan" : `${entry.cost.input}/${entry.cost.output}`;
			const text = columns([
				[`${picked ? "▸" : " "} ${entry.selector}`, pickW],
				[`t${entry.tier}`, 4],
				[entry.openWeight ? "yes" : "", 4],
				[ctxLabel(entry.contextWindow), 5],
				[price, 11],
				[entry.strengths.join(",") || "general", 22],
				[padStart(est, costW), costW],
			]);
			out.push(line(picked ? s("accent", text) : s(entry.enabled ? "text" : "muted", text)));
		});
		out.push(line(s("dim", list.length > PICK_ROWS ? `${mode.index + 1}/${list.length} models` : "")));
		out.push(
			line(
				this.#hints([
					["⏎", "use model"],
					["↑↓", "move"],
					["^o", "open-weight"],
					["^p", "provider"],
					["^t", "tier"],
					["^a", "roster/all"],
					["esc", "back"],
				]),
			),
		);
	}

	#hints(pairs: [string, string][]): string {
		const s = this.#style;
		return pairs.map(([key, label]) => `${s("accent", key)} ${s("muted", label)}`).join("  ");
	}
}
