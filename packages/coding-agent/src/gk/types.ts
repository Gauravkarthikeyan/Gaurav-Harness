export type Skill = "frontend" | "backend" | "tests" | "docs" | "infra" | "refactor" | "research" | "review" | "design";
export type Tier = 1 | 2 | 3;
export type Size = "S" | "M" | "L";

export const SKILLS: readonly Skill[] = [
	"frontend",
	"backend",
	"tests",
	"docs",
	"infra",
	"refactor",
	"research",
	"review",
	"design",
];

export interface RosterEntry {
	selector: string;
	/** Provider id (the selector's first segment). */
	provider: string;
	tier: Tier;
	strengths: Skill[];
	enabled: boolean;
	maxConcurrent: number;
	planIncluded: boolean;
	/** Published weights (llama, qwen, deepseek, kimi, glm, …), whatever provider serves it. */
	openWeight: boolean;
	cost: { input: number; output: number };
	/** Context window in tokens, when the catalog lists one. */
	contextWindow?: number;
	/** Measured output tokens/sec from local history, when known. */
	tps?: number;
}

/**
 * Session-level casting rules (Gaurav's stated preferences): set by `crew_policy` or `/crew policy`,
 * enforced by the router, the Casting Board and every crew tool that picks a model.
 */
export interface CrewPolicy {
	openWeightOnly?: boolean;
	/** Only these providers. */
	providers?: string[];
	excludeProviders?: string[];
	/** Never cast above this tier. */
	maxTier?: Tier;
	/** Cast one tier above each item's floor when such a model exists. */
	preferQuality?: boolean;
}

export interface RosterOverride {
	selector: string;
	tier?: Tier;
	strengths?: Skill[];
	enabled?: boolean;
	maxConcurrent?: number;
}
