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
	tier: Tier;
	strengths: Skill[];
	enabled: boolean;
	maxConcurrent: number;
	planIncluded: boolean;
	cost: { input: number; output: number };
}

export interface RosterOverride {
	selector: string;
	tier?: Tier;
	strengths?: Skill[];
	enabled?: boolean;
	maxConcurrent?: number;
}
