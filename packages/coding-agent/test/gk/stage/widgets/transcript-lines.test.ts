import { describe, expect, it } from "bun:test";
import {
	renderDiffBlock,
	renderEventLines,
	renderPlanTable,
	renderTranscript,
} from "../../../../src/gk/stage/widgets/transcript-lines";
import * as F from "./fixtures";
import { expectExact, expectExactAcrossSizes, identity, sgr, trimmed } from "./helpers";

describe("renderEventLines", () => {
	it("renders time, glyph, text, right-aligned metric and continuation rows", () => {
		const rows = renderEventLines(F.events, 60, 6, identity);
		expectExact(rows, 60, 6);
		expect(trimmed(rows)).toEqual([
			"03:10:02 ✓ read src/server.ts                           0.1s",
			"03:10:41 ✓ edit src/api/routes.ts                     +12 −3",
			"03:11:02 ● verifying @ada",
			"         route matches the existing router style",
			"03:11:38 ● bash bun test api                      → pane 0.3",
			"",
		]);
	});

	it("colors +N and −N metric words", () => {
		const seen: string[] = [];
		renderEventLines([F.events[1]!], 60, 1, (token, text) => {
			seen.push(`${token}:${text}`);
			return text;
		});
		expect(seen).toContain("success:+12");
		expect(seen).toContain("error:−3");
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderEventLines(F.events, w, h, sgr));
	});
});

describe("renderDiffBlock", () => {
	it("renders line numbers, signs and add/del backgrounds across the full width", () => {
		const rows = renderDiffBlock(F.diff, 50, 3, identity);
		expectExact(rows, 50, 3);
		expect(trimmed(rows)).toEqual([
			'    41    router.get("/health", health)',
			"    42  − // TODO: hello endpoint",
			'    42  + router.get("/hello", hello)',
		]);
		const bgs: string[] = [];
		renderDiffBlock(F.diff, 50, 3, (token, text) => {
			if (token === "diffAddBg" || token === "diffDelBg") bgs.push(`${token}:${text.length}`);
			return text;
		});
		expect(bgs).toEqual(["diffDelBg:50", "diffAddBg:50"]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderDiffBlock(F.diff, w, h, sgr));
	});
});

describe("renderPlanTable", () => {
	it("renders the plan card with all columns when wide", () => {
		const rows = renderPlanTable(F.plan, 70, 6, identity);
		expectExact(rows, 70, 6);
		expect(rows).toEqual([
			"┌─ PLAN #1 · 4 items · 2 waves ─────────────────── −88% vs baseline ─┐",
			"│ ID    OWNER   MODEL       SCOPE     STATE                          │",
			"│ W-01  @ada    haiku-5.5   src/api/  ● run 1:12                     │",
			"│ W-03  @grace  sonnet-5.5  test/     ○ ← W-01 W-02                  │",
			"│ W-04  @wren   gemma-3-1b  docs/     ✓ done $0.00                   │",
			"└────────────────────────────────────────────────────────────────────┘",
		]);
	});

	it("drops SCOPE and OWNER, then the note, when narrow", () => {
		expect(renderPlanTable(F.plan, 40, 6, identity)).toEqual([
			"┌─ PLAN #1 · 4 items · 2 waves ────────┐",
			"│ ID    MODEL       STATE              │",
			"│ W-01  haiku-5.5   ● run 1:12         │",
			"│ W-03  sonnet-5.5  ○ ← W-01 W-02      │",
			"│ W-04  gemma-3-1b  ✓ done $0.00       │",
			"└──────────────────────────────────────┘",
		]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderPlanTable(F.plan, w, h, sgr));
	});
});

describe("renderTranscript", () => {
	const blocks = [
		{ kind: "event" as const, event: F.events[0]! },
		{ kind: "diff" as const, diff: F.diff },
		{ kind: "plan" as const, plan: F.plan },
		{ kind: "event" as const, event: F.events[3]! },
	];

	it("keeps the newest rows when blocks overflow", () => {
		const rows = renderTranscript(blocks, 60, 2, identity);
		expect(trimmed(rows)).toEqual([
			"└──────────────────────────────────────────────────────────┘",
			"03:11:38 ● bash bun test api                      → pane 0.3",
		]);
	});

	it("pads below when blocks fit", () => {
		const rows = renderTranscript(blocks.slice(0, 1), 60, 3, identity);
		expect(trimmed(rows)).toEqual(["03:10:02 ✓ read src/server.ts                           0.1s", "", ""]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderTranscript(blocks, w, h, sgr));
	});
});
