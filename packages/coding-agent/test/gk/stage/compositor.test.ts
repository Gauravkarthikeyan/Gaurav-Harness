import { describe, expect, it } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@oh-my-pi/pi-tui";
import { CellBuffer, drawFrame, type FramePart, paneTitle } from "../../../src/gk/stage/compositor";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

describe("CellBuffer", () => {
	it("blits ANSI-colored text at an offset with exact row widths", () => {
		const buf = new CellBuffer(20, 3);
		buf.blit([`${RED}hello${RESET} world`, "\x1b[1mbold"], { x: 4, y: 1, w: 10, h: 2 });
		const lines = buf.toLines();
		for (const line of lines) expect(visibleWidth(line)).toBe(20);
		expect(stripTerminalSequences(lines[1])).toBe("    hello worl      ");
		expect(lines[1]).toBe(`    ${RED}hello${RESET} worl      `);
		expect(lines[2]).toBe(`    \x1b[1mbold${RESET}${" ".repeat(12)}`);
	});

	it("does not let a wide CJK char overflow the rect boundary", () => {
		const buf = new CellBuffer(8, 1);
		buf.blit(["XXXXXXXX"], { x: 0, y: 0, w: 8, h: 1 });
		buf.blit(["abcd中"], { x: 0, y: 0, w: 5, h: 1 });
		const [line] = buf.toLines();
		expect(line).toBe("abcd XXX");
		expect(visibleWidth(line)).toBe(8);
	});

	it("keeps wide chars that fit and repairs halves broken by overwrites", () => {
		const buf = new CellBuffer(6, 1);
		buf.blit(["中文字"], { x: 0, y: 0, w: 6, h: 1 });
		expect(buf.toLines()[0]).toBe("中文字");
		buf.blit(["x"], { x: 3, y: 0, w: 1, h: 1 });
		const [line] = buf.toLines();
		expect(line).toBe("中 x字");
		expect(visibleWidth(line)).toBe(6);
	});

	it("drops non-SGR escapes and keeps SGR across resets", () => {
		const buf = new CellBuffer(6, 1);
		buf.blit(["\x1b]8;;http://x\x07ab\x1b]8;;\x07\x1b[2Kc\x1b[0;32md"], { x: 0, y: 0, w: 6, h: 1 });
		expect(buf.toLines()[0]).toBe(`abc\x1b[32md${RESET}  `);
	});

	it("normalizes SGR per cell so long styled rows stay short", () => {
		const buf = new CellBuffer(200, 1);
		// 200 cells, each toggling colors: the source carries 400 escapes.
		const line = Array.from({ length: 200 }, (_, i) => `\x1b[38;2;${i};0;0m\x1b[48;5;${i % 2}m█\x1b[49m`).join("");
		buf.blit([line], { x: 0, y: 0, w: 200, h: 1 });
		expect(buf.cell(5, 0)?.sgr).toBe("\x1b[38;2;5;0;0;48;5;1m");
		const [out] = buf.toLines();
		expect(visibleWidth(out)).toBe(200);
		expect(out.length).toBeLessThan(200 * 32);
	});

	it("resets attributes slot by slot", () => {
		const buf = new CellBuffer(4, 1);
		buf.blit(["\x1b[1;2;31ma\x1b[22mb\x1b[39;4mc\x1b[24md"], { x: 0, y: 0, w: 4, h: 1 });
		expect([0, 1, 2, 3].map(x => buf.cell(x, 0)?.sgr)).toEqual(["\x1b[1;2;31m", "\x1b[31m", "\x1b[4m", ""]);
	});

	it("paints unset backgrounds and blanks with the base style", () => {
		const BASE = "\x1b[48;2;0;0;0m";
		const buf = new CellBuffer(6, 2, BASE);
		buf.blit([`${RED}ab\x1b[49m\x1b[44mc\x1b[49md`], { x: 0, y: 0, w: 4, h: 1 });
		expect(buf.cell(0, 0)?.sgr).toBe("\x1b[31;48;2;0;0;0m");
		expect(buf.cell(2, 0)?.sgr).toBe("\x1b[31;44m");
		expect(buf.cell(3, 0)?.sgr).toBe("\x1b[31;48;2;0;0;0m");
		expect(buf.cell(5, 0)?.sgr).toBe(BASE);
		expect(buf.cell(0, 1)?.sgr).toBe(BASE);
		expect(buf.toLines()[1]).toBe(`${BASE}      ${RESET}`);
	});
});

describe("drawFrame", () => {
	it("draws a titled frame with a right-aligned badge and statusline", () => {
		const buf = new CellBuffer(30, 5);
		const inner = drawFrame(buf, { x: 0, y: 0, w: 30, h: 5 }, {
			title: paneTitle(1, "W-01 · GET"),
			badge: "@ada",
			status: "main · $0.03",
		});
		expect(inner).toEqual({ x: 1, y: 1, w: 28, h: 2 });
		const lines = buf.toLines();
		expect(lines[0]).toBe("╭─ 0.1 W-01 · GET ──── @ada ─╮");
		expect(lines[1]).toBe(`│${" ".repeat(28)}│`);
		expect(lines[3]).toBe(`│main · $0.03${" ".repeat(16)}│`);
		expect(lines[4]).toBe(`╰${"─".repeat(28)}╯`);
		for (const line of lines) expect(visibleWidth(line)).toBe(30);
	});

	it("truncates long titles and drops the badge first", () => {
		const buf = new CellBuffer(16, 3);
		drawFrame(buf, { x: 0, y: 0, w: 16, h: 3 }, { title: "0.2 W-02 · Hello page with a long name", badge: "@linus" });
		const [top] = buf.toLines();
		expect(visibleWidth(top)).toBe(16);
		expect(top.startsWith("╭─ 0.2 W-02")).toBe(true);
		expect(top).toContain("…");
		expect(top).not.toContain("@linus");
		expect(top.endsWith("─╮")).toBe(true);
	});

	it("routes every part through the style callback", () => {
		const buf = new CellBuffer(24, 4);
		const seen = new Set<FramePart>();
		drawFrame(buf, { x: 0, y: 0, w: 24, h: 4 }, {
			title: "t",
			badge: "b",
			status: "s",
			style: (part, text) => {
				seen.add(part);
				return part === "border" ? `\x1b[33m${text}${RESET}` : text;
			},
		});
		expect([...seen].sort()).toEqual(["badge", "border", "status", "title"]);
		const lines = buf.toLines();
		expect(lines[0].startsWith("\x1b[33m╭─ ")).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBe(24);
	});
});
