import { describe, expect, it } from "bun:test";
import { creditsLines, formatCreditsOutput } from "@oh-my-pi/pi-coding-agent/gk/credits";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { visibleWidth } from "@oh-my-pi/pi-tui";

describe("creditsLines", () => {
	it("names the author, the version and the upstream projects", () => {
		const text = creditsLines(100).join("\n");
		for (const needle of [
			"GAURAV'S HARNESS",
			"gk-code 0.1.0",
			"Gaurav Karthikeyan",
			"github.com/Gauravkarthikeyan",
			"gauravkarthik22@gmail.com",
			"oh-my-pi",
			"Can Bölük",
			"Mario Zechner",
			"MIT",
		]) {
			expect(text).toContain(needle);
		}
	});

	it("draws a closed box", () => {
		const lines = creditsLines(100);
		expect(lines[0]).toStartWith("┌");
		expect(lines[0]).toEndWith("┐");
		expect(lines.at(-1)).toStartWith("└");
		expect(lines.at(-1)).toEndWith("┘");
		for (const line of lines.slice(1, -1)) {
			expect(line).toStartWith("│");
			expect(line).toEndWith("│");
		}
	});

	it("keeps every row the same width and never wider than the terminal", () => {
		for (const width of [200, 100, 80, 60, 40, 30]) {
			const lines = creditsLines(width);
			const widths = new Set(lines.map(line => visibleWidth(line)));
			expect(widths.size).toBe(1);
			expect([...widths][0]).toBeLessThanOrEqual(width);
		}
	});

	it("caps the card width on wide terminals", () => {
		expect(visibleWidth(creditsLines(200)[0])).toBeLessThanOrEqual(80);
	});

	it("keeps the content when it wraps on narrow terminals", () => {
		const text = creditsLines(40)
			.map(line => line.slice(1, -1).trim())
			.join(" ");
		expect(text).toContain("github.com/Gauravkarthikeyan");
		expect(text).toContain("Mario Zechner");
	});

	it("applies the style to tokens without changing the layout", () => {
		const styled = creditsLines(100, (token, text) => `<${token}>${text}</${token}>`);
		expect(styled.join("\n")).toContain("<accent>GAURAV'S HARNESS</accent>");
		const plain = creditsLines(100);
		expect(styled.map(line => line.replace(/<\/?[a-z]+>/g, ""))).toEqual(plain);
	});
});

describe("credits wiring", () => {
	it("registers /credits as a TUI command", () => {
		expect(lookupBuiltinSlashCommand("credits")?.handleTui).toBeDefined();
	});

	it("prints plain text for --credits when stdout is not a terminal", () => {
		const out = formatCreditsOutput(80, false);
		expect(out).not.toContain("\x1b[");
		expect(out).toContain("Can Bölük");
		expect(out.endsWith("┘\n")).toBe(true);
	});
});
