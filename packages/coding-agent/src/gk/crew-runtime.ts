import { logger } from "@oh-my-pi/pi-utils";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { generateTaskName } from "../task/name-generator";
import type { ToolSession } from "../tools";
import type { VibeSessionRegistry } from "../vibe/runtime";
import { answerCrewQuestion } from "./ask-conductor-tool";
import type { CrewLedger } from "./ledger";
import { estimateCostUsd } from "./roster";
import { type Assignment, type CastResult, conductorBaseline, conductorEquivalentUsd, type WorkItem } from "./router";
import type { RosterEntry, Tier } from "./types";

export type CrewItemState = "waiting" | "running" | "done" | "failed" | "cancelled";

export interface CrewWorkerResult {
	ok: boolean;
	costUsd: number;
	tokens: number;
	text: string;
}

export interface CrewWorkerHandle {
	workerId: string;
	settled: Promise<CrewWorkerResult>;
}

export interface CrewWorkerSpawner {
	spawn(a: { name: string; prompt: string; model: string }): Promise<CrewWorkerHandle>;
	send(workerId: string, msg: string): Promise<void>;
	kill(workerId: string): Promise<void>;
	/** Live cumulative cost of a worker session (follow-up turns included); falls back to settled results. */
	costOf?(workerId: string): number | undefined;
}

export interface CrewRunSummary {
	runId: string;
	items: Array<{
		itemId: string;
		name: string;
		selector: string;
		state: CrewItemState;
		costUsd: number;
		durationMs: number;
	}>;
	actualUsd: number;
	/** Conductor-only estimate for the run's items (same size estimates, conductor catalog price). */
	baselineEstUsd: number;
	/** Crew estimate the Casting Board approved. */
	crewEstUsd?: number;
	/** Conductor alone on the same work at its own rates; see {@link conductorEquivalentUsd}. */
	conductorEquivUsd?: number;
	/** The conductor is plan-priced: no dollar baseline, no savings claim. */
	baselinePlan?: boolean;
	/** Conductor selector the baseline is priced on. */
	conductor?: string;
	status: "completed" | "partial" | "cancelled";
}

export type CrewEvent =
	| { type: "item-state"; itemId: string; state: CrewItemState }
	| { type: "item-worker"; itemId: string; workerId: string }
	| { type: "run-done"; summary: CrewRunSummary };

/** Read-only view of one item, for the Stage and the crew tools. */
export interface CrewItemSnapshot {
	item: WorkItem;
	name: string;
	assignment: Assignment;
	state: CrewItemState;
	workerId: string | undefined;
	startedAt: number | undefined;
	endedAt: number | undefined;
	costUsd: number;
	lastText: string | undefined;
}

export interface CrewEvents {
	on(listener: (e: CrewEvent) => void): () => void;
}

export interface CrewRunOptions {
	runId: string;
	items: WorkItem[];
	cast: CastResult;
	roster: RosterEntry[];
	spawner: CrewWorkerSpawner;
	ledger: CrewLedger;
	onChange(): void;
	/** First line of the user's prompt, recorded in the ledger. */
	promptHead?: string;
	/** Employee names by item id (the Casting Board shows them before the run exists); generated when absent. */
	names?: Record<string, string>;
	/** The conductor's roster entry: prices the conductor-only baseline in the summary. */
	conductor?: Pick<RosterEntry, "selector" | "planIncluded" | "cost">;
}

/** Concurrency cap for a selector the roster does not list (e.g. the conductor fallback). */
const DEFAULT_MAX_CONCURRENT = 2;
/** Cap on the previous worker's report carried into an escalation brief. */
const ESCALATION_REPORT_MAX = 4000;

interface ItemRuntime {
	item: WorkItem;
	name: string;
	assignment: Assignment;
	state: CrewItemState;
	/** Bumped on every (re)launch so settlements of replaced workers are ignored. */
	generation: number;
	workerId?: string;
	/** In-flight `spawner.spawn` for the current generation. */
	spawning?: Promise<void>;
	/** Brief override for the next launch (escalation). */
	nextPrompt?: string;
	/** Failed only because a dependency failed; revived if that dependency is escalated. */
	depFailed: boolean;
	excluded: string[];
	/** Cost reported by settled turns. */
	costUsd: number;
	/** Every worker id that ran this item (escalations add one). */
	workers: string[];
	startedAt?: number;
	endedAt?: number;
	lastText?: string;
}

/**
 * The worker brief: the conductor's brief, then the house rules every worker follows (spec §5.4,
 * planner/executor with an advisor): read context first, load the named skills, verify each
 * acceptance criterion yourself, ask the conductor instead of guessing, stay in scope, report.
 */
export function crewWorkerPrompt(item: WorkItem): string {
	const scope = item.scope.filter(entry => entry.trim() !== "");
	const lines = [`# ${item.title}`, "", item.brief.trim(), "", "## How to work", ""];
	lines.push(
		"- Read every file the brief names before you change anything; match the conventions you find.",
		"- If the brief names skills (e.g. `skill://impeccable`, `skill://test-driven-development`), read each one first and follow it.",
		"- Meet every acceptance criterion and check each one yourself (run it, test it, open it). Do not stop at “looks right”.",
		"- A requirement is ambiguous, a contract conflicts with the code, or a file the brief relies on is missing: call `ask_conductor` with one specific question and the options you see. Do not guess on decisions that change the result.",
	);
	if (scope.length === 0) {
		lines.push("- Do not modify any files; report findings only.");
	} else {
		lines.push(`- Only write inside: ${scope.join(", ")}. Do not modify files outside these paths.`);
	}
	lines.push(
		"",
		"## Report",
		"",
		"End with: files changed; each acceptance criterion and how you verified it (command + result); anything left open or assumed.",
	);
	return lines.join("\n");
}

/**
 * One approved crew plan in flight: spawns items as their dependencies finish
 * (honouring `maxConcurrent` per model), tracks state and cost, and records the
 * run in the ledger when it ends. A run ends by itself once every item is done;
 * with failures it stays open so the conductor can `escalate`, until `finish()`
 * (status "partial") or `cancelAll()` (status "cancelled").
 */
export class CrewRun {
	readonly done: Promise<CrewRunSummary>;
	readonly events: CrewEvents;

	readonly #opts: CrewRunOptions;
	readonly #items = new Map<string, ItemRuntime>();
	readonly #limits = new Map<string, number>();
	readonly #listeners = new Set<(e: CrewEvent) => void>();
	readonly #resolveDone: (summary: CrewRunSummary) => void;
	#started = false;
	#cancelled = false;
	#finished = false;

	constructor(opts: CrewRunOptions) {
		this.#opts = opts;
		const { promise, resolve } = Promise.withResolvers<CrewRunSummary>();
		this.done = promise;
		this.#resolveDone = resolve;
		this.events = {
			on: listener => {
				this.#listeners.add(listener);
				return () => {
					this.#listeners.delete(listener);
				};
			},
		};
		this.#register(opts.items, opts.cast.assignments, opts.names, opts.roster);
	}

	#register(
		items: readonly WorkItem[],
		assignments: readonly Assignment[],
		names: Record<string, string> | undefined,
		roster: readonly RosterEntry[],
	): void {
		for (const entry of roster) {
			if (!this.#limits.has(entry.selector)) this.#limits.set(entry.selector, Math.max(1, entry.maxConcurrent));
		}
		const byItem = new Map(assignments.map(a => [a.itemId, a]));
		for (const item of items) {
			const assignment = byItem.get(item.id);
			if (!assignment) throw new Error(`Crew item "${item.id}" has no assignment.`);
			if (this.#items.has(item.id)) throw new Error(`Crew item "${item.id}" is already in this run.`);
			this.#items.set(item.id, {
				item,
				name: names?.[item.id] ?? generateTaskName(),
				assignment,
				state: "waiting",
				generation: 0,
				depFailed: false,
				excluded: [],
				costUsd: 0,
				workers: [],
			});
		}
	}

	/**
	 * Add approved items to the live run (crew_add). Dependencies may name any item already in the run;
	 * new items start as soon as theirs are done.
	 */
	addItems(
		items: readonly WorkItem[],
		assignments: readonly Assignment[],
		names: Record<string, string> | undefined,
		roster: readonly RosterEntry[],
	): void {
		if (this.#finished || this.#cancelled) throw new Error("Crew run has already finished.");
		this.#register(items, assignments, names, roster);
		for (const item of items) this.#emit({ type: "item-state", itemId: item.id, state: "waiting" });
		this.#opts.onChange();
		this.#pump();
	}

	/** Spawn every item whose dependencies are done, honouring `maxConcurrent` per selector. */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#pump();
	}

	get runId(): string {
		return this.#opts.runId;
	}

	state(itemId: string): CrewItemState {
		return this.#get(itemId).state;
	}

	/** Employee name for the item, stable for the life of the run and unique within it. */
	workerName(itemId: string): string {
		return this.#get(itemId).name;
	}

	/** Current assignment (changes after `escalate`). */
	assignment(itemId: string): Assignment {
		return this.#get(itemId).assignment;
	}

	/** Live worker id for the item, once its spawn resolved. */
	workerId(itemId: string): string | undefined {
		return this.#get(itemId).workerId;
	}

	/** Every item in plan order. */
	snapshot(): CrewItemSnapshot[] {
		return [...this.#items.values()].map(rt => ({
			item: rt.item,
			name: rt.name,
			assignment: rt.assignment,
			state: rt.state,
			workerId: rt.workerId,
			startedAt: rt.startedAt,
			endedAt: rt.endedAt,
			costUsd: this.#costOf(rt),
			lastText: rt.lastText,
		}));
	}

	#costOf(rt: ItemRuntime): number {
		const live = this.#opts.spawner.costOf;
		if (!live || rt.workers.length === 0) return rt.costUsd;
		let total = 0;
		for (const id of rt.workers) {
			const cost = live.call(this.#opts.spawner, id);
			if (cost === undefined || !Number.isFinite(cost)) return rt.costUsd;
			total += cost;
		}
		return Math.max(total, rt.costUsd);
	}

	async send(itemId: string, msg: string): Promise<void> {
		const rt = this.#get(itemId);
		if (rt.spawning) await rt.spawning;
		if (!rt.workerId) throw new Error(`Crew item "${itemId}" has no live worker.`);
		await this.#opts.spawner.send(rt.workerId, msg);
	}

	/**
	 * Replace the item's worker with a stronger model: recast with the current
	 * selector excluded and `minTier = current + 1`, kill the old worker, and
	 * respawn with the conductor's note (plus the old worker's report) in the brief.
	 */
	async escalate(
		itemId: string,
		note: string,
		recast: (exclude: string[], minTier: Tier) => Assignment,
	): Promise<Assignment> {
		if (this.#finished || this.#cancelled) throw new Error("Crew run has already finished.");
		const rt = this.#get(itemId);
		const previous = rt.assignment;
		if (!rt.excluded.includes(previous.selector)) rt.excluded.push(previous.selector);
		const minTier = Math.min(3, previous.tier + 1) as Tier;
		const next = recast([...rt.excluded], minTier);
		await this.#replace(rt, next, [
			"## Escalation",
			`A previous worker (${previous.selector}) did not finish this item well. Note from the conductor:`,
			note.trim(),
		]);
		return next;
	}

	/**
	 * Put the item on another model (crew_reassign / Casting Board pick). A waiting item just swaps its
	 * assignment; a running or failed one is stopped and restarted on `next` with the conductor's note and
	 * whatever the previous worker reported. Done and cancelled items are refused.
	 */
	async reassign(itemId: string, next: Assignment, note = ""): Promise<"swapped" | "restarted"> {
		if (this.#finished || this.#cancelled) throw new Error("Crew run has already finished.");
		const rt = this.#get(itemId);
		if (rt.state === "done" || rt.state === "cancelled") {
			throw new Error(`Crew item "${itemId}" is already ${rt.state}; add a new item with crew_add instead.`);
		}
		if (rt.state === "waiting" && rt.workers.length === 0 && !rt.spawning) {
			rt.assignment = next;
			this.#opts.onChange();
			this.#pump();
			return "swapped";
		}
		const previous = rt.assignment.selector;
		await this.#replace(rt, next, [
			"## Reassigned",
			`This item moved from ${previous} to you. Pick up from the current state of the files in scope; do not redo finished work.`,
			...(note.trim() ? ["Note from the conductor:", note.trim()] : []),
		]);
		return "restarted";
	}

	/** Kill the item's worker and queue it to relaunch on `next` with `section` and the old report appended. */
	async #replace(rt: ItemRuntime, next: Assignment, section: string[]): Promise<void> {
		const oldWorker = rt.workerId;
		rt.generation++;
		rt.workerId = undefined;
		rt.spawning = undefined;
		if (oldWorker) await this.#kill(oldWorker);

		rt.assignment = next;
		rt.endedAt = undefined;
		rt.depFailed = false;
		const report = rt.lastText?.trim();
		rt.nextPrompt = [
			crewWorkerPrompt(rt.item),
			"",
			...section,
			...(report ? ["", "Previous worker's report:", report.slice(0, ESCALATION_REPORT_MAX)] : []),
		].join("\n");
		this.#setState(rt, "waiting");
		for (const other of this.#items.values()) {
			if (other.depFailed && other.state === "failed") {
				other.depFailed = false;
				other.endedAt = undefined;
				this.#setState(other, "waiting");
			}
		}
		this.#pump();
	}

	/** Stop one item's worker and mark it cancelled; items depending on it fail instead of starting. */
	async killItem(itemId: string): Promise<void> {
		if (this.#finished || this.#cancelled) throw new Error("Crew run has already finished.");
		const rt = this.#get(itemId);
		if (rt.state !== "running" && rt.state !== "waiting") {
			throw new Error(`Crew item "${itemId}" is already ${rt.state}.`);
		}
		const spawning = rt.spawning;
		const worker = rt.workerId;
		rt.generation++;
		rt.workerId = undefined;
		rt.spawning = undefined;
		rt.endedAt = rt.startedAt !== undefined ? Date.now() : undefined;
		this.#setState(rt, "cancelled");
		// A spawn still in flight sees the bumped generation and kills its own worker.
		if (spawning) await spawning;
		if (worker) await this.#kill(worker);
		this.#pump();
	}

	/** True when nothing is running or waiting (the run may still be open for escalation). */
	get settled(): boolean {
		for (const rt of this.#items.values()) {
			if (rt.state === "running" || rt.state === "waiting") return false;
		}
		return true;
	}

	get finished(): boolean {
		return this.#finished;
	}

	/** End a run that has no running or waiting items (e.g. the conductor gave up on failed items). */
	async finish(): Promise<CrewRunSummary> {
		if (!this.#finished && !this.#cancelled) {
			for (const rt of this.#items.values()) {
				if (rt.state === "waiting" || rt.state === "running") {
					throw new Error(`Crew item "${rt.item.id}" is still ${rt.state}; wait for it or cancel the run.`);
				}
			}
			await this.#finish();
		}
		return this.done;
	}

	/** Kill every running worker, mark unfinished items cancelled, and record the run as cancelled. */
	async cancelAll(): Promise<void> {
		if (this.#finished || this.#cancelled) {
			await this.done;
			return;
		}
		this.#cancelled = true;
		const live: ItemRuntime[] = [];
		for (const rt of this.#items.values()) {
			if (rt.state === "running") live.push(rt);
			if (rt.state === "running" || rt.state === "waiting") {
				rt.endedAt = rt.startedAt !== undefined ? Date.now() : undefined;
				this.#setState(rt, "cancelled");
			}
		}
		await Promise.allSettled(
			live.map(async rt => {
				// A spawn still in flight sees the cancelled state and kills its own worker.
				if (rt.spawning) await rt.spawning;
				if (rt.workerId) await this.#kill(rt.workerId);
			}),
		);
		await this.#finish();
	}

	#get(itemId: string): ItemRuntime {
		const rt = this.#items.get(itemId);
		if (!rt) throw new Error(`Unknown crew item "${itemId}".`);
		return rt;
	}

	#emit(event: CrewEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("gk crew: event listener failed", { error: String(error) });
			}
		}
	}

	#setState(rt: ItemRuntime, state: CrewItemState): void {
		rt.state = state;
		this.#emit({ type: "item-state", itemId: rt.item.id, state });
		this.#opts.onChange();
	}

	#runningOn(selector: string): number {
		let count = 0;
		for (const rt of this.#items.values()) {
			if (rt.state === "running" && rt.assignment.selector === selector) count++;
		}
		return count;
	}

	#pump(): void {
		if (!this.#started || this.#cancelled || this.#finished) return;
		let changed = true;
		while (changed) {
			changed = false;
			for (const rt of this.#items.values()) {
				if (rt.state !== "waiting") continue;
				const deps = rt.item.dependsOn.map(id => this.#items.get(id));
				if (deps.some(dep => !dep || dep.state === "failed" || dep.state === "cancelled")) {
					rt.depFailed = true;
					this.#setState(rt, "failed");
					changed = true;
					continue;
				}
				if (!deps.every(dep => dep?.state === "done")) continue;
				const selector = rt.assignment.selector;
				if (this.#runningOn(selector) >= (this.#limits.get(selector) ?? DEFAULT_MAX_CONCURRENT)) continue;
				this.#launch(rt);
				changed = true;
			}
		}
		this.#maybeFinish();
	}

	#launch(rt: ItemRuntime): void {
		const prompt = rt.nextPrompt ?? crewWorkerPrompt(rt.item);
		rt.nextPrompt = undefined;
		rt.startedAt ??= Date.now();
		const generation = ++rt.generation;
		this.#setState(rt, "running");
		const spawning = this.#spawnWorker(rt, generation, prompt);
		rt.spawning = spawning;
		void spawning.finally(() => {
			if (rt.spawning === spawning) rt.spawning = undefined;
		});
	}

	#isCurrent(rt: ItemRuntime, generation: number): boolean {
		return rt.generation === generation && rt.state === "running";
	}

	async #spawnWorker(rt: ItemRuntime, generation: number, prompt: string): Promise<void> {
		let handle: CrewWorkerHandle;
		try {
			handle = await this.#opts.spawner.spawn({ name: rt.name, prompt, model: rt.assignment.selector });
		} catch (error) {
			if (!this.#isCurrent(rt, generation)) return;
			rt.lastText = error instanceof Error ? error.message : String(error);
			this.#settle(rt, "failed");
			return;
		}
		const current = this.#isCurrent(rt, generation);
		rt.workers.push(handle.workerId);
		if (current) {
			rt.workerId = handle.workerId;
			this.#emit({ type: "item-worker", itemId: rt.item.id, workerId: handle.workerId });
			this.#opts.onChange();
		}
		handle.settled.then(
			result => {
				if (Number.isFinite(result.costUsd)) rt.costUsd += result.costUsd;
				if (!this.#isCurrent(rt, generation)) return;
				rt.lastText = result.text;
				this.#settle(rt, result.ok ? "done" : "failed");
			},
			error => {
				if (!this.#isCurrent(rt, generation)) return;
				rt.lastText = error instanceof Error ? error.message : String(error);
				this.#settle(rt, "failed");
			},
		);
		// Cancelled or escalated while the spawn was in flight: this worker is orphaned.
		if (!current) await this.#kill(handle.workerId);
	}

	#settle(rt: ItemRuntime, state: "done" | "failed"): void {
		rt.endedAt = Date.now();
		this.#setState(rt, state);
		this.#pump();
	}

	async #kill(workerId: string): Promise<void> {
		try {
			await this.#opts.spawner.kill(workerId);
		} catch (error) {
			logger.warn("gk crew: failed to kill worker", { workerId, error: String(error) });
		}
	}

	#maybeFinish(): void {
		for (const rt of this.#items.values()) {
			if (rt.state !== "done") return;
		}
		void this.#finish();
	}

	#summary(): CrewRunSummary {
		const runtimes = [...this.#items.values()];
		const items = runtimes.map(rt => ({
			itemId: rt.item.id,
			name: rt.name,
			selector: rt.assignment.selector,
			state: rt.state,
			costUsd: this.#costOf(rt),
			durationMs: rt.startedAt !== undefined && rt.endedAt !== undefined ? rt.endedAt - rt.startedAt : 0,
		}));
		const status = this.#cancelled
			? "cancelled"
			: items.every(entry => entry.state === "done")
				? "completed"
				: "partial";
		const actualUsd = items.reduce((sum, entry) => sum + entry.costUsd, 0);
		const conductor = this.#opts.conductor;
		const crewEstUsd = runtimes.reduce((sum, rt) => sum + rt.assignment.estCostUsd, 0);
		if (!conductor) {
			return {
				runId: this.#opts.runId,
				items,
				actualUsd,
				baselineEstUsd: this.#opts.cast.baselineEstUsd,
				crewEstUsd,
				status,
			};
		}
		const baseline = conductorBaseline(
			runtimes.map(rt => rt.item),
			conductor,
		);
		const conductorEquivUsd = baseline.plan
			? undefined
			: conductorEquivalentUsd(
					runtimes.map((rt, i) => ({
						actualUsd: items[i]!.costUsd,
						estUsd: rt.assignment.estCostUsd,
						baselineUsd: estimateCostUsd(conductor.cost, rt.item.size),
					})),
				);
		return {
			runId: this.#opts.runId,
			items,
			actualUsd,
			baselineEstUsd: baseline.usd,
			crewEstUsd,
			conductorEquivUsd,
			baselinePlan: baseline.plan,
			conductor: conductor.selector,
			status,
		};
	}

	async #finish(): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		const summary = this.#summary();
		try {
			await this.#opts.ledger.append({
				...summary,
				promptHead: this.#opts.promptHead ?? "",
				at: new Date().toISOString(),
			});
		} catch (error) {
			logger.warn("gk crew: failed to append ledger entry", { runId: summary.runId, error: String(error) });
		}
		this.#emit({ type: "run-done", summary });
		this.#opts.onChange();
		this.#resolveDone(summary);
	}
}

/**
 * Production spawner: each crew worker is a persistent vibe worker session on
 * the bundled `task` agent pinned to the assigned model. `settled` follows the
 * first turn's background job; cost/tokens come from the worker session's stats.
 */
export function createVibeCrewSpawner(registry: VibeSessionRegistry, session: ToolSession): CrewWorkerSpawner {
	const conductorId = session.getAgentId?.() ?? MAIN_AGENT_ID;
	return {
		async spawn({ name, prompt, model }) {
			const manager = session.asyncJobManager;
			if (!manager) throw new Error("Crew workers require the background job manager.");
			const { id, jobId } = await registry.spawn(session, {
				cli: "good",
				name,
				prompt,
				model,
				crewConductorId: conductorId,
			});
			// Hold the job object: the manager may evict it after delivery.
			const job = manager.getJob(jobId);
			const settled = (job?.promise ?? Promise.resolve()).then((): CrewWorkerResult => {
				const stats = AgentRegistry.global().get(id)?.session?.getSessionStats();
				return {
					ok: job?.status === "completed",
					costUsd: stats?.cost ?? 0,
					tokens: stats?.tokens.total ?? 0,
					text: job?.resultText ?? job?.errorText ?? "",
				};
			});
			return { workerId: id, settled };
		},
		async send(workerId, msg) {
			// A worker blocked in ask_conductor takes the message as its answer.
			if (await answerCrewQuestion(conductorId, workerId, msg)) return;
			await registry.send(session, { session: workerId, message: msg });
		},
		async kill(workerId) {
			await registry.kill(session, workerId);
		},
		costOf(workerId) {
			const ref = AgentRegistry.global().get(workerId);
			return ref?.session?.getSessionStats().cost ?? ref?.history?.metrics?.cost;
		},
	};
}
