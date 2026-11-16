import { describe, expect, it } from "bun:test";
import { conductorLimitHint } from "../../src/gk/orchestra-mode";

describe("conductorLimitHint", () => {
	it("tells Gaurav to switch the conductor on a usage limit", () => {
		const hint = conductorLimitHint(
			"Retry failed after 1 attempts: Codex error event: The usage limit has been reached (code=usage_limit_reached)",
			"openai-codex/gpt-6-luna",
		);
		expect(hint).toStartWith("Conductor openai-codex/gpt-6-luna hit a usage/quota limit (Codex error event:");
		expect(hint).toContain("/models → set the conductor role");
	});

	it("covers rate limits and plan errors, not other failures", () => {
		expect(conductorLimitHint("429 Too Many Requests", "a/b")).toBeDefined();
		expect(conductorLimitHint("403 Your Go plan doesn't include API access", "a/b")).toBeDefined();
		expect(conductorLimitHint("socket hang up", "a/b")).toBeUndefined();
		expect(conductorLimitHint(undefined, "a/b")).toBeUndefined();
	});
});
