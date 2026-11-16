/**
 * The conductor's view of every connected model (crew_models): one compact row per roster entry with
 * the facts it needs to cast by difficulty — tier, price, per-size estimate, strengths, open weights,
 * context and speed — under the session's crew policy.
 */
import { describePolicy, entryCost, policyViolation } from "./router";
import type { CrewPolicy, RosterEntry, Skill, Tier } from "./types";

export interface ModelFilter {
	openWeight?: boolean;
	provider?: string;
	minTier?: Tier;
	skills?: Skill[];
}

/** Entries matching `filter`, strongest tier first, cheapest first within a tier. */
export function filterModels(roster: readonly RosterEntry[], filter: ModelFilter = {}): RosterEntry[] {
	return roster
		.filter(entry => {
			if (filter.openWeight !== undefined && entry.openWeight !== filter.openWeight) return false;
			if (filter.provider && entry.provider !== filter.provider) return false;
			if (filter.minTier !== undefined && entry.tier < filter.minTier) return false;
			if (filter.skills?.length && !filter.skills.some(skill => entry.strengths.includes(skill))) return false;
			return true;
		})
		.sort((a, b) => b.tier - a.tier || entryCost(a, "M") - entryCost(b, "M") || a.selector.localeCompare(b.selector));
}

function money(usd: number, plan: boolean): string {
	if (plan) return "plan";
	if (usd < 0.01) return usd > 0 ? "<.01" : "0";
	return usd.toFixed(2);
}

function ctx(tokens: number | undefined): string {
	if (!tokens) return "?";
	return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}k`;
}

/** Markdown-ish table for the conductor; rows the policy rules out end with `✗ <why>`. */
export function formatModelTable(
	roster: readonly RosterEntry[],
	opts: {
		filter?: ModelFilter;
		policy?: CrewPolicy;
		conductor?: string;
		/** Models that failed to start this session, with why. */
		unhealthy?: ReadonlyMap<string, string>;
	} = {},
): string {
	const rows = filterModels(roster, opts.filter);
	const lines = [
		`Crew policy: ${describePolicy(opts.policy)}${opts.conductor ? ` · conductor ${opts.conductor}` : ""}`,
		`${rows.length} of ${roster.length} connected model(s). Prices USD per 1M tokens; est = one S/M/L item; tier 1 mechanical · 2 normal engineering · 3 frontier.`,
		"selector | provider | tier | $in/$out | est S/M/L | strengths | open | ctx | tok/s",
	];
	for (const entry of rows) {
		const price = entry.planIncluded ? "plan" : `${entry.cost.input}/${entry.cost.output}`;
		const est = (["S", "M", "L"] as const).map(size => money(entryCost(entry, size), entry.planIncluded)).join("/");
		const violation = policyViolation(entry, opts.policy);
		const sick = opts.unhealthy?.get(entry.selector);
		const flags = [
			sick ? `✗ unhealthy: ${sick}` : !entry.enabled ? "off in roster" : "",
			violation ? `✗ ${violation}` : "",
		]
			.filter(Boolean)
			.join("; ");
		lines.push(
			[
				entry.selector,
				entry.provider,
				`t${entry.tier}`,
				price,
				est,
				entry.strengths.join(",") || "general",
				entry.openWeight ? "open" : "closed",
				ctx(entry.contextWindow),
				entry.tps ? String(Math.round(entry.tps)) : "?",
			].join(" | ") + (flags ? ` | ${flags}` : ""),
		);
	}
	if (rows.length === 0) lines.push("(no model matches the filter)");
	return lines.join("\n");
}
