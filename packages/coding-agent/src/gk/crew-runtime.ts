import { logger } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import { generateTaskName } from "../task/name-generator";
import type { ToolSession } from "../tools";
import type { VibeSessionRegistry } from "../vibe/runtime";
import type { CrewLedger } from "./ledger";
import type { Assignment, CastResult, WorkItem } from "./router";
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
	baselineEstUsd: number;
	status: "completed" | "partial" | "cancelled";
}

export type CrewEvent =
	| { type: "item-state"; itemId: string; state: CrewItemState }
	| { type: "run-done"; summary: CrewRunSummary };

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
	costUsd: number;
	startedAt?: number;
	endedAt?: number;
	lastText?: string;
}

/** The worker brief: item brief + write-scope rule + reporting rule. */
export function crewWorkerPrompt(item: WorkItem): string {
	const scope = item.scope.filter(entry => entry.trim() !== "");
	const lines = [`# ${item.title}`, "", item.brief.trim(), ""];
	if (scope.length === 0) {
		lines.push("Do not modify any files; report findings only.");
	} else {
		lines.push(
			`Only write inside: ${scope.join(", ")}. Do not modify files outside these paths.`,
			"",
			"When done, report the files you changed and how you verified the change.",
		);
	}
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
		for (const entry of opts.roster) this.#limits.set(entry.selector, Math.max(1, entry.maxConcurrent));
		const assignments = new Map(opts.cast.assignments.map(a => [a.itemId, a]));
		for (const item of opts.items) {
			const assignment = assignments.get(item.id);
			if (!assignment) throw new Error(`Crew item "${item.id}" has no assignment.`);
			this.#items.set(item.id, {
				item,
				name: generateTaskName(),
				assignment,
				state: "waiting",
				generation: 0,
				depFailed: false,
				excluded: [],
				costUsd: 0,
			});
		}
	}

	/** Spawn every item whose dependencies are done, honouring `maxConcurrent` per selector. */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#pump();
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
			"## Escalation",
			`A previous worker (${previous.selector}) did not finish this item well. Note from the conductor:`,
			note.trim(),
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
		return next;
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
		if (current) rt.workerId = handle.workerId;
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
		const items = [...this.#items.values()].map(rt => ({
			itemId: rt.item.id,
			name: rt.name,
			selector: rt.assignment.selector,
			state: rt.state,
			costUsd: rt.costUsd,
			durationMs: rt.startedAt !== undefined && rt.endedAt !== undefined ? rt.endedAt - rt.startedAt : 0,
		}));
		const status = this.#cancelled
			? "cancelled"
			: items.every(entry => entry.state === "done")
				? "completed"
				: "partial";
		return {
			runId: this.#opts.runId,
			items,
			actualUsd: items.reduce((sum, entry) => sum + entry.costUsd, 0),
			baselineEstUsd: this.#opts.cast.baselineEstUsd,
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
	return {
		async spawn({ name, prompt, model }) {
			const manager = session.asyncJobManager;
			if (!manager) throw new Error("Crew workers require the background job manager.");
			const { id, jobId } = await registry.spawn(session, { cli: "good", name, prompt, model });
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
			await registry.send(session, { session: workerId, message: msg });
		},
		async kill(workerId) {
			await registry.kill(session, workerId);
		},
	};
}
