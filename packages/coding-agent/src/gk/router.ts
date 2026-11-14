import { estimateCostUsd } from "./roster";
import type { RosterEntry, Size, Skill, Tier } from "./types";

export interface WorkItem {
	id: string;
	title: string;
	brief: string;
	skills: Skill[];
	difficulty: Tier;
	size: Size;
	dependsOn: string[];
	scope: string[];
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
	baselineEstUsd: number;
	overBudget: boolean;
}

export const NO_ELIGIBLE_WORKER = "no eligible worker";

/** Scores closer than this are treated as equal so float noise never decides a tie. */
const SCORE_EPSILON = 1e-9;

interface Candidate {
	entry: RosterEntry;
	estCost: number;
	fit: number;
	matched: Skill[];
	score: number;
}

function entryCost(entry: RosterEntry, size: Size): number {
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

function describe(candidate: Candidate): string {
	const skills = candidate.matched.length > 0 ? candidate.matched.join("/") : "general";
	const price = candidate.entry.planIncluded ? "plan" : formatUsd(candidate.estCost);
	return `tier ${candidate.entry.tier} ${skills}, cheapest fit: ${price}`;
}

/**
 * Deterministically assign each work item to a roster model (spec §5.4 Router).
 * Eligible = enabled, `tier ≥ max(difficulty, minTier[id])`, not in `exclude[id]`;
 * lowest `estCost × (1 − 0.3 × fit)` wins; ties → higher fit → lower tier → selector ascending.
 * No eligible model → the conductor, reason "no eligible worker".
 */
export function castCrew(
	items: WorkItem[],
	roster: RosterEntry[],
	conductor: RosterEntry,
	opts: { maxRunUsd?: number; exclude?: Record<string, string[]>; minTier?: Record<string, Tier> } = {},
): CastResult {
	const assignments: Assignment[] = [];
	let totalEstUsd = 0;
	let baselineEstUsd = 0;

	for (const item of items) {
		const conductorCost = entryCost(conductor, item.size);
		baselineEstUsd += conductorCost;

		const requiredTier = Math.max(item.difficulty, opts.minTier?.[item.id] ?? 1);
		const excluded = new Set(opts.exclude?.[item.id] ?? []);
		const skills = new Set(item.skills);

		let best: Candidate | undefined;
		for (const entry of roster) {
			if (!entry.enabled || entry.tier < requiredTier || excluded.has(entry.selector)) continue;
			const matched = entry.strengths.filter(skill => skills.has(skill));
			const fit = skills.size > 0 ? matched.length / skills.size : 0;
			const estCost = entryCost(entry, item.size);
			const candidate: Candidate = { entry, estCost, fit, matched, score: estCost * (1 - 0.3 * fit) };
			if (!best || compareCandidates(candidate, best) < 0) best = candidate;
		}

		const assignment: Assignment = best
			? {
					itemId: item.id,
					selector: best.entry.selector,
					tier: best.entry.tier,
					estCostUsd: best.estCost,
					planIncluded: best.entry.planIncluded,
					reason: describe(best),
				}
			: {
					itemId: item.id,
					selector: conductor.selector,
					tier: conductor.tier,
					estCostUsd: conductorCost,
					planIncluded: conductor.planIncluded,
					reason: NO_ELIGIBLE_WORKER,
				};
		totalEstUsd += assignment.estCostUsd;
		assignments.push(assignment);
	}

	const overBudget = opts.maxRunUsd !== undefined && totalEstUsd > opts.maxRunUsd;
	return { assignments, totalEstUsd, baselineEstUsd, overBudget };
}
