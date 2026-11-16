import { describe, expect, it } from "bun:test";
import { stripTerminalSequences } from "@oh-my-pi/pi-tui";
import { bold } from "../../../../src/gk/stage/widgets/common";
import { formatBranch, headerWidth, renderHeader } from "../../../../src/gk/stage/widgets/header";
import { renderPaneStatus } from "../../../../src/gk/stage/widgets/pane-status";
import { renderStatusBar } from "../../../../src/gk/stage/widgets/statusbar";
import { renderTabs } from "../../../../src/gk/stage/widgets/tabs";
import * as F from "./fixtures";
import { expectExact, expectExactAcrossSizes, identity, sgr, trimmed } from "./helpers";

/** Solo header at 212 columns with branch `feature/stage-header-overflow-fix`, 2 ahead, 24 dirty: every field shows. */
const GOLDEN_212 = [
	` </>  G A U R A V ' S   H A R N E S S  SESSION gk-7f3a2c  HOST Gauravs-MacBook-Pro · arm64  BRANCH feature/stage-hea… ↑2 ±24  SESSION ${bold("$12.34 · 1.2m tok · 345 calls")}  CTX   15% ▕█▁▁▁▁▁▁▁▁▁▏ 148.9k/1.0m    ${bold("03:11:42")}`,
	"                                       MODE    ● SOLO     CWD  ~/Developer/Gk-code          UPTIME 01:02:03                   TODAY   $41.07                         CACHE 72% hit                       SUN 15 NOV",
];

describe("renderHeader", () => {
	it("lays out logo, field columns and the clock block", () => {
		const rows = renderHeader(F.header, 160, 2, identity);
		expectExact(rows, 160, 2);
		expect(trimmed(rows)).toEqual([
			` </> GK  SESSION gk-7f3a2c    HOST MacBook-Air · arm64  BRANCH main ↑2 ✱4 ?1         RUN   ${bold("$0.42")} / $2.00 ▕██▁▁▁▁▁▁▁▁▏ 21%${" ".repeat(30)}${bold("03:11:42")}`,
			`     ──  MODE    ● ORCHESTRA  CWD  ~/Developer/Gk-code  UPTIME 00:14:22 · pid 48190  SAVED −88% vs opus-only${" ".repeat(18)}TODAY $1.84 · 6 runs · SUN 15 NOV`,
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
		expect(narrow).not.toContain("CTX");
		expect(narrow).not.toContain("BRANCH");
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

	describe("with a long dirty branch (Solo)", () => {
		const solo = {
			...F.header,
			logo: ["</>  G A U R A V ' S   H A R N E S S", ""],
			mode: "SOLO",
			host: "Gauravs-MacBook-Pro · arm64",
			branch: formatBranch("feature/stage-header-overflow-fix", 2, 24),
			uptime: "01:02:03",
			cost: { label: "SESSION" as const, spent: "$12.34 · 1.2m tok · 345 calls" },
			saved: undefined,
			today: "$41.07",
			ctx: { used: 148_900, limit: 1_000_000, label: "148.9k/1.0m" },
		};

		it("cuts the branch name and collapses dirty counts", () => {
			expect(formatBranch("feature/stage-header-overflow-fix", 2, 24)).toBe("feature/stage-hea… ↑2 ±24");
			expect(formatBranch("main", 0, 0)).toBe("main");
			expect(formatBranch("main", 0, 3)).toBe("main ±3");
		});

		it("keeps every field at 212 columns (golden)", () => {
			const rows = renderHeader(solo, 212, 2, identity);
			expectExact(rows, 212, 2);
			expect(trimmed(rows)).toEqual(GOLDEN_212);
		});

		it("keeps every field at ≥200 columns once the logo is unspaced", () => {
			expect(headerWidth(solo)).toBeLessThanOrEqual(212);
			const plainLogo = { ...solo, logo: ["</>  GAURAV'S HARNESS", ""] };
			expect(headerWidth(plainLogo)).toBeLessThanOrEqual(200);
			const text = renderHeader(plainLogo, 200, 2, identity).join("\n");
			for (const label of ["SESSION", "MODE", "HOST", "CWD", "BRANCH", "UPTIME", "TODAY", "CTX", "CACHE"]) {
				expect(text).toContain(label);
			}
		});

		it("draws TODAY in the warning colour over budget", () => {
			const tokens: string[] = [];
			renderHeader({ ...solo, todayWarning: true }, 212, 2, (token, text) => {
				if (text === "$41.07") tokens.push(token);
				return text;
			});
			expect(tokens).toEqual(["warning"]);
		});

		it("puts the budget notice in row 2's free space only when it fits whole", () => {
			const notice = "! Daily budget reached: $41.07 spent today of $40.00 (gk.budget.dailyUsd)";
			const warned: string[] = [];
			const style = (token: string, text: string) => {
				if (token === "warning") warned.push(text);
				return text;
			};
			const wide = renderHeader({ ...solo, todayWarning: true, notice }, 300, 2, style);
			expectExact(wide, 300, 2);
			expect(wide[1]).toContain(`${notice}  SUN 15 NOV`);
			expect(warned).toContain(notice);
			// At 212 the fields leave too little room: TODAY still turns warning, nothing is cut mid-word.
			const tight = renderHeader({ ...solo, todayWarning: true, notice }, 212, 2, identity);
			expect(trimmed(tight)).toEqual(GOLDEN_212);
		});
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
			` ${bold(" 0:stage* ")}  1:crew   2:logs   3:git   4:pty:claude ${" ".repeat(15)}● 2 running  ○ 1 queued  ✓ 1 done │ plan#1 · 4 items`,
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
			`  ^K  palette   ⏎  zoom pane   ^O  expand   M-a  agent hub   ?  help${" ".repeat(58)}gk-code 0.1.0`,
		]);
	});

	it("drops low-priority segments when narrow and never mentions omp", () => {
		const rows = renderStatusBar(F.statusBar, 60, 2, identity);
		expect(trimmed(rows)).toEqual([
			" [gk]  0:stage*    ✱ opus-5.5 conductor  crew 2▶1○1✓  $0.42",
			"  ^K  palette   ⏎  zoom pane   ^O  expand     gk-code 0.1.0",
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

	it("adds the effort after the model and a composer mode line on the second row", () => {
		const rows = renderPaneStatus(
			{
				branch: "main",
				dirty: true,
				model: "gpt-5.6-luna",
				effort: "high",
				tokens: "15.1k tok",
				cost: "$0.00",
				ctx: { used: 15_140, limit: 272_000 },
				modeLine: { mode: "INSERT", tools: 3, editedFiles: 1 },
			},
			100,
			2,
			identity,
		);
		expectExact(rows, 100, 2);
		expect(trimmed(rows)).toEqual([
			"⎇ main ●  ✱ gpt-5.6-luna · high  § 15.1k tok  $0.00  ◷ 15,140 (6%)",
			"-- INSERT --  tools 3 · edits 1 file",
		]);
		expect(
			trimmed(renderPaneStatus({ modeLine: { mode: "INSERT", tools: 0, editedFiles: 2 } }, 60, 2, identity))[1],
		).toBe("-- INSERT --  tools 0 · edits 2 files");
	});

	it("is width/height exact with styled text", () => {
		expectExactAcrossSizes((w, h) => renderPaneStatus(F.paneStatus, w, h, sgr));
	});
});
