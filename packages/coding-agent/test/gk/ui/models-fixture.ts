import { initialModelsScreenState, type ModelsScreenState, type ScreenModel } from "../../../src/gk/ui/models-screen";

function model(selector: string, patch: Partial<ScreenModel>): ScreenModel {
	const slash = selector.indexOf("/");
	return {
		selector,
		provider: selector.slice(0, slash),
		id: selector.slice(slash + 1),
		contextWindow: 200_000,
		cost: { input: 1, output: 5 },
		kind: "chat",
		connected: true,
		tier: 2,
		strengths: [],
		inRoster: true,
		maxConcurrent: 2,
		planIncluded: false,
		roles: [],
		...patch,
	};
}

export function fixtureState(): ModelsScreenState {
	return initialModelsScreenState({
		models: [
			model("anthropic/claude-opus-5-5", {
				contextWindow: 1_000_000,
				cost: { input: 5, output: 25 },
				tier: 3,
				tps: 94,
				strengths: ["review", "design", "research"],
				roles: ["default", "conductor", "plan"],
			}),
			model("anthropic/claude-haiku-5-5", {
				contextWindow: 100_000,
				cost: { input: 0.1, output: 0.5 },
				tier: 1,
				strengths: ["backend", "tests", "docs"],
				roles: ["smol"],
			}),
			model("openrouter/qwen/qwen3.5-plus", {
				contextWindow: 1_000_000,
				cost: { input: 0.3, output: 1.8 },
				tier: 1,
				inRoster: false,
			}),
			model("local/gemma-3-1b", { contextWindow: undefined, cost: { input: 0, output: 0 }, planIncluded: true }),
			model("openai/gpt-6", { connected: false, cost: { input: 2, output: 10 } }),
			model("openai/gpt-image-2", { kind: "image", cost: { input: 5, output: 40 } }),
		],
		connected: [
			{ id: "anthropic", models: 2, auth: "API key" },
			{ id: "local", models: 1 },
			{ id: "openrouter", models: 1, auth: "API key" },
		],
		attention: [{ id: "google-gemini-cli", reason: "login expired" }],
		notSetUp: ["openai", "xai"],
		roles: [
			{ role: "default", selector: "anthropic/claude-opus-5-5" },
			{ role: "conductor", selector: "anthropic/claude-opus-5-5" },
			{ role: "plan", selector: "anthropic/claude-opus-5-5" },
			{ role: "smol", selector: "anthropic/claude-haiku-5-5" },
			{ role: "slow" },
			{ role: "task" },
		],
	});
}
