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
				tier: 3,
				strengths: [],
				enabled: true,
				maxConcurrent: 2,
				planIncluded: false,
				cost: { input: 3, output: 15 },
			},
			{
				selector: "c/d",
				tier: 2,
				strengths: [],
				enabled: true,
				maxConcurrent: 2,
				planIncluded: true,
				cost: { input: 0, output: 0 },
			},
		]);
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
			{ provider: "anthropic", id: "claude-haiku", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
			{ provider: "ollama", id: "qwen", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		];
		const registry = {
			getAvailable: (...args: unknown[]) => {
				calls.push(args);
				return available;
			},
		} as unknown as Pick<ModelRegistry, "getAvailable">;

		expect(availableRosterModels(registry)).toEqual([
			{ selector: "anthropic/claude-haiku", cost: { input: 1, output: 5 } },
			{ selector: "ollama/qwen", cost: { input: 0, output: 0 } },
		]);
		expect(calls).toEqual([[]]);
	});

	it("returns [] when no model has credentials", () => {
		const registry = { getAvailable: () => [] } as unknown as Pick<ModelRegistry, "getAvailable">;
		expect(availableRosterModels(registry)).toEqual([]);
	});
});
