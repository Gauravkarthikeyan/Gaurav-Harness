import { afterEach, describe, expect, test, vi } from "bun:test";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { isOpenWeightModelId } from "@oh-my-pi/pi-catalog/provider-models/open-weight";
import { aiCreditsModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_API_KEY = Bun.env.AICREDITS_API_KEY;

afterEach(() => {
	if (ORIGINAL_API_KEY === undefined) delete Bun.env.AICREDITS_API_KEY;
	else Bun.env.AICREDITS_API_KEY = ORIGINAL_API_KEY;
	vi.restoreAllMocks();
});

/** Rows recorded from `GET https://api.aicredits.in/v1/models` (2026-11-15), trimmed to the fields discovery reads. */
const RECORDED_MODELS = [
	{
		id: "aion-labs/aion-2.0",
		name: "AionLabs: Aion-2.0",
		input_cost_per_token: 8.000000000000001e-7,
		output_cost_per_token: 0.0000016000000000000001,
		cached_input_cost_per_token: 2.0000000000000002e-7,
		context_length: 131072,
		is_active: true,
		input_modalities: ["text"],
		mode: "chat",
		supported_apis: ["chat_completions"],
	},
	{
		id: "anthropic/claude-sonnet-4.6",
		name: "Anthropic: Claude Sonnet 4.6",
		input_cost_per_token: 0.000003,
		output_cost_per_token: 0.000015,
		cached_input_cost_per_token: 3e-7,
		context_length: 1000000,
		is_active: true,
		input_modalities: ["text", "image", "file"],
		mode: "chat",
		supported_apis: ["messages", "chat_completions"],
	},
	{
		id: "mistralai/mistral-medium-3",
		name: "Mistral: Mistral Medium 3",
		input_cost_per_token: 4.0000000000000003e-7,
		output_cost_per_token: 0.000002,
		cached_input_cost_per_token: 4e-8,
		context_length: 131072,
		is_active: true,
		input_modalities: ["text", "image", "file"],
		mode: "chat",
		supported_apis: ["chat_completions"],
	},
	{
		id: "moonshotai/kimi-k2.6",
		name: "MoonshotAI: Kimi K2.6",
		input_cost_per_token: 5.89e-7,
		output_cost_per_token: 0.00000349,
		cached_input_cost_per_token: 9.92e-8,
		context_length: 262144,
		is_active: true,
		input_modalities: ["text", "image"],
		mode: "chat",
		supported_apis: ["chat_completions"],
	},
	{
		id: "openai/gpt-4o-mini",
		name: "OpenAI: GPT-4o-mini",
		input_cost_per_token: 1.5e-7,
		output_cost_per_token: 6e-7,
		cached_input_cost_per_token: 7.5e-8,
		context_length: 128000,
		is_active: true,
		input_modalities: ["text", "image", "file"],
		mode: "chat",
		supported_apis: ["chat_completions", "responses"],
	},
	{
		id: "openai/gpt-oss-120b",
		name: "OpenAI: gpt-oss-120b",
		input_cost_per_token: 3.7e-8,
		output_cost_per_token: 1.7000000000000001e-7,
		cached_input_cost_per_token: 3.9e-9,
		context_length: 131072,
		is_active: true,
		input_modalities: ["text"],
		mode: "chat",
		supported_apis: ["chat_completions"],
	},
	{
		id: "openai/text-embedding-3-small",
		name: "text-embedding-3-small",
		input_cost_per_token: 2e-8,
		output_cost_per_token: 0,
		cached_input_cost_per_token: null,
		context_length: 8191,
		is_active: true,
		input_modalities: ["text"],
		mode: "embedding",
		supported_apis: ["embeddings"],
	},
	{
		id: "qwen/qwen3-vl-8b-instruct",
		name: "Qwen: Qwen3 VL 8B Instruct",
		input_cost_per_token: 1.17e-7,
		output_cost_per_token: 5e-7,
		cached_input_cost_per_token: 8e-9,
		context_length: 262144,
		is_active: true,
		input_modalities: ["image", "text"],
		mode: "chat",
		supported_apis: ["chat_completions"],
	},
	{
		id: "qwen/qwen3.6-plus",
		name: "Qwen: Qwen3.6 Plus",
		input_cost_per_token: 3.25e-7,
		output_cost_per_token: 0.00000195,
		cached_input_cost_per_token: 3.25e-8,
		context_length: 1000000,
		is_active: true,
		input_modalities: ["text", "image", "video"],
		mode: "chat",
		supported_apis: ["chat_completions"],
	},
	{
		id: "z-ai/glm-5-turbo",
		name: "Z.ai: GLM 5 Turbo",
		input_cost_per_token: 0.0000012,
		output_cost_per_token: 0.000004,
		cached_input_cost_per_token: 2.4e-7,
		context_length: 202752,
		is_active: true,
		input_modalities: ["text"],
		mode: "chat",
		supported_apis: ["chat_completions"],
	},
	{
		id: "z-ai/glm-5.1",
		name: "Z.ai: GLM 5.1",
		input_cost_per_token: 9.66e-7,
		output_cost_per_token: 0.0000030360000000000002,
		cached_input_cost_per_token: 1.794e-7,
		context_length: 204800,
		is_active: true,
		input_modalities: ["text"],
		mode: "chat",
		supported_apis: ["chat_completions"],
	},
	{
		id: "z-ai/glm-4.7",
		name: "Z.ai: GLM 4.7 (retired)",
		input_cost_per_token: 4e-7,
		output_cost_per_token: 0.00000175,
		context_length: 204800,
		is_active: false,
		input_modalities: ["text"],
		mode: "chat",
		supported_apis: ["chat_completions"],
	},
	{
		id: "deepseek/deepseek-latest",
		name: "DeepSeek Latest",
		input_cost_per_token: 0.00000132,
		output_cost_per_token: 0.00000396,
		cached_input_cost_per_token: 4.4e-8,
		context_length: 1048576,
		is_active: true,
		input_modalities: ["text"],
		mode: "chat",
		supported_apis: ["chat_completions"],
	},
];

function recordedModelsFetch(): FetchImpl {
	return vi.fn(
		async () =>
			new Response(JSON.stringify({ object: "list", data: RECORDED_MODELS }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	) as unknown as FetchImpl;
}

describe("AI Credits provider registration", () => {
	test("resolves AICREDITS_API_KEY", () => {
		Bun.env.AICREDITS_API_KEY = "sk-aicredits-test";
		expect(getEnvApiKey("aicredits")).toBe("sk-aicredits-test");
	});

	test("registers descriptor, default model, API-key login, and open-weight bundled roster", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "aicredits");
		expect(descriptor?.defaultModel).toBe("moonshotai/kimi-k2.6");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(descriptor?.allowUnauthenticated).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.aicredits).toBe("moonshotai/kimi-k2.6");

		const login = getOAuthProviders().find(item => item.id === "aicredits");
		expect(login?.name).toBe("AI Credits");

		const bundled = getBundledModels("aicredits");
		expect(bundled.some(model => model.id === "moonshotai/kimi-k2.6")).toBe(true);
		for (const model of bundled) {
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.aicredits.in/v1");
			expect(isOpenWeightModelId(model.id)).toBe(true);
		}
	});
});

describe("isOpenWeightModelId", () => {
	test.each([
		"moonshotai/kimi-k2.6",
		"z-ai/glm-5.1",
		"z-ai/glm-4.7-flash",
		"qwen/qwen3-coder-next",
		"qwen/qwen3-235b-a22b-thinking-2507",
		"groq/qwen-qwq-32b",
		"deepseek/deepseek-v4-pro",
		"meta-llama/llama-4-maverick",
		"groq/llama3-70b-8192",
		"minimax/minimax-m2.7",
		"mistralai/mistral-large-2512",
		"mistralai/ministral-8b-2512",
		"mistralai/devstral-2512",
		"mistralai/mixtral-8x22b-instruct",
		"google/gemma-4-31b-it",
		"openai/gpt-oss-120b",
		"microsoft/phi-4",
		"allenai/olmo-3-32b",
		"nvidia/nemotron-3-super-120b-a12b",
		"ibm-granite/granite-4.2-8b",
		"cohere/command-r7b-12-2024",
		"nousresearch/hermes-4-405b",
		"01-ai/yi-34b-chat",
		"internlm/internlm3-8b-instruct",
		"lgai/exaone-4.0-32b",
		"tiiuae/falcon-h1-34b",
		"bigcode/starcoder2-15b",
	])("keeps open-weight %s", id => {
		expect(isOpenWeightModelId(id)).toBe(true);
	});

	test.each([
		"openai/gpt-4o-mini",
		"openai/o3",
		"anthropic/claude-sonnet-4.6",
		"google/gemini-2.5-pro",
		"x-ai/grok-4",
		"cohere/command-a",
		"aion-labs/aion-2.0",
		"qwen/qwen-plus",
		"qwen/qwen3.6-plus",
		"qwen/qwen3.8-max-prime",
		"qwen/qwen3-coder-flash",
		"qwen/qwen3.8-omni-flash",
		"mistralai/mistral-medium-3.1",
		"mistralai/mistral-saba",
		"mistralai/codestral-2508",
		"z-ai/glm-5-turbo",
		"z-ai/glm-5v-turbo",
		"z-ai/glm-5.3-flashx",
		"deepseek/deepseek-latest",
		"mistralai/mistral-small-latest",
		"openai/gpt-oss-latest",
		"microsoft/dolphin-ish",
		"yield/yieldmax",
	])("drops %s", id => {
		expect(isOpenWeightModelId(id)).toBe(false);
	});
});

describe("AI Credits model discovery", () => {
	test("fetches the public roster and keeps only open-weight chat models", async () => {
		const fetchMock = recordedModelsFetch();
		const options = aiCreditsModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.aicredits.in/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
		expect(models?.map(model => model.id)).toEqual([
			"moonshotai/kimi-k2.6",
			"openai/gpt-oss-120b",
			"qwen/qwen3-vl-8b-instruct",
			"z-ai/glm-5.1",
		]);
	});

	test("sends the API key when one is configured", async () => {
		const fetchMock = recordedModelsFetch();
		await aiCreditsModelManagerOptions({ apiKey: "sk-aicredits", fetch: fetchMock }).fetchDynamicModels?.();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.aicredits.in/v1/models",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sk-aicredits" }) }),
		);
	});

	test("maps USD per-token pricing to per-million cost, context, and modalities", async () => {
		const models = await aiCreditsModelManagerOptions({ fetch: recordedModelsFetch() }).fetchDynamicModels?.();
		const kimi = models?.find(model => model.id === "moonshotai/kimi-k2.6");
		expect(kimi).toMatchObject({
			name: "MoonshotAI: Kimi K2.6",
			api: "openai-completions",
			provider: "aicredits",
			baseUrl: "https://api.aicredits.in/v1",
			contextWindow: 262144,
			input: ["text", "image"],
			cost: { input: 0.589, output: 3.49, cacheRead: 0.0992, cacheWrite: 0 },
		});

		const glm = models?.find(model => model.id === "z-ai/glm-5.1");
		expect(glm?.cost).toEqual({ input: 0.966, output: 3.036, cacheRead: 0.1794, cacheWrite: 0 });
		expect(glm?.input).toEqual(["text"]);

		const qwenVl = models?.find(model => model.id === "qwen/qwen3-vl-8b-instruct");
		expect(qwenVl?.input).toEqual(["text", "image"]);
		expect(qwenVl?.cost.input).toBe(0.117);
	});

	test("leaves cost unset when the roster carries no price", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "acme/llama-9-unpriced",
								name: "Llama 9",
								context_length: 8192,
								is_active: true,
								input_modalities: ["text"],
								mode: "chat",
								supported_apis: ["chat_completions"],
							},
						],
					}),
					{ status: 200 },
				),
		) as unknown as FetchImpl;
		const models = await aiCreditsModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		expect(models?.[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});
