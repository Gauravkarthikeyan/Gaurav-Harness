import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "../../src/config/model-registry";
import {
	availableRosterModels,
	buildRoster,
	defaultTier,
	estimateCostUsd,
	loadRosterOverrides,
	patchRosterOverride,
	SIZE_TOKENS,
	saveRosterOverrides,
} from "../../src/gk/roster";

describe("SIZE_TOKENS", () => {
	it("matches the spec size table", () => {
		expect(SIZE_TOKENS).toEqual({
			S: { input: 60_000, output: 8_000 },
			M: { input: 250_000, output: 30_000 },
			L: { input: 800_000, output: 80_000 },
		});
	});
});

describe("defaultTier", () => {
	it("maps output price per 1M tokens to a tier", () => {
		expect(defaultTier(1.25)).toEqual({ tier: 1, planIncluded: false });
		expect(defaultTier(10)).toEqual({ tier: 2, planIncluded: false });
		expect(defaultTier(75)).toEqual({ tier: 3, planIncluded: false });
	});

	it("uses exclusive upper bounds", () => {
		expect(defaultTier(2).tier).toBe(2);
		expect(defaultTier(12).tier).toBe(3);
	});

	it("treats zero price as a plan-included tier-2 model", () => {
		expect(defaultTier(0)).toEqual({ tier: 2, planIncluded: true });
	});
});

describe("estimateCostUsd", () => {
	it("prices a medium item", () => {
		expect(estimateCostUsd({ input: 3, output: 15 }, "M")).toBeCloseTo(0.75 + 0.45, 10);
	});

	it("returns 0, never NaN, for zero-priced models", () => {
		const cost = estimateCostUsd({ input: 0, output: 0 }, "L");
		expect(cost).toBe(0);
		expect(Number.isNaN(cost)).toBe(false);
	});
});

describe("buildRoster", () => {
	const models = [
		{ selector: "a/b", cost: { input: 3, output: 15 } },
		{ selector: "c/d", cost: { input: 0, output: 0 } },
	];

	it("fills defaults", () => {
		expect(buildRoster(models, [])).toEqual([
			{
				selector: "a/b",
				provider: "a",
				tier: 3,
				strengths: [],
				enabled: true,
				maxConcurrent: 2,
				planIncluded: false,
				openWeight: false,
				cost: { input: 3, output: 15 },
			},
			{
				selector: "c/d",
				provider: "c",
				tier: 2,
				strengths: [],
				enabled: true,
				maxConcurrent: 2,
				planIncluded: true,
				openWeight: false,
				cost: { input: 0, output: 0 },
			},
		]);
	});

	it("detects open weights from the model id, whatever the provider", () => {
		const roster = buildRoster(
			[
				{ selector: "commandcode/moonshotai/Kimi-K2.6", cost: { input: 0.95, output: 4 } },
				{ selector: "commandcode/zai-org/GLM-5.3", cost: { input: 1.4, output: 4.4 } },
				{ selector: "commandcode/MiniMaxAI/MiniMax-M3", cost: { input: 0.3, output: 1.2 } },
				{ selector: "commandcode/deepseek/deepseek-v4-pro", cost: { input: 0.66, output: 1.98 } },
				{ selector: "groq/llama-3.3-70b-versatile", cost: { input: 0.59, output: 0.79 } },
				{ selector: "openrouter/openai/gpt-oss-120b", cost: { input: 0.1, output: 0.5 } },
				{ selector: "commandcode/Qwen/Qwen3.8-Max", cost: { input: 2, output: 6 } },
				{ selector: "anthropic/claude-sonnet-5", cost: { input: 2, output: 10 } },
				{ selector: "openai-codex/gpt-6-luna", cost: { input: 0.1, output: 0.5 } },
			],
			[],
		);
		expect(Object.fromEntries(roster.map(e => [e.selector, e.openWeight]))).toEqual({
			"commandcode/moonshotai/Kimi-K2.6": true,
			"commandcode/zai-org/GLM-5.3": true,
			"commandcode/MiniMaxAI/MiniMax-M3": true,
			"commandcode/deepseek/deepseek-v4-pro": true,
			"groq/llama-3.3-70b-versatile": true,
			"openrouter/openai/gpt-oss-120b": true,
			"commandcode/Qwen/Qwen3.8-Max": false,
			"anthropic/claude-sonnet-5": false,
			"openai-codex/gpt-6-luna": false,
		});
		expect(roster[0]!.provider).toBe("commandcode");
	});

	it("raises open-weight flagships priced like tier 1 to tier 2 and seeds strengths", () => {
		const [kimi, minimax, flash, fable] = buildRoster(
			[
				{ selector: "cc/moonshotai/Kimi-K2.6", cost: { input: 0.95, output: 4 } },
				{ selector: "cc/MiniMaxAI/MiniMax-M3", cost: { input: 0.3, output: 1.2 } },
				{ selector: "cc/deepseek/deepseek-v4-flash", cost: { input: 0.15, output: 0.6 } },
				{ selector: "cc/claude-fable-5-2", cost: { input: 0, output: 0 } },
			],
			[],
		);
		expect(kimi).toMatchObject({ tier: 2, strengths: ["frontend", "backend", "refactor"] });
		expect(minimax!.tier).toBe(2);
		expect(flash).toMatchObject({ tier: 1, strengths: ["docs", "tests"] });
		// A gateway listing a frontier model at $0 does not make it a cheap tier-2 worker.
		expect(fable).toMatchObject({ tier: 3, planIncluded: true });
	});

	it("carries context window and measured speed", () => {
		const [entry] = buildRoster(
			[{ selector: "a/b", provider: "a", id: "b", cost: { input: 1, output: 2 }, contextWindow: 200_000, tps: 88 }],
			[],
		);
		expect(entry).toMatchObject({ contextWindow: 200_000, tps: 88 });
	});

	it("applies overrides by selector", () => {
		const [entry] = buildRoster(models, [{ selector: "a/b", tier: 1, strengths: ["backend"] }]);
		expect(entry.tier).toBe(1);
		expect(entry.strengths).toEqual(["backend"]);
		expect(entry.enabled).toBe(true);
		expect(entry.maxConcurrent).toBe(2);
	});

	it("ignores overrides for unknown selectors", () => {
		const roster = buildRoster(models, [{ selector: "x/y", tier: 1, enabled: false }]);
		expect(roster.map(entry => entry.selector)).toEqual(["a/b", "c/d"]);
		expect(roster).toEqual(buildRoster(models, []));
	});
});

describe("loadRosterOverrides", () => {
	const dirs: string[] = [];
	const tempFile = (contents: string): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-"));
		dirs.push(dir);
		const file = path.join(dir, "roster.yml");
		fs.writeFileSync(file, contents);
		return file;
	};

	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("returns [] for a missing file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-"));
		dirs.push(dir);
		expect(await loadRosterOverrides(path.join(dir, "roster.yml"))).toEqual([]);
	});

	it("parses valid entries", async () => {
		const file = tempFile(
			[
				"models:",
				"  - selector: a/b",
				"    tier: 1",
				"    strengths: [backend, tests]",
				"    enabled: false",
				"    maxConcurrent: 4",
				"  - selector: c/d",
			].join("\n"),
		);
		expect(await loadRosterOverrides(file)).toEqual([
			{ selector: "a/b", tier: 1, strengths: ["backend", "tests"], enabled: false, maxConcurrent: 4 },
			{ selector: "c/d" },
		]);
	});

	it("skips malformed entries with a warning", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const file = tempFile(
				[
					"models:",
					"  - selector: good/one",
					"    tier: 2",
					"  - tier: 1",
					"  - selector: bad/tier",
					"    tier: 7",
					"  - selector: bad/skill",
					"    strengths: [cooking]",
					"  - just a string",
				].join("\n"),
			);
			expect(await loadRosterOverrides(file)).toEqual([{ selector: "good/one", tier: 2 }]);
			expect(warn).toHaveBeenCalledTimes(4);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("saveRosterOverrides", () => {
	const dirs: string[] = [];
	const tempDir = (): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-"));
		dirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips through loadRosterOverrides, creating parent dirs", async () => {
		const file = path.join(tempDir(), "agent", "roster.yml");
		const overrides = [
			{ selector: "anthropic/claude-haiku-5-5", tier: 1 as const, strengths: ["tests" as const, "docs" as const] },
			{ selector: "local/gemma-3-1b", enabled: false, maxConcurrent: 3 },
		];
		await saveRosterOverrides(file, overrides);
		expect(await loadRosterOverrides(file)).toEqual(overrides);
		expect(fs.readdirSync(path.dirname(file))).toEqual(["roster.yml"]);
	});

	it("keeps other top-level keys and replaces models", async () => {
		const file = path.join(tempDir(), "roster.yml");
		fs.writeFileSync(file, "note: keep me\nmodels:\n  - selector: old/model\n    tier: 3\n");
		await saveRosterOverrides(file, [{ selector: "new/model", enabled: false }]);
		const doc = Bun.YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		expect(doc).toEqual({ note: "keep me", models: [{ selector: "new/model", enabled: false }] });
	});

	it("refuses to overwrite a file that is not a YAML mapping", async () => {
		const file = path.join(tempDir(), "roster.yml");
		fs.writeFileSync(file, "- just\n- a list\n");
		await expect(saveRosterOverrides(file, [])).rejects.toThrow("not a YAML mapping");
		expect(fs.readFileSync(file, "utf8")).toBe("- just\n- a list\n");
	});
});

describe("patchRosterOverride", () => {
	it("merges patches into one entry per selector", () => {
		let overrides = patchRosterOverride([], "a/b", { tier: 2 });
		overrides = patchRosterOverride(overrides, "a/b", { enabled: false });
		overrides = patchRosterOverride(overrides, "c/d", { maxConcurrent: 4 });
		expect(overrides).toEqual([
			{ selector: "a/b", tier: 2, enabled: false },
			{ selector: "c/d", maxConcurrent: 4 },
		]);
	});

	it("drops the default enabled: true and removes entries left empty", () => {
		const disabled = patchRosterOverride([], "a/b", { enabled: false });
		expect(patchRosterOverride(disabled, "a/b", { enabled: true })).toEqual([]);
	});
});

describe("availableRosterModels", () => {
	it("maps the registry's available chat models to provider/id selectors with prices", () => {
		const calls: unknown[][] = [];
		const available = [
			{
				provider: "anthropic",
				id: "claude-haiku",
				contextWindow: 200_000,
				cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
			},
			{ provider: "ollama", id: "qwen", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		];
		const registry = {
			getAvailable: (...args: unknown[]) => {
				calls.push(args);
				return available;
			},
		} as unknown as Pick<ModelRegistry, "getAvailable">;

		expect(availableRosterModels(registry, new Map([["ollama/qwen", { tps: 42 }]]))).toEqual([
			{
				selector: "anthropic/claude-haiku",
				provider: "anthropic",
				id: "claude-haiku",
				cost: { input: 1, output: 5 },
				contextWindow: 200_000,
				tps: undefined,
			},
			{
				selector: "ollama/qwen",
				provider: "ollama",
				id: "qwen",
				cost: { input: 0, output: 0 },
				contextWindow: undefined,
				tps: 42,
			},
		]);
		expect(calls).toEqual([[]]);
	});

	it("returns [] when no model has credentials", () => {
		const registry = { getAvailable: () => [] } as unknown as Pick<ModelRegistry, "getAvailable">;
		expect(availableRosterModels(registry)).toEqual([]);
	});
});
