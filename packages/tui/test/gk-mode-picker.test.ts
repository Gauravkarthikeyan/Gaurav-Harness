import { describe, expect, it, jest } from "bun:test";
import type { Component } from "../src";
import { runLaunchScreens, type SplashCheckTask } from "../src/gk/launch-screens";
import { type ModePickerState, pickerKey, renderModePicker } from "../src/gk/mode-picker";
import { fgAnsi } from "../src/theme/color";
import { GK_NIGHT } from "../src/theme/gk-palette";
import { visibleWidth } from "../src/utils";

const plain = (lines: string[]): string[] => lines.map(line => Bun.stripANSI(line));

const STATE: ModePickerState = {
	focused: "orchestra",
	last: "orchestra",
	version: "0.1.0",
	colorMode: "truecolor",
	solo: [
		{ key: "model", value: "anthropic/claude-opus-4-5" },
		{ key: "tools", value: "19 skills · MCP 3/4" },
	],
	orchestra: [
		{ key: "conductor", value: "anthropic/claude-opus-4-5" },
		{ key: "roster", value: "7 models · t1 ×3" },
		{ key: "status", value: "not wired yet · starts Solo", tone: "warn" },
	],
};

describe("pickerKey", () => {
	it("moves focus with arrows, h/l and Tab", () => {
		expect(pickerKey("orchestra", "\x1b[D")).toEqual({ type: "focus", choice: "solo" });
		expect(pickerKey("solo", "\x1b[C")).toEqual({ type: "focus", choice: "orchestra" });
		expect(pickerKey("orchestra", "h")).toEqual({ type: "focus", choice: "solo" });
		expect(pickerKey("solo", "l")).toEqual({ type: "focus", choice: "orchestra" });
		expect(pickerKey("solo", "\t")).toEqual({ type: "focus", choice: "orchestra" });
		expect(pickerKey("orchestra", "\t")).toEqual({ type: "focus", choice: "solo" });
	});

	it("starts the focused card on Enter and a card directly on s / o", () => {
		expect(pickerKey("orchestra", "\r")).toEqual({ type: "start", choice: "orchestra" });
		expect(pickerKey("solo", "\r")).toEqual({ type: "start", choice: "solo" });
		expect(pickerKey("orchestra", "s")).toEqual({ type: "start", choice: "solo" });
		expect(pickerKey("solo", "o")).toEqual({ type: "start", choice: "orchestra" });
	});

	it("quits on Ctrl+C and ignores other keys", () => {
		expect(pickerKey("solo", "\x03")).toEqual({ type: "quit" });
		expect(pickerKey("solo", "x")).toBeNull();
		expect(pickerKey("solo", "\x1b")).toBeNull();
	});
});

describe("renderModePicker", () => {
	for (const [width, height] of [
		[212, 58],
		[120, 40],
		[80, 24],
	] as const) {
		it(`is exactly ${width}×${height} with both cards, facts and key hints`, () => {
			const lines = renderModePicker(STATE, width, height);
			expect(lines).toHaveLength(height);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
			const text = plain(lines).join("\n");
			expect(text).toContain("┌─ Solo ");
			expect(text).toContain("┌─ Orchestra · last used ");
			expect(text).toMatch(/conductor\s+anthropic\/claude-opu/);
			expect(text).toContain("! not wired yet");
			expect(plain(lines).at(-1)).toMatch(/← → choose {3}⏎ start .* gk-code 0\.1\.0 $/);
			expect(text.toLowerCase()).not.toMatch(/\bomp\b/);
			expect(text).not.toMatch(/ONE BRAIN|WHOLE CREW/i);
		});
	}

	it("draws only the focused card's border in gold", () => {
		const gold = fgAnsi(GK_NIGHT.borderFocus, "truecolor");
		const topRow = (state: ModePickerState): string => {
			const lines = renderModePicker(state, 212, 58);
			const index = plain(lines).findIndex(line => line.includes("┌─ Solo"));
			return lines[index];
		};
		const goldBefore = (row: string, title: string): boolean => {
			const at = row.indexOf(title);
			const corner = row.lastIndexOf("┌", at);
			return row.slice(0, corner).endsWith(gold);
		};
		const orchestraFocused = topRow(STATE);
		expect(goldBefore(orchestraFocused, " Orchestra")).toBe(true);
		expect(goldBefore(orchestraFocused, " Solo")).toBe(false);
		const soloFocused = topRow({ ...STATE, focused: "solo" });
		expect(goldBefore(soloFocused, " Solo")).toBe(true);
		expect(goldBefore(soloFocused, " Orchestra")).toBe(false);
	});
});

describe("runLaunchScreens", () => {
	function fakeHost() {
		let overlay: (Component & { handleInput?: (data: string) => void }) | undefined;
		let hidden = false;
		const host = {
			ui: {
				terminal: { rows: 24 },
				showOverlay: (component: Component) => {
					overlay = component;
					return { hide: () => (hidden = true) };
				},
				setFocus: () => {},
				requestRender: () => {},
				invalidate: () => {},
			},
		};
		return { host: host as never, overlay: () => overlay, hidden: () => hidden };
	}

	it("runs the checks, skips the splash on a key, and returns the picker choice", async () => {
		const { host, overlay, hidden } = fakeHost();
		const started: string[] = [];
		const checks: SplashCheckTask[] = ["a", "b"].map(id => ({
			id,
			label: id,
			run: async () => {
				started.push(id);
				return { state: "ok", value: `${id} ok` };
			},
		}));
		const run = runLaunchScreens(host, {
			version: "0.1.0",
			motion: false,
			splash: { checks },
			picker: { initial: "solo", facts: () => ({ solo: [{ key: "model", value: "m" }], orchestra: [] }) },
		});
		expect(started).toEqual(["a", "b"]);
		// Let the check promises' result handlers run (a few microtasks, no timers).
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(plain([...(overlay()?.render(80) ?? [])]).join("\n")).toMatch(/✓ a\s+a ok/);
		overlay()?.handleInput?.(" "); // any key ends the splash
		expect(plain([...(overlay()?.render(80) ?? [])]).join("\n")).toContain("┌─ Solo");
		overlay()?.handleInput?.("\x1b[C");
		overlay()?.handleInput?.("\r");
		expect(await run).toEqual({ kind: "chosen", choice: "orchestra" });
		expect(hidden()).toBe(true);
	});

	it("ends the splash by itself once checks settle and the minimum time passed", async () => {
		const { host } = fakeHost();
		let clock = 0;
		const run = runLaunchScreens(host, {
			version: "0.1.0",
			motion: false,
			now: () => clock,
			splash: { checks: [{ id: "a", label: "a", run: async () => ({ state: "ok" }) }] },
		});
		clock = 10_000;
		expect(await run).toEqual({ kind: "none" });
	});

	it("paces check rows with motion, then holds the full checklist before the picker", async () => {
		// The splash ticks on setInterval; fake timers fire it deterministically while `clock` drives elapsed time.
		jest.useFakeTimers();
		const { host, overlay } = fakeHost();
		let clock = 0;
		const checks: SplashCheckTask[] = ["alpha", "beta"].map(id => ({
			id,
			label: id,
			run: async () => ({ state: "ok", value: `${id} ok` }),
		}));
		const run = runLaunchScreens(host, {
			version: "0.1.0",
			motion: true,
			now: () => clock,
			splash: { checks },
			picker: { initial: "solo", facts: () => ({ solo: [], orchestra: [] }) },
		});
		for (let i = 0; i < 5; i++) await Promise.resolve();
		const screen = () => plain([...(overlay()?.render(80) ?? [])]).join("\n");
		// Both checks already settled, but only the first is revealed at 1 s.
		clock = 1000;
		expect(screen()).toMatch(/✓ alpha\s+alpha ok/);
		expect(screen()).not.toContain("beta ok");
		// Everything shows from 2.5 s; the splash still holds at 3.4 s.
		clock = 3400;
		jest.advanceTimersByTime(40);
		expect(screen()).toContain("beta ok");
		expect(screen()).not.toContain("┌─ Solo");
		clock = 3600;
		jest.advanceTimersByTime(40);
		jest.useRealTimers();
		expect(screen()).toContain("┌─ Solo");
		overlay()?.handleInput?.("\r");
		expect(await run).toEqual({ kind: "chosen", choice: "solo" });
	});

	it("quits from the picker on Ctrl+C", async () => {
		const { host, overlay } = fakeHost();
		const run = runLaunchScreens(host, {
			version: "0.1.0",
			motion: true,
			picker: { initial: "orchestra", facts: () => ({ solo: [], orchestra: [] }) },
		});
		overlay()?.handleInput?.("\x03");
		expect(await run).toEqual({ kind: "quit" });
	});
});
