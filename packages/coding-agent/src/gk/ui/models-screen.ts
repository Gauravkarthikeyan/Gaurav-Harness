/**
 * Models & providers screen: pure state, key reducer and renderer. The controller
 * (`models-screen-controller.ts`) feeds it registry/auth/roster data and runs its effects.
 *
 *   sidebar (scopes) │ role chips · filters · model table │ detail panel for the selected model
 */
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { estimateCostUsd } from "../roster";
import { fit, padEnd, padStart, spread } from "../stage/widgets/common";
import type { StageToken } from "../stage/widgets/common";
import { type RosterOverride, SKILLS, type Size, type Skill, type Tier } from "../types";

export type ModelsToken = StageToken | "selectedBg";
export type ModelsStyle = (token: ModelsToken, text: string) => string;

export type KindFilter = "chat" | "image" | "tts-stt";
export type ModelKindGroup = KindFilter | "other";
export type SortKey = "roster" | "price" | "name";

export const KIND_FILTERS: readonly KindFilter[] = ["chat", "image", "tts-stt"];
export const SORT_KEYS: readonly SortKey[] = ["roster", "price", "name"];
/** Role chips, in display order. `conductor` falls back to the default model when unset. */
export const SCREEN_ROLES = ["default", "conductor", "plan", "smol", "slow", "task"] as const;
const MAX_PARALLEL = 6;

export interface ScreenModel {
	selector: string;
	provider: string;
	id: string;
	contextWindow?: number;
	/** USD per 1M tokens. */
	cost: { input: number; output: number };
	kind: ModelKindGroup;
	connected: boolean;
	/** Measured output tokens/sec, when known. */
	tps?: number;
	tier: Tier;
	strengths: Skill[];
	inRoster: boolean;
	maxConcurrent: number;
	planIncluded: boolean;
	/** Roles this model currently fills. */
	roles: string[];
}

export interface ConnectedProvider {
	id: string;
	models: number;
	/** e.g. `API key`, `login`, `env`. */
	auth?: string;
}

export interface AttentionProvider {
	id: string;
	reason: "login expired" | "needs login";
}

export interface RoleChip {
	role: string;
	/** Selector of the model filling the role. */
	selector?: string;
}

export type Scope =
	| { kind: "all" }
	| { kind: "roster" }
	| { kind: "provider"; id: string }
	| { kind: "attention"; id: string }
	| { kind: "notSetUp" }
	| { kind: "add" };

export type ScreenMode = "browse" | "search" | "strengths" | "role";

export interface ModelsScreenState {
	models: ScreenModel[];
	connected: ConnectedProvider[];
	attention: AttentionProvider[];
	notSetUp: string[];
	roles: RoleChip[];
	scopeIndex: number;
	query: string;
	kind: KindFilter;
	connectedOnly: boolean;
	sort: SortKey;
	cursor: number;
	mode: ScreenMode;
	strengthCursor: number;
	roleCursor: number;
	status?: string;
}

export type ModelsEffect =
	| { kind: "close" }
	| { kind: "assignRole"; role: string; selector: string }
	| { kind: "saveRoster"; selector: string; patch: Omit<RosterOverride, "selector"> }
	/** Open the login flow, for one provider or the provider chooser. */
	| { kind: "login"; provider?: string };

export function initialModelsScreenState(
	data: Pick<ModelsScreenState, "models" | "connected" | "attention" | "notSetUp" | "roles">,
): ModelsScreenState {
	return {
		...data,
		scopeIndex: 0,
		query: "",
		kind: "chat",
		connectedOnly: true,
		sort: "roster",
		cursor: 0,
		mode: "browse",
		strengthCursor: 0,
		roleCursor: 0,
	};
}

// ─── Derived data ────────────────────────────────────────────────────────────

export function screenScopes(state: ModelsScreenState): Scope[] {
	return [
		{ kind: "all" },
		{ kind: "roster" },
		...state.connected.map(p => ({ kind: "provider" as const, id: p.id })),
		...state.attention.map(p => ({ kind: "attention" as const, id: p.id })),
		...(state.notSetUp.length > 0 ? [{ kind: "notSetUp" as const }] : []),
		{ kind: "add" },
	];
}

export function currentScope(state: ModelsScreenState): Scope {
	const scopes = screenScopes(state);
	return scopes[Math.min(state.scopeIndex, scopes.length - 1)]!;
}

function scopeShowsModels(scope: Scope): boolean {
	return scope.kind === "all" || scope.kind === "roster" || scope.kind === "provider";
}

export interface ModelSections {
	inRoster: ScreenModel[];
	notInRoster: ScreenModel[];
	notConnected: ScreenModel[];
}

function matchesQuery(model: ScreenModel, query: string): boolean {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return true;
	const hay = `${model.selector} ${model.strengths.join(" ")}`.toLowerCase();
	return tokens.every(token => hay.includes(token));
}

function compareModels(sort: SortKey): (a: ScreenModel, b: ScreenModel) => number {
	const byName = (a: ScreenModel, b: ScreenModel) => a.selector.localeCompare(b.selector);
	if (sort === "name") return byName;
	if (sort === "price") return (a, b) => a.cost.output - b.cost.output || a.cost.input - b.cost.input || byName(a, b);
	return (a, b) =>
		Number(b.roles.length > 0) - Number(a.roles.length > 0) || b.cost.output - a.cost.output || byName(a, b);
}

export function modelSections(state: ModelsScreenState): ModelSections {
	const scope = currentScope(state);
	const empty: ModelSections = { inRoster: [], notInRoster: [], notConnected: [] };
	if (!scopeShowsModels(scope)) return empty;
	const rows = state.models
		.filter(m => m.kind === state.kind)
		.filter(m => (scope.kind === "provider" ? m.provider === scope.id : true))
		.filter(m => (state.connectedOnly || scope.kind === "roster" ? m.connected : true))
		.filter(m => matchesQuery(m, state.query))
		.sort(compareModels(state.sort));
	for (const m of rows) {
		if (!m.connected) empty.notConnected.push(m);
		else if (m.inRoster) empty.inRoster.push(m);
		else if (scope.kind !== "roster") empty.notInRoster.push(m);
	}
	return empty;
}

export function visibleModels(state: ModelsScreenState): ScreenModel[] {
	const s = modelSections(state);
	return [...s.inRoster, ...s.notInRoster, ...s.notConnected];
}

export function selectedModel(state: ModelsScreenState): ScreenModel | undefined {
	const list = visibleModels(state);
	return list[Math.min(Math.max(0, state.cursor), list.length - 1)];
}

function conductorSelector(state: ModelsScreenState): string | undefined {
	return (
		state.roles.find(r => r.role === "conductor")?.selector ?? state.roles.find(r => r.role === "default")?.selector
	);
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

/**
 * Keys: `up` `down` `left` `right` `enter` `space` `esc` `tab` `shift+tab` `backspace`,
 * or one printable character.
 */
export function reduceModelsScreen(
	state: ModelsScreenState,
	key: string,
): { state: ModelsScreenState; effects: ModelsEffect[] } {
	const next: ModelsScreenState = { ...state, status: undefined };
	const done = (effects: ModelsEffect[] = []) => ({ state: next, effects });
	const count = visibleModels(state).length;

	if (state.mode === "search") {
		if (key === "enter" || key === "esc") next.mode = "browse";
		else if (key === "backspace") next.query = state.query.slice(0, -1);
		else if (key === "space") next.query = `${state.query} `;
		else if ([...key].length === 1) next.query = state.query + key;
		next.cursor = key === "enter" || key === "esc" ? state.cursor : 0;
		return done();
	}

	if (state.mode === "strengths") {
		const model = selectedModel(state);
		if (key === "left") next.strengthCursor = (state.strengthCursor + SKILLS.length - 1) % SKILLS.length;
		else if (key === "right") next.strengthCursor = (state.strengthCursor + 1) % SKILLS.length;
		else if (key === "space" && model) {
			const skill = SKILLS[state.strengthCursor]!;
			const strengths = model.strengths.includes(skill)
				? model.strengths.filter(s => s !== skill)
				: SKILLS.filter(s => s === skill || model.strengths.includes(s));
			next.models = replaceModel(state.models, model.selector, { strengths });
			return done([{ kind: "saveRoster", selector: model.selector, patch: { strengths } }]);
		} else if (key === "esc" || key === "enter" || key === "s") next.mode = "browse";
		return done();
	}

	if (state.mode === "role") {
		const model = selectedModel(state);
		if (key === "left") next.roleCursor = (state.roleCursor + SCREEN_ROLES.length - 1) % SCREEN_ROLES.length;
		else if (key === "right") next.roleCursor = (state.roleCursor + 1) % SCREEN_ROLES.length;
		else if (key === "esc") next.mode = "browse";
		else if (key === "enter") {
			next.mode = "browse";
			if (model)
				return done([{ kind: "assignRole", role: SCREEN_ROLES[state.roleCursor]!, selector: model.selector }]);
		}
		return done();
	}

	const scope = currentScope(state);
	const model = selectedModel(state);
	switch (key) {
		case "up":
			next.cursor = Math.max(0, Math.min(state.cursor, count - 1) - 1);
			return done();
		case "down":
			next.cursor = Math.max(0, Math.min(count - 1, state.cursor + 1));
			return done();
		case "tab":
		case "shift+tab": {
			const n = screenScopes(state).length;
			next.scopeIndex = (state.scopeIndex + (key === "tab" ? 1 : n - 1)) % n;
			next.cursor = 0;
			return done();
		}
		case "esc":
			return done([{ kind: "close" }]);
		case "/":
			next.mode = "search";
			return done();
		case "c":
			next.connectedOnly = !state.connectedOnly;
			next.cursor = 0;
			return done();
		case "k":
			next.kind = KIND_FILTERS[(KIND_FILTERS.indexOf(state.kind) + 1) % KIND_FILTERS.length]!;
			next.cursor = 0;
			return done();
		case "o":
			next.sort = SORT_KEYS[(SORT_KEYS.indexOf(state.sort) + 1) % SORT_KEYS.length]!;
			return done();
		case "a":
			return done([{ kind: "login" }]);
		case "l":
			if (scope.kind === "attention") return done([{ kind: "login", provider: scope.id }]);
			return done([{ kind: "login", provider: model?.provider }]);
		case "enter":
			if (scope.kind === "attention") return done([{ kind: "login", provider: scope.id }]);
			if (scope.kind === "notSetUp" || scope.kind === "add") return done([{ kind: "login" }]);
			if (model?.connected) {
				next.mode = "role";
				const held = SCREEN_ROLES.findIndex(role => model.roles.includes(role));
				next.roleCursor = held >= 0 ? held : 0;
			} else if (model) next.status = `${model.provider} is not connected · l to log in`;
			return done();
	}

	if (!model) return done();
	if (!model.connected && (key === "space" || key === "t" || key === "m" || key === "s")) {
		next.status = `${model.provider} is not connected · l to log in`;
		return done();
	}
	switch (key) {
		case "space": {
			const enabled = !model.inRoster;
			next.models = replaceModel(state.models, model.selector, { inRoster: enabled });
			// The row moves between sections; keep the cursor on it.
			const moved = visibleModels(next).findIndex(m => m.selector === model.selector);
			next.cursor = moved >= 0 ? moved : state.cursor;
			return done([{ kind: "saveRoster", selector: model.selector, patch: { enabled } }]);
		}
		case "t": {
			const tier = ((model.tier % 3) + 1) as Tier;
			next.models = replaceModel(state.models, model.selector, { tier });
			return done([{ kind: "saveRoster", selector: model.selector, patch: { tier } }]);
		}
		case "m": {
			const maxConcurrent = (model.maxConcurrent % MAX_PARALLEL) + 1;
			next.models = replaceModel(state.models, model.selector, { maxConcurrent });
			return done([{ kind: "saveRoster", selector: model.selector, patch: { maxConcurrent } }]);
		}
		case "s":
			next.mode = "strengths";
			next.strengthCursor = 0;
			return done();
	}
	return done();
}

function replaceModel(models: ScreenModel[], selector: string, patch: Partial<ScreenModel>): ScreenModel[] {
	return models.map(m => (m.selector === selector ? { ...m, ...patch } : m));
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatContext(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) return "—";
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toPrecision(2))}m`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

export function formatPrice(usdPerM: number): string {
	return `$${Number.isFinite(usdPerM) && usdPerM > 0 ? Number(usdPerM.toPrecision(3)) : 0}`;
}

function priceColumn(model: ScreenModel): string {
	if (!(model.cost.input > 0) && !(model.cost.output > 0)) return "free";
	return `${formatPrice(model.cost.input)} / ${formatPrice(model.cost.output)}`;
}

function formatUsd(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

function formatRatio(ratio: number): string {
	return ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1);
}

/** How the model's large-task cost compares to the conductor's: `24× cheaper`, `1.5× pricier`. */
export function conductorRatio(model: ScreenModel, conductor: ScreenModel | undefined): string {
	if (!conductor) return "—";
	if (conductor.selector === model.selector) return "is conductor";
	const mine = estimateCostUsd(model.cost, "L");
	const theirs = estimateCostUsd(conductor.cost, "L");
	if (!(mine > 0) || !(theirs > 0)) return "—";
	const ratio = theirs / mine;
	if (Math.abs(ratio - 1) < 0.05) return "same";
	return ratio > 1 ? `${formatRatio(ratio)}× cheaper` : `${formatRatio(1 / ratio)}× pricier`;
}

function shortModel(selector: string | undefined): string {
	if (!selector) return "—";
	const slash = selector.indexOf("/");
	return slash >= 0 ? selector.slice(slash + 1) : selector;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

interface Layout {
	sidebar: number;
	detail: number;
	table: number;
}

function layoutFor(width: number): Layout {
	const sidebar = width >= 150 ? 30 : width >= 100 ? 24 : 0;
	const detail = width >= 140 ? 44 : 0;
	const separators = (sidebar > 0 ? 1 : 0) + (detail > 0 ? 1 : 0);
	return { sidebar, detail, table: Math.max(0, width - sidebar - detail - separators) };
}

export function renderModelsScreen(
	state: ModelsScreenState,
	width: number,
	height: number,
	style: ModelsStyle,
): string[] {
	if (width <= 0 || height <= 0) return Array.from({ length: Math.max(0, height) }, () => "");
	const layout = layoutFor(width);
	const bodyH = Math.max(0, height - 4);
	const sidebar = layout.sidebar > 0 ? renderSidebar(state, layout.sidebar, bodyH, style) : [];
	const table = renderTable(state, layout.table, bodyH, style);
	const detail = layout.detail > 0 ? renderDetail(state, layout.detail, bodyH, style) : [];
	const sep = style("border", "│");

	const rows: string[] = [renderTopBar(state, width, style), style("border", "─".repeat(width))];
	for (let r = 0; r < bodyH; r++) {
		let row = "";
		if (layout.sidebar > 0) row += `${sidebar[r]}${sep}`;
		row += table[r];
		if (layout.detail > 0) row += `${sep}${detail[r]}`;
		rows.push(row);
	}
	rows.push(style("border", "─".repeat(width)), renderFooter(state, width, style));
	return rows.slice(0, height).map(row => fit(row, width));
}

function renderTopBar(state: ModelsScreenState, width: number, style: ModelsStyle): string {
	const models = state.connected.reduce((n, p) => n + p.models, 0);
	const left = ` ${style("accent", "●")} ${style("accent", "Models")}  ${style("muted", "& providers")}`;
	const right = `${style("success", "●")} ${style("text", `${state.connected.length} providers connected`)}${style("dim", " · ")}${style("text", `${models} models`)} `;
	return spread(left, right, width);
}

function sideRow(
	selected: boolean,
	glyph: string,
	label: string,
	right: string,
	width: number,
	style: ModelsStyle,
): string {
	const mark = selected ? style("accent", "▸") : " ";
	const text = selected ? style("accent", label) : style("text", label);
	const row = spread(` ${mark} ${glyph} ${text}`, right ? `${right} ` : "", width);
	return selected ? style("selectedBg", row) : row;
}

function renderSidebar(state: ModelsScreenState, width: number, height: number, style: ModelsStyle): string[] {
	const scope = currentScope(state);
	const is = (s: Scope) => s.kind === scope.kind && ("id" in s ? "id" in scope && s.id === scope.id : true);
	const rosterCount = state.models.filter(m => m.connected && m.inRoster).length;
	const connectedCount = state.connected.reduce((n, p) => n + p.models, 0);
	const heading = (text: string) => ` ${style("dim", text)}`;
	const rows: string[] = [
		"",
		sideRow(is({ kind: "all" }), " ", "All connected", style("muted", String(connectedCount)), width, style),
		sideRow(
			is({ kind: "roster" }),
			style("accent", "★"),
			"Roster",
			style("muted", String(rosterCount)),
			width,
			style,
		),
		"",
	];
	if (state.connected.length > 0) {
		rows.push(heading("CONNECTED"));
		for (const p of state.connected) {
			rows.push(
				sideRow(
					is({ kind: "provider", id: p.id }),
					style("success", "●"),
					p.id,
					style("muted", String(p.models)),
					width,
					style,
				),
			);
		}
		rows.push("");
	}
	if (state.attention.length > 0) {
		rows.push(heading("NEEDS ATTENTION"));
		for (const p of state.attention) {
			rows.push(sideRow(is({ kind: "attention", id: p.id }), style("warning", "!"), p.id, "", width, style));
			rows.push(
				`     ${style("warning", p.reason)}${style("dim", " · ")}${style("accent", "l")}${style("dim", " to fix")}`,
			);
		}
		rows.push("");
	}
	if (state.notSetUp.length > 0) {
		rows.push(heading("NOT SET UP"));
		rows.push(
			sideRow(
				is({ kind: "notSetUp" }),
				style("dim", "○"),
				`${state.notSetUp.length} providers`,
				style("accent", "Enter"),
				width,
				style,
			),
		);
	}
	rows.push(
		sideRow(is({ kind: "add" }), style("accent", "+"), "Add API key or login", style("accent", "a"), width, style),
	);
	return rows
		.slice(0, height)
		.map(r => fit(r, width))
		.concat(blankRows(height - rows.length, width));
}

function blankRows(count: number, width: number): string[] {
	return Array.from({ length: Math.max(0, count) }, () => " ".repeat(width));
}

interface Columns {
	model: number;
	context: number;
	price: number;
	small: number;
	speed: number;
	tier: number;
	goodAt: number;
}

function tableColumns(width: number): Columns {
	const context = 8;
	const price = 16;
	const small = 8;
	const tier = 5;
	const wide = width >= 90;
	const speed = wide ? 9 : 0;
	const goodAt = wide ? Math.min(26, Math.max(12, Math.floor(width * 0.22))) : 0;
	const model = Math.max(8, width - 3 - context - price - small - speed - tier - goodAt - (goodAt ? 2 : 0));
	return { model, context, price, small, speed, tier, goodAt };
}

function tableHeader(cols: Columns, style: ModelsStyle): string {
	let row = `   ${padEnd("MODEL", cols.model)}${padStart("CONTEXT", cols.context)}${padStart("$ IN / OUT 1M", cols.price)}${padStart("SMALL", cols.small)}`;
	if (cols.speed) row += padStart("SPEED", cols.speed);
	row += padStart("TIER", cols.tier);
	if (cols.goodAt) row += `  ${padEnd("GOOD AT", cols.goodAt)}`;
	return style("dim", row);
}

function modelRow(model: ScreenModel, selected: boolean, cols: Columns, width: number, style: ModelsStyle): string {
	const star = model.connected ? (model.inRoster ? style("accent", "★") : style("dim", "☆")) : style("dim", "·");
	const roleTags =
		model.roles.length > 0 ? ` ${model.roles[0]}${model.roles.length > 1 ? `+${model.roles.length - 1}` : ""}` : "";
	const nameW = Math.max(1, cols.model - visibleWidth(roleTags));
	const providerText = `${model.provider}/`;
	const name = fit(
		`${style("muted", providerText)}${style(selected ? "accent" : "text", model.id)}`,
		Math.min(nameW, visibleWidth(providerText) + visibleWidth(model.id)),
	);
	const nameCell = padEnd(`${name}${style("accent", roleTags)}`, cols.model);
	const small = estimateCostUsd(model.cost, "S");
	let row = ` ${star} ${nameCell}`;
	row += style("muted", padStart(formatContext(model.contextWindow), cols.context));
	row += style("text", padStart(priceColumn(model), cols.price));
	row += style(small > 0 ? "text" : "success", padStart(formatUsd(small), cols.small));
	if (cols.speed) row += style("muted", padStart(model.tps ? `${Math.round(model.tps)} t/s` : "—", cols.speed));
	row += style("text", padStart(`T${model.tier}`, cols.tier));
	if (cols.goodAt) {
		const good =
			model.strengths.length > 0 ? style("text", model.strengths.join(" ")) : style("dim", "not rated yet");
		row += `  ${fit(good, cols.goodAt)}`;
	}
	const line = fit(row, width);
	return selected ? style("selectedBg", line) : line;
}

function renderChips(state: ModelsScreenState, width: number, style: ModelsStyle): string {
	const chips = SCREEN_ROLES.map((role, i) => {
		const chip = state.roles.find(r => r.role === role);
		const active = state.mode === "role" && state.roleCursor === i;
		const label = `${role} ${shortModel(chip?.selector)}`;
		return active
			? style("accent", `▸${label}`)
			: `${style("dim", role)} ${style("text", shortModel(chip?.selector))}`;
	});
	return fit(` ${chips.join("   ")}`, width);
}

function renderFilters(state: ModelsScreenState, width: number, style: ModelsStyle): string {
	const searching = state.mode === "search";
	const search = state.query
		? `${style("text", state.query)}${searching ? style("accent", "█") : ""}`
		: searching
			? style("accent", "█")
			: style("dim", "search models (name, provider, skill)");
	const kinds = KIND_FILTERS.map(k => (k === state.kind ? style("accent", k) : style("dim", k))).join(" ");
	const connected = state.connectedOnly ? style("accent", "connected only ✓") : style("dim", "connected only ✗");
	const key = (k: string) => style("dim", ` ${k}`);
	const right = `${kinds}${key("k")}   ${connected}${key("c")}   ${style("dim", "sort")} ${style("text", state.sort)}${key("o")} `;
	return spread(` ${style(searching ? "accent" : "dim", "⌕")} ${search}`, right, width);
}

function renderTable(state: ModelsScreenState, width: number, height: number, style: ModelsStyle): string[] {
	if (width <= 0) return blankRows(height, 0);
	const top = [renderChips(state, width, style), renderFilters(state, width, style), ""];
	const scope = currentScope(state);
	let body: string[];
	if (scope.kind === "attention") {
		const p = state.attention.find(a => a.id === scope.id);
		body = [
			` ${style("warning", "!")} ${style("text", scope.id)}${style("dim", " · ")}${style("warning", p?.reason ?? "")}`,
			"",
			` ${style("accent", "Enter")}${style("muted", " or ")}${style("accent", "l")}${style("muted", " opens the login flow for this provider.")}`,
		];
	} else if (scope.kind === "notSetUp") {
		body = [
			` ${style("dim", "NOT SET UP")}  ${style("muted", String(state.notSetUp.length))}`,
			...state.notSetUp.map(id => `   ${style("dim", "○")} ${style("muted", id)}`),
			"",
			` ${style("accent", "Enter")}${style("muted", " opens the login flow.")}`,
		];
	} else if (scope.kind === "add") {
		body = [` ${style("accent", "Enter")}${style("muted", " adds an API key or starts a login.")}`];
	} else {
		body = tableBody(state, width, height - top.length, style);
	}
	return [...top, ...body]
		.slice(0, height)
		.map(r => fit(r, width))
		.concat(blankRows(height - top.length - body.length, width));
}

function tableBody(state: ModelsScreenState, width: number, height: number, style: ModelsStyle): string[] {
	const cols = tableColumns(width);
	const sections = modelSections(state);
	const cursor = Math.min(state.cursor, Math.max(0, visibleModels(state).length - 1));
	const lines: { text: string; modelIndex?: number }[] = [];
	let index = 0;
	const section = (title: string, hint: string, models: ScreenModel[]) => {
		if (models.length === 0) return;
		if (lines.length > 0) lines.push({ text: "" });
		lines.push({
			text: ` ${style("muted", title)}  ${style("dim", String(models.length))}${hint ? `${style("dim", " · ")}${style("dim", hint)}` : ""}`,
		});
		for (const m of models) {
			lines.push({ text: modelRow(m, index === cursor, cols, width, style), modelIndex: index });
			index++;
		}
	};
	section("★ IN ROSTER", "", sections.inRoster);
	section("CONNECTED, NOT IN ROSTER", "Space adds", sections.notInRoster);
	section("NOT CONNECTED", "l to log in", sections.notConnected);
	if (index === 0) {
		return [
			tableHeader(cols, style),
			"",
			` ${style("dim", state.query ? "No models match the search." : "No models in this view.")}`,
		];
	}

	const room = Math.max(1, height - 1);
	const cursorLine = lines.findIndex(l => l.modelIndex === cursor);
	let start = 0;
	if (lines.length > room) {
		start = Math.min(lines.length - room, Math.max(0, cursorLine - Math.floor(room / 2)));
	}
	const shown = lines.slice(start, start + room).map(l => l.text);
	const below = lines.slice(start + room).filter(l => l.modelIndex !== undefined).length;
	if (below > 0 && shown.length === room) {
		shown[room - 1] = ` ${style("dim", `+ ${below} more · ↑↓ to scroll · / to search`)}`;
	}
	return [tableHeader(cols, style), ...shown];
}

function detailRow(label: string, value: string, width: number, style: ModelsStyle): string {
	return spread(`  ${style("muted", label)}`, `${value}  `, width);
}

function renderDetail(state: ModelsScreenState, width: number, height: number, style: ModelsStyle): string[] {
	const model = scopeShowsModels(currentScope(state)) ? selectedModel(state) : undefined;
	if (!model) return blankRows(height, width);
	const conductorSel = conductorSelector(state);
	const conductor = state.models.find(m => m.selector === conductorSel);
	const provider = state.connected.find(p => p.id === model.provider);
	const heading = (text: string) => `  ${style("dim", text)}`;
	const sizeCost = (size: Size) => {
		const usd = estimateCostUsd(model.cost, size);
		return style(usd > 0 ? "text" : "success", formatUsd(usd));
	};
	const keyHint = (k: string) => `${style("dim", " · ")}${style("accent", k)}${style("dim", " change")}`;
	const rows: string[] = [
		"",
		`  ${style("accent", model.id)}`,
		`  ${style(model.connected ? "success" : "dim", "●")} ${style("muted", [model.provider, model.connected ? "connected" : "not connected", provider?.auth].filter(Boolean).join(" · "))}`,
		"",
		heading("COST"),
		detailRow(
			"per 1M tokens",
			`${style("text", formatPrice(model.cost.input))}${style("dim", " in · ")}${style("text", formatPrice(model.cost.output))}${style("dim", " out")}`,
			width,
			style,
		),
		detailRow("small task (S)", sizeCost("S"), width, style),
		detailRow("medium task (M)", sizeCost("M"), width, style),
		detailRow("large task (L)", sizeCost("L"), width, style),
		detailRow("vs conductor (L)", style("accent", conductorRatio(model, conductor)), width, style),
		"",
		heading("ORCHESTRA"),
		detailRow(
			"in roster",
			`${style(model.inRoster ? "success" : "muted", model.inRoster ? "yes" : "no")}${style("dim", " · ")}${style("accent", "Space")}`,
			width,
			style,
		),
		detailRow("tier", `${style("text", `T${model.tier}`)}${keyHint("t")}`, width, style),
		detailRow("parallel workers", `${style("text", String(model.maxConcurrent))}${keyHint("m")}`, width, style),
		"",
		`${heading("GOOD AT")}${style("dim", state.mode === "strengths" ? "  ←→ · Space toggles · Esc" : "  s toggles")}`,
		...skillChips(model, state, width, style),
		"",
		heading("USED FOR"),
		detailRow("role", style("text", model.roles.length > 0 ? model.roles.join(", ") : "—"), width, style),
		detailRow("context", style("text", formatContext(model.contextWindow)), width, style),
	];
	if (model.planIncluded) rows.push(detailRow("billing", style("muted", "plan / local"), width, style));
	const hint = `  ${style("accent", "Enter")}${style("muted", " use for a role  ")}${style("accent", "Space")}${style("muted", " roster")}`;
	const body = rows.slice(0, Math.max(0, height - 2));
	while (body.length < height - 1) body.push("");
	if (height >= 2) body.push(hint);
	return body.slice(0, height).map(r => fit(r, width));
}

function skillChips(model: ScreenModel, state: ModelsScreenState, width: number, style: ModelsStyle): string[] {
	const lines: string[] = [];
	let line = "  ";
	let lineW = 2;
	SKILLS.forEach((skill, i) => {
		const on = model.strengths.includes(skill);
		const focused = state.mode === "strengths" && state.strengthCursor === i;
		const label = focused ? `[${skill}]` : ` ${skill} `;
		const chip = style(on ? "accent" : "dim", label);
		const w = visibleWidth(label) + 1;
		if (lineW + w > width - 1 && lineW > 2) {
			lines.push(line);
			line = "  ";
			lineW = 2;
		}
		line += `${chip} `;
		lineW += w;
	});
	lines.push(line);
	return lines;
}

function renderFooter(state: ModelsScreenState, width: number, style: ModelsStyle): string {
	const hint = (k: string, label: string) => `${style("accent", k)} ${style("muted", label)}`;
	let hints: string[];
	if (state.mode === "search") hints = [hint("type", "to filter"), hint("⌫", "delete"), hint("Enter/Esc", "done")];
	else if (state.mode === "strengths") hints = [hint("←→", "skill"), hint("Space", "toggle"), hint("Esc", "done")];
	else if (state.mode === "role") hints = [hint("←→", "role"), hint("Enter", "assign"), hint("Esc", "cancel")];
	else {
		hints = [
			hint("↑↓", "move"),
			hint("Enter", "set role"),
			hint("Space", "roster on/off"),
			hint("t", "tier"),
			hint("s", "strengths"),
			hint("/", "search"),
			hint("Tab", "scope"),
			hint("l", "login"),
			hint("Esc", "close"),
		];
	}
	const right = state.status
		? style("warning", state.status)
		: style("dim", "tier by output $/1M: T1 < $2 · T2 < $12 · T3");
	return spread(` ${hints.join("  ")}`, `${right} `, width);
}
