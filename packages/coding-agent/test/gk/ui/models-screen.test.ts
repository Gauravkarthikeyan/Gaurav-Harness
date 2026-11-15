import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import {
	conductorRatio,
	currentScope,
	formatContext,
	formatPrice,
	type ModelsScreenState,
	type ModelsStyle,
	modelSections,
	reduceModelsScreen,
	renderModelsScreen,
	selectedModel,
	visibleModels,
} from "../../../src/gk/ui/models-screen";
import { fixtureState } from "./models-fixture";

const identity: ModelsStyle = (_token, text) => text;
const sgr: ModelsStyle = (token, text) =>
	token === "selectedBg" ? `\x1b[48;5;236m${text}\x1b[49m` : `\x1b[38;5;${token.length + 16}m${text}\x1b[39m`;

function press(state: ModelsScreenState, ...keys: string[]) {
	let effects: ReturnType<typeof reduceModelsScreen>["effects"] = [];
	for (const key of keys) {
		const result = reduceModelsScreen(state, key);
		state = result.state;
		effects = [...effects, ...result.effects];
	}
	return { state, effects };
}

describe("renderModelsScreen", () => {
	it("renders sidebar, role chips, filters and sectioned table (100×20, no detail panel)", () => {
		const rows = renderModelsScreen(fixtureState(), 100, 20, identity);
		expect(rows.map(r => r.trimEnd())).toEqual([
			" ● Models  & providers                                           ● 3 providers connected · 4 models",
			"────────────────────────────────────────────────────────────────────────────────────────────────────",
			"                        │ default claude-opus-5-5   conductor claude-opus-5-5   plan claude-opus-5-…",
			" ▸   All connected    4 │ ⌕ search model… chat image tts-stt k   connected only ✓ c   sort roster o",
			"   ★ Roster           4 │",
			"                        │   MODEL                               CONTEXT   $ IN / OUT 1M   SMALL TIER",
			" CONNECTED              │ ★ IN ROSTER  3",
			"   ● anthropic        2 │ ★ anthropic/claude-opus-5-5 default+2      1m        $5 / $25   $0.50   T3",
			"   ● local            1 │ ★ anthropic/claude-haiku-5-5 smol        100k     $0.1 / $0.5   $0.01   T1",
			"   ● openrouter       1 │ ★ local/gemma-3-1b                          —            free   $0.00   T2",
			"                        │",
			" NEEDS ATTENTION        │ CONNECTED, NOT IN ROSTER  1 · Space adds",
			"   ! google-gemini-cli  │ ☆ openrouter/qwen/qwen3.5-plus             1m     $0.3 / $1.8   $0.03   T1",
			"     login expired · l …│",
			"                        │",
			" NOT SET UP             │",
			"   ○ 2 providers  Enter │",
			"   + Add API key or … a │",
			"────────────────────────────────────────────────────────────────────────────────────────────────────",
			" ↑↓ move  Enter set role  Space roster on/off  t tier… tier by output $/1M: T1 < $2 · T2 < $12 · T3",
		]);
	});

	it("shows the detail panel for the selected model when wide", () => {
		const state = press(fixtureState(), "down").state;
		const text = renderModelsScreen(state, 170, 34, identity).join("\n");
		expect(text).toContain("claude-haiku-5-5");
		expect(text).toContain("● anthropic · connected · API key");
		expect(text).toMatch(/small task \(S\) +\$0\.01/);
		expect(text).toMatch(/vs conductor \(L\) +50× cheaper/);
		expect(text).toMatch(/tier +T1 · t change/);
		expect(text).toMatch(/parallel workers +2 · m change/);
		expect(text).toMatch(/role +smol/);
		expect(text).not.toContain("omp");
	});

	it("is width/height exact with styled text at every size", () => {
		const states = [
			fixtureState(),
			press(fixtureState(), "down", "s").state,
			press(fixtureState(), "tab", "tab", "tab", "tab", "tab", "tab").state,
		];
		for (const state of states) {
			for (const width of [0, 1, 20, 60, 99, 100, 140, 160, 212]) {
				for (const height of [0, 1, 4, 12, 58]) {
					const rows = renderModelsScreen(state, width, height, sgr);
					expect(rows).toHaveLength(height);
					for (const row of rows) expect(visibleWidth(row)).toBe(width);
				}
			}
		}
	});

	it("scrolls to keep the cursor visible and counts the rows below", () => {
		const base = fixtureState();
		const many = Array.from({ length: 40 }, (_, i) => ({
			...base.models[0]!,
			selector: `bulk/model-${String(i).padStart(2, "0")}`,
			provider: "bulk",
			id: `model-${String(i).padStart(2, "0")}`,
			roles: [],
		}));
		let state: ModelsScreenState = { ...base, models: many, connected: [{ id: "bulk", models: 40 }], sort: "name" };
		const first = renderModelsScreen(state, 100, 20, identity).join("\n");
		expect(first).toContain("bulk/model-00");
		expect(first).toMatch(/\+ \d+ more/);
		state = press(state, ...Array.from({ length: 39 }, () => "down")).state;
		const last = renderModelsScreen(state, 100, 20, identity).join("\n");
		expect(last).toContain("bulk/model-39");
		expect(last).not.toContain("bulk/model-00");
	});
});

describe("reduceModelsScreen", () => {
	it("toggles roster membership with Space and emits a roster save", () => {
		const { state, effects } = press(fixtureState(), "down", "space");
		expect(effects).toEqual([
			{ kind: "saveRoster", selector: "anthropic/claude-haiku-5-5", patch: { enabled: false } },
		]);
		expect(modelSections(state).notInRoster.map(m => m.selector)).toContain("anthropic/claude-haiku-5-5");
		expect(selectedModel(state)?.selector).toBe("anthropic/claude-haiku-5-5");
	});

	it("cycles tier and parallel workers", () => {
		const { state, effects } = press(fixtureState(), "t", "m");
		expect(effects).toEqual([
			{ kind: "saveRoster", selector: "anthropic/claude-opus-5-5", patch: { tier: 1 } },
			{ kind: "saveRoster", selector: "anthropic/claude-opus-5-5", patch: { maxConcurrent: 3 } },
		]);
		expect(selectedModel(state)).toMatchObject({ tier: 1, maxConcurrent: 3 });
	});

	it("toggles strengths in skill order", () => {
		const { state, effects } = press(fixtureState(), "s", "space", "right", "right", "space", "esc");
		expect(effects.at(-1)).toEqual({
			kind: "saveRoster",
			selector: "anthropic/claude-opus-5-5",
			patch: { strengths: ["frontend", "tests", "research", "review", "design"] },
		});
		expect(state.mode).toBe("browse");
	});

	it("assigns a role through Enter → role chooser → Enter", () => {
		const { effects } = press(fixtureState(), "down", "enter", "right", "enter");
		expect(effects).toEqual([{ kind: "assignRole", role: "slow", selector: "anthropic/claude-haiku-5-5" }]);
	});

	it("searches by name and skill", () => {
		let { state } = press(fixtureState(), "/", ..."docs".split(""), "enter");
		expect(visibleModels(state).map(m => m.id)).toEqual(["claude-haiku-5-5"]);
		state = press(state, "/", "backspace", "backspace", "backspace", "backspace", ..."qwen".split(""), "esc").state;
		expect(visibleModels(state).map(m => m.id)).toEqual(["qwen/qwen3.5-plus"]);
	});

	it("filters by kind and connection", () => {
		let { state } = press(fixtureState(), "k");
		expect(visibleModels(state).map(m => m.id)).toEqual(["gpt-image-2"]);
		state = press(fixtureState(), "c").state;
		expect(modelSections(state).notConnected.map(m => m.id)).toEqual(["gpt-6"]);
	});

	it("routes login: selected provider, attention scope, add", () => {
		expect(press(fixtureState(), "l").effects).toEqual([{ kind: "login", provider: "anthropic" }]);
		const attention = press(fixtureState(), "tab", "tab", "tab", "tab", "tab");
		expect(currentScope(attention.state)).toEqual({ kind: "attention", id: "google-gemini-cli" });
		expect(press(attention.state, "enter").effects).toEqual([{ kind: "login", provider: "google-gemini-cli" }]);
		expect(press(fixtureState(), "a").effects).toEqual([{ kind: "login" }]);
	});

	it("refuses roster edits on a provider that is not connected", () => {
		const start = press(fixtureState(), "c").state;
		const index = visibleModels(start).findIndex(m => m.id === "gpt-6");
		const { state, effects } = press({ ...start, cursor: index }, "space");
		expect(effects).toEqual([]);
		expect(state.status).toContain("openai is not connected");
	});

	it("closes on Esc", () => {
		expect(press(fixtureState(), "esc").effects).toEqual([{ kind: "close" }]);
	});
});

describe("formatting", () => {
	it("formats context and prices", () => {
		expect([undefined, 0, 900, 100_000, 262_144, 1_000_000, 1_100_000].map(formatContext)).toEqual([
			"—",
			"—",
			"900",
			"100k",
			"262k",
			"1m",
			"1.1m",
		]);
		expect([0, 0.04, 0.1, 2.5, 25].map(formatPrice)).toEqual(["$0", "$0.04", "$0.1", "$2.5", "$25"]);
	});

	it("compares large-task cost against the conductor", () => {
		const [opus, haiku, , gemma] = fixtureState().models;
		expect(conductorRatio(haiku!, opus)).toBe("50× cheaper");
		expect(conductorRatio(opus!, haiku)).toBe("50× pricier");
		expect(conductorRatio(opus!, opus)).toBe("is conductor");
		expect(conductorRatio(gemma!, opus)).toBe("—");
	});
});
