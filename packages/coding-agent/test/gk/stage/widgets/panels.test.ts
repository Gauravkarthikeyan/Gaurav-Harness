import { describe, expect, it } from "bun:test";
import { agentToken, sparkline, strike } from "../../../../src/gk/stage/widgets/common";
import { renderDag } from "../../../../src/gk/stage/widgets/dag";
import { renderEvents } from "../../../../src/gk/stage/widgets/events";
import { renderGit } from "../../../../src/gk/stage/widgets/git";
import { renderProc } from "../../../../src/gk/stage/widgets/proc";
import { renderThroughput } from "../../../../src/gk/stage/widgets/sparkline";
import { renderTelemetry } from "../../../../src/gk/stage/widgets/telemetry";
import { renderTodo } from "../../../../src/gk/stage/widgets/todo";
import * as F from "./fixtures";
import { expectExact, expectExactAcrossSizes, identity, sgr, trimmed } from "./helpers";

describe("common", () => {
	it("sparkline scales to the window max and left-pads short series", () => {
		expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8)).toBe("▁▂▃▄▅▆▇█");
		expect(sparkline([7, 7], 4, 7)).toBe("  ██");
		expect(sparkline([1, 2, 3, 4, 5], 2)).toBe("▇█");
		expect(sparkline([0, 0], 2)).toBe("▁▁");
	});

	it("agentToken cycles through six hues", () => {
		expect([0, 1, 5, 6, -1].map(agentToken)).toEqual(["agent1", "agent2", "agent6", "agent1", "agent6"]);
	});
});

describe("renderProc", () => {
	it("renders the proc table with dashes for missing values", () => {
		const rows = renderProc(F.proc, 46, 4, identity);
		expectExact(rows, 46, 4);
		expect(trimmed(rows)).toEqual([
			"PID    AGENT  MODEL       TOK/S  S   TIME",
			"48190  cond   opus-5.5       94  R  02:14",
			"48213  bun    test api        –  R  00:04",
			"    –  grace  sonnet-5.5      –  Q      –",
		]);
	});

	it("drops MODEL first when narrow", () => {
		expect(trimmed(renderProc(F.proc, 30, 2, identity))).toEqual([
			"PID    AGENT  TOK/S  S   TIME",
			"48190  cond      94  R  02:14",
		]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderProc(F.proc, w, h, sgr));
	});
});

describe("renderThroughput", () => {
	it("draws per-agent sparklines on a shared scale with a bottom footer", () => {
		const rows = renderThroughput(F.throughput, 24, 4, identity);
		expectExact(rows, 24, 4);
		expect(trimmed(rows)).toEqual(["cond       ▁▂▃▄▅▆▇█    7", "ada            ████    7", "", "cache hit 72%"]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderThroughput(F.throughput, w, h, sgr));
	});
});

describe("renderTelemetry", () => {
	it("draws tok/s, ctx and $/min sparklines plus the io line", () => {
		const rows = renderTelemetry(F.telemetry, 36, 4, identity);
		expectExact(rows, 36, 4);
		expect(trimmed(rows)).toEqual([
			"tok/s                       ▂▃▅█  94",
			"ctx                          ▁▁▂  9%",
			"$/min                        ▁▁█ .04",
			"in 162.1k · out 26.3k · cached 131k",
		]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderTelemetry(F.telemetry, w, h, sgr));
	});
});

describe("renderTodo", () => {
	it("strikes done items and marks the current one", () => {
		const rows = renderTodo(F.todo, 30, 3, identity);
		expectExact(rows, 30, 3);
		expect(trimmed(rows)).toEqual([`✓ ${strike("reproduce loop with curl")}`, "● regression test green", "○ ship"]);
	});

	it("scrolls to keep the current item visible", () => {
		const items = Array.from({ length: 10 }, (_, i) => ({
			text: `step ${i}`,
			state: i < 7 ? ("done" as const) : i === 7 ? ("current" as const) : ("pending" as const),
		}));
		const rows = trimmed(renderTodo({ items }, 20, 3, identity));
		expect(rows).toEqual([`✓ ${strike("step 6")}`, "● step 7", "○ step 8"]);
		expect(trimmed(renderTodo({ items }, 20, 2, identity))).toEqual(["● step 7", "○ step 8"]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderTodo(F.todo, w, h, sgr));
	});
});

describe("renderDag", () => {
	it("draws a fan-in bracket into the target plus the legend", () => {
		const rows = renderDag(F.dag, 46, 5, identity);
		expectExact(rows, 46, 5);
		expect(trimmed(rows)).toEqual([
			"W-04 @wren  ✓ ──┐",
			"W-01 @ada   ● ──┼──▶ W-03 @grace ○",
			"W-02 @linus ● ──┘",
			"● run  ○ wait  ✓ done  ✗ fail",
			"",
		]);
	});

	it("handles single edges, two-way fan-in and isolated nodes", () => {
		const rows = renderDag(
			{
				nodes: [
					{ id: "A", state: "done" },
					{ id: "B", state: "failed" },
					{ id: "C", state: "queued" },
					{ id: "D", state: "queued" },
					{ id: "E", state: "running" },
				],
				edges: [
					{ from: "A", to: "C" },
					{ from: "A", to: "D" },
					{ from: "B", to: "D" },
				],
				legend: false,
			},
			30,
			5,
			identity,
		);
		expect(trimmed(rows)).toEqual(["E ●", "A ✓ ─────▶ C ○", "A ✓ ──┐", "B ✗ ──┴──▶ D ○", ""]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderDag(F.dag, w, h, sgr));
	});
});

describe("renderGit", () => {
	it("renders graph lines then file rows with diffstat bars", () => {
		const rows = renderGit(F.git, 46, 6, identity);
		expectExact(rows, 46, 6);
		expect(trimmed(rows)).toEqual([
			"* a3f9c1e (HEAD→main) add health check",
			"* 77e0b21 split api module",
			"│",
			"M src/api/routes.ts  ▇▒          +12 −3",
			"A src/ui/Hello.tsx   ▇▇▇▇▇▇▇▇▇▇  +64",
			"D old.ts             ▒           −8",
		]);
	});

	it("drops the bar before the path gets too short", () => {
		const rows = trimmed(renderGit({ graph: [], files: F.git.files }, 24, 1, identity));
		expect(rows).toEqual(["M src/api/route…  +12 −3"]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderGit(F.git, w, h, sgr));
	});
});

describe("renderEvents", () => {
	it("renders tail -f rows with the agent column in its hue", () => {
		const tokens: string[] = [];
		const rows = renderEvents(
			{ rows: [{ ...F.eventsPanel.rows[0]!, agentToken: "agent2" }, ...F.eventsPanel.rows.slice(1)] },
			46,
			3,
			(token, text) => {
				if (text.trim() === "ada") tokens.push(token);
				return text;
			},
		);
		expectExact(rows, 46, 3);
		expect(tokens).toEqual(["agent2"]);
		expect(trimmed(rows)).toEqual([
			"03:11:42 ● ada    bash bun test api",
			"03:11:31 ✓ scout  done → linus",
			"03:04:51 ! mcp    grovv 401",
		]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderEvents(F.eventsPanel, w, h, sgr));
	});
});
