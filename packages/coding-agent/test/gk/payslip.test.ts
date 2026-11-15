import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { CrewRunSummary } from "../../src/gk/crew-runtime";
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
