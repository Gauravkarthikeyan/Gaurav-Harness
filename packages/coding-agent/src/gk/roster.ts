import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { isOpenWeightModelId } from "@oh-my-pi/pi-catalog/provider-models/open-weight";
import { type RosterEntry, type RosterOverride, SKILLS, type Size, type Skill, type Tier } from "./types";

/** Token estimates per work-item size (labelled "estimate" in the UI). */
export const SIZE_TOKENS: Record<Size, { input: number; output: number }> = {
	S: { input: 60_000, output: 8_000 },
	M: { input: 250_000, output: 30_000 },
	L: { input: 800_000, output: 80_000 },
};

const DEFAULT_MAX_CONCURRENT = 2;

/** Default tier from catalog output price (USD per 1M tokens). Zero price = subscription/local plan. */
export function defaultTier(outputPerMTok: number): { tier: Tier; planIncluded: boolean } {
	if (!(outputPerMTok > 0)) return { tier: 2, planIncluded: true };
	if (outputPerMTok < 2) return { tier: 1, planIncluded: false };
	if (outputPerMTok < 12) return { tier: 2, planIncluded: false };
	return { tier: 3, planIncluded: false };
}

/** Estimated USD for one work item of `size` on a model priced per 1M tokens. Never NaN. */
export function estimateCostUsd(cost: { input: number; output: number }, size: Size): number {
	const tokens = SIZE_TOKENS[size];
	const input = Number.isFinite(cost.input) && cost.input > 0 ? cost.input : 0;
	const output = Number.isFinite(cost.output) && cost.output > 0 ? cost.output : 0;
	return (tokens.input * input) / 1e6 + (tokens.output * output) / 1e6;
}

/**
 * Capability hints by model family, matched against the lowercased model id; first match wins.
 * `tier` is a floor on top of the price tier: open-weight flagships are priced like tier 1 but do
 * normal engineering well, and frontier models listed at $0 by a gateway are still frontier.
 * `strengths` seed the router's skill fit; roster.yml overrides replace them.
 */
export const MODEL_HINTS: ReadonlyArray<{ match: RegExp; tier?: Tier; strengths: Skill[] }> = [
	{
		match: /(?:^|[/_.:-])(?:opus|fable)(?:$|[\d/_.:-])/,
		tier: 3,
		strengths: ["design", "frontend", "review", "research"],
	},
	{ match: /(?:^|[/_.:-])sonnet(?:$|[\d/_.:-])/, tier: 2, strengths: ["frontend", "design", "backend", "refactor"] },
	{ match: /(?:^|[/_.:-])haiku(?:$|[\d/_.:-])/, strengths: ["docs", "tests", "refactor"] },
	{ match: /(?:^|[/_.:-])kimi-k\d(?!.*flash)/, tier: 2, strengths: ["frontend", "backend", "refactor"] },
	{ match: /(?:^|[/_.:-])glm-\d(?:\.\d+)?(?!.*flash)/, tier: 2, strengths: ["frontend", "design", "backend"] },
	{ match: /(?:^|[/_.:-])minimax-m\d(?:\.\d+)?(?!.*flash)/, tier: 2, strengths: ["backend", "frontend", "refactor"] },
	{
		match: /(?:^|[/_.:-])deepseek-(?:v\d(?:\.\d+)?-pro|r\d|v3)/,
		tier: 2,
		strengths: ["backend", "research", "review"],
	},
	{
		match: /(?:^|[/_.:-])(?:qwen\d(?:\.\d+)?-coder|devstral|codestral)/,
		tier: 2,
		strengths: ["backend", "refactor", "tests"],
	},
	{ match: /(?:^|[/_.:-])qwen\d(?:\.\d+)?-(?:\d{3}b|27b|32b)/, tier: 2, strengths: ["backend", "frontend", "tests"] },
	{
		match: /(?:^|[/_.:-])(?:gpt-oss-120b|nemotron-[\w.-]*ultra|mistral-large|llama-4-maverick)/,
		tier: 2,
		strengths: ["backend", "docs", "research"],
	},
	{ match: /(?:^|[/_.:-])(?:flash|mini|lite|small|nano)(?:$|[\d/_.:-])/, strengths: ["docs", "tests"] },
];

/** Catalog facts the roster needs about one available model. */
export interface RosterModel {
	selector: string;
	cost: { input: number; output: number };
	/** Defaults to the selector's first segment. */
	provider?: string;
	/** Defaults to the selector after the provider. */
	id?: string;
	contextWindow?: number;
	tps?: number;
}

/** Price tier raised by the first matching {@link MODEL_HINTS} entry, plus its strengths. */
export function hintedCapability(id: string, outputPerMTok: number): { tier: Tier; strengths: Skill[] } {
	const priced = defaultTier(outputPerMTok).tier;
	const hint = MODEL_HINTS.find(h => h.match.test(id.toLowerCase()));
	if (!hint) return { tier: priced, strengths: [] };
	return { tier: Math.max(priced, hint.tier ?? 1) as Tier, strengths: [...hint.strengths] };
}

/** Roster from available models, with overrides applied by selector. Overrides for unknown selectors are ignored. */
export function buildRoster(models: RosterModel[], overrides: RosterOverride[]): RosterEntry[] {
	const bySelector = new Map<string, RosterOverride[]>();
	for (const override of overrides) {
		const list = bySelector.get(override.selector);
		if (list) list.push(override);
		else bySelector.set(override.selector, [override]);
	}
	return models.map(model => {
		const slash = model.selector.indexOf("/");
		const provider = model.provider ?? (slash > 0 ? model.selector.slice(0, slash) : model.selector);
		const id = model.id ?? (slash > 0 ? model.selector.slice(slash + 1) : model.selector);
		const { planIncluded } = defaultTier(model.cost.output);
		const { tier, strengths } = hintedCapability(id, model.cost.output);
		const entry: RosterEntry = {
			selector: model.selector,
			provider,
			tier,
			strengths,
			enabled: true,
			maxConcurrent: DEFAULT_MAX_CONCURRENT,
			planIncluded,
			openWeight: isOpenWeightModelId(id),
			cost: { input: model.cost.input, output: model.cost.output },
		};
		if (model.contextWindow !== undefined && model.contextWindow > 0) entry.contextWindow = model.contextWindow;
		if (model.tps !== undefined && Number.isFinite(model.tps) && model.tps > 0) entry.tps = model.tps;
		for (const override of bySelector.get(model.selector) ?? []) {
			if (override.tier !== undefined) entry.tier = override.tier;
			if (override.strengths !== undefined) entry.strengths = [...override.strengths];
			if (override.enabled !== undefined) entry.enabled = override.enabled;
			if (override.maxConcurrent !== undefined) entry.maxConcurrent = override.maxConcurrent;
		}
		return entry;
	});
}

function isTier(value: unknown): value is Tier {
	return value === 1 || value === 2 || value === 3;
}

function isSkill(value: unknown): value is Skill {
	return typeof value === "string" && (SKILLS as readonly string[]).includes(value);
}

/** Validate one raw YAML entry; returns the override or a reason it was rejected. */
function parseOverride(raw: unknown): RosterOverride | string {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "entry is not a mapping";
	const record = raw as Record<string, unknown>;
	const { selector, tier, strengths, enabled, maxConcurrent } = record;
	if (typeof selector !== "string" || selector.trim() === "") return "missing selector";
	const override: RosterOverride = { selector: selector.trim() };
	if (tier !== undefined) {
		if (!isTier(tier)) return `tier must be 1, 2 or 3 (got ${JSON.stringify(tier)})`;
		override.tier = tier;
	}
	if (strengths !== undefined) {
		if (!Array.isArray(strengths) || !strengths.every(isSkill)) {
			return `strengths must be a list of: ${SKILLS.join(", ")}`;
		}
		override.strengths = [...new Set(strengths)];
	}
	if (enabled !== undefined) {
		if (typeof enabled !== "boolean") return "enabled must be true or false";
		override.enabled = enabled;
	}
	if (maxConcurrent !== undefined) {
		if (typeof maxConcurrent !== "number" || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
			return "maxConcurrent must be a positive integer";
		}
		override.maxConcurrent = maxConcurrent;
	}
	return override;
}

/** Read `models:` overrides from a roster.yml. Missing file → []; invalid entries skipped with a warning. */
export async function loadRosterOverrides(path: string): Promise<RosterOverride[]> {
	const file = Bun.file(path);
	if (!(await file.exists())) return [];
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(await file.text());
	} catch (err) {
		console.warn(`gk roster: cannot parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
	if (doc === null || doc === undefined) return [];
	const models = typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>).models : undefined;
	if (models === undefined || models === null) return [];
	if (!Array.isArray(models)) {
		console.warn(`gk roster: ${path}: "models" must be a list`);
		return [];
	}
	const overrides: RosterOverride[] = [];
	models.forEach((raw, index) => {
		const result = parseOverride(raw);
		if (typeof result === "string") console.warn(`gk roster: ${path}: skipping models[${index}]: ${result}`);
		else overrides.push(result);
	});
	return overrides;
}

/** `~/.gk/agent/roster.yml`. */
export function getRosterPath(): string {
	return join(getAgentDir(), "roster.yml");
}

/**
 * Write `overrides` as the `models:` list of a roster.yml, keeping any other top-level keys.
 * Throws when the existing file is not a YAML mapping, so a hand-edited file is never clobbered.
 */
export async function saveRosterOverrides(path: string, overrides: RosterOverride[]): Promise<void> {
	const file = Bun.file(path);
	let doc: Record<string, unknown> = {};
	if (await file.exists()) {
		const parsed: unknown = Bun.YAML.parse(await file.text());
		if (parsed !== null && parsed !== undefined) {
			if (typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`gk roster: ${path} is not a YAML mapping; not overwriting it`);
			}
			doc = parsed as Record<string, unknown>;
		}
	}
	doc.models = overrides.map(override => {
		const out: Record<string, unknown> = { selector: override.selector };
		if (override.tier !== undefined) out.tier = override.tier;
		if (override.strengths !== undefined) out.strengths = [...override.strengths];
		if (override.enabled !== undefined) out.enabled = override.enabled;
		if (override.maxConcurrent !== undefined) out.maxConcurrent = override.maxConcurrent;
		return out;
	});
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await Bun.write(tmp, Bun.YAML.stringify(doc, null, 2));
	await rename(tmp, path);
}

/**
 * Return `overrides` with `patch` merged into `selector`'s entry (one entry per selector).
 * `enabled: true` is the default, so it is dropped; an entry left with no fields is removed.
 */
export function patchRosterOverride(
	overrides: readonly RosterOverride[],
	selector: string,
	patch: Omit<RosterOverride, "selector">,
): RosterOverride[] {
	const merged: RosterOverride = { selector };
	for (const override of overrides) if (override.selector === selector) Object.assign(merged, override);
	Object.assign(merged, patch);
	if (merged.enabled === true) delete merged.enabled;
	const rest = overrides.filter(override => override.selector !== selector);
	return Object.keys(merged).length > 1 ? [...rest, merged] : rest;
}

/**
 * Chat models the router may cast, as `provider/id` with catalog prices, context window and the
 * measured speed from `perf` (keyed by selector). `getAvailable()` is the same credential gate the
 * `/model` picker starts from.
 */
export function availableRosterModels(
	registry: Pick<ModelRegistry, "getAvailable">,
	perf: ReadonlyMap<string, { tps: number }> = new Map(),
): RosterModel[] {
	return registry.getAvailable().map(model => {
		const selector = `${model.provider}/${model.id}`;
		return {
			selector,
			provider: model.provider,
			id: model.id,
			cost: { input: model.cost.input, output: model.cost.output },
			contextWindow: model.contextWindow ?? undefined,
			tps: perf.get(selector)?.tps,
		};
	});
}
