import { describe, expect, it } from "bun:test";
import {
	FINALE_BURST_MS,
	type FinaleResult,
	type FinaleState,
	headlineForm,
	renderFinaleFrame,
} from "../src/gk/finale";
import { visibleWidth } from "../src/utils";

const plain = (lines: string[]): string[] => lines.map(line => Bun.stripANSI(line));
const PARTICLE = /[✦*+·]/;

const SUCCESS: FinaleResult = {
	kind: "success",
	caption: "bun test passed in 4.2s",
	rows: [
		{ label: "duration", value: "12m 04s" },
		{ label: "cost", value: "$0.42" },
		{ label: "files changed", value: "3 (+120 −8)" },
		{ label: "verify", value: "bun test · 4.2s" },
	],
};

const FAILURE: FinaleResult = {
	kind: "failure",
	caption: "bun test exited 1 after 2.1s",
	failures: [{ label: "bun test", detail: "exit 1 · 2.1s" }],
	output: Array.from({ length: 14 }, (_, i) => `out ${i}`),
	outputTitle: "bun test",
};

const frame = (state: Omit<FinaleState, "colorMode">, width: number, height: number, t = 0): string[] =>
	renderFinaleFrame({ ...state, colorMode: "truecolor" }, width, height, t);

describe("renderFinaleFrame", () => {
	for (const [width, height] of [
		[212, 58],
		[80, 24],
	] as const) {
		describe(`${width}×${height}`, () => {
			const states: Array<[string, Omit<FinaleState, "colorMode">, number]> = [
				["burst", { result: SUCCESS, phase: "headline" }, 600],
				["burst end", { result: SUCCESS, phase: "headline" }, FINALE_BURST_MS],
				["static", { result: SUCCESS, phase: "headline", motion: false }, 600],
				["summary", { result: SUCCESS, phase: "summary" }, 0],
				["failure", { result: FAILURE, phase: "headline" }, 0],
			];
			for (const [name, state, t] of states) {
				it(`${name}: exactly ${height} rows of ${width} columns`, () => {
					const rows = frame(state, width, height, t);
					expect(rows).toHaveLength(height);
					for (const row of rows) expect(visibleWidth(row)).toBe(width);
				});
			}

			it("bursts particles mid-animation, none once it ends or with motion off", () => {
				const text = (t: number, motion?: boolean) =>
					plain(frame({ result: SUCCESS, phase: "headline", motion }, width, height, t)).join("\n");
				expect(text(600)).toMatch(PARTICLE);
				expect(text(FINALE_BURST_MS).replace("any key to continue", "")).not.toMatch(PARTICLE);
				expect(text(600, false).replace("any key to continue", "")).not.toMatch(PARTICLE);
				// Deterministic: the same time gives the same frame.
				expect(text(600)).toBe(text(600));
			});

			it("draws the headline in block letters with the caption under it", () => {
				const rows = plain(frame({ result: SUCCESS, phase: "headline", motion: false }, width, height));
				expect(rows.some(row => row.includes("█"))).toBe(true);
				expect(rows.some(row => row.includes("bun test passed in 4.2s"))).toBe(true);
			});

			it("shows the summary card", () => {
				const text = plain(frame({ result: SUCCESS, phase: "summary" }, width, height)).join("\n");
				expect(text).toContain("┌─ bun test passed in 4.2s");
				expect(text).toMatch(/│ files changed +3 \(\+120 −8\)/);
				expect(text).toContain("any key to close");
			});

			it("lists what failed and the last 10 output lines", () => {
				const text = plain(frame({ result: FAILURE, phase: "headline" }, width, height)).join("\n");
				expect(text).toContain("✗ bun test  exit 1 · 2.1s");
				expect(text).toContain("bun test · last 10 lines");
				expect(text).toContain("out 13");
				expect(text).toContain("out 4");
				expect(text).not.toMatch(/out 3\b/);
				expect(text).not.toContain("✦");
			});
		});
	}

	it("wraps to two lines on narrow screens and falls back to bold text below 60 columns", () => {
		expect(headlineForm("BUILD SUCCESSFUL", 212, 58)).toEqual({
			kind: "pixel",
			scale: 2,
			lines: ["BUILD SUCCESSFUL"],
		});
		expect(headlineForm("BUILD SUCCESSFUL", 120, 40)).toEqual({
			kind: "pixel",
			scale: 2,
			lines: ["BUILD", "SUCCESSFUL"],
		});
		expect(headlineForm("BUILD SUCCESSFUL", 80, 24)).toEqual({
			kind: "pixel",
			scale: 1,
			lines: ["BUILD SUCCESSFUL"],
		});
		expect(headlineForm("BUILD SUCCESSFUL", 70, 24)).toEqual({
			kind: "pixel",
			scale: 1,
			lines: ["BUILD", "SUCCESSFUL"],
		});
		expect(headlineForm("BUILD SUCCESSFUL", 59, 24)).toEqual({ kind: "text" });
		const rows = frame({ result: SUCCESS, phase: "headline", motion: false }, 50, 20);
		for (const row of rows) expect(visibleWidth(row)).toBe(50);
		expect(rows.find(row => Bun.stripANSI(row).includes("BUILD SUCCESSFUL"))).toContain("\x1b[1m");
	});
});
