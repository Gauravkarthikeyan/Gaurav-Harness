import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { CrewApprovalRequest } from "../../src/gk/crew-tools";
import { castCrew, type WorkItem } from "../../src/gk/router";
import { CastingBoard, formatUsd, savingsLabel } from "../../src/gk/ui/casting-board";
import { CONDUCTOR, item, ROSTER, tick } from "./crew-fixtures";
import { sgr } from "./stage/widgets/helpers";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

function request(items: WorkItem[] = [item("W-01"), item("W-02")], maxRunUsd?: number): CrewApprovalRequest {
	const cast = castCrew(items, ROSTER, CONDUCTOR, { maxRunUsd });
	const names = Object.fromEntries(items.map((it, i) => [it.id, ["CalmPanda", "SwiftOtter", "BoldHeron"][i]!]));
	return { planNumber: 1, items, cast, names, roster: ROSTER, conductor: CONDUCTOR, maxRunUsd };
}

describe("formatUsd", () => {
	it("formats plan, zero, tiny and normal amounts, never NaN", () => {
		expect(formatUsd(0, true)).toBe("plan");
		expect(formatUsd(0)).toBe("$0.00");
		expect(formatUsd(Number.NaN)).toBe("$0.00");
		expect(formatUsd(0.004)).toBe("<$0.01");
		expect(formatUsd(1.234)).toBe("$1.23");
	});

	it("labels savings and overruns", () => {
		expect(savingsLabel(0.5, 4)).toBe("−88%");
		expect(savingsLabel(5, 4)).toBe("+25%");
		expect(savingsLabel(1, 0)).toBe("–");
	});
});

describe("CastingBoard", () => {
	it("renders every row (item, worker, model, est) and the footer at exact widths", () => {
		for (const width of [60, 100, 132, 212]) {
			const rows = new CastingBoard(request(), { style: sgr }).render(width);
			for (const row of rows) expect(visibleWidth(row)).toBe(width);
		}
		const text = new CastingBoard(request()).render(100).join("\n");
		for (const needle of [
			"W-01 title W-01",
			"W-02 title W-02",
			"@CalmPanda",
			"@SwiftOtter",
			"cheap/one",
			"docs",
			"total",
			"conductor-only",
			"saves",
			"⏎ approve",
		]) {
			expect(text).toContain(needle);
		}
		expect(text).toMatch(/−\d+% vs baseline/);
	});

	it("Enter approves the cast", async () => {
		const board = new CastingBoard(request());
		board.handleInput(ENTER);
		const result = await board.result;
		expect(result.approved).toBe(true);
		if (result.approved) expect(result.cast.assignments.map(a => a.itemId)).toEqual(["W-01", "W-02"]);
	});

	it("x drops the selected row and re-scores the totals", async () => {
		const req = request();
		const board = new CastingBoard(req);
		board.handleInput(DOWN);
		board.handleInput("x");
		expect(board.render(100).join("\n")).not.toContain("W-02 title");
		board.handleInput(ENTER);
		const result = await board.result;
		if (!result.approved) throw new Error("expected approval");
		expect(result.cast.assignments.map(a => a.itemId)).toEqual(["W-01"]);
		expect(result.cast.baselineEstUsd).toBeLessThan(req.cast.baselineEstUsd);
	});

	it("r collects a note and Enter rejects with it", async () => {
		const board = new CastingBoard(request());
		board.handleInput("r");
		for (const ch of "one item") board.handleInput(ch);
		board.handleInput("\x7f");
		expect(board.render(100).join("\n")).toContain("reject note ❯ one ite");
		board.handleInput(ENTER);
		expect(await board.result).toEqual({ approved: false, note: "one ite" });
	});

	it("over budget: Enter alone does nothing, ! then Enter approves", async () => {
		const board = new CastingBoard(request(undefined, 0.0001));
		expect(board.render(100).join("\n")).toContain("press ! then ⏎");
		let settled = false;
		void board.result.then(() => {
			settled = true;
		});
		board.handleInput(ENTER);
		await tick();
		expect(settled).toBe(false);
		board.handleInput("!");
		board.handleInput(ENTER);
		const result = await board.result;
		expect(result.approved).toBe(true);
	});

	it("e opens the roster picker (cheapest first) and re-casts the row", async () => {
		const board = new CastingBoard(request());
		board.handleInput("e");
		const picker = board.render(100).join("\n");
		expect(picker).toContain("roster only");
		expect(picker.indexOf("cheap/one")).toBeLessThan(picker.indexOf("top/three"));
		board.handleInput(DOWN);
		board.handleInput(ENTER);
		expect(board.cast().assignments[0]).toMatchObject({
			selector: "mid/two",
			tier: 2,
			reason: "chosen on the Casting Board",
		});
		board.handleInput(ESC);
		expect(await board.result).toMatchObject({ approved: false });
	});

	it("a approves and turns on auto-approve", async () => {
		const board = new CastingBoard(request());
		board.handleInput("a");
		expect(await board.result).toMatchObject({ approved: true, autoApprove: true });
	});
});
