import { describe, expect, it } from "bun:test";
import { renderSplashFrame, type SplashCheck, type SplashState, splashProgress } from "../src/gk/splash-frame";
import { visibleWidth } from "../src/utils";

const plain = (lines: string[]): string[] => lines.map(line => Bun.stripANSI(line));

const CHECKS: SplashCheck[] = [
	{ id: "providers", label: "providers", state: "ok", value: "6 connected", detail: "anthropic · openai · google +3" },
	{ id: "roster", label: "roster", state: "ok", value: "7 models", detail: "t1 ×3 · t2 ×3 · t3 ×1" },
	{ id: "skills", label: "skills", state: "pending" },
	{ id: "mcp", label: "mcp", state: "warn", value: "3/4 connected", detail: "down: context7" },
	{ id: "computer", label: "computer use", state: "off", value: "off", detail: "computer.enabled = false" },
];

const state = (checks: SplashCheck[] = CHECKS, extra: Partial<SplashState> = {}): SplashState => ({
	checks,
	version: "0.1.0",
	host: "darwin arm64 · pid 4242",
	colorMode: "truecolor",
	...extra,
});

const pending = (n: number): SplashCheck[] =>
	Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: `check ${i}`, state: "pending" }));

/** The `━…─ n/m` row: filled count and total bar length. */
function bar(lines: string[]): { filled: number; total: number; count: string } {
	const row = plain(lines).find(line => /[━─]{10,}/.test(line));
	if (!row) throw new Error("no progress bar row");
	const filled = [...row].filter(char => char === "━").length;
	const empty = [...row].filter(char => char === "─").length;
	return { filled, total: filled + empty, count: row.trim().split(" ").at(-1) ?? "" };
}

describe("renderSplashFrame", () => {
	for (const [width, height] of [
		[212, 58],
		[120, 40],
		[80, 24],
	] as const) {
		it(`is exactly ${width}×${height}`, () => {
			for (const t of [0, 400, 1700]) {
				const lines = renderSplashFrame(state(), width, height, t);
				expect(lines).toHaveLength(height);
				for (const line of lines) expect(visibleWidth(line)).toBe(width);
			}
		});

		it(`never mentions omp at ${width}×${height}`, () => {
			for (const line of plain(renderSplashFrame(state(), width, height, 900))) {
				expect(line.toLowerCase()).not.toMatch(/\bomp\b/);
			}
		});
	}

	it("renders every check state with its glyph, value and detail", () => {
		const text = plain(renderSplashFrame(state(), 212, 58, 0)).join("\n");
		expect(text).toMatch(/✓ providers\s+6 connected\s+anthropic · openai · google \+3/);
		expect(text).toMatch(/✓ roster\s+7 models/);
		expect(text).toMatch(/⠋ skills\s+probing/);
		expect(text).toMatch(/! mcp\s+3\/4 connected\s+down: context7/);
		expect(text).toMatch(/○ computer use\s+off\s+computer\.enabled = false/);
		expect(text).not.toContain("✗");
		const failed = plain(
			renderSplashFrame(state([{ id: "x", label: "roster", state: "fail", value: "failed" }]), 120, 40, 0),
		).join("\n");
		expect(failed).toMatch(/✗ roster\s+failed/);
	});

	it("fills the progress bar in proportion to settled checks", () => {
		const total = bar(renderSplashFrame(state(pending(4)), 212, 58, 0)).total;
		for (let done = 0; done <= 4; done++) {
			const checks = pending(4).map((check, i) => (i < done ? { ...check, state: "ok" as const } : check));
			const result = bar(renderSplashFrame(state(checks), 212, 58, 0));
			expect(result.total).toBe(total);
			expect(result.filled).toBe(Math.round((done / 4) * total));
			expect(result.count).toBe(`${done}/4`);
			expect(splashProgress(checks)).toBe(done / 4);
		}
	});

	it("shows the wordmark, the footer and the boot line", () => {
		const lines = plain(renderSplashFrame(state(), 212, 58, 0));
		expect(lines.join("\n")).toContain("</>");
		expect(lines.some(line => line.includes("█"))).toBe(true);
		expect(lines[0]).toContain("gk-code boot · darwin arm64 · pid 4242");
		expect(lines.at(-1)).toMatch(
			/^ by Gaurav Karthikeyan · github\.com\/Gauravkarthikeyan .* gk-code 0\.1\.0 · any key to skip $/,
		);
	});

	it("stacks the footer when one row cannot hold both halves", () => {
		const lines = plain(renderSplashFrame(state(), 80, 24, 0));
		expect(lines.at(-2)).toContain("by Gaurav Karthikeyan · github.com/Gauravkarthikeyan");
		expect(lines.at(-1)?.trimEnd().endsWith("gk-code 0.1.0 · any key to skip")).toBe(true);
	});

	it("animates the globe over time and holds still with motion off", () => {
		const a = renderSplashFrame(state(), 212, 58, 0);
		const b = renderSplashFrame(state(), 212, 58, 600);
		expect(a).not.toEqual(b);
		const still = state(CHECKS, { motion: false });
		expect(renderSplashFrame(still, 212, 58, 0)).toEqual(renderSplashFrame(still, 212, 58, 2400));
		// Motionless pending checks show a static dot, not a spinner frame.
		expect(plain(renderSplashFrame(still, 212, 58, 0)).join("\n")).toMatch(/● skills/);
	});

	it("draws a globe of dots with depth shading", () => {
		const lines = plain(renderSplashFrame(state(), 212, 58, 0));
		const dots = lines
			.slice(1, 30)
			.join("")
			.replace(/[^·•●]/g, "");
		expect(dots.length).toBeGreaterThan(200);
		expect(dots).toContain("·");
		expect(dots).toContain("•");
	});

	it("survives tiny terminals", () => {
		for (const [w, h] of [
			[1, 1],
			[20, 6],
			[40, 12],
		] as const) {
			const lines = renderSplashFrame(state(), w, h, 100);
			expect(lines).toHaveLength(h);
			for (const line of lines) expect(visibleWidth(line)).toBe(w);
		}
	});
});
