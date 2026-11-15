/**
 * Orchestra crew tools (spec §5.4): the conductor's whole non-read surface. `crew_plan` validates a plan,
 * casts it onto the roster, asks for approval on the Casting Board and starts a {@link CrewRun}; the rest
 * steer, watch, escalate and stop the run's workers. {@link CrewController} holds the run state so the
 * tools stay thin and the Stage can read the same run.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import crewEscalateDescription from "../prompts/tools/crew-escalate.md" with { type: "text" };
import crewKillDescription from "../prompts/tools/crew-kill.md" with { type: "text" };
import crewPlanDescription from "../prompts/tools/crew-plan.md" with { type: "text" };
import crewSendDescription from "../prompts/tools/crew-send.md" with { type: "text" };
import crewStatusDescription from "../prompts/tools/crew-status.md" with { type: "text" };
import crewWaitDescription from "../prompts/tools/crew-wait.md" with { type: "text" };
import { generateTaskName } from "../task/name-generator";
import { type CrewItemSnapshot, type CrewItemState, CrewRun, type CrewWorkerSpawner } from "./crew-runtime";
import type { CrewLedger } from "./ledger";
import { validateCrewPlan } from "./plan-validate";
import { type Assignment, type CastResult, castCrew, type WorkItem } from "./router";
import type { RosterEntry, Tier } from "./types";
import { formatUsd as usd } from "./ui/casting-board";

export const CREW_TOOL_NAMES = [
	"crew_plan",
	"crew_send",
	"crew_wait",
	"crew_status",
	"crew_escalate",
	"crew_kill",
] as const;

export type CrewApproval =
	| { approved: true; cast: CastResult; autoApprove?: boolean }
	| { approved: false; note: string };

/** What the Casting Board shows for one plan. */
export interface CrewApprovalRequest {
	planNumber: number;
	items: WorkItem[];
	cast: CastResult;
	names: Record<string, string>;
	roster: RosterEntry[];
	conductor: RosterEntry;
	maxRunUsd: number | undefined;
}

/** Started run plus the plan it came from, for the Stage adapters. */
export interface CrewRunContext {
	run: CrewRun;
	planNumber: number;
	items: WorkItem[];
	cast: CastResult;
	conductor: RosterEntry;
	startedAt: number;
	toolCallId: string;
}

export interface CrewHost {
	/** Enabled roster entries the router may cast. */
	roster(): Promise<RosterEntry[]>;
	/** The conductor's model as a roster entry (baseline and no-eligible fallback). */
	conductor(): RosterEntry;
	/** Run budget; `undefined` = none. */
	maxRunUsd(): number | undefined;
	autoApprove(): boolean;
	setAutoApprove?(on: boolean): void;
	/** Casting Board; absent when no UI can ask (then plans within budget start directly). */
	approve?(request: CrewApprovalRequest, signal?: AbortSignal): Promise<CrewApproval>;
	spawner(): CrewWorkerSpawner;
	ledger(): CrewLedger;
	/** First line of the user's prompt for the ledger. */
	promptHead(): string;
	onRunStart?(context: CrewRunContext): void;
	onChange?(): void;
}

export interface CrewToolDetails {
	op: "plan" | "send" | "wait" | "status" | "escalate" | "kill";
	runId?: string;
	planNumber?: number;
	totalEstUsd?: number;
	baselineEstUsd?: number;
}

const DEFAULT_WAIT_SECONDS = 30;
const TERMINAL: ReadonlySet<CrewItemState> = new Set(["done", "failed", "cancelled"]);

function elapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Unique employee names for a plan. */
function castNames(items: readonly WorkItem[]): Record<string, string> {
	const used = new Set<string>();
	const names: Record<string, string> = {};
	for (const item of items) {
		let name = generateTaskName();
		for (let i = 0; used.has(name) && i < 20; i++) name = generateTaskName();
		if (used.has(name)) name = `${name}${used.size + 1}`;
		used.add(name);
		names[item.id] = name;
	}
	return names;
}

/** Items kept by the board, with dependencies on dropped rows removed. */
function keptItems(items: readonly WorkItem[], cast: CastResult): { kept: WorkItem[]; dropped: string[] } {
	const ids = new Set(cast.assignments.map(a => a.itemId));
	const dropped = items.filter(item => !ids.has(item.id)).map(item => item.id);
	const kept = items
		.filter(item => ids.has(item.id))
		.map(item => ({ ...item, dependsOn: item.dependsOn.filter(dep => ids.has(dep)) }));
	return { kept, dropped };
}

export class CrewController {
	readonly #host: CrewHost;
	#context: CrewRunContext | undefined;
	#roster: RosterEntry[] = [];
	#plans = 0;
	#runs = 0;

	constructor(host: CrewHost) {
		this.#host = host;
	}

	get context(): CrewRunContext | undefined {
		return this.#context;
	}

	get run(): CrewRun | undefined {
		return this.#context?.run;
	}

	#requireRun(): CrewRun {
		const run = this.#context?.run;
		if (!run || run.finished) throw new ToolError("No crew run is active. Submit a plan with crew_plan.");
		return run;
	}

	#requireItem(run: CrewRun, id: string): CrewItemSnapshot {
		const found = run.snapshot().find(entry => entry.item.id === id);
		if (!found) {
			const known = run
				.snapshot()
				.map(entry => entry.item.id)
				.join(", ");
			throw new ToolError(`Unknown item "${id}". Items in this run: ${known}.`);
		}
		return found;
	}

	async plan(items: WorkItem[], toolCallId: string, signal?: AbortSignal): Promise<AgentToolResult<CrewToolDetails>> {
		const active = this.#context?.run;
		if (active && !active.finished) {
			if (!active.settled) {
				throw new ToolError("A crew run is still in progress. Wait for it, or crew_kill its items first.");
			}
			await active.finish();
		}
		const errors = validateCrewPlan(items);
		if (errors.length > 0) {
			throw new ToolError(
				[
					"The plan is invalid; nothing was spawned. Fix these and call crew_plan again:",
					...errors.map(e => `- ${e.message}`),
				].join("\n"),
			);
		}
		const roster = await this.#host.roster();
		const conductor = this.#host.conductor();
		const maxRunUsd = this.#host.maxRunUsd();
		const cast = castCrew(items, roster, conductor, { maxRunUsd });
		const names = castNames(items);
		const planNumber = ++this.#plans;
		const request: CrewApprovalRequest = { planNumber, items, cast, names, roster, conductor, maxRunUsd };

		let approval: CrewApproval;
		if (this.#host.autoApprove() && !cast.overBudget) approval = { approved: true, cast };
		else if (this.#host.approve) approval = await this.#host.approve(request, signal);
		else if (cast.overBudget) {
			throw new ToolError(
				`Plan #${planNumber} is estimated at ${usd(cast.totalEstUsd)}, over the ${usd(maxRunUsd ?? 0)} run budget, and there is no Casting Board here to confirm it. Nothing was spawned; shrink the plan (fewer or smaller items, lower difficulty where honest).`,
			);
		} else approval = { approved: true, cast };

		if (!approval.approved) {
			throw new ToolError(
				[
					`Gaurav rejected plan #${planNumber} on the Casting Board; nothing was spawned.`,
					approval.note.trim() ? `Note: ${approval.note.trim()}` : "No note given.",
					"Revise the plan and call crew_plan again.",
				].join("\n"),
			);
		}
		if (approval.autoApprove) this.#host.setAutoApprove?.(true);

		const { kept, dropped } = keptItems(items, approval.cast);
		if (kept.length === 0) throw new ToolError("Every item was dropped on the Casting Board; nothing was spawned.");
		this.#roster = roster;
		const runNumber = ++this.#runs;
		const runId = `crew-${runNumber}-${Date.now().toString(36)}`;
		const run = new CrewRun({
			runId,
			items: kept,
			cast: approval.cast,
			roster,
			spawner: this.#host.spawner(),
			ledger: this.#host.ledger(),
			onChange: () => this.#host.onChange?.(),
			promptHead: this.#host.promptHead(),
			names,
		});
		this.#context = {
			run,
			planNumber,
			items: kept,
			cast: approval.cast,
			conductor,
			startedAt: Date.now(),
			toolCallId,
		};
		this.#host.onRunStart?.(this.#context);
		run.start();

		const lines = [`Plan #${planNumber} approved. Run ${run.snapshot().length} item(s):`];
		for (const entry of run.snapshot()) {
			const a = entry.assignment;
			const deps = entry.item.dependsOn.length > 0 ? ` · after ${entry.item.dependsOn.join(", ")}` : "";
			lines.push(
				`- ${entry.item.id} → ${entry.name} on ${a.selector} (tier ${a.tier}, est ${usd(a.estCostUsd, a.planIncluded)})${deps}`,
			);
		}
		lines.push(`Estimate ${usd(approval.cast.totalEstUsd)} vs ${usd(approval.cast.baselineEstUsd)} conductor-only.`);
		if (dropped.length > 0) lines.push(`Dropped on the board (do not re-plan unless asked): ${dropped.join(", ")}.`);
		lines.push("Results deliver themselves as workers finish; verify each by reading the files it touched.");
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				op: "plan",
				runId,
				planNumber,
				totalEstUsd: approval.cast.totalEstUsd,
				baselineEstUsd: approval.cast.baselineEstUsd,
			},
		};
	}

	async send(itemId: string, message: string): Promise<AgentToolResult<CrewToolDetails>> {
		const run = this.#requireRun();
		const entry = this.#requireItem(run, itemId);
		try {
			await run.send(itemId, message);
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		return text(`Sent to ${entry.name} (${itemId}). The reply delivers itself.`, { op: "send" });
	}

	async wait(
		itemIds: string[] | undefined,
		timeoutSec: number | undefined,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CrewToolDetails>> {
		const run = this.#requireRun();
		for (const id of itemIds ?? []) this.#requireItem(run, id);
		const watched = new Set(
			itemIds?.length
				? itemIds
				: run
						.snapshot()
						.filter(e => !TERMINAL.has(e.state))
						.map(e => e.item.id),
		);
		const pending = [...watched].filter(id => !TERMINAL.has(run.state(id)));
		let timedOut = false;
		if (pending.length > 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			const off = run.events.on(event => {
				if (event.type === "run-done") resolve();
				else if (event.type === "item-state" && watched.has(event.itemId) && TERMINAL.has(event.state)) resolve();
			});
			const timer = setTimeout(
				() => {
					timedOut = true;
					resolve();
				},
				(timeoutSec ?? DEFAULT_WAIT_SECONDS) * 1000,
			);
			const onAbort = () => resolve();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await promise;
			} finally {
				off();
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		}
		const lines = [this.#statusLines(run).join("\n")];
		if (timedOut) lines.push("", "Wait window elapsed with no change; call crew_wait again to keep waiting.");
		else lines.push("", "Full worker reports deliver themselves as messages.");
		return text(lines.join("\n"), { op: "wait" });
	}

	status(): AgentToolResult<CrewToolDetails> {
		const run = this.#context?.run;
		if (!run) return text("No crew run yet. Submit a plan with crew_plan.", { op: "status" });
		return text(this.#statusLines(run).join("\n"), { op: "status", planNumber: this.#context?.planNumber });
	}

	async escalate(itemId: string, note: string): Promise<AgentToolResult<CrewToolDetails>> {
		const run = this.#requireRun();
		const entry = this.#requireItem(run, itemId);
		const conductor = this.#context?.conductor ?? this.#host.conductor();
		const roster = this.#roster;
		let next: Assignment;
		try {
			next = await run.escalate(itemId, note, (exclude: string[], minTier: Tier) => {
				const cast = castCrew([entry.item], roster, conductor, {
					exclude: { [itemId]: exclude },
					minTier: { [itemId]: minTier },
				});
				return cast.assignments[0]!;
			});
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		return text(
			`Escalated ${itemId}: ${entry.assignment.selector} (tier ${entry.assignment.tier}) → ${next.selector} (tier ${next.tier}, est ${usd(next.estCostUsd, next.planIncluded)}; ${next.reason}). The new worker starts with your note and the previous report.`,
			{ op: "escalate" },
		);
	}

	async kill(itemId: string): Promise<AgentToolResult<CrewToolDetails>> {
		const run = this.#requireRun();
		const entry = this.#requireItem(run, itemId);
		try {
			await run.killItem(itemId);
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		return text(`Stopped ${entry.name} on ${itemId}; the item is cancelled.`, { op: "kill" });
	}

	/** Close an open run whose items have all settled (called when the conductor goes idle). */
	async finishIfSettled(): Promise<void> {
		const run = this.#context?.run;
		if (run && !run.finished && run.settled) await run.finish();
	}

	async cancelAll(): Promise<void> {
		const run = this.#context?.run;
		if (run && !run.finished) await run.cancelAll();
	}

	#statusLines(run: CrewRun): string[] {
		const now = Date.now();
		const snap = run.snapshot();
		const lines = snap.map(e => {
			const time = e.startedAt !== undefined ? ` · ${elapsed((e.endedAt ?? now) - e.startedAt)}` : "";
			const waits =
				e.state === "waiting" && e.item.dependsOn.length > 0 ? ` · waits on ${e.item.dependsOn.join(", ")}` : "";
			return `- ${e.item.id} ${e.name} · ${e.assignment.selector} · ${e.state}${time}${waits} · ${usd(e.costUsd)}`;
		});
		const cast = this.#context?.cast;
		const spent = snap.reduce((sum, e) => sum + e.costUsd, 0);
		lines.push(
			`Spent ${usd(spent)} of est ${usd(cast?.totalEstUsd ?? 0)} (conductor-only est ${usd(cast?.baselineEstUsd ?? 0)}).`,
		);
		if (!run.finished && run.settled)
			lines.push("Every item has settled; escalate failures, or finish your reply to close the run.");
		return lines;
	}
}

function text(body: string, details: CrewToolDetails): AgentToolResult<CrewToolDetails> {
	return { content: [{ type: "text", text: body }], details };
}

const skillSchema = type(
	"'frontend' | 'backend' | 'tests' | 'docs' | 'infra' | 'refactor' | 'research' | 'review' | 'design'",
);

const workItemSchema = type({
	id: type("string > 0").describe("item id, e.g. W-01"),
	title: type("string > 0").describe("a few words"),
	brief: type("string").describe("self-contained brief with acceptance criteria; the worker sees nothing else"),
	skills: skillSchema.array().describe("skills the item needs"),
	difficulty: type("1 | 2 | 3").describe("1 mechanical · 2 normal engineering · 3 frontier judgment"),
	size: type("'S' | 'M' | 'L'").describe("S ≈ a file or two · M · L"),
	"dependsOn?": type("string[]").describe("item ids that must finish first"),
	scope: type("string[]").describe("path prefixes the item may write; [] = read-only"),
});

const crewPlanSchema = type({ items: workItemSchema.array().atLeastLength(1).describe("work items") });
const crewSendSchema = type({
	item: type("string > 0").describe("item id"),
	message: type("string > 0").describe("instructions for the worker"),
});
const crewWaitSchema = type({
	"items?": type("string[]").describe("item ids to watch; omit for every running item"),
	"timeout?": type("number > 0").describe("max seconds (default 30)"),
});
const crewStatusSchema = type({});
const crewEscalateSchema = type({
	item: type("string > 0").describe("item id"),
	note: type("string > 0").describe("what went wrong and what the new worker must do differently"),
});
const crewKillSchema = type({ item: type("string > 0").describe("item id") });

abstract class CrewTool {
	readonly strict = true;
	constructor(protected readonly crew: CrewController) {}
}

class CrewPlanTool extends CrewTool implements AgentTool<typeof crewPlanSchema, CrewToolDetails> {
	readonly name = "crew_plan";
	readonly approval = "exec" as const;
	readonly label = "Crew Plan";
	readonly summary = "Validate, cast and approve a crew plan, then start it";
	readonly description = prompt.render(crewPlanDescription);
	readonly parameters = crewPlanSchema;
	execute(toolCallId: string, params: typeof crewPlanSchema.infer, signal?: AbortSignal) {
		const items: WorkItem[] = params.items.map(item => ({ ...item, dependsOn: item.dependsOn ?? [] }));
		return this.crew.plan(items, toolCallId, signal);
	}
}

class CrewSendTool extends CrewTool implements AgentTool<typeof crewSendSchema, CrewToolDetails> {
	readonly name = "crew_send";
	readonly approval = "exec" as const;
	readonly label = "Crew Send";
	readonly summary = "Message an item's worker";
	readonly description = prompt.render(crewSendDescription);
	readonly parameters = crewSendSchema;
	execute(_id: string, params: typeof crewSendSchema.infer) {
		return this.crew.send(params.item, params.message);
	}
}

class CrewWaitTool extends CrewTool implements AgentTool<typeof crewWaitSchema, CrewToolDetails> {
	readonly name = "crew_wait";
	readonly approval = "read" as const;
	readonly label = "Crew Wait";
	readonly summary = "Block until a crew item settles";
	readonly description = prompt.render(crewWaitDescription);
	readonly parameters = crewWaitSchema;
	readonly interruptible = true;
	execute(_id: string, params: typeof crewWaitSchema.infer, signal?: AbortSignal) {
		return this.crew.wait(params.items, params.timeout, signal);
	}
}

class CrewStatusTool extends CrewTool implements AgentTool<typeof crewStatusSchema, CrewToolDetails> {
	readonly name = "crew_status";
	readonly approval = "read" as const;
	readonly label = "Crew Status";
	readonly summary = "List crew items and spend";
	readonly description = prompt.render(crewStatusDescription);
	readonly parameters = crewStatusSchema;
	async execute() {
		return this.crew.status();
	}
}

class CrewEscalateTool extends CrewTool implements AgentTool<typeof crewEscalateSchema, CrewToolDetails> {
	readonly name = "crew_escalate";
	readonly approval = "exec" as const;
	readonly label = "Crew Escalate";
	readonly summary = "Re-cast an item on a higher tier";
	readonly description = prompt.render(crewEscalateDescription);
	readonly parameters = crewEscalateSchema;
	execute(_id: string, params: typeof crewEscalateSchema.infer) {
		return this.crew.escalate(params.item, params.note);
	}
}

class CrewKillTool extends CrewTool implements AgentTool<typeof crewKillSchema, CrewToolDetails> {
	readonly name = "crew_kill";
	readonly approval = "read" as const;
	readonly label = "Crew Kill";
	readonly summary = "Stop an item's worker";
	readonly description = prompt.render(crewKillDescription);
	readonly parameters = crewKillSchema;
	execute(_id: string, params: typeof crewKillSchema.infer) {
		return this.crew.kill(params.item);
	}
}

/** The ephemeral tools installed while Orchestra mode is active. */
export function createCrewTools(crew: CrewController): AgentTool[] {
	return [
		new CrewPlanTool(crew),
		new CrewSendTool(crew),
		new CrewWaitTool(crew),
		new CrewStatusTool(crew),
		new CrewEscalateTool(crew),
		new CrewKillTool(crew),
	] as unknown as AgentTool[];
}
