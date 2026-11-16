import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { CrewRunSummary } from "../../src/gk/crew-runtime";
import { estimateCostUsd } from "../../src/gk/roster";
import { conductorEquivalentUsd } from "../../src/gk/router";
import { renderPayslip } from "../../src/gk/ui/payslip";
import { sgr } from "./stage/widgets/helpers";

function summary(actualUsd: number, baselineEstUsd: number): CrewRunSummary {
	return {
		runId: "crew-1-abc",
		items: [
			{
				itemId: "W-01",
				name: "CalmPanda",
				selector: "cheap/one",
				state: "done",
				costUsd: actualUsd * 0.6,
				durationMs: 42_000,
			},
			{
				itemId: "W-02",
				name: "SwiftOtter",
				selector: "mid/two",
				state: "failed",
				costUsd: actualUsd * 0.4,
				durationMs: 9_000,
			},
		],
		actualUsd,
		baselineEstUsd,
		status: "partial",
	};
}

describe("renderPayslip", () => {
	it("states the savings", () => {
		expect(renderPayslip(summary(0.5, 4), 90).join("\n")).toContain("You saved $3.50 (88%)");
	});

	it("states an overrun plainly", () => {
		expect(renderPayslip(summary(5, 4), 90).join("\n")).toContain("cost $1.00 more than the conductor alone");
	});

	it("screenshot case: haiku crew under a gpt-6-luna conductor compares like for like", () => {
		// Conductor $0.1/$0.5, worker $1/$5, one S item: est $0.10 crew vs $0.01 conductor; actual $0.249.
		const crewEst = estimateCostUsd({ input: 1, output: 5 }, "S");
		const baseEst = estimateCostUsd({ input: 0.1, output: 0.5 }, "S");
		const slip: CrewRunSummary = {
			...summary(0.249, baseEst),
			items: [{ ...summary(0.249, baseEst).items[0]!, costUsd: 0.249, selector: "anthropic/claude-haiku-4-5" }],
			crewEstUsd: crewEst,
			conductorEquivUsd: conductorEquivalentUsd([{ actualUsd: 0.249, estUsd: crewEst, baselineUsd: baseEst }]),
			conductor: "openai-codex/gpt-6-luna",
			baselinePlan: false,
		};
		const text = renderPayslip(slip, 110).join("\n");
		expect(text).toContain("actual $0.25 (est $0.10)");
		expect(text).toContain("same work at its rates ≈$0.02");
		expect(text).toContain("This run cost $0.22 more than the conductor alone would have (≈$0.02).");
		expect(text).not.toContain("est $0.01).");
	});

	it("live-run case: a crew on the conductor's own model claims no savings", () => {
		// crew-1-mwj4rthr: three items on anthropic/claude-sonnet-5 under a sonnet-5 conductor.
		const slip: CrewRunSummary = {
			...summary(0.7317, 0.6),
			crewEstUsd: 0.6,
			conductorEquivUsd: 0.7317,
			conductor: "anthropic/claude-sonnet-5",
			baselinePlan: false,
		};
		const text = renderPayslip(slip, 110).join("\n");
		expect(text).toContain("Same cost as the conductor alone (≈$0.73)");
		expect(text).not.toContain("You saved");
	});

	it("makes no savings claim for a plan-priced conductor", () => {
		const slip: CrewRunSummary = { ...summary(0.5, 0), baselinePlan: true, conductor: "sub/plan" };
		const text = renderPayslip(slip, 110).join("\n");
		expect(text).toContain("is on a plan, so there is no dollar baseline");
		expect(text).not.toContain("saved");
		expect(text).not.toContain("more than");
	});

	it("never cuts the cost column for long model names", () => {
		const slip = summary(0.5, 4);
		slip.items[0]!.selector = "commandcode/moonshotai/Kimi-K2.7-Code-Highspeed-extra-long-name";
		const row = renderPayslip(slip, 80).find(r => r.includes("W-01"))!;
		expect(row).toContain("$0.30");
	});

	it("has one row per item with name, model, state glyph, time and cost", () => {
		const rows = renderPayslip(summary(0.5, 4), 90);
		const ada = rows.find(r => r.includes("W-01"))!;
		expect(ada).toContain("@CalmPanda");
		expect(ada).toContain("cheap/one");
		expect(ada).toContain("✓ done");
		expect(ada).toContain("42s");
		expect(ada).toContain("$0.30");
		expect(rows.find(r => r.includes("W-02"))).toContain("✗ failed");
	});

	it("keeps exact widths under SGR", () => {
		for (const width of [40, 90, 110]) {
			for (const row of renderPayslip(summary(0.5, 4), width, sgr)) expect(visibleWidth(row)).toBe(width);
		}
	});
});
