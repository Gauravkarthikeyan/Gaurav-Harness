/**
 * Orchestra mode (spec §5.4): the session becomes the read-only conductor. Entry narrows the toolset to
 * `read`, optional `todo` and the crew tools, injects `prompts/gk/conductor.md` on every prompt, switches
 * to the `conductor` role model when one is configured, and hands the Stage the crew adapter. Plans go
 * through the Casting Board; finished runs append a payslip to the transcript (the ledger entry is
 * written by the run itself). Exit cancels the run, kills its workers and restores the previous toolset
 * and model. Mirrors Vibe's entry/exit in interactive mode.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { Component, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { CrewRunSummary } from "./crew-runtime";
import { CrewLedger } from "./ledger";
import { type CrewApproval, type CrewApprovalRequest, CrewController, createCrewTools } from "./crew-tools";
import { OrchestraStage } from "./orchestra/stage-adapter";
import { availableRosterModels, buildRoster, getRosterPath, loadRosterOverrides } from "./roster";
import { cfgGkOrchestraAutoApprove, cfgGkOrchestraMaxRunUsd } from "./settings";
import { AgentRegistry } from "../registry/agent-registry";
import type { StageHost } from "./stage/host";
import { modelLabel } from "./stage/host";
import { themeStyle } from "./stage/style";
import type { CrewPolicy, RosterEntry } from "./types";
import { CastingBoard } from "./ui/casting-board";
import { PayslipComponent } from "./ui/payslip";

export interface OrchestraModeHost {
	readonly session: AgentSession;
	readonly settings: Settings;
	readonly ui: TUI;
	stage(): StageHost | undefined;
	focusEditor(): void;
	showStatus(message: string): void;
	showWarning(message: string): void;
	/** Append a block to the transcript (payslip). */
	addTranscriptBlock(component: Component): void;
	/** gk: verify and play the finale for a finished run (spec §5.9); the payslip lands once it closes. */
	finale?(summary: CrewRunSummary): Promise<unknown>;
	/** Open the worker scope crew sessions spawn into; the returned teardown kills them and reports how many. */
	openWorkerScope(): () => Promise<number>;
	/** Session crew policy; outlives Orchestra mode so `/crew policy` and re-entry keep it. */
	crewPolicy(): CrewPolicy;
	setCrewPolicy(policy: CrewPolicy): void;
}

function selectorOf(model: Pick<Model, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

const CONDUCTOR_LIMIT_RE =
	/usage[_ ]limit|quota|rate[_ ]limit|too many requests|\b429\b|\b402\b|insufficient[_ ]?(?:credit|balance|funds|quota)|billing|upgrade_required|api access/i;

/**
 * The warning to show when the conductor's own model fails on a quota, rate or plan limit, or
 * `undefined` for any other error: Orchestra cannot plan until the conductor is switched.
 */
export function conductorLimitHint(error: string | undefined, conductor: string): string | undefined {
	if (!error || !CONDUCTOR_LIMIT_RE.test(error)) return undefined;
	const detail = error
		.replace(/^Retry failed after \d+ attempts?: /, "")
		.split("\n")[0]!
		.slice(0, 160);
	return `Conductor ${conductor} hit a usage/quota limit (${detail}). Switch the conductor: /models → set the conductor role to another connected model, then send your request again.`;
}

function lastUserText(session: AgentSession): string {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "user") continue;
		const content = message.content;
		const text =
			typeof content === "string" ? content : content.map(part => (part.type === "text" ? part.text : "")).join(" ");
		return text.trim().split("\n")[0]!.slice(0, 200);
	}
	return "";
}

export class OrchestraMode {
	readonly crew: CrewController;
	readonly stage: OrchestraStage | undefined;
	readonly #host: OrchestraModeHost;
	readonly #previousTools: string[];
	readonly #previousModel: Model | undefined;
	readonly #killWorkers: () => Promise<number>;
	readonly #unsubscribe: () => void;
	readonly #startCost: number;
	#board: { board: CastingBoard; handle: OverlayHandle } | undefined;

	private constructor(host: OrchestraModeHost, previousTools: string[], previousModel: Model | undefined) {
		this.#host = host;
		this.#previousTools = previousTools;
		this.#previousModel = previousModel;
		this.#startCost = host.session.getSessionStats().cost;
		this.#killWorkers = host.openWorkerScope();
		const { session, settings } = host;
		const ledger = new CrewLedger(path.join(getAgentDir(), "crew-ledger.jsonl"));
		this.crew = new CrewController({
			roster: () => this.#roster(),
			conductor: () => this.#conductorEntry(),
			maxRunUsd: () => {
				const max = cfgGkOrchestraMaxRunUsd.get(settings);
				return max > 0 ? max : undefined;
			},
			autoApprove: () => cfgGkOrchestraAutoApprove.get(settings),
			setAutoApprove: on => cfgGkOrchestraAutoApprove.set(settings, on),
			policy: () => host.crewPolicy(),
			setPolicy: policy => {
				host.setCrewPolicy(policy);
				host.ui.requestRender();
			},
			approve: (request, signal) => this.#approve(request, signal),
			spawner: () => {
				const spawner = session.createCrewSpawner();
				if (!spawner) throw new Error("Crew workers are unavailable in this session.");
				return spawner;
			},
			ledger: () => ledger,
			promptHead: () => lastUserText(session),
			onRunStart: context => {
				this.stage?.attach(context);
				void context.run.done.then(async summary => {
					await host.finale?.(summary).catch((error: unknown) => {
						logger.warn("Crew finale failed", { error: String(error) });
					});
					host.addTranscriptBlock(new PayslipComponent(summary, themeStyle));
					host.ui.requestRender();
				});
			},
			onChange: () => host.ui.requestRender(),
		});
		const stageHost = host.stage();
		this.stage = stageHost
			? new OrchestraStage(stageHost, {
					conductorLabel: () => modelLabel(session.model),
					conductorCostUsd: () => Math.max(0, session.getSessionStats().cost - this.#startCost),
					conductorStreaming: () => session.isStreaming,
					conductorSession: () => session,
					agentSession: id => AgentRegistry.global().get(id)?.session ?? undefined,
					maxRunUsd: () => {
						const max = cfgGkOrchestraMaxRunUsd.get(settings);
						return max > 0 ? max : undefined;
					},
				})
			: undefined;
		// The conductor going idle with every item settled closes the run (payslip + ledger). A conductor
		// turn that dies on a quota/limit says how to switch the conductor instead of a bare provider error.
		let lastHint = "";
		this.#unsubscribe = session.subscribe(event => {
			let error: string | undefined;
			if (event.type === "auto_retry_end" && !event.success) error = event.finalError;
			else if (event.type === "agent_end") {
				void this.crew.finishIfSettled();
				const last = event.messages.at(-1);
				if (last?.role === "assistant" && last.stopReason === "error") error = last.errorMessage;
			}
			const hint = conductorLimitHint(error, session.model ? selectorOf(session.model) : "model");
			if (hint && hint !== lastHint) {
				lastHint = hint;
				host.showWarning(hint);
			}
		});
	}

	/** Enter Orchestra mode on `host.session`. */
	static async enter(host: OrchestraModeHost): Promise<OrchestraMode> {
		const { session, settings } = host;
		const previousTools = session.getEnabledToolNames();
		let previousModel: Model | undefined;
		if (settings.getModelRoles().conductor) {
			const conductor = session.resolveRoleModel("conductor");
			if (conductor && session.model && selectorOf(conductor) !== selectorOf(session.model)) {
				previousModel = session.model;
				await session.setModelTemporary(conductor);
			}
		}
		const mode = new OrchestraMode(host, previousTools, previousModel);
		const base = ["read"];
		if (session.hasBuiltInTool("todo")) base.push("todo");
		try {
			await session.activateCrewTools(createCrewTools(mode.crew), base);
		} catch (error) {
			await mode.#teardown();
			throw error;
		}
		session.setOrchestraModeEnabled(true);
		host.stage()?.setOrchestra(mode.stage ?? null);
		return mode;
	}

	/** Leave Orchestra mode: cancel the run, kill workers, restore tools and model. Returns workers killed. */
	async exit(): Promise<number> {
		this.#board?.board.cancel("Orchestra mode was turned off.");
		await this.crew.cancelAll();
		const killed = await this.#teardown();
		await this.#host.session.deactivateCrewTools(this.#previousTools);
		this.#host.session.setOrchestraModeEnabled(false);
		if (this.#previousModel) await this.#host.session.setModelTemporary(this.#previousModel);
		return killed;
	}

	async #teardown(): Promise<number> {
		this.#unsubscribe();
		this.#host.stage()?.setOrchestra(null);
		this.stage?.detach();
		try {
			return await this.#killWorkers();
		} catch (error) {
			logger.warn("gk orchestra: failed to kill workers", { error: String(error) });
			return 0;
		}
	}

	/** Every connected model (disabled roster entries included: the router skips them, the picker shows them). */
	async #roster(): Promise<RosterEntry[]> {
		const overrides = await loadRosterOverrides(getRosterPath());
		const perf = this.#host.settings.getStorage()?.getModelPerf() ?? new Map();
		this.#rosterCache = buildRoster(availableRosterModels(this.#host.session.modelRegistry, perf), overrides);
		return this.#rosterCache;
	}

	#rosterCache: RosterEntry[] = [];

	/** The conductor priced from the catalog (its roster entry when connected), for baselines and fallback. */
	#conductorEntry(): RosterEntry {
		const model = this.#host.session.model;
		if (!model) throw new Error("No conductor model; run /login or set the conductor role.");
		const selector = selectorOf(model);
		const listed = this.#rosterCache.find(entry => entry.selector === selector);
		if (listed) return listed;
		return buildRoster(
			[
				{
					selector,
					provider: model.provider,
					id: model.id,
					cost: { input: model.cost.input, output: model.cost.output },
					contextWindow: model.contextWindow ?? undefined,
				},
			],
			[],
		)[0]!;
	}

	/** Casting Board as a centered modal over the Stage; resolves when Gaurav decides. */
	#approve(request: CrewApprovalRequest, signal?: AbortSignal): Promise<CrewApproval> {
		const { ui } = this.#host;
		const board = new CastingBoard(request, { style: themeStyle, onChange: () => ui.requestRender() });
		const width = Math.max(40, Math.min(ui.terminal.columns - 8, 132));
		const handle = ui.showOverlay(board, { anchor: "center", width, maxHeight: "90%" });
		ui.setFocus(board);
		ui.requestRender();
		this.#board = { board, handle };
		const onAbort = () => board.cancel("The crew_plan call was interrupted.");
		signal?.addEventListener("abort", onAbort, { once: true });
		return board.result.finally(() => {
			signal?.removeEventListener("abort", onAbort);
			handle.hide();
			if (this.#board?.board === board) this.#board = undefined;
			this.#host.focusEditor();
			ui.requestRender();
		});
	}
}

/** Enter Orchestra mode (mutual exclusion with plan/goal/vibe is the caller's check). */
export function enterOrchestraMode(host: OrchestraModeHost): Promise<OrchestraMode> {
	return OrchestraMode.enter(host);
}

export function exitOrchestraMode(mode: OrchestraMode): Promise<number> {
	return mode.exit();
}
