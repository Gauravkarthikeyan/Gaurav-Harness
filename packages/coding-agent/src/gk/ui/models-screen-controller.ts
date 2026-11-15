/**
 * Fullscreen host for the Models & providers screen. Reads the same registry/auth state as the
 * model hub, writes roster changes to roster.yml and hands role assignment and login back to the
 * selector controller, which owns those code paths.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { type Component, extractPrintableText, matchesKey, type TUI } from "@oh-my-pi/pi-tui";
import { resolveRoleAssignments } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { ModelRegistry } from "../../config/model-registry";
import { cfgDisabledProviders } from "../../config/model-settings";
import type { Settings } from "../../config/settings";
import { createModelBrowserSource } from "../../modes/model-browser-source";
import { buildRoster, getRosterPath, loadRosterOverrides, patchRosterOverride, saveRosterOverrides } from "../roster";
import type { RosterOverride } from "../types";
import {
	type AttentionProvider,
	type ConnectedProvider,
	type ModelKindGroup,
	type ModelsEffect,
	type ModelsScreenState,
	type ModelsStyle,
	type ModelsToken,
	initialModelsScreenState,
	type RoleChip,
	reduceModelsScreen,
	renderModelsScreen,
	SCREEN_ROLES,
	type ScreenModel,
} from "./models-screen";

export interface ModelsScreenHost {
	registry: ModelRegistry;
	settings: Settings;
	/** The selector controller's role-assignment path; resolves false when nothing changed. */
	assignRole(model: Model, role: string, selector: string): Promise<boolean>;
	/** Close the screen and open the login flow (one provider, or the chooser). */
	login(provider?: string): void;
	close(): void;
	showError(message: string): void;
}

function kindGroup(model: Model): ModelKindGroup {
	const kind = modelKind(model);
	if (kind === "chat" || kind === "tiny") return "chat";
	if (kind === "image") return "image";
	if (kind === "tts" || kind === "stt") return "tts-stt";
	return "other";
}

function authLabel(kind: string | undefined): string | undefined {
	if (kind === "oauth") return "login";
	if (kind === "api_key") return "API key";
	return kind;
}

/** Snapshot registry, auth and roster state into screen data. */
export function loadModelsScreenData(
	registry: ModelRegistry,
	settings: Settings,
	overrides: RosterOverride[],
): Pick<ModelsScreenState, "models" | "connected" | "attention" | "notSetUp" | "roles"> {
	const all = registry.getAll("all");
	const available = registry.getAvailable("all");
	const availableKeys = new Set(available.map(m => `${m.provider}/${m.id}`));
	const disabled = new Set(cfgDisabledProviders.get(settings));

	const source = createModelBrowserSource(settings);
	const assignments = resolveRoleAssignments(source, all, available);
	const roleSelector = (role: string): string | undefined => {
		const model = assignments[role]?.model;
		if (model) return `${model.provider}/${model.id}`;
		const value = settings.getModelRole(role);
		const resolved = value ? source.resolveRoleValue(value, all).model : undefined;
		return resolved ? `${resolved.provider}/${resolved.id}` : undefined;
	};
	const roles: RoleChip[] = SCREEN_ROLES.map(role => ({
		role,
		selector: roleSelector(role) ?? (role === "conductor" ? roleSelector("default") : undefined),
	}));
	const rolesBySelector = new Map<string, string[]>();
	for (const chip of roles) {
		if (!chip.selector) continue;
		const list = rolesBySelector.get(chip.selector) ?? [];
		list.push(chip.role);
		rolesBySelector.set(chip.selector, list);
	}

	const perf: ReadonlyMap<string, { tps: number }> = settings.getStorage()?.getModelPerf() ?? new Map();
	const catalog = new Map<string, Model>();
	for (const model of [...available, ...all]) {
		const key = `${model.provider}/${model.id}`;
		if (!catalog.has(key)) catalog.set(key, model);
	}
	const entries = buildRoster(
		[...catalog.entries()].map(([selector, model]) => ({ selector, cost: model.cost })),
		overrides,
	);
	const models: ScreenModel[] = entries.map(entry => {
		const model = catalog.get(entry.selector)!;
		return {
			selector: entry.selector,
			provider: model.provider,
			id: model.id,
			contextWindow: model.contextWindow ?? undefined,
			cost: entry.cost,
			kind: kindGroup(model),
			connected: availableKeys.has(entry.selector),
			tps: perf.get(entry.selector)?.tps,
			tier: entry.tier,
			strengths: entry.strengths,
			inRoster: entry.enabled,
			maxConcurrent: entry.maxConcurrent,
			planIncluded: entry.planIncluded,
			roles: rolesBySelector.get(entry.selector) ?? [],
		};
	});

	const availableCounts = new Map<string, number>();
	for (const m of available) availableCounts.set(m.provider, (availableCounts.get(m.provider) ?? 0) + 1);
	const keys = registry.authStorage.keys;
	const connected: ConnectedProvider[] = [...availableCounts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, count]) => ({ id, models: count, auth: authLabel(keys.source(id)?.kind) }));

	// Same split as the model hub's locked providers: catalog providers without usable models.
	const lockedProviders = new Set<string>();
	for (const m of all) {
		if (!availableCounts.has(m.provider) && !disabled.has(m.provider)) lockedProviders.add(m.provider);
	}
	const attention: AttentionProvider[] = [];
	const notSetUp: string[] = [];
	for (const id of [...lockedProviders].sort((a, b) => a.localeCompare(b))) {
		if (keys.source(id) !== undefined) attention.push({ id, reason: "login expired" });
		else if (registry.getProviderDiscoveryState(id)?.status === "unauthenticated") {
			attention.push({ id, reason: "needs login" });
		} else notSetUp.push(id);
	}
	return { models, connected, attention, notSetUp, roles };
}

/** Map screen tokens onto the active theme. Agent hues are unused here and render as text. */
export const themeModelsStyle: ModelsStyle = (token: ModelsToken, text: string) => {
	switch (token) {
		case "selectedBg":
			return theme.bg("selectedBg", text);
		case "diffAddBg":
		case "diffDelBg":
			return text;
		case "accent":
		case "text":
		case "muted":
		case "dim":
		case "border":
		case "borderAccent":
		case "success":
		case "error":
		case "warning":
			return theme.fg(token, text);
		case "info":
			return theme.fg("accent", text);
		default:
			return theme.fg("text", text);
	}
};

const KEY_NAMES = ["up", "down", "left", "right", "enter", "space", "escape", "tab", "shift+tab", "backspace"] as const;

function keyName(data: string): string | undefined {
	for (const key of KEY_NAMES) {
		if (matchesKey(data, key)) return key === "escape" ? "esc" : key;
	}
	if (data === "\r" || data === "\n") return "enter";
	const printable = extractPrintableText(data);
	if (printable === " ") return "space";
	return printable && [...printable].length === 1 ? printable : undefined;
}

export class ModelsScreenComponent implements Component {
	#state: ModelsScreenState;
	#overrides: RosterOverride[];
	#saving: Promise<void> = Promise.resolve();
	readonly #rosterPath = getRosterPath();

	private constructor(
		private readonly tui: TUI,
		private readonly host: ModelsScreenHost,
		overrides: RosterOverride[],
	) {
		this.#overrides = overrides;
		this.#state = initialModelsScreenState(loadModelsScreenData(host.registry, host.settings, overrides));
	}

	static async create(tui: TUI, host: ModelsScreenHost): Promise<ModelsScreenComponent> {
		return new ModelsScreenComponent(tui, host, await loadRosterOverrides(getRosterPath()));
	}

	get state(): ModelsScreenState {
		return this.#state;
	}

	render(width: number): readonly string[] {
		const height = Math.max(12, this.tui.terminal?.rows || process.stdout.rows || 40);
		return renderModelsScreen(this.#state, width, height, themeModelsStyle);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const key = keyName(data);
		if (!key) return;
		const { state, effects } = reduceModelsScreen(this.#state, key);
		this.#state = state;
		for (const effect of effects) this.#run(effect);
		this.tui.requestRender();
	}

	#reload(): void {
		const { scopeIndex, query, kind, connectedOnly, sort, cursor, mode, strengthCursor, roleCursor } = this.#state;
		const data = loadModelsScreenData(this.host.registry, this.host.settings, this.#overrides);
		this.#state = {
			...this.#state,
			...data,
			scopeIndex,
			query,
			kind,
			connectedOnly,
			sort,
			cursor,
			mode,
			strengthCursor,
			roleCursor,
		};
		this.tui.requestRender();
	}

	#run(effect: ModelsEffect): void {
		switch (effect.kind) {
			case "close":
				this.host.close();
				return;
			case "login":
				this.host.login(effect.provider);
				return;
			case "saveRoster": {
				this.#overrides = patchRosterOverride(this.#overrides, effect.selector, effect.patch);
				const overrides = this.#overrides;
				// Serialize writes so the file always ends with the latest overrides.
				this.#saving = this.#saving
					.then(() => saveRosterOverrides(this.#rosterPath, overrides))
					.catch(error => {
						this.host.showError(error instanceof Error ? error.message : String(error));
					});
				return;
			}
			case "assignRole": {
				const [provider, ...rest] = effect.selector.split("/");
				const model = this.host.registry.find(provider ?? "", rest.join("/"));
				if (!model) {
					this.host.showError(`Unknown model: ${effect.selector}`);
					return;
				}
				void this.host
					.assignRole(model, effect.role, effect.selector)
					.then(changed => {
						if (changed) this.#reload();
					})
					.catch(error => this.host.showError(error instanceof Error ? error.message : String(error)));
				return;
			}
		}
	}
}
