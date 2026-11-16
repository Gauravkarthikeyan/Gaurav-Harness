import { describe, expect, it } from "bun:test";
import { parseCrewPolicyArgs } from "../../src/gk/crew-policy-command";

describe("parseCrewPolicyArgs", () => {
	it("combines tokens over the current policy", () => {
		expect(parseCrewPolicyArgs("open-weight providers=commandcode,zai max-tier=2 quality", {})).toEqual({
			policy: { openWeightOnly: true, providers: ["commandcode", "zai"], maxTier: 2, preferQuality: true },
		});
		expect(parseCrewPolicyArgs("exclude=anthropic", { openWeightOnly: true })).toEqual({
			policy: { openWeightOnly: true, excludeProviders: ["anthropic"] },
		});
	});

	it("removes rules and clears", () => {
		const current = { openWeightOnly: true, maxTier: 2 as const, preferQuality: true };
		expect(parseCrewPolicyArgs("any-weights max-tier=off no-quality", current)).toEqual({ policy: {} });
		expect(parseCrewPolicyArgs("clear open", current)).toEqual({ policy: { openWeightOnly: true } });
	});

	it("show and empty args leave the policy unchanged", () => {
		expect(parseCrewPolicyArgs("", { maxTier: 1 })).toEqual({ policy: { maxTier: 1 } });
		expect(parseCrewPolicyArgs("show", { maxTier: 1 })).toEqual({ policy: { maxTier: 1 } });
	});

	it("rejects unknown options and bad tiers with usage", () => {
		expect(parseCrewPolicyArgs("cheap", {})).toMatchObject({
			error: expect.stringContaining('Unknown policy option "cheap"'),
		});
		expect(parseCrewPolicyArgs("max-tier=5", {})).toMatchObject({
			error: expect.stringContaining("max-tier must be"),
		});
	});
});
