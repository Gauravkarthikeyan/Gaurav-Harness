/**
 * Orchestra crew tools (spec §5.4): the conductor's whole non-read surface. `crew_models` shows every
 * connected model, `crew_policy` records Gaurav's casting rules, `crew_plan` validates a plan, casts it,
 * asks for approval on the Casting Board and starts a {@link CrewRun}; `crew_add` / `crew_reassign` grow
 * and re-cast a live run; the rest steer, watch, escalate and stop the run's workers.
 * {@link CrewController} holds the run state so the tools stay thin and the Stage can read the same run.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import crewAddDescription from "../prompts/tools/crew-add.md" with { type: "text" };
import crewEscalateDescription from "../prompts/tools/crew-escalate.md" with { type: "text" };
import crewKillDescription from "../prompts/tools/crew-kill.md" with { type: "text" };
import crewModelsDescription from "../prompts/tools/crew-models.md" with { type: "text" };
import crewPlanDescription from "../prompts/tools/crew-plan.md" with { type: "text" };
import crewPolicyDescription from "../prompts/tools/crew-policy.md" with { type: "text" };
import crewReassignDescription from "../prompts/tools/crew-reassign.md" with { type: "text" };
import crewSendDescription from "../prompts/tools/crew-send.md" with { type: "text" };
import crewStatusDescription from "../prompts/tools/crew-status.md" with { type: "text" };
import crewWaitDescription from "../prompts/tools/crew-wait.md" with { type: "text" };
import { generateTaskName } from "../task/name-generator";
import {
	type CrewItemSnapshot,
	type CrewItemState,
	CrewRun,
	type CrewWorkerSpawner,
	type UnhealthyMark,
} from "./crew-runtime";
import type { CrewLedger } from "./ledger";
import { formatModelTable, type ModelFilter } from "./model-table";
import { validateCrewPlan } from "./plan-validate";
import {
	type Assignment,
	type CastResult,
	CrewCastError,
	castCrew,
	describePolicy,
	entryCost,
	policyViolation,
	type WorkItem,
} from "./router";
import type { CrewPolicy, RosterEntry, Tier } from "./types";
import { formatUsd as usd } from "./ui/casting-board";

export const CREW_TOOL_NAMES = [
	"crew_models",
	"crew_policy",
	"crew_plan",
	"crew_add",
	"crew_reassign",
	"crew_send",
	"crew_wait",
	"crew_status",
	"crew_escalate",
	"crew_kill",
] as const;

/** A board row Gaurav re-cast by hand. */
export interface BoardEdit {
	itemId: string;
	selector: string;
}

export type CrewApproval =
	| { approved: true; cast: CastResult; autoApprove?: boolean; policy?: CrewPolicy }
	| { approved: false; note: string; edits?: BoardEdit[]; dropped?: string[] };

/** What the Casting Board shows for one plan (or one `crew_add`). */
export interface CrewApprovalRequest {
	planNumber: number;
	items: WorkItem[];
	cast: CastResult;
	names: Record<string, string>;
	/** Every connected model (disabled roster entries included; the picker can show them). */
	roster: RosterEntry[];
	conductor: RosterEntry;
	maxRunUsd: number | undefined;
	/** Policy in force for this cast. */
	policy?: CrewPolicy;
	/** Re-cast the same items under another policy (board `p`); throws {@link CrewCastError}. */
	recast?(policy: CrewPolicy): CastResult;
	/** Run id when the board approves additions to a live run. */
	addingTo?: string;
	/** Warnings for the top of the board, e.g. models skipped as unhealthy. */
	notices?: string[];
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
	/** The board's `p` toggle for this run, layered over the session policy. */
	policyOverride?: Pick<CrewPolicy, "openWeightOnly">;
}

export interface CrewHost {
	/** Every connected model as a roster entry (disabled ones included; the router skips them). */
	roster(): Promise<RosterEntry[]>;
	/** The conductor's model as a roster entry (baseline and no-eligible fallback). */
	conductor(): RosterEntry;
	/** Run budget; `undefined` = none. */
	maxRunUsd(): number | undefined;
	autoApprove(): boolean;
	setAutoApprove?(on: boolean): void;
	/** Session crew policy (Gaurav's stated preferences). */
	policy?(): CrewPolicy;
	setPolicy?(policy: CrewPolicy): void;
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
	op: "models" | "policy" | "plan" | "add" | "reassign" | "send" | "wait" | "status" | "escalate" | "kill";
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

/** Unique employee names for a plan, avoiding names already in use. */
function castNames(items: readonly WorkItem[], taken: Iterable<string> = []): Record<string, string> {
	const used = new Set(taken);
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

/** Items kept by the board, with dependencies on dropped rows removed (`known` deps always kept). */
function keptItems(
	items: readonly WorkItem[],
	cast: CastResult,
	known: ReadonlySet<string> = new Set(),
): { kept: WorkItem[]; dropped: string[] } {
	const ids = new Set(cast.assignments.map(a => a.itemId));
	const dropped = items.filter(item => !ids.has(item.id)).map(item => item.id);
	const kept = items
		.filter(item => ids.has(item.id))
		.map(item => ({ ...item, dependsOn: item.dependsOn.filter(dep => ids.has(dep) || known.has(dep)) }));
	return { kept, dropped };
}

/**
 * What must change between a rejected plan and the next one: the items (brief included), the models
 * they were cast on, and the policy. Equal fingerprints = an identical resubmission.
 */
export function planFingerprint(items: readonly WorkItem[], cast: CastResult, policy: CrewPolicy): string {
	const selectors = new Map(cast.assignments.map(a => [a.itemId, a.selector]));
	const rows = [...items]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map(item => [
			item.id,
			item.title.trim(),
			item.brief.trim(),
			[...item.skills].sort(),
			item.difficulty,
			item.size,
			[...item.dependsOn].sort(),
			[...item.scope].sort(),
			selectors.get(item.id) ?? "",
		]);
	return JSON.stringify({ rows, policy: describePolicy(policy) });
}

/** Normalised policy: empty lists and false flags dropped. */
function cleanPolicy(policy: CrewPolicy): CrewPolicy {
	const out: CrewPolicy = {};
	if (policy.openWeightOnly) out.openWeightOnly = true;
	if (policy.providers?.length) out.providers = [...new Set(policy.providers)];
	if (policy.excludeProviders?.length) out.excludeProviders = [...new Set(policy.excludeProviders)];
	if (policy.maxTier !== undefined) out.maxTier = policy.maxTier;
	if (policy.preferQuality) out.preferQuality = true;
	return out;
}

interface Rejection {
	planNumber: number;
	fingerprint: string;
	note: string;
}

export class CrewController {
	readonly #host: CrewHost;
	#context: CrewRunContext | undefined;
	#roster: RosterEntry[] = [];
	#plans = 0;
	#runs = 0;
	/** Session policy when the host keeps none. */
	#policy: CrewPolicy = {};
	#lastRejection: Rejection | undefined;
	/** Models Gaurav picked on the board for a rejected plan, applied to the next plan's same item ids. */
	#boardPicks = new Map<string, string>();
	/** Models the crew found unusable this session (fast spawn failures), with why. */
	#unhealthy = new Map<string, string>();

	constructor(host: CrewHost) {
		this.#host = host;
	}

	get context(): CrewRunContext | undefined {
		return this.#context;
	}

	get run(): CrewRun | undefined {
		return this.#context?.run;
	}

	/** The session crew policy. */
	policy(): CrewPolicy {
		return this.#host.policy?.() ?? this.#policy;
	}

	/** The session policy with the live run's board toggle applied (four call sites cast under it). */
	#runPolicy(): CrewPolicy {
		return { ...this.policy(), ...this.#context?.policyOverride };
	}

	#setPolicy(policy: CrewPolicy): void {
		if (this.#host.setPolicy) this.#host.setPolicy(policy);
		else this.#policy = policy;
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

	#cast(items: WorkItem[], roster: RosterEntry[], conductor: RosterEntry, policy: CrewPolicy, maxRunUsd?: number) {
		try {
			return castCrew(items, roster, conductor, { maxRunUsd, policy });
		} catch (error) {
			if (error instanceof CrewCastError) throw new ToolError(error.message);
			throw error;
		}
	}

	/**
	 * The host's roster with models the crew found unusable switched off (the router skips them, the
	 * picker still shows them). Cached for re-casts and reassignments.
	 */
	async #rosterNow(): Promise<RosterEntry[]> {
		const roster = await this.#host.roster();
		this.#roster = roster.map(entry => (this.#unhealthy.has(entry.selector) ? { ...entry, enabled: false } : entry));
		return this.#roster;
	}

	/** Record a fast spawn failure: the model, or every model of the provider for account-wide errors. */
	#markUnhealthy(mark: UnhealthyMark): void {
		this.#unhealthy.set(mark.selector, mark.reason);
		if (mark.provider) {
			for (const entry of this.#roster)
				if (entry.provider === mark.provider) this.#unhealthy.set(entry.selector, mark.reason);
		}
		this.#roster = this.#roster.map(entry =>
			this.#unhealthy.has(entry.selector) ? { ...entry, enabled: false } : entry,
		);
		this.#host.onChange?.();
	}

	/** `commandcode (27 models): 403 …` lines for the board and status. */
	#unhealthyNotes(): string[] {
		const byReason = new Map<string, string[]>();
		for (const [selector, reason] of this.#unhealthy) {
			const list = byReason.get(reason) ?? [];
			list.push(selector);
			byReason.set(reason, list);
		}
		return [...byReason].map(([reason, selectors]) => {
			const providers = [...new Set(selectors.map(s => s.split("/")[0]!))];
			const who = selectors.length === 1 ? selectors[0]! : `${providers.join(", ")} (${selectors.length} models)`;
			return `skipping unhealthy ${who}: ${reason}`;
		});
	}

	/** CrewRun's re-cast after a fast spawn failure: same item, its model pick dropped, unhealthy models out. */
	#autoRecast(item: WorkItem, exclude: string[], conductor: RosterEntry): Assignment | undefined {
		try {
			const [next] = castCrew([{ ...item, model: undefined }], this.#roster, conductor, {
				exclude: { [item.id]: exclude },
				policy: this.#runPolicy(),
			}).assignments;
			return next && !this.#unhealthy.has(next.selector) ? next : undefined;
		} catch {
			return undefined;
		}
	}

	async models(filter: ModelFilter = {}): Promise<AgentToolResult<CrewToolDetails>> {
		const roster = await this.#rosterNow();
		const conductor = this.#host.conductor();
		return text(
			formatModelTable(roster, {
				filter,
				policy: this.policy(),
				conductor: conductor.selector,
				unhealthy: this.#unhealthy,
			}),
			{ op: "models" },
		);
	}

	async setPolicy(patch: CrewPolicy & { clear?: boolean }): Promise<AgentToolResult<CrewToolDetails>> {
		const { clear, ...fields } = patch;
		const next = cleanPolicy(clear ? fields : { ...this.policy(), ...fields });
		const roster = await this.#rosterNow();
		const providers = new Set(roster.map(entry => entry.provider));
		const unknown = (next.providers ?? []).filter(provider => !providers.has(provider));
		if (unknown.length > 0) {
			throw new ToolError(
				`Unknown provider(s): ${unknown.join(", ")}. Connected providers: ${[...providers].sort().join(", ")}.`,
			);
		}
		const allowed = roster.filter(entry => entry.enabled && !policyViolation(entry, next));
		if (allowed.length === 0) {
			throw new ToolError(
				[
					`No connected model satisfies that policy (${describePolicy(next)}); the policy was not changed.`,
					formatModelTable(roster, { policy: next }),
				].join("\n"),
			);
		}
		this.#setPolicy(next);
		const byTier = [3, 2, 1].map(tier => `t${tier}: ${allowed.filter(e => e.tier === tier).length}`).join(", ");
		return text(
			[
				`Crew policy set: ${describePolicy(next)}. It holds for every plan, addition, reassignment and escalation this session until changed.`,
				`${allowed.length} model(s) allowed (${byTier}): ${allowed
					.sort((a, b) => b.tier - a.tier || a.selector.localeCompare(b.selector))
					.slice(0, 12)
					.map(e => `${e.selector} t${e.tier}`)
					.join(", ")}${allowed.length > 12 ? ", …" : ""}`,
			].join("\n"),
			{ op: "policy" },
		);
	}

	async plan(items: WorkItem[], toolCallId: string, signal?: AbortSignal): Promise<AgentToolResult<CrewToolDetails>> {
		const active = this.#context?.run;
		if (active && !active.finished) {
			if (!active.settled) {
				throw new ToolError(
					"A crew run is still in progress. Add items to it with crew_add, wait for it, or crew_kill its items first.",
				);
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
		const picked = items.map(item => {
			const pick = this.#boardPicks.get(item.id);
			return pick && !item.model ? { ...item, model: pick, reason: "Gaurav's pick on the Casting Board" } : item;
		});
		const roster = await this.#rosterNow();
		const conductor = this.#host.conductor();
		const maxRunUsd = this.#host.maxRunUsd();
		const policy = this.policy();
		const cast = this.#cast(picked, roster, conductor, policy, maxRunUsd);

		const fingerprint = planFingerprint(picked, cast, policy);
		const last = this.#lastRejection;
		if (last && last.fingerprint === fingerprint) {
			throw new ToolError(
				[
					`This is the same plan Gaurav rejected as plan #${last.planNumber} (same items, same models, same policy); it was not shown again.`,
					last.note ? `His note: ${last.note}` : "He gave no note; ask him what to change.",
					"Change what the note asks for before resubmitting: set `model` per item (see crew_models), change the items, or record his preference with crew_policy.",
				].join("\n"),
			);
		}

		const names = castNames(picked);
		const planNumber = ++this.#plans;
		const request: CrewApprovalRequest = {
			planNumber,
			items: picked,
			cast,
			names,
			roster,
			conductor,
			maxRunUsd,
			policy,
			recast: next => castCrew(picked, roster, conductor, { maxRunUsd, policy: next }),
			notices: this.#unhealthyNotes(),
		};

		const approval = await this.#decide(request, signal);
		if (!approval.approved) throw this.#rejected(planNumber, fingerprint, approval);
		this.#lastRejection = undefined;
		this.#boardPicks.clear();
		if (approval.autoApprove) this.#host.setAutoApprove?.(true);

		const { kept, dropped } = keptItems(picked, approval.cast);
		if (kept.length === 0) throw new ToolError("Every item was dropped on the Casting Board; nothing was spawned.");
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
			conductor,
			recast: (item, exclude) => this.#autoRecast(item, exclude, conductor),
			onUnhealthy: mark => this.#markUnhealthy(mark),
		});
		this.#context = {
			run,
			planNumber,
			items: kept,
			cast: approval.cast,
			conductor,
			startedAt: Date.now(),
			toolCallId,
			policyOverride: approval.policy ? { openWeightOnly: approval.policy.openWeightOnly === true } : undefined,
		};
		this.#host.onRunStart?.(this.#context);
		run.start();

		const lines = [`Plan #${planNumber} approved. Run ${run.snapshot().length} item(s):`];
		lines.push(...this.#castLines(run.snapshot()));
		lines.push(this.#estimateLine(approval.cast));
		if (approval.policy)
			lines.push(`Gaurav set the policy for this run on the board: ${describePolicy(approval.policy)}.`);
		if (dropped.length > 0) lines.push(`Dropped on the board (do not re-plan unless asked): ${dropped.join(", ")}.`);
		lines.push(
			"Results deliver themselves as workers finish. Review each one against its acceptance criteria by reading the files it touched, then crew_send concrete fix-ups.",
		);
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

	async #decide(request: CrewApprovalRequest, signal?: AbortSignal): Promise<CrewApproval> {
		const { cast, maxRunUsd, planNumber } = request;
		if (this.#host.autoApprove() && !cast.overBudget) return { approved: true, cast };
		if (this.#host.approve) return this.#host.approve(request, signal);
		if (cast.overBudget) {
			throw new ToolError(
				`Plan #${planNumber} is estimated at ${usd(cast.totalEstUsd)}, over the ${usd(maxRunUsd ?? 0)} run budget, and there is no Casting Board here to confirm it. Nothing was spawned; shrink the plan (fewer or smaller items, lower difficulty where honest).`,
			);
		}
		return { approved: true, cast };
	}

	#rejected(planNumber: number, fingerprint: string, approval: Extract<CrewApproval, { approved: false }>): ToolError {
		const note = approval.note.trim();
		this.#lastRejection = { planNumber, fingerprint, note };
		for (const edit of approval.edits ?? []) this.#boardPicks.set(edit.itemId, edit.selector);
		const lines = [`Gaurav rejected plan #${planNumber} on the Casting Board; nothing was spawned.`];
		lines.push(note ? `Gaurav rejected: ${note}` : "No note given.");
		if (approval.edits?.length) {
			lines.push(
				`His row edits (kept for the same item ids in your next plan): ${approval.edits.map(e => `${e.itemId} → ${e.selector}`).join(", ")}.`,
			);
		}
		if (approval.dropped?.length) lines.push(`He dropped: ${approval.dropped.join(", ")}.`);
		lines.push(
			"Change something real before resubmitting — models (`model` per item), items, or the policy (crew_policy when the note states a preference such as open-weight or a provider). An identical plan is refused.",
		);
		return new ToolError(lines.join("\n"));
	}

	#castLines(entries: CrewItemSnapshot[]): string[] {
		return entries.map(entry => {
			const a = entry.assignment;
			const deps = entry.item.dependsOn.length > 0 ? ` · after ${entry.item.dependsOn.join(", ")}` : "";
			return `- ${entry.item.id} → ${entry.name} on ${a.selector} (tier ${a.tier}, est ${usd(a.estCostUsd, a.planIncluded)}; ${a.reason})${deps}`;
		});
	}

	#estimateLine(cast: CastResult): string {
		return cast.baselinePlan
			? `Estimate ${usd(cast.totalEstUsd)}; the conductor is plan-priced, so there is no dollar baseline.`
			: `Estimate ${usd(cast.totalEstUsd)} vs ${usd(cast.baselineEstUsd)} conductor-only.`;
	}

	async add(items: WorkItem[], toolCallId: string, signal?: AbortSignal): Promise<AgentToolResult<CrewToolDetails>> {
		const context = this.#context;
		const run = context?.run;
		if (!context || !run || run.finished) return this.plan(items, toolCallId, signal);

		const snapshot = run.snapshot();
		const existing = new Map(snapshot.map(entry => [entry.item.id, entry]));
		const clash = items.filter(item => existing.has(item.id)).map(item => item.id);
		if (clash.length > 0) {
			throw new ToolError(
				`Item id(s) already in this run: ${clash.join(", ")}. Use new ids (e.g. W-0${snapshot.length + 1}).`,
			);
		}
		// Settled items stay as read-only anchors: new items may depend on them but never clash with their scopes.
		const anchors: WorkItem[] = snapshot.map(entry =>
			TERMINAL.has(entry.state) ? { ...entry.item, scope: [], dependsOn: [] } : entry.item,
		);
		const errors = validateCrewPlan([...anchors, ...items]).filter(e => e.itemIds.some(id => !existing.has(id)));
		if (errors.length > 0) {
			throw new ToolError(
				["Nothing was added. Fix these and call crew_add again:", ...errors.map(e => `- ${e.message}`)].join("\n"),
			);
		}

		const roster = await this.#rosterNow();
		const conductor = context.conductor;
		const maxRunUsd = this.#host.maxRunUsd();
		const policy = this.#runPolicy();
		const cast = this.#cast(items, roster, conductor, policy, maxRunUsd);
		const names = castNames(
			items,
			snapshot.map(entry => entry.name),
		);
		const planNumber = context.planNumber;
		const request: CrewApprovalRequest = {
			planNumber,
			items,
			cast,
			names,
			roster,
			conductor,
			maxRunUsd,
			policy,
			recast: next => castCrew(items, roster, conductor, { maxRunUsd, policy: next }),
			notices: this.#unhealthyNotes(),
			addingTo: run.runId,
		};
		const approval = await this.#decide(request, signal);
		if (!approval.approved) {
			const note = approval.note.trim();
			throw new ToolError(
				[
					`Gaurav rejected the additions to ${run.runId}; nothing was added. The running items continue.`,
					note ? `Gaurav rejected: ${note}` : "No note given.",
					...(approval.edits?.length
						? [`His row edits: ${approval.edits.map(e => `${e.itemId} → ${e.selector}`).join(", ")}.`]
						: []),
				].join("\n"),
			);
		}
		if (approval.autoApprove) this.#host.setAutoApprove?.(true);
		const { kept, dropped } = keptItems(items, approval.cast, new Set(existing.keys()));
		if (kept.length === 0) throw new ToolError("Every new item was dropped on the Casting Board; nothing was added.");
		try {
			run.addItems(kept, approval.cast.assignments, names, roster);
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		context.items = [...context.items, ...kept];
		context.cast = {
			assignments: [...context.cast.assignments, ...approval.cast.assignments],
			totalEstUsd: context.cast.totalEstUsd + approval.cast.totalEstUsd,
			baselineEstUsd: context.cast.baselineEstUsd + approval.cast.baselineEstUsd,
			baselinePlan: context.cast.baselinePlan,
			overBudget: context.cast.overBudget || approval.cast.overBudget,
		};
		this.#host.onChange?.();

		const added = new Set(kept.map(item => item.id));
		const lines = [`Added ${kept.length} item(s) to ${run.runId}:`];
		lines.push(...this.#castLines(run.snapshot().filter(entry => added.has(entry.item.id))));
		lines.push(this.#estimateLine(approval.cast));
		if (dropped.length > 0) lines.push(`Dropped on the board: ${dropped.join(", ")}.`);
		return text(lines.join("\n"), {
			op: "add",
			runId: run.runId,
			planNumber,
			totalEstUsd: context.cast.totalEstUsd,
			baselineEstUsd: context.cast.baselineEstUsd,
		});
	}

	async reassign(
		itemId: string,
		selector: string,
		note: string | undefined,
	): Promise<AgentToolResult<CrewToolDetails>> {
		const run = this.#requireRun();
		const entry = this.#requireItem(run, itemId);
		const roster = this.#roster.length > 0 ? this.#roster : await this.#rosterNow();
		const target = roster.find(candidate => candidate.selector === selector);
		if (!target) {
			throw new ToolError(`"${selector}" is not a connected model. Call crew_models for the exact selectors.`);
		}
		const policy = this.#runPolicy();
		const sick = this.#unhealthy.get(selector);
		if (sick) throw new ToolError(`${selector} failed to start earlier this session (${sick}). Pick another model.`);
		const violation = policyViolation(target, policy);
		if (violation) throw new ToolError(`${selector} breaks the crew policy: ${violation}. Pick another model.`);
		const next: Assignment = {
			itemId,
			selector,
			tier: target.tier,
			estCostUsd: entryCost(target, entry.item.size),
			planIncluded: target.planIncluded,
			reason: `reassigned by the conductor${note?.trim() ? `: ${note.trim()}` : ""}`,
		};
		let outcome: "swapped" | "restarted";
		try {
			outcome = await run.reassign(itemId, next, note ?? "");
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		return text(
			outcome === "swapped"
				? `${itemId} (${entry.name}) will start on ${selector} (tier ${target.tier}, est ${usd(next.estCostUsd, next.planIncluded)}).`
				: `${itemId} (${entry.name}) restarted on ${selector} (tier ${target.tier}, est ${usd(next.estCostUsd, next.planIncluded)}) with your note and the previous report.`,
			{ op: "reassign" },
		);
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
		if (!run) {
			return text(`No crew run yet. Crew policy: ${describePolicy(this.policy())}. Submit a plan with crew_plan.`, {
				op: "status",
			});
		}
		return text(this.#statusLines(run).join("\n"), { op: "status", planNumber: this.#context?.planNumber });
	}

	async escalate(itemId: string, note: string): Promise<AgentToolResult<CrewToolDetails>> {
		const run = this.#requireRun();
		const entry = this.#requireItem(run, itemId);
		const conductor = this.#context?.conductor ?? this.#host.conductor();
		const roster = this.#roster;
		const policy = this.#runPolicy();
		let next: Assignment;
		try {
			next = await run.escalate(itemId, note, (exclude: string[], minTier: Tier) => {
				const cast = castCrew([{ ...entry.item, model: undefined }], roster, conductor, {
					exclude: { [itemId]: exclude },
					minTier: { [itemId]: minTier },
					policy,
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
			const recast = e.assignment.reason.startsWith("auto re-cast") ? ` · ${e.assignment.reason}` : "";
			return `- ${e.item.id} ${e.name} · ${e.assignment.selector} · ${e.state}${time}${waits} · ${usd(e.costUsd)}${recast}`;
		});
		const cast = this.#context?.cast;
		const spent = snap.reduce((sum, e) => sum + e.costUsd, 0);
		const baseline = cast?.baselinePlan
			? "conductor on a plan"
			: `conductor-only est ${usd(cast?.baselineEstUsd ?? 0)}`;
		lines.push(`Spent ${usd(spent)} of est ${usd(cast?.totalEstUsd ?? 0)} (${baseline}).`);
		lines.push(`Crew policy: ${describePolicy(this.#runPolicy())}.`);
		for (const note of this.#unhealthyNotes()) lines.push(`${note[0]!.toUpperCase()}${note.slice(1)}.`);
		if (!run.finished && run.settled)
			lines.push("Every item has settled; escalate failures, or finish your reply to close the run.");
		return lines;
	}
}

function text(body: string, details: CrewToolDetails): AgentToolResult<CrewToolDetails> {
	return { content: [{ type: "text", text: body }], details };
}

const SKILL_UNION =
	"'frontend' | 'backend' | 'tests' | 'docs' | 'infra' | 'refactor' | 'research' | 'review' | 'design'";
const skillSchema = type(SKILL_UNION);

const workItemSchema = type({
	id: type("string > 0").describe("item id, e.g. W-01"),
	title: type("string > 0").describe("a few words"),
	brief: type("string").describe(
		"self-contained brief: goal, files to read first, interfaces/contracts, acceptance criteria, quality bar, skills to load; the worker sees nothing else",
	),
	skills: skillSchema.array().describe("skills the item needs"),
	difficulty: type("1 | 2 | 3").describe("1 mechanical · 2 normal engineering · 3 frontier judgment"),
	size: type("'S' | 'M' | 'L'").describe("S ≈ a file or two · M · L"),
	"dependsOn?": type("string[]").describe("item ids that must finish first"),
	scope: type("string[]").describe("path prefixes the item may write; [] = read-only"),
	"model?": type("string > 0").describe("exact selector from crew_models; omit to auto-cast"),
	"reason?": type("string").describe("one line: why this model for this item"),
});

const crewPlanSchema = type({ items: workItemSchema.array().atLeastLength(1).describe("work items") });
const crewAddSchema = type({ items: workItemSchema.array().atLeastLength(1).describe("new work items") });
const crewModelsSchema = type({
	"filter?": type({
		"openWeight?": type("boolean").describe("only open-weight (true) or closed (false) models"),
		"provider?": type("string > 0").describe("provider id"),
		"minTier?": type("1 | 2 | 3").describe("tier at least"),
		"skills?": skillSchema.array().describe("strengths covering any of these"),
	}).describe("narrow the list"),
});
const crewPolicySchema = type({
	"openWeightOnly?": type("boolean").describe("only models with published weights"),
	"providers?": type("string[]").describe("only these providers"),
	"excludeProviders?": type("string[]").describe("never these providers"),
	"maxTier?": type("1 | 2 | 3").describe("never cast above this tier"),
	"preferQuality?": type("boolean").describe("cast one tier above each item's floor when possible"),
	"clear?": type("boolean").describe("reset to no policy before applying the other fields"),
});
const crewReassignSchema = type({
	item: type("string > 0").describe("item id"),
	model: type("string > 0").describe("exact selector from crew_models"),
	"note?": type("string").describe("what the new worker should know"),
});
const crewSendSchema = type({
	item: type("string > 0").describe("item id"),
	message: type("string > 0").describe("instructions for the worker, or the answer to its question"),
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

function toItems(params: { items: Array<typeof workItemSchema.infer> }): WorkItem[] {
	return params.items.map(item => ({ ...item, dependsOn: item.dependsOn ?? [] }));
}

class CrewModelsTool extends CrewTool implements AgentTool<typeof crewModelsSchema, CrewToolDetails> {
	readonly name = "crew_models";
	readonly approval = "read" as const;
	readonly label = "Crew Models";
	readonly summary = "List connected models with tier, price, strengths and open weights";
	readonly description = prompt.render(crewModelsDescription);
	readonly parameters = crewModelsSchema;
	execute(_id: string, params: typeof crewModelsSchema.infer) {
		return this.crew.models(params.filter);
	}
}

class CrewPolicyTool extends CrewTool implements AgentTool<typeof crewPolicySchema, CrewToolDetails> {
	readonly name = "crew_policy";
	readonly approval = "read" as const;
	readonly label = "Crew Policy";
	readonly summary = "Record Gaurav's casting rules for the session";
	readonly description = prompt.render(crewPolicyDescription);
	readonly parameters = crewPolicySchema;
	execute(_id: string, params: typeof crewPolicySchema.infer) {
		return this.crew.setPolicy(params);
	}
}

class CrewPlanTool extends CrewTool implements AgentTool<typeof crewPlanSchema, CrewToolDetails> {
	readonly name = "crew_plan";
	readonly approval = "exec" as const;
	readonly label = "Crew Plan";
	readonly summary = "Validate, cast and approve a crew plan, then start it";
	readonly description = prompt.render(crewPlanDescription);
	readonly parameters = crewPlanSchema;
	execute(toolCallId: string, params: typeof crewPlanSchema.infer, signal?: AbortSignal) {
		return this.crew.plan(toItems(params), toolCallId, signal);
	}
}

class CrewAddTool extends CrewTool implements AgentTool<typeof crewAddSchema, CrewToolDetails> {
	readonly name = "crew_add";
	readonly approval = "exec" as const;
	readonly label = "Crew Add";
	readonly summary = "Add items (workers) to the running crew";
	readonly description = prompt.render(crewAddDescription);
	readonly parameters = crewAddSchema;
	execute(toolCallId: string, params: typeof crewAddSchema.infer, signal?: AbortSignal) {
		return this.crew.add(toItems(params), toolCallId, signal);
	}
}

class CrewReassignTool extends CrewTool implements AgentTool<typeof crewReassignSchema, CrewToolDetails> {
	readonly name = "crew_reassign";
	readonly approval = "exec" as const;
	readonly label = "Crew Reassign";
	readonly summary = "Move an item to another model";
	readonly description = prompt.render(crewReassignDescription);
	readonly parameters = crewReassignSchema;
	execute(_id: string, params: typeof crewReassignSchema.infer) {
		return this.crew.reassign(params.item, params.model, params.note);
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
		new CrewModelsTool(crew),
		new CrewPolicyTool(crew),
		new CrewPlanTool(crew),
		new CrewAddTool(crew),
		new CrewReassignTool(crew),
		new CrewSendTool(crew),
		new CrewWaitTool(crew),
		new CrewStatusTool(crew),
		new CrewEscalateTool(crew),
		new CrewKillTool(crew),
	] as unknown as AgentTool[];
}
