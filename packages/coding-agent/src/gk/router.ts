import { estimateCostUsd } from "./roster";
import type { CrewPolicy, RosterEntry, Size, Skill, Tier } from "./types";

export interface WorkItem {
	id: string;
	title: string;
	brief: string;
	skills: Skill[];
	difficulty: Tier;
	size: Size;
	dependsOn: string[];
	scope: string[];
	/** Exact roster selector the conductor chose; used when connected and allowed by the policy. */
	model?: string;
	/** Why the conductor chose `model` (shown on the Casting Board). */
	reason?: string;
}

export interface Assignment {
	itemId: string;
	selector: string;
	tier: Tier;
	estCostUsd: number;
	planIncluded: boolean;
	reason: string;
}

export interface CastResult {
	assignments: Assignment[];
	totalEstUsd: number;
	/** What the conductor model alone would cost for the same items (same size estimates, its catalog price). */
	baselineEstUsd: number;
	/** The conductor is plan/subscription-priced: there is no dollar baseline and no savings claim. */
	baselinePlan: boolean;
	overBudget: boolean;
}

export const NO_ELIGIBLE_WORKER = "no eligible worker";

/** Thrown when the policy leaves no model that can take an item. The message lists what is available. */
export class CrewCastError extends Error {}

/** Scores closer than this are treated as equal so float noise never decides a tie. */
const SCORE_EPSILON = 1e-9;

/** Skills whose output quality shows directly to Gaurav: never cast below tier 2. */
const QUALITY_SKILLS: Partial<Record<Skill, true>> = { frontend: true, design: true };
const ARCHITECTURE_RE = /\barchitect/i;

interface Candidate {
	entry: RosterEntry;
	estCost: number;
	fit: number;
	matched: Skill[];
	score: number;
}

export function entryCost(entry: Pick<RosterEntry, "planIncluded" | "cost">, size: Size): number {
	return entry.planIncluded ? 0 : estimateCostUsd(entry.cost, size);
}

function formatUsd(usd: number): string {
	if (usd === 0) return "$0";
	if (usd < 0.01) return "<$0.01";
	return `$${usd.toFixed(2)}`;
}

function compareCandidates(a: Candidate, b: Candidate): number {
	if (Math.abs(a.score - b.score) > SCORE_EPSILON) return a.score - b.score;
	if (a.fit !== b.fit) return b.fit - a.fit;
	if (a.entry.tier !== b.entry.tier) return a.entry.tier - b.entry.tier;
	return a.entry.selector < b.entry.selector ? -1 : a.entry.selector > b.entry.selector ? 1 : 0;
}

function describe(candidate: Candidate, floor: Tier): string {
	const skills = candidate.matched.length > 0 ? candidate.matched.join("/") : "general";
	const price = candidate.entry.planIncluded ? "plan" : formatUsd(candidate.estCost);
	return `floor t${floor} · t${candidate.entry.tier} ${skills}${candidate.entry.openWeight ? " · open-weight" : ""} · cheapest fit ${price}`;
}

/**
 * Lowest tier an item may be cast on: its difficulty, raised to 2 for frontend/design/architecture work
 * (quality shows), raised by `minTier`, plus one with `preferQuality`. Never above 3.
 */
export function itemFloor(item: WorkItem, policy: CrewPolicy = {}, minTier: Tier = 1): Tier {
	let floor: number = Math.max(item.difficulty, minTier);
	if (item.skills.some(skill => QUALITY_SKILLS[skill]) || ARCHITECTURE_RE.test(item.title)) {
		floor = Math.max(floor, 2);
	}
	// The quality bump never pushes past the policy's max tier; an honest floor above it still errors.
	if (policy.preferQuality) floor = Math.max(floor, Math.min(floor + 1, policy.maxTier ?? 3));
	return Math.min(3, floor) as Tier;
}

/** Why `entry` breaks `policy`, or undefined when it is allowed. */
export function policyViolation(entry: RosterEntry, policy: CrewPolicy = {}): string | undefined {
	if (policy.openWeightOnly && !entry.openWeight) return "closed weights (policy: open-weight only)";
	if (policy.providers?.length && !policy.providers.includes(entry.provider)) {
		return `provider ${entry.provider} not in policy (${policy.providers.join(", ")})`;
	}
	if (policy.excludeProviders?.includes(entry.provider)) return `provider ${entry.provider} excluded by policy`;
	if (policy.maxTier !== undefined && entry.tier > policy.maxTier) {
		return `tier ${entry.tier} above policy max tier ${policy.maxTier}`;
	}
	return undefined;
}

/** True when the policy has at least one rule. */
export function policyActive(policy: CrewPolicy = {}): boolean {
	return Boolean(
		policy.openWeightOnly ||
		policy.providers?.length ||
		policy.excludeProviders?.length ||
		policy.maxTier !== undefined ||
		policy.preferQuality,
	);
}

/** `open-weight only · providers a, b · max tier 2 · prefer quality`, or `none`. */
export function describePolicy(policy: CrewPolicy = {}): string {
	const parts: string[] = [];
	if (policy.openWeightOnly) parts.push("open-weight only");
	if (policy.providers?.length) parts.push(`providers ${policy.providers.join(", ")}`);
	if (policy.excludeProviders?.length) parts.push(`not ${policy.excludeProviders.join(", ")}`);
	if (policy.maxTier !== undefined) parts.push(`max tier ${policy.maxTier}`);
	if (policy.preferQuality) parts.push("prefer quality");
	return parts.length > 0 ? parts.join(" · ") : "none";
}

/**
 * What the conductor model alone would cost for every item: its real catalog price over the same size
 * estimates the workers are scored with. A plan-priced conductor has no dollar baseline.
 */
export function conductorBaseline(
	items: readonly Pick<WorkItem, "size">[],
	conductor: Pick<RosterEntry, "planIncluded" | "cost">,
): { usd: number; plan: boolean } {
	if (conductor.planIncluded) return { usd: 0, plan: true };
	let usd = 0;
	for (const item of items) usd += estimateCostUsd(conductor.cost, item.size);
	return { usd, plan: false };
}

/**
 * What the conductor alone would actually have spent on the work the crew did: each item's actual
 * worker spend repriced by the conductor-to-worker estimate ratio (same token mix, the conductor's
 * rates). Items with no worker estimate (plan-priced worker) fall back to the conductor estimate.
 */
export function conductorEquivalentUsd(
	items: ReadonlyArray<{ actualUsd: number; estUsd: number; baselineUsd: number }>,
): number {
	let total = 0;
	for (const { actualUsd, estUsd, baselineUsd } of items) {
		total += estUsd > 0 && actualUsd > 0 ? actualUsd * (baselineUsd / estUsd) : baselineUsd;
	}
	return total;
}

function policyError(item: WorkItem, floor: Tier, roster: RosterEntry[], policy: CrewPolicy): CrewCastError {
	const allowed = roster.filter(entry => entry.enabled && !policyViolation(entry, policy));
	const lines = [
		`No connected model satisfies the crew policy (${describePolicy(policy)}) for item "${item.id}" (needs tier ≥ ${floor}).`,
	];
	if (allowed.length === 0) {
		lines.push("Nothing connected matches the policy at all.");
	} else {
		lines.push("Models the policy allows:");
		for (const entry of [...allowed].sort((a, b) => b.tier - a.tier || a.selector.localeCompare(b.selector))) {
			lines.push(`- ${entry.selector} (tier ${entry.tier}${entry.openWeight ? ", open-weight" : ""})`);
		}
	}
	lines.push(
		"Lower the item's difficulty only if that is honest, set `model` on the item to one of these, or ask Gaurav to relax the policy (crew_policy).",
	);
	return new CrewCastError(lines.join("\n"));
}

/**
 * Assign each work item to a roster model (spec §5.4 Router; quality-first).
 * - The conductor's `item.model` wins when it is connected, enabled and allowed by the policy.
 * - Otherwise: eligible = enabled, allowed by the policy, `tier ≥ itemFloor`, not in `exclude[id]`;
 *   lowest `estCost × (1 − 0.3 × fit)` wins; ties → higher fit → lower tier → selector ascending.
 *   Money never pushes an item below its floor.
 * - Nothing eligible: with an active policy, {@link CrewCastError} listing what the policy allows;
 *   without one, the conductor, reason "no eligible worker".
 */
export function castCrew(
	items: WorkItem[],
	roster: RosterEntry[],
	conductor: RosterEntry,
	opts: {
		maxRunUsd?: number;
		exclude?: Record<string, string[]>;
		minTier?: Record<string, Tier>;
		policy?: CrewPolicy;
	} = {},
): CastResult {
	const policy = opts.policy ?? {};
	const assignments: Assignment[] = [];
	let totalEstUsd = 0;
	const baseline = conductorBaseline(items, conductor);

	for (const item of items) {
		const floor = itemFloor(item, policy, opts.minTier?.[item.id] ?? 1);
		const excluded = new Set(opts.exclude?.[item.id] ?? []);
		let pickNote = "";

		if (item.model && !excluded.has(item.model)) {
			const picked = roster.find(entry => entry.selector === item.model);
			const violation = picked ? policyViolation(picked, policy) : undefined;
			if (picked?.enabled && !violation) {
				const why = item.reason?.trim() ? `: ${item.reason.trim()}` : "";
				const below = picked.tier < floor ? ` (t${picked.tier}, below floor t${floor})` : "";
				const assignment: Assignment = {
					itemId: item.id,
					selector: picked.selector,
					tier: picked.tier,
					estCostUsd: entryCost(picked, item.size),
					planIncluded: picked.planIncluded,
					reason: `conductor's pick${below}${why}`,
				};
				totalEstUsd += assignment.estCostUsd;
				assignments.push(assignment);
				continue;
			}
			pickNote = !picked
				? `${item.model} not connected; `
				: !picked.enabled
					? `${item.model} disabled in roster; `
					: `${item.model} skipped: ${violation}; `;
		}

		const skills = new Set(item.skills);
		let best: Candidate | undefined;
		for (const entry of roster) {
			if (!entry.enabled || entry.tier < floor || excluded.has(entry.selector)) continue;
			if (policyViolation(entry, policy)) continue;
			const matched = entry.strengths.filter(skill => skills.has(skill));
			const fit = skills.size > 0 ? matched.length / skills.size : 0;
			const estCost = entryCost(entry, item.size);
			const candidate: Candidate = { entry, estCost, fit, matched, score: estCost * (1 - 0.3 * fit) };
			if (!best || compareCandidates(candidate, best) < 0) best = candidate;
		}

		if (!best && policyActive(policy)) throw policyError(item, floor, roster, policy);
		const assignment: Assignment = best
			? {
					itemId: item.id,
					selector: best.entry.selector,
					tier: best.entry.tier,
					estCostUsd: best.estCost,
					planIncluded: best.entry.planIncluded,
					reason: `${pickNote}${describe(best, floor)}`,
				}
			: {
					itemId: item.id,
					selector: conductor.selector,
					tier: conductor.tier,
					estCostUsd: entryCost(conductor, item.size),
					planIncluded: conductor.planIncluded,
					reason: `${pickNote}${NO_ELIGIBLE_WORKER}`,
				};
		totalEstUsd += assignment.estCostUsd;
		assignments.push(assignment);
	}

	const overBudget = opts.maxRunUsd !== undefined && totalEstUsd > opts.maxRunUsd;
	return { assignments, totalEstUsd, baselineEstUsd: baseline.usd, baselinePlan: baseline.plan, overBudget };
}
