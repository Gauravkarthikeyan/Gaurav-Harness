import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { plainStyle } from "../../../src/gk/stage/style";
import { renderTranscriptPane, type TranscriptPaneInput } from "../../../src/gk/stage/transcript-pane";
import { renderPaneStatus } from "../../../src/gk/stage/widgets/pane-status";

const block = (rows: string[]): Component => ({ render: () => rows, invalidate: () => {} });

function input(overrides: Partial<TranscriptPaneInput>): TranscriptPaneInput {
	return {
		blocks: [],
		chrome: [],
		tool: () => undefined,
		isAssistant: () => false,
		expandTools: false,
		scroll: 0,
		lineContext: { now: 0 },
		seenAt: () => 0,
		style: plainStyle,
		...overrides,
	};
}

describe("renderTranscriptPane", () => {
	it("pins the pane statusline and mode line under the composer", () => {
		const status = renderPaneStatus(
			{
				branch: "main",
				model: "gpt-5.6-luna",
				effort: "high",
				tokens: "15.1k tok",
				cost: "$0.00",
				ctx: { used: 15_140, limit: 272_000 },
				modeLine: { mode: "INSERT", tools: 0, editedFiles: 0 },
			},
			80,
			2,
			plainStyle,
		);
		const out = renderTranscriptPane(
			input({
				blocks: [block(["notice"])],
				chrome: [block([`❯ hi${CURSOR_MARKER}`])],
				status,
			}),
			80,
			6,
		);
		expect(out.rows.map(r => r.trimEnd())).toEqual([
			"notice",
			"",
			"",
			"❯ hi",
			"⎇ main  ✱ gpt-5.6-luna · high  § 15.1k tok  $0.00  ◷ 15,140 (6%)",
			"-- INSERT --  tools 0 · edits 0 files",
		]);
		expect(out.cursor).toEqual({ row: 3, col: 4 });
	});
});
