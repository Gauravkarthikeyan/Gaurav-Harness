import { describe, expect, it } from "bun:test";
import { estimateCostUsd } from "../../src/gk/roster";
import {
	CrewCastError,
	castCrew,
	conductorBaseline,
	conductorEquivalentUsd,
	describePolicy,
	itemFloor,
	policyViolation,
	type WorkItem,
} from "../../src/gk/router";
import type { RosterEntry, Tier } from "../../src/gk/types";

function entry(
	selector: string,
	tier: Tier,
	cost: { input: number; output: number },
	extra: Partial<RosterEntry> = {},
): RosterEntry {
	return {
		selector,
		provider: selector.split("/")[0]!,
		openWeight: false,
		tier,
		strengths: [],
		enabled: true,
		maxConcurrent: 2,
		planIncluded: cost.input === 0 && cost.output === 0,
		cost,
		...extra,
	};
}

function item(id: string, extra: Partial<WorkItem> = {}): WorkItem {
	return {
		id,
		title: id,
		brief: `do ${id}`,
		skills: ["backend"],
		difficulty: 1,
		size: "S",
		dependsOn: [],
		scope: [`src/${id}/`],
		...extra,
	};
}

const conductor = entry("anthropic/opus", 3, { input: 15, output: 75 });

describe("castCrew", () => {
	it("picks the lowest score among eligible workers", () => {
		const haiku = entry("anthropic/haiku", 1, { input: 1, output: 5 }, { strengths: ["backend"] });
		const flash = entry("google/flash", 1, { input: 0.3, output: 2.5 });
		const result = castCrew([item("api")], [haiku, flash], conductor);
		const [assignment] = result.assignments;
		expect(assignment.itemId).toBe("api");
		expect(assignment.selector).toBe("google/flash");
		expect(assignment.tier).toBe(1);
		expect(assignment.estCostUsd).toBeCloseTo(estimateCostUsd(flash.cost, "S"), 10);
		expect(assignment.planIncluded).toBe(false);
		expect(assignment.reason.length).toBeGreaterThan(0);
	});

	it("lets strength fit beat a slightly cheaper model", () => {
		// haiku: 0.10 × 0.7 = 0.07; flash: 0.08 × 1 = 0.08
		const haiku = entry("anthropic/haiku", 1, { input: 1, output: 5 }, { strengths: ["backend"] });
		const flash = entry("google/flash", 1, { input: 1, output: 2.5 });
		const [assignment] = castCrew([item("api")], [haiku, flash], conductor).assignments;
		expect(assignment.selector).toBe("anthropic/haiku");
		expect(assignment.reason).toContain("backend");
	});

	it("falls back to the conductor when no worker is high enough tier", () => {
		const roster = [entry("t1/cheap", 1, { input: 0.1, output: 0.4 }), entry("t2/mid", 2, { input: 1, output: 4 })];
		const [assignment] = castCrew([item("hard", { difficulty: 3 })], roster, conductor).assignments;
		expect(assignment.selector).toBe("anthropic/opus");
		expect(assignment.tier).toBe(3);
		expect(assignment.reason).toBe("no eligible worker");
		expect(assignment.estCostUsd).toBeCloseTo(estimateCostUsd(conductor.cost, "S"), 10);
	});

	it("assigns every item to the conductor when the roster is empty", () => {
		const items = [item("a"), item("b", { difficulty: 2, size: "M" }), item("c", { size: "L" })];
		const result = castCrew(items, [], conductor);
		expect(result.assignments.map(a => a.selector)).toEqual(["anthropic/opus", "anthropic/opus", "anthropic/opus"]);
		expect(result.assignments.every(a => a.reason === "no eligible worker")).toBe(true);
		expect(result.totalEstUsd).toBeCloseTo(result.baselineEstUsd, 10);
	});

	it("ignores disabled entries", () => {
		const roster = [entry("off/model", 1, { input: 0.1, output: 0.4 }, { enabled: false })];
		const [assignment] = castCrew([item("a")], roster, conductor).assignments;
		expect(assignment.reason).toBe("no eligible worker");
	});

	describe("tie-breaks", () => {
		it("prefers higher fit on equal score", () => {
			const plain = entry("a/plain", 1, { input: 0, output: 0 });
			const strong = entry("z/strong", 1, { input: 0, output: 0 }, { strengths: ["backend"] });
			const [assignment] = castCrew([item("x")], [plain, strong], conductor).assignments;
			expect(assignment.selector).toBe("z/strong");
		});

		it("prefers higher fit when float noise separates equal scores", () => {
			// strong: 0.08 × 0.7; plain: 0.056 × 1 — equal up to rounding
			const strong = entry("z/strong", 1, { input: 0, output: 10 }, { strengths: ["backend"] });
			const plain = entry("a/plain", 1, { input: 0, output: 7 });
			const [assignment] = castCrew([item("x")], [plain, strong], conductor).assignments;
			expect(assignment.selector).toBe("z/strong");
		});

		it("then prefers lower tier", () => {
			const high = entry("a/high", 2, { input: 1, output: 4 });
			const low = entry("z/low", 1, { input: 1, output: 4 });
			const [assignment] = castCrew([item("x")], [high, low], conductor).assignments;
			expect(assignment.selector).toBe("z/low");
		});

		it("then prefers selector ascending", () => {
			const b = entry("b/model", 1, { input: 1, output: 4 });
			const a = entry("a/model", 1, { input: 1, output: 4 });
			const [assignment] = castCrew([item("x")], [b, a], conductor).assignments;
			expect(assignment.selector).toBe("a/model");
		});
	});

	it("chooses an eligible plan-included model at zero cost", () => {
		const paid = entry("cheap/paid", 2, { input: 0.1, output: 0.4 }, { strengths: ["backend"] });
		const plan = entry("sub/plan", 2, { input: 0, output: 0 });
		const [assignment] = castCrew([item("x", { difficulty: 2 })], [paid, plan], conductor).assignments;
		expect(assignment.selector).toBe("sub/plan");
		expect(assignment.estCostUsd).toBe(0);
		expect(assignment.planIncluded).toBe(true);
		expect(Number.isNaN(assignment.estCostUsd)).toBe(false);
	});

	it("sums conductor estimates as the baseline and flags over-budget runs", () => {
		const worker = entry("w/one", 2, { input: 1, output: 4 });
		const items = [item("a", { size: "S" }), item("b", { size: "M" })];
		const baseline = estimateCostUsd(conductor.cost, "S") + estimateCostUsd(conductor.cost, "M");
		const total = estimateCostUsd(worker.cost, "S") + estimateCostUsd(worker.cost, "M");

		const result = castCrew(items, [worker], conductor, { maxRunUsd: total / 2 });
		expect(result.baselineEstUsd).toBeCloseTo(baseline, 10);
		expect(result.totalEstUsd).toBeCloseTo(total, 10);
		expect(result.overBudget).toBe(true);

		expect(castCrew(items, [worker], conductor, { maxRunUsd: total * 2 }).overBudget).toBe(false);
		expect(castCrew(items, [worker], conductor).overBudget).toBe(false);
	});

	it("respects exclude and minTier", () => {
		const t1 = entry("a/t1", 1, { input: 0.1, output: 0.4 });
		const t2a = entry("b/t2", 2, { input: 1, output: 4 });
		const t2b = entry("c/t2", 2, { input: 2, output: 8 });
		const roster = [t1, t2a, t2b];

		expect(castCrew([item("x")], roster, conductor).assignments[0].selector).toBe("a/t1");

		const escalated = castCrew([item("x")], roster, conductor, { minTier: { x: 2 }, exclude: { x: ["b/t2"] } });
		expect(escalated.assignments[0].selector).toBe("c/t2");

		const exhausted = castCrew([item("x")], roster, conductor, {
			minTier: { x: 2 },
			exclude: { x: ["b/t2", "c/t2"] },
		});
		expect(exhausted.assignments[0].reason).toBe("no eligible worker");

		const otherItem = castCrew([item("x"), item("y")], roster, conductor, { exclude: { y: ["a/t1"] } });
		expect(otherItem.assignments.map(a => a.selector)).toEqual(["a/t1", "b/t2"]);
	});
});

describe("quality-first casting", () => {
	const cheap = entry("open/llama", 1, { input: 0.1, output: 0.4 }, { openWeight: true });
	const kimi = entry("cc/kimi", 2, { input: 0.95, output: 4 }, { openWeight: true, strengths: ["frontend"] });
	const haiku = entry("anthropic/haiku", 2, { input: 1, output: 5 });
	const fable = entry("cc/fable", 3, { input: 0, output: 0 });
	const roster = [cheap, kimi, haiku];

	it("never casts frontend, design or architecture work below tier 2, even when tier 1 is cheaper", () => {
		expect(itemFloor(item("ui", { skills: ["frontend"], difficulty: 1 }))).toBe(2);
		expect(itemFloor(item("look", { skills: ["design"], difficulty: 1 }))).toBe(2);
		expect(itemFloor(item("arch", { title: "Architecture for sync", difficulty: 1 }))).toBe(2);
		expect(itemFloor(item("docs", { skills: ["docs"], difficulty: 1 }))).toBe(1);
		const [a] = castCrew([item("ui", { skills: ["frontend"] })], roster, conductor).assignments;
		expect(a!.selector).toBe("cc/kimi");
		expect(a!.reason).toContain("floor t2");
	});

	it("preferQuality raises the floor by one, capped by maxTier", () => {
		expect(itemFloor(item("x"), { preferQuality: true })).toBe(2);
		expect(itemFloor(item("x", { difficulty: 2 }), { preferQuality: true, maxTier: 2 })).toBe(2);
	});

	it("uses the conductor's model pick when connected and allowed, noting it", () => {
		const [a] = castCrew(
			[item("x", { model: "anthropic/haiku", reason: "steady on tests" })],
			roster,
			conductor,
		).assignments;
		expect(a).toMatchObject({ selector: "anthropic/haiku", reason: "conductor's pick: steady on tests" });
	});

	it("falls back to auto-casting when the pick is not connected or breaks the policy", () => {
		const [missing] = castCrew([item("x", { model: "nope/model" })], roster, conductor).assignments;
		expect(missing!.selector).toBe("open/llama");
		expect(missing!.reason).toStartWith("nope/model not connected; ");
		const [closed] = castCrew([item("x", { model: "anthropic/haiku" })], roster, conductor, {
			policy: { openWeightOnly: true },
		}).assignments;
		expect(closed!.selector).toBe("open/llama");
		expect(closed!.reason).toContain("closed weights");
	});

	it("open-weight only skips a free closed frontier model", () => {
		const [a] = castCrew([item("x", { difficulty: 2 })], [...roster, fable], conductor, {
			policy: { openWeightOnly: true },
		}).assignments;
		expect(a!.selector).toBe("cc/kimi");
	});

	it("enforces providers, excludeProviders and maxTier", () => {
		const only = castCrew([item("x")], roster, conductor, { policy: { providers: ["anthropic"] } });
		expect(only.assignments[0]!.selector).toBe("anthropic/haiku");
		const not = castCrew([item("x")], roster, conductor, { policy: { excludeProviders: ["open"] } });
		expect(not.assignments[0]!.selector).toBe("cc/kimi");
		expect(policyViolation(fable, { maxTier: 2 })).toContain("above policy max tier 2");
	});

	it("errors with the allowed models when the policy leaves nothing for an item", () => {
		expect(() =>
			castCrew([item("hard", { difficulty: 3 })], roster, conductor, { policy: { openWeightOnly: true } }),
		).toThrow(CrewCastError);
		try {
			castCrew([item("hard", { difficulty: 3 })], roster, conductor, { policy: { openWeightOnly: true } });
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("open-weight only");
			expect(message).toContain("cc/kimi (tier 2, open-weight)");
			expect(message).toContain("open/llama (tier 1, open-weight)");
		}
	});

	it("describes the policy", () => {
		expect(describePolicy({})).toBe("none");
		expect(describePolicy({ openWeightOnly: true, providers: ["cc"], maxTier: 2, preferQuality: true })).toBe(
			"open-weight only · providers cc · max tier 2 · prefer quality",
		);
	});
});

describe("conductor baseline", () => {
	// Screenshot case: conductor openai-codex/gpt-6-luna ($0.1/$0.5), one S item cast on haiku ($1/$5),
	// which actually spent $0.249. The payslip claimed "conductor alone est $0.01".
	const luna = entry("openai-codex/gpt-6-luna", 1, { input: 0.1, output: 0.5 });
	const haiku = entry("anthropic/claude-haiku-4-5", 2, { input: 1, output: 5 });

	it("prices every item at the conductor's catalog rates on the same size estimates", () => {
		const items = [item("a", { size: "S" }), item("b", { size: "L" })];
		const result = castCrew(items, [haiku], luna);
		expect(result.baselineEstUsd).toBeCloseTo(estimateCostUsd(luna.cost, "S") + estimateCostUsd(luna.cost, "L"), 10);
		expect(result.baselinePlan).toBe(false);
	});

	it("a plan-priced conductor has no dollar baseline", () => {
		const plan = entry("sub/plan", 3, { input: 0, output: 0 });
		expect(conductorBaseline([item("a")], plan)).toEqual({ usd: 0, plan: true });
		expect(castCrew([item("a")], [haiku], plan).baselinePlan).toBe(true);
	});

	it("reprices the crew's actual spend at the conductor's rates", () => {
		const est = estimateCostUsd(haiku.cost, "S");
		const base = estimateCostUsd(luna.cost, "S");
		const equiv = conductorEquivalentUsd([{ actualUsd: 0.249, estUsd: est, baselineUsd: base }]);
		// Same token mix at luna's rates is a tenth of haiku's: ≈ $0.025, not the $0.01 size estimate.
		expect(equiv).toBeCloseTo(0.0249, 4);
		expect(conductorEquivalentUsd([{ actualUsd: 0.3, estUsd: 0, baselineUsd: 0.2 }])).toBe(0.2);
	});
});
