/**
 * Orchestra on the Stage (spec §5.5, visual v2 §4): feeds the host from the live crew run. Queued items
 * get a placeholder agent tile until their worker registers; worker panes are titled `W-01 · title` with
 * the worker's `@name` badge in its Casting Board hue, show its tool lines with inline diffs and a
 * statusline (model · tokens · cost · ctx · scope). The right column gets proc, throughput and the plan
 * DAG; the header shows RUN cost against the budget and SAVED against the conductor-only estimate; pane
 * 0.0 shows the PLAN table under the approved `crew_plan` line.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { CrewItemSnapshot, CrewItemState } from "../crew-runtime";
import type { CrewRunContext } from "../crew-tools";
import type { StageAgentInput, StageAgentPane, StageOrchestra, StagePaneFrame } from "../stage/orchestra-hooks";
import type { Tile, TileStore } from "../stage/tiles";
import { clockTime, formatElapsed, type ToolRecord } from "../stage/tool-lines";
import { agentToken, glyph, type StageStyle, type StageToken, type StateGlyph } from "../stage/widgets/common";
import { renderDag, type DagState } from "../stage/widgets/dag";
import { renderProc, type ProcRow } from "../stage/widgets/proc";
import { renderThroughput } from "../stage/widgets/sparkline";
import { eventRows, type PlanRow, planRows } from "../stage/widgets/transcript-lines";
import { formatUsd, savingsLabel } from "../ui/casting-board";
import { estimateCostUsd } from "../roster";
import { conductorEquivalentUsd } from "../router";

export const W_PROC = "w:proc";
export const W_DAG = "w:dag";
const QUEUED_PREFIX = "crew-";
const SAMPLE_EVERY_TICKS = 2;
const SERIES_MAX = 60;
const TICK_SEC = 0.5;

/** What the adapter writes to: the host's tile store and its events tail. */
export interface OrchestraStageTarget {
	readonly store: TileStore;
	note(event: { agent: string; agentToken?: StageToken; glyph: StateGlyph; text: string }): void;
	requestRender(): void;
}

/** Live session handle the adapter samples for tok/s (an `AgentSession` satisfies it). */
export interface StreamSource {
	subscribe(
		listener: (event: { type: string; assistantMessageEvent?: { type: string; delta?: string } }) => void,
	): () => void;
	readonly isStreaming?: boolean;
	/** The session's own generation meter (rolling tok/s that holds across tool runs), when it has one. */
	readonly tokenRate?: { rate(nowMs?: number): number | null };
}

export interface OrchestraStageSources {
	/** Conductor model label, e.g. `opus-5.5`. */
	conductorLabel(): string;
	/** Conductor spend since Orchestra mode started. */
	conductorCostUsd(): number;
	conductorStreaming(): boolean;
	conductorSession(): StreamSource | undefined;
	/** Live session of a registry agent, for tok/s. */
	agentSession(agentId: string): StreamSource | undefined;
	maxRunUsd(): number | undefined;
}

interface Rate {
	chars: number;
	series: number[];
	unsubscribe?: () => void;
	source?: StreamSource;
}

const ITEM_GLYPH: Record<CrewItemState, StateGlyph> = {
	waiting: "queued",
	running: "running",
	done: "done",
	failed: "failed",
	cancelled: "failed",
};

const DAG_STATE: Record<CrewItemState, DagState> = {
	waiting: "queued",
	running: "running",
	done: "done",
	failed: "failed",
	cancelled: "failed",
};

function money(n: number): string {
	return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
	return String(Math.round(n));
}

/** Short model label: `anthropic/claude-haiku-4-5` → `haiku-4.5`. */
function shortModel(selector: string): string {
	return selector
		.replace(/^.*\//, "")
		.replace(/^claude-/, "")
		.replace(/-(\d+)-(\d+)(?=$|-)/, "-$1.$2");
}

/** Dependency depth per item: wave 1 = no deps. */
function waves(items: readonly CrewItemSnapshot[]): Map<string, number> {
	const byId = new Map(items.map(e => [e.item.id, e]));
	const depth = new Map<string, number>();
	const visit = (id: string, seen: Set<string>): number => {
		const known = depth.get(id);
		if (known !== undefined) return known;
		if (seen.has(id)) return 1;
		seen.add(id);
		const deps = byId.get(id)?.item.dependsOn ?? [];
		const d = deps.length === 0 ? 1 : 1 + Math.max(...deps.map(dep => visit(dep, seen)));
		depth.set(id, d);
		return d;
	};
	for (const e of items) visit(e.item.id, new Set());
	return depth;
}

export class OrchestraStage implements StageOrchestra {
	readonly #target: OrchestraStageTarget;
	readonly #sources: OrchestraStageSources;
	readonly #rates = new Map<string, Rate>();
	#ctx: CrewRunContext | undefined;
	#unsubRun: (() => void) | undefined;
	#ticks = 0;

	constructor(target: OrchestraStageTarget, sources: OrchestraStageSources) {
		this.#target = target;
		this.#sources = sources;
	}

	/** Put a started run on stage (replaces the previous run's tiles). */
	attach(ctx: CrewRunContext): void {
		this.#unsubRun?.();
		for (const tile of this.#target.store.all()) {
			if (tile.id.startsWith(`agent:${QUEUED_PREFIX}`)) this.#target.store.remove(tile.id);
		}
		this.#ctx = ctx;
		const store = this.#target.store;
		if (!store.get(W_PROC)) store.add({ id: W_PROC, kind: "proc", title: "proc", state: "running" });
		if (!store.get(W_DAG)) store.add({ id: W_DAG, kind: "dag", title: "dag", parentId: null, state: "running" });
		this.#target.note({
			agent: "plan",
			glyph: "done",
			text: `approved ${ctx.items.length} item${ctx.items.length === 1 ? "" : "s"}`,
		});
		this.#unsubRun = ctx.run.events.on(event => {
			const snap = this.#snapshot();
			if (event.type === "item-state") {
				const entry = snap.find(e => e.item.id === event.itemId);
				const token = this.#itemToken(event.itemId);
				if (entry && event.state !== "waiting") {
					const text = event.state === "running" ? `start ${entry.item.id}` : `${event.state} ${entry.item.id}`;
					this.#target.note({ agent: entry.name, agentToken: token, glyph: ITEM_GLYPH[event.state], text });
				}
			} else if (event.type === "worker-retired") {
				// The replaced worker's pane folds to a chip right away instead of holding a tile.
				const id = `agent:${event.workerId}`;
				if (store.get(id)) {
					store.update(id, { state: "error" });
					store.dismiss(id);
				}
			} else if (event.type === "model-unhealthy") {
				this.#target.note({
					agent: "crew",
					glyph: "failed",
					text: `${event.provider ? `${event.provider} (all models)` : event.selector} unhealthy: ${event.reason}`,
				});
			} else if (event.type === "item-recast") {
				this.#target.note({
					agent: "crew",
					agentToken: this.#itemToken(event.itemId),
					glyph: "running",
					text: `re-cast ${event.itemId} ${event.from} → ${event.to}`,
				});
			} else if (event.type === "run-done") {
				this.#target.note({
					agent: "crew",
					glyph: "done",
					text: `run ${event.summary.status} · ${formatUsd(event.summary.actualUsd)}`,
				});
				for (const id of [W_PROC, W_DAG]) if (store.get(id)) store.update(id, { state: "done" });
			}
			this.sync();
			this.#target.requestRender();
		});
		this.sync();
	}

	detach(): void {
		this.#unsubRun?.();
		this.#unsubRun = undefined;
		for (const rate of this.#rates.values()) rate.unsubscribe?.();
		this.#rates.clear();
		const store = this.#target.store;
		for (const tile of store.all()) {
			if (tile.id.startsWith(`agent:${QUEUED_PREFIX}`) || tile.id === W_PROC || tile.id === W_DAG)
				store.remove(tile.id);
		}
		this.#ctx = undefined;
	}

	get context(): CrewRunContext | undefined {
		return this.#ctx;
	}

	#snapshot(): CrewItemSnapshot[] {
		return this.#ctx?.run.snapshot() ?? [];
	}

	#itemIndex(itemId: string): number {
		return this.#ctx?.items.findIndex(item => item.id === itemId) ?? -1;
	}

	#itemToken(itemId: string): StageToken {
		return agentToken(Math.max(0, this.#itemIndex(itemId)));
	}

	#itemByWorker(agentId: string): CrewItemSnapshot | undefined {
		return this.#snapshot().find(e => e.workerId === agentId);
	}

	/** Reconcile placeholder tiles with the run: one per item that has no worker yet and is still waiting. */
	sync(): void {
		const store = this.#target.store;
		for (const entry of this.#snapshot()) {
			const id = `agent:${QUEUED_PREFIX}${entry.item.id}`;
			const placeholder = entry.state === "waiting" || (entry.state === "running" && !entry.workerId);
			const tile = store.get(id);
			if (placeholder && !tile) {
				store.add({ id, kind: "agent", parentId: null, state: "idle", title: entry.name });
			} else if (!placeholder && tile) {
				store.remove(id);
			}
			if (entry.workerId) this.#watch(entry.workerId, this.#sources.agentSession(entry.workerId));
		}
		this.#watch("conductor", this.#sources.conductorSession());
	}

	#watch(key: string, source: StreamSource | undefined): void {
		let rate = this.#rates.get(key);
		if (!rate) {
			rate = { chars: 0, series: [] };
			this.#rates.set(key, rate);
		}
		if (!source || rate.source === source) return;
		rate.unsubscribe?.();
		rate.source = source;
		const target = rate;
		rate.unsubscribe = source.subscribe(event => {
			const delta = event.type === "message_update" ? event.assistantMessageEvent : undefined;
			if (
				delta &&
				(delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta")
			) {
				target.chars += delta.delta?.length ?? 0;
			}
		});
	}

	tick(now: number): void {
		if (!this.#ctx) return;
		this.sync();
		if (++this.#ticks % SAMPLE_EVERY_TICKS !== 0) return;
		const bucket = SAMPLE_EVERY_TICKS * TICK_SEC;
		for (const rate of this.#rates.values()) {
			rate.series.push(this.#meterRate(rate, now) ?? rate.chars / 4 / bucket);
			if (rate.series.length > SERIES_MAX) rate.series.shift();
			rate.chars = 0;
		}
	}

	/** The session's rolling generation rate while its turn runs; `undefined` when idle or unmetered. */
	#meterRate(rate: Rate, now: number): number | undefined {
		const source = rate.source;
		if (!source?.tokenRate || source.isStreaming === false) return undefined;
		return source.tokenRate.rate(now) ?? undefined;
	}

	/** Live tok/s for the proc table: the meter now, else the last sampled bucket. */
	#tokPerSec(key: string, now: number): number | undefined {
		const rate = this.#rates.get(key);
		if (!rate) return undefined;
		return this.#meterRate(rate, now) ?? rate.series.at(-1);
	}

	#workerCost(): number {
		return this.#snapshot().reduce((sum, e) => sum + e.costUsd, 0);
	}

	#counts(): { running: number; queued: number; done: number } {
		const snap = this.#snapshot();
		return {
			running: snap.filter(e => e.state === "running").length,
			queued: snap.filter(e => e.state === "waiting").length,
			done: snap.filter(e => e.state === "done").length,
		};
	}

	// ── Chrome ──────────────────────────────────────────────────────────

	transcriptFrame(style: StageStyle): StagePaneFrame {
		return { title: "conductor · read-only", badge: style("accent", "@main") };
	}

	header() {
		const spent = this.#sources.conductorCostUsd() + this.#workerCost();
		const max = this.#sources.maxRunUsd();
		const ctx = this.#ctx;
		const cast = ctx?.cast;
		let saved = "plan pending · no estimate yet";
		if (ctx && cast?.baselinePlan) saved = `${this.#sources.conductorLabel()} on a plan · no savings claim`;
		else if (ctx && cast) {
			// Finished: actual spend against the same work repriced at the conductor's rates; running: estimates.
			const done = ctx.run.finished;
			const baseline = done
				? conductorEquivalentUsd(
						ctx.run.snapshot().map(e => ({
							actualUsd: e.costUsd,
							estUsd: e.assignment.estCostUsd,
							baselineUsd: estimateCostUsd(ctx.conductor.cost, e.item.size),
						})),
					)
				: cast.baselineEstUsd;
			const compare = done ? this.#workerCost() : cast.totalEstUsd;
			saved = `${savingsLabel(compare, baseline)} vs ${this.#sources.conductorLabel()}-only ${done ? "≈" : "est "}${money(baseline)}`;
		}
		return {
			mode: "ORCHESTRA",
			cost: {
				label: "RUN" as const,
				spent: money(spent),
				...(max !== undefined && max > 0 ? { budget: money(max), fraction: spent / max } : {}),
			},
			saved,
		};
	}

	tabs() {
		const counts = this.#counts();
		const summary = this.#ctx
			? [
					[
						{ glyph: "running" as const, text: `${counts.running} running` },
						{ glyph: "queued" as const, text: `${counts.queued} queued` },
						{ glyph: "done" as const, text: `${counts.done} done` },
					],
					[
						{
							text: `plan#${this.#ctx.planNumber} · ${this.#ctx.items.length} item${this.#ctx.items.length === 1 ? "" : "s"}`,
						},
					],
				]
			: [[{ glyph: "thinking" as const, text: "conductor planning" }]];
		return {
			tabs: [
				{ index: 0, name: "stage", active: true },
				{ index: 1, name: "crew" },
				{ index: 2, name: "logs" },
				{ index: 3, name: "git" },
			],
			summary,
		};
	}

	footer() {
		return {
			window: "0:stage",
			role: "conductor",
			crew: this.#counts(),
			cost: money(this.#sources.conductorCostUsd() + this.#workerCost()),
		};
	}

	agentToken(agentId: string): StageToken | undefined {
		const item = agentId.startsWith(QUEUED_PREFIX)
			? agentId.slice(QUEUED_PREFIX.length)
			: this.#itemByWorker(agentId)?.item.id;
		return item === undefined ? undefined : this.#itemToken(item);
	}

	// ── Panes ───────────────────────────────────────────────────────────

	agentPane(input: StageAgentInput): StageAgentPane | undefined {
		const { agentId, style: s, width, now } = input;
		const queued = agentId.startsWith(QUEUED_PREFIX);
		const entry = queued
			? this.#snapshot().find(e => e.item.id === agentId.slice(QUEUED_PREFIX.length))
			: this.#itemByWorker(agentId);
		if (!entry) return undefined;
		const token = this.#itemToken(entry.item.id);
		const badge = s(token, `@${entry.name}`);
		const title = `${entry.item.id} · ${entry.item.title}`;
		const scope = entry.item.scope.length > 0 ? entry.item.scope.join(" ") : "read-only";
		if (queued) {
			const deps = entry.item.dependsOn.map(dep => {
				const state = this.#ctx?.run.state(dep) ?? "waiting";
				return `${s("text", dep)} ${glyph(ITEM_GLYPH[state], s)}`;
			});
			const head =
				entry.state === "running"
					? `${glyph("running", s)} ${s("muted", "starting worker…")}`
					: `${glyph("queued", s)} ${s("muted", "queued")}${deps.length > 0 ? `${s("dim", " · waits on ")}${deps.join("  ")}` : ""}`;
			const row = (label: string, value: string) => `${s("dim", label.padEnd(7))}${s("text", value)}`;
			return {
				title,
				badge,
				rows: [
					head,
					row("model", `${shortModel(entry.assignment.selector)} · tier ${entry.assignment.tier}`),
					row(
						"est",
						`${formatUsd(entry.assignment.estCostUsd, entry.assignment.planIncluded)} · size ${entry.item.size}`,
					),
					row("scope", scope),
					row("brief", entry.item.brief.replace(/\s+/g, " ").trim()),
				],
			};
		}
		const rows = input.body(width);
		if (rows.length === 0) {
			const state = entry.state === "running" ? "thinking" : ITEM_GLYPH[entry.state];
			rows.push(
				`${s("dim", clockTime(entry.startedAt ?? now))} ${glyph(state, s)} ${s("muted", entry.state === "running" ? "reading the brief…" : entry.state)}`,
			);
		}
		if (entry.state === "done" || entry.state === "failed" || entry.state === "cancelled") {
			const text = entry.lastText?.replace(/\s+/g, " ").trim();
			rows.push(
				`${s("dim", clockTime(entry.endedAt ?? now))} ${glyph(ITEM_GLYPH[entry.state], s)} ${s("text", `${entry.state} · ${formatUsd(entry.costUsd)}`)}${text ? s("muted", ` · ${text}`) : ""}`,
			);
		}
		const stats = input.stats;
		return {
			title,
			badge,
			rows,
			status: {
				agent: entry.name,
				agentToken: token,
				model: stats?.model ?? shortModel(entry.assignment.selector),
				tokens: stats?.tokens !== undefined ? compact(stats.tokens) : undefined,
				cost: money(stats?.cost ?? entry.costUsd),
				ctx: stats?.ctx,
				scope,
			},
		};
	}

	widget(tile: Tile, width: number, height: number, now: number, style: StageStyle) {
		if (!this.#ctx) return undefined;
		const snap = this.#snapshot();
		if (tile.id === W_PROC) {
			const rows: ProcRow[] = [
				{
					pid: process.pid,
					agent: "cond",
					agentToken: "accent",
					model: this.#sources.conductorLabel(),
					tokPerSec: this.#tokPerSec("conductor", now),
					state: this.#sources.conductorStreaming() ? "R" : "S",
					time: formatElapsed(now - this.#ctx.startedAt),
				},
			];
			for (const e of snap) {
				rows.push({
					agent: e.name.length > 10 ? e.name.slice(0, 10) : e.name,
					agentToken: this.#itemToken(e.item.id),
					model: shortModel(e.assignment.selector),
					tokPerSec: e.workerId && e.state === "running" ? this.#tokPerSec(e.workerId, now) : undefined,
					state: e.state === "running" ? "R" : e.state === "waiting" ? "Q" : e.state === "done" ? "Z" : "X",
					time: e.startedAt !== undefined ? formatElapsed((e.endedAt ?? now) - e.startedAt) : undefined,
				});
			}
			return {
				title: "proc",
				badge: style("muted", `${rows.length} tasks`),
				rows: renderProc({ rows }, width, height, style),
			};
		}
		if (tile.id === W_DAG) {
			const depth = waves(snap);
			const total = Math.max(1, ...depth.values());
			const active = snap
				.filter(e => e.state === "running" || e.state === "waiting")
				.map(e => depth.get(e.item.id) ?? 1);
			const wave = active.length > 0 ? Math.min(...active) : total;
			return {
				title: `dag · plan#${this.#ctx.planNumber}`,
				badge: style("muted", `wave ${wave}/${total}`),
				rows: renderDag(
					{
						nodes: snap.map(e => ({
							id: e.item.id,
							agent: e.name,
							agentToken: this.#itemToken(e.item.id),
							state: DAG_STATE[e.state],
						})),
						edges: snap.flatMap(e => e.item.dependsOn.map(dep => ({ from: dep, to: e.item.id }))),
					},
					width,
					height,
					style,
				),
			};
		}
		if (tile.kind === "telemetry") {
			const series = [
				{ agent: "cond", agentToken: "accent" as StageToken, values: this.#rates.get("conductor")?.series ?? [] },
				...snap
					.filter(e => e.workerId)
					.map(e => ({
						agent: e.name.length > 10 ? e.name.slice(0, 10) : e.name,
						agentToken: this.#itemToken(e.item.id),
						values: this.#rates.get(e.workerId!)?.series ?? [],
					})),
			];
			const spent = this.#workerCost();
			return {
				title: "throughput · 60s",
				badge: style("muted", "tok/s"),
				rows: renderThroughput(
					{
						series,
						footer: `crew ${formatUsd(spent)} of est ${formatUsd(this.#ctx.cast.totalEstUsd)} · conductor ${formatUsd(this.#sources.conductorCostUsd())}`,
					},
					width,
					height,
					style,
				),
			};
		}
		return undefined;
	}

	// ── Pane 0.0 ────────────────────────────────────────────────────────

	toolRows(record: ToolRecord, width: number, now: number, style: StageStyle): string[] | undefined {
		if (record.name !== "crew_plan") return undefined;
		const s = style;
		const time = clockTime(record.startedAt);
		const details = isRecord(record.details) ? record.details : {};
		if (record.endedAt === null) {
			return eventRows(
				[{ time, glyph: "running", text: "crew_plan · Casting Board open", metric: "awaiting approval" }],
				width,
				s,
			);
		}
		if (record.isError || typeof details.planNumber !== "number") {
			const head = record.output.split("\n")[0] ?? "crew_plan rejected";
			return eventRows([{ time, glyph: "failed", text: `crew_plan ${head}` }], width, s);
		}
		const est = typeof details.totalEstUsd === "number" ? details.totalEstUsd : 0;
		const base = typeof details.baselineEstUsd === "number" ? details.baselineEstUsd : 0;
		const rows = eventRows(
			[
				{
					time,
					glyph: "done",
					text: `crew_plan#${details.planNumber} approved`,
					metric: `est ${money(est)} · base ${money(base)}`,
				},
			],
			width,
			s,
		);
		const ctx = this.#ctx;
		if (!ctx || ctx.planNumber !== details.planNumber) return rows;
		const snap = this.#snapshot();
		const depth = waves(snap);
		const waveCount = Math.max(1, ...depth.values());
		const planTableRows: PlanRow[] = snap.map(e => {
			const elapsed = e.startedAt !== undefined ? formatElapsed((e.endedAt ?? now) - e.startedAt) : "";
			const stateText =
				e.state === "running"
					? `run ${elapsed}`
					: e.state === "waiting"
						? e.item.dependsOn.length > 0
							? `← ${e.item.dependsOn.join(" ")}`
							: "queued"
						: `${e.state} ${formatUsd(e.costUsd)}`;
			return {
				id: e.item.id,
				owner: e.name,
				ownerToken: this.#itemToken(e.item.id),
				model: shortModel(e.assignment.selector),
				scope: e.item.scope.length > 0 ? e.item.scope.join(" ") : "read-only",
				state: DAG_STATE[e.state],
				stateText,
			};
		});
		const indent = 1;
		const table = planRows(
			{
				title: `PLAN #${ctx.planNumber} · ${snap.length} item${snap.length === 1 ? "" : "s"} · ${waveCount} wave${waveCount === 1 ? "" : "s"}`,
				note: `${savingsLabel(ctx.cast.totalEstUsd, ctx.cast.baselineEstUsd)} vs baseline`,
				rows: planTableRows,
			},
			Math.max(4, width - indent * 2),
			s,
		);
		return [...rows, ...table.map(r => `${" ".repeat(indent)}${r}`)];
	}
}
