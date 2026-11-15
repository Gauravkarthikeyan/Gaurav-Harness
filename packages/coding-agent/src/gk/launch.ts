/**
 * GK launch flow (spec §5.2): splash with live startup checks, then the mode picker when the launch mode is
 * `ask`. Checks read the real sources (model registry, roster overrides, loaded skills, MCP manager, computer
 * setting) and run in parallel with the animation.
 */
import * as path from "node:path";
import { runLaunchScreens, type SplashCheckResult, type SplashCheckTask } from "@oh-my-pi/pi-tui/gk/launch-screens";
import type { PickerFact } from "@oh-my-pi/pi-tui/gk/mode-picker";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { SetupUiHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { cfgModelRoles } from "../config/model-settings";
import type { Settings } from "../config/settings";
import type { MCPManager } from "../mcp/manager";
import { cfgMotionResolved } from "../modes/settings";
import { cfgComputerEnabled } from "../tools/settings";
import { GK_VERSION } from "./brand";
import type { LaunchMode, LaunchModeResolution } from "./launch-mode";
import { availableRosterModels, buildRoster, loadRosterOverrides } from "./roster";
import { cfgGkLastLaunchMode, cfgGkOrchestraAutoApprove, cfgGkOrchestraMaxRunUsd } from "./settings";
import type { RosterEntry } from "./types";

/** `$2.00 / run · board approves` for the Orchestra card. */
function budgetFact(settings: Settings): string {
	const max = cfgGkOrchestraMaxRunUsd.get(settings);
	const approval = cfgGkOrchestraAutoApprove.get(settings) ? "auto-approve" : "board approves";
	return `${max > 0 ? `$${max.toFixed(2)} / run` : "no budget"} · ${approval}`;
}

export interface GkLaunchSources {
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	/** `provider/id` of the session's default model, if any. */
	readonly defaultModel: string | undefined;
	readonly skillCount: number;
	readonly mcpManager: MCPManager | undefined;
}

export interface GkLaunchOptions {
	readonly resolution: LaunchModeResolution;
	/** Play the splash (interactive TTY, fresh session, `startup.showSplash`, not quiet). */
	readonly splash: boolean;
}

export type GkLaunchOutcome = { readonly kind: "mode"; readonly mode: LaunchMode } | { readonly kind: "quit" };

const COMPUTER_PLATFORMS: Record<string, true> = { darwin: true, linux: true, win32: true };

/** `a · b · c +2` */
function nameList(names: readonly string[], max: number): string {
	const shown = names.slice(0, max).join(" · ");
	return names.length > max ? `${shown} +${names.length - max}` : shown;
}

function tierSummary(entries: readonly RosterEntry[]): string {
	const counts = [1, 2, 3].map(tier => entries.filter(entry => entry.tier === tier).length);
	return counts.flatMap((count, index) => (count > 0 ? [`t${index + 1} ×${count}`] : [])).join(" · ");
}

/** Resolves when `promise` settles or `signal` aborts, whichever is first. */
function untilAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const { promise: aborted, resolve } = Promise.withResolvers<void>();
	signal.addEventListener("abort", () => resolve(), { once: true });
	return Promise.race([promise.then(() => undefined), aborted]);
}

/** Live startup checks plus the facts they produce for the mode picker. */
class StartupChecks {
	#roster: RosterEntry[] = [];
	#mcp: { connected: number; total: number } | undefined;
	#refresh: Promise<void> | undefined;

	constructor(readonly sources: GkLaunchSources) {}

	/** One shared wait for the registry's initial model refresh (discovery/cache), cut short when the splash ends. */
	#awaitModels(signal: AbortSignal): Promise<void> {
		this.#refresh ??= untilAborted(this.sources.modelRegistry.awaitInitialBackgroundRefresh(signal), signal);
		return this.#refresh;
	}

	tasks(): SplashCheckTask[] {
		const { settings, modelRegistry, mcpManager, skillCount } = this.sources;
		return [
			{
				id: "providers",
				label: "providers",
				run: async (signal): Promise<SplashCheckResult> => {
					await this.#awaitModels(signal);
					const providers = [...new Set(modelRegistry.getAvailable().map(model => model.provider))];
					if (providers.length === 0) return { state: "warn", value: "none connected", detail: "run /login" };
					return { state: "ok", value: `${providers.length} connected`, detail: nameList(providers, 3) };
				},
			},
			{
				id: "roster",
				label: "roster",
				run: async (signal): Promise<SplashCheckResult> => {
					const rosterPath = path.join(getAgentDir(), "roster.yml");
					const [overrides] = await Promise.all([loadRosterOverrides(rosterPath), this.#awaitModels(signal)]);
					this.#roster = buildRoster(availableRosterModels(modelRegistry), overrides).filter(
						entry => entry.enabled,
					);
					if (this.#roster.length === 0)
						return { state: "warn", value: "0 models", detail: "no model with credentials" };
					return { state: "ok", value: `${this.#roster.length} models`, detail: tierSummary(this.#roster) };
				},
			},
			{
				id: "skills",
				label: "skills",
				run: async (): Promise<SplashCheckResult> =>
					skillCount > 0 ? { state: "ok", value: `${skillCount} discovered` } : { state: "off", value: "none" },
			},
			{
				id: "mcp",
				label: "mcp",
				run: async (signal): Promise<SplashCheckResult> => {
					const total = mcpManager?.getAllServerNames().length ?? 0;
					if (!mcpManager || total === 0) {
						this.#mcp = { connected: 0, total: 0 };
						return { state: "off", value: "none configured" };
					}
					await untilAborted(mcpManager.waitForPendingConnections(), signal);
					const connected = mcpManager.getConnectedServers();
					const missing = mcpManager.getAllServerNames().filter(name => !connected.includes(name));
					this.#mcp = { connected: connected.length, total: connected.length + missing.length };
					const value = `${this.#mcp.connected}/${this.#mcp.total} connected`;
					if (missing.length === 0) return { state: "ok", value, detail: nameList(connected, 3) };
					return { state: "warn", value, detail: `down: ${nameList(missing, 2)}` };
				},
			},
			{
				id: "computer",
				label: "computer use",
				run: async (): Promise<SplashCheckResult> => {
					if (!COMPUTER_PLATFORMS[process.platform]) {
						return { state: "off", value: "unsupported", detail: process.platform };
					}
					return cfgComputerEnabled.get(settings)
						? { state: "ok", value: "available", detail: "computer.enabled" }
						: { state: "off", value: "off", detail: "computer.enabled = false" };
				},
			},
		];
	}

	/** Picker facts from what the checks found; checks still running fall back to the registry as it stands. */
	facts(): { solo: PickerFact[]; orchestra: PickerFact[] } {
		const { settings, modelRegistry, defaultModel, skillCount, mcpManager } = this.sources;
		const roster =
			this.#roster.length > 0
				? this.#roster
				: buildRoster(availableRosterModels(modelRegistry), []).filter(entry => entry.enabled);
		const mcp = this.#mcp ?? {
			connected: mcpManager?.getConnectedServers().length ?? 0,
			total: mcpManager?.getAllServerNames().length ?? 0,
		};
		const conductor = cfgModelRoles.get(settings).conductor ?? defaultModel;
		const tiers = tierSummary(roster);
		return {
			solo: [
				{ key: "model", value: defaultModel ?? "none · run /login" },
				{ key: "tools", value: `${skillCount} skills · MCP ${mcp.connected}/${mcp.total}` },
				{ key: "cwd", value: shortenPath(getProjectDir()) },
			],
			orchestra: [
				{ key: "conductor", value: conductor ?? "none · run /login" },
				{ key: "roster", value: `${roster.length} models${tiers ? ` · ${tiers}` : ""}` },
				{ key: "budget", value: budgetFact(settings) },
			],
		};
	}
}

/**
 * Run the splash and/or the mode picker for this launch and return the mode to start in. A picker choice is
 * remembered in `gk.lastLaunchMode`.
 */
export async function runGkLaunch(
	host: SetupUiHost,
	sources: GkLaunchSources,
	options: GkLaunchOptions,
): Promise<GkLaunchOutcome> {
	const ask = options.resolution.kind === "ask";
	const preset = options.resolution.kind === "mode" ? options.resolution.mode : options.resolution.initial;
	if (!options.splash && !ask) return { kind: "mode", mode: preset };

	const checks = new StartupChecks(sources);
	// Only a stored choice earns the `last used` tag; the default merely preselects Solo.
	const last = cfgGkLastLaunchMode.isConfigured(sources.settings)
		? cfgGkLastLaunchMode.get(sources.settings)
		: undefined;
	const result = await runLaunchScreens(host, {
		version: GK_VERSION,
		motion: cfgMotionResolved.get(sources.settings).effects,
		splash: options.splash
			? { checks: checks.tasks(), host: `${process.platform} ${process.arch} · pid ${process.pid}` }
			: undefined,
		picker: ask ? { initial: preset, last, facts: () => checks.facts() } : undefined,
	});
	if (result.kind === "quit") return result;
	if (result.kind === "none") return { kind: "mode", mode: preset };
	if (result.choice !== last) cfgGkLastLaunchMode.set(sources.settings, result.choice);
	return { kind: "mode", mode: result.choice };
}
