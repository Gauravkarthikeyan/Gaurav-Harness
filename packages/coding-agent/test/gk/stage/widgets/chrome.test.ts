import { describe, expect, it } from "bun:test";
import { stripTerminalSequences } from "@oh-my-pi/pi-tui";
import { bold } from "../../../../src/gk/stage/widgets/common";
import { renderHeader } from "../../../../src/gk/stage/widgets/header";
import { renderPaneStatus } from "../../../../src/gk/stage/widgets/pane-status";
import { renderStatusBar } from "../../../../src/gk/stage/widgets/statusbar";
import { renderTabs } from "../../../../src/gk/stage/widgets/tabs";
import * as F from "./fixtures";
import { expectExact, expectExactAcrossSizes, identity, sgr, trimmed } from "./helpers";

describe("renderHeader", () => {
	it("lays out logo, field columns and the clock block", () => {
		const rows = renderHeader(F.header, 160, 2, identity);
		expectExact(rows, 160, 2);
		expect(trimmed(rows)).toEqual([
			` </> GK   SESSION gk-7f3a2c     BRANCH main ↑2 ✱4 ?1          RUN   ${bold("$0.42")} / $2.00 ▕██▁▁▁▁▁▁▁▁▏ 21%${" ".repeat(53)}${bold("03:11:42")}`,
			`     ──   MODE    ● ORCHESTRA   UPTIME 00:14:22 · pid 48190   SAVED −88% vs opus-only${" ".repeat(41)}TODAY $1.84 · 6 runs · SUN 15 NOV`,
		]);
	});

	it("shows every column when wide and drops low-priority ones when narrow", () => {
		const wide = renderHeader(F.header, 260, 2, identity).join("\n");
		for (const label of ["SESSION", "HOST", "CWD", "BRANCH", "RUN", "SAVED", "CTX", "CACHE"]) {
			expect(wide).toContain(label);
		}
		expect(wide).toContain("34k/200k");
		const narrow = renderHeader(F.header, 90, 2, identity).join("\n");
		expect(narrow).toContain("SESSION");
		expect(narrow).not.toContain("HOST");
		expect(narrow).toContain("03:11:42");
	});

	it("puts TODAY under cost when there is no SAVED figure", () => {
		const rows = renderHeader(
			{ ...F.header, saved: undefined, cost: { label: "SESSION", spent: "$0.27" } },
			200,
			2,
			identity,
		);
		expect(rows[1]).toContain("TODAY   $1.84 · 6 runs");
		expect(rows[1]!.trimEnd().endsWith("SUN 15 NOV")).toBe(true);
		expect(rows[0]).toContain(`SESSION ${bold("$0.27")}`);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderHeader(F.header, w, h, sgr));
	});
});

describe("renderTabs", () => {
	it("renders windows with the active one marked and a grouped summary", () => {
		const rows = renderTabs(F.tabs, 120, 1, identity);
		expectExact(rows, 120, 1);
		expect(trimmed(rows)).toEqual([
			` ${bold("0:stage*")}  1:crew  2:logs  3:git  4:pty:claude${" ".repeat(21)}● 2 running  ○ 1 queued  ✓ 1 done │ plan#1 · 4 items`,
		]);
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderTabs(F.tabs, w, h, sgr));
	});
});

describe("renderStatusBar", () => {
	it("renders the status and key-hint rows", () => {
		const rows = renderStatusBar(F.statusBar, 140, 2, identity);
		expectExact(rows, 140, 2);
		expect(trimmed(rows)).toEqual([
			` [gk]  0:stage*  ⎇ main ↑2  MCP 3/4 · skills 19${" ".repeat(35)}✱ opus-5.5 conductor  crew 2▶1○1✓  $0.42  03:11 15-Nov-26`,
			` ^K palette  ⏎ zoom pane  ^O expand  M-a agent hub  ? help${" ".repeat(68)}gk-code 0.1.0`,
		]);
	});

	it("drops low-priority segments when narrow and never mentions omp", () => {
		const rows = renderStatusBar(F.statusBar, 60, 2, identity);
		expect(trimmed(rows)).toEqual([
			" [gk]  0:stage*    ✱ opus-5.5 conductor  crew 2▶1○1✓  $0.42",
			" ^K palette  ⏎ zoom pane  ^O expand           gk-code 0.1.0",
		]);
		for (const w of [40, 80, 212]) {
			expect(stripTerminalSequences(renderStatusBar(F.statusBar, w, 2, sgr).join("\n"))).not.toContain("omp");
		}
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderStatusBar(F.statusBar, w, h, sgr));
	});
});

describe("renderPaneStatus", () => {
	it("renders all segments when they fit", () => {
		const rows = renderPaneStatus(F.paneStatus, 90, 1, identity);
		expectExact(rows, 90, 1);
		expect(trimmed(rows)).toEqual(["⎇ main  ✱ haiku-5.5  § 61.2k  $0.03  ◷ 18,402 (18%)  scope src/api/"]);
	});

	it("drops branch, tokens and scope first when narrow", () => {
		expect(trimmed(renderPaneStatus(F.paneStatus, 40, 1, identity))).toEqual(["✱ haiku-5.5  $0.03  ◷ 18,402 (18%)"]);
	});

	it("leads with the agent name and marks a dirty branch", () => {
		const [row] = renderPaneStatus(
			{ agent: "ada", branch: "main", dirty: true, model: "haiku-5.5" },
			40,
			1,
			identity,
		);
		expect(row!.trimEnd()).toBe("ada  ⎇ main ●  ✱ haiku-5.5");
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderPaneStatus(F.paneStatus, w, h, sgr));
	});
});
