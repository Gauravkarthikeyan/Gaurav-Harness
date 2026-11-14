import { describe, expect, it } from "bun:test";
import {
	PIXEL_GLYPH_ROWS,
	pixelGlyphWidth,
	pixelTextRows,
	pixelTextWidth,
	renderPixelText,
} from "../src/gk/pixel-font";
import { GK_NIGHT } from "../src/theme/gk-palette";
import { visibleWidth } from "../src/utils";

const plain = (lines: string[]): string[] => lines.map(line => Bun.stripANSI(line));

const SUPPORTED = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.-<>/ ";

const GLYPH_WIDTHS: ReadonlyArray<readonly [string, number]> = [
	["A", 4],
	["G", 4],
	["I", 3],
	["M", 5],
	["N", 5],
	["T", 5],
	["V", 5],
	["W", 5],
	["0", 4],
	["1", 3],
	["'", 1],
	[".", 1],
	["-", 3],
	["<", 3],
	[">", 3],
	["/", 3],
	[" ", 2],
];

describe("pixel font", () => {
	for (const [char, width] of GLYPH_WIDTHS) {
		it(`glyph ${JSON.stringify(char)} is ${width} pixels wide`, () => {
			expect(pixelGlyphWidth(char)).toBe(width);
			for (const scale of [1, 2] as const) {
				const lines = plain(renderPixelText(char, { scale, shadow: false }));
				for (const line of lines) expect(visibleWidth(line)).toBe(width * scale);
			}
		});
	}

	it("renders every supported character", () => {
		for (const char of SUPPORTED) {
			const lines = plain(renderPixelText(char, { scale: 1, shadow: false }));
			expect(lines).toHaveLength(3);
			if (char !== " ") expect(lines.join("").trim().length).toBeGreaterThan(0);
		}
	});

	it("renders unknown characters as a space", () => {
		for (const char of ["?", "@", "é", "→"]) {
			expect(pixelGlyphWidth(char)).toBe(pixelGlyphWidth(" "));
			expect(plain(renderPixelText(`A${char}B`, { scale: 1, shadow: true, colorMode: "truecolor" }))).toEqual(
				plain(renderPixelText("A B", { scale: 1, shadow: true, colorMode: "truecolor" })),
			);
		}
	});

	it("treats lowercase as uppercase", () => {
		expect(plain(renderPixelText("harness", { scale: 1, shadow: false }))).toEqual(
			plain(renderPixelText("HARNESS", { scale: 1, shadow: false })),
		);
	});

	const ROWS: ReadonlyArray<readonly [1 | 2, boolean, number]> = [
		[1, false, 3],
		[1, true, 3],
		[2, false, PIXEL_GLYPH_ROWS],
		[2, true, PIXEL_GLYPH_ROWS + 1],
	];
	for (const [scale, shadow, rows] of ROWS) {
		it(`scale ${scale}${shadow ? " with shadow" : ""} renders ${rows} rows of equal width`, () => {
			const text = "GAURAV'S HARNESS";
			const lines = renderPixelText(text, { scale, shadow });
			expect(lines).toHaveLength(rows);
			expect(pixelTextRows(scale, shadow)).toBe(rows);
			for (const line of lines) expect(visibleWidth(line)).toBe(pixelTextWidth(text, scale, shadow));
		});
	}

	it("sizes the wordmark as specified", () => {
		expect(pixelTextWidth("GAURAV'S HARNESS", 1, true)).toBe(77);
		expect(pixelTextWidth("GAURAV'S HARNESS", 2, true)).toBe(153);
		expect(pixelTextWidth("", 1, true)).toBe(0);
	});

	it("draws glyph pixels with half blocks", () => {
		// A at scale 1: pixel rows 0-1 → cell row 0, 2-3 → row 1, 4 → row 2 (top half).
		expect(plain(renderPixelText("A", { scale: 1, shadow: false }))).toEqual(["▄▀▀▄", "█▀▀█", "▀  ▀"]);
		// At scale 2 every pixel is a full 2×1 block.
		expect(plain(renderPixelText("I", { scale: 2, shadow: false }))).toEqual([
			"██████",
			"  ██  ",
			"  ██  ",
			"  ██  ",
			"██████",
		]);
	});

	it("paints the shadow one column right and half a row down in the shadow color", () => {
		const face = "#ffffff";
		const shadow = "#101010";
		const lines = renderPixelText(".", { scale: 2, shadow: true, colors: { face, shadow }, colorMode: "truecolor" });
		// "." is one pixel at the bottom-left: face █ at row 4, shadow fills the half row below, shifted right.
		expect(plain(lines)).toEqual(["   ", "   ", "   ", "   ", "██▄", " ▀▀"]);
		expect(lines[4]).toContain("\x1b[38;2;255;255;255m██");
		expect(lines[4]).toContain("\x1b[38;2;16;16;16m▄");
		expect(lines[5]).toContain("\x1b[38;2;16;16;16m▀▀");
	});

	it("defaults to the gk-night accent", () => {
		const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(GK_NIGHT.accent.slice(i, i + 2), 16));
		const lines = renderPixelText("H", { scale: 1, shadow: true, colorMode: "truecolor" });
		expect(lines[0]).toContain(`\x1b[38;2;${r};${g};${b}m`);
		for (const line of lines) expect(line.endsWith("\x1b[39m") || line.endsWith("\x1b[49m")).toBe(true);
	});
});
