import { beforeAll, describe, expect, it } from "bun:test";
import { type PaletteItem, rankPalette } from "@oh-my-pi/pi-coding-agent/gk/palette-sources";
import { CommandPalette, PALETTE_MAX_ROWS } from "@oh-my-pi/pi-coding-agent/gk/ui/command-palette";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

function item(id: string, kind: PaletteItem["kind"], label: string, detail = ""): PaletteItem {
	return { id, kind, label, detail, run: async () => {} };
}

const ITEMS: PaletteItem[] = [
	item("command:caps", "command", "Capabilities", "MCP servers, skills and plugins (/caps)"),
	item("command:mcp", "command", "/mcp", "Manage MCP servers"),
	item("command:model", "command", "/model", "Switch model for this session"),
	item("command:new", "command", "/new", "Start a new session"),
	item("skill:writing-plans", "skill", "writing-plans", "Plan a multi-step task"),
	item("model:anthropic/claude", "model", "Claude Opus", "anthropic/claude"),
	item("setting:gk.launchMode", "setting", "Launch Mode", "gk.launchMode"),
	...Array.from({ length: 30 }, (_, i) => item(`key:k${i}`, "key", `Key action ${i}`, `app.k${i}`)),
];

describe("rankPalette", () => {
	it("puts the Capabilities and /mcp items first for `mcp`", () => {
		const ids = rankPalette(ITEMS, "mcp", [])
			.slice(0, 2)
			.map(entry => entry.id)
			.sort();
		expect(ids).toEqual(["command:caps", "command:mcp"]);
	});

	it("lets a recent id outrank an equal-score item", () => {
		const twins = [item("a", "command", "/alpha", "same"), item("b", "command", "/alpha", "same")];
		expect(rankPalette(twins, "alpha", [])[0]!.id).toBe("a");
		expect(rankPalette(twins, "alpha", ["b"])[0]!.id).toBe("b");
	});

	it("lists recents first, then commands, for an empty query", () => {
		const ranked = rankPalette(ITEMS, "", ["setting:gk.launchMode", "skill:writing-plans"]);
		expect(ranked.slice(0, 2).map(entry => entry.id)).toEqual(["setting:gk.launchMode", "skill:writing-plans"]);
		expect(ranked.slice(2, 6).every(entry => entry.kind === "command")).toBe(true);
	});
});

describe("CommandPalette", () => {
	const noop = { onRun: () => {}, onClose: () => {} };

	it("renders at most 12 item rows within the width", () => {
		const lines = new CommandPalette(ITEMS, () => [], noop).render(80).map(line => Bun.stripANSI(line));
		const rows = lines.filter(line => / (command|skill|model|setting|key) │$/.test(line));
		expect(rows.length).toBe(PALETTE_MAX_ROWS);
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
	});

	it("shows the empty-result copy for a query with no match", () => {
		const palette = new CommandPalette(ITEMS, () => [], noop);
		for (const char of "zzqxj") palette.handleInput(char);
		const text = palette
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(text).toContain('No match for "zzqxj". Try a command, skill, model or setting name.');
	});

	it("runs the selected item on Enter and closes on Esc", () => {
		const ran: string[] = [];
		let closed = 0;
		const palette = new CommandPalette(ITEMS, () => [], {
			onRun: entry => ran.push(entry.id),
			onClose: () => closed++,
		});
		for (const char of "/new") palette.handleInput(char);
		palette.handleInput("\r");
		palette.handleInput("\x1b");
		expect(ran).toEqual(["command:new"]);
		expect(closed).toBe(1);
	});
});
