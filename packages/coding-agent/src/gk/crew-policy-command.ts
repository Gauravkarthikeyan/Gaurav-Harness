/**
 * `/crew policy …` argument parsing. Tokens combine left to right over the current policy:
 * `open-weight` · `any-weights` · `providers=a,b` · `exclude=a,b` · `max-tier=1|2|3` · `max-tier=off` ·
 * `quality` · `no-quality` · `clear`. No tokens (or `show`) leaves the policy as is.
 */
import type { CrewPolicy, Tier } from "./types";

export const CREW_POLICY_USAGE =
	"/crew policy [open-weight|any-weights] [providers=a,b] [exclude=a,b] [max-tier=1|2|3|off] [quality|no-quality] [clear]";

export function parseCrewPolicyArgs(args: string, current: CrewPolicy): { policy: CrewPolicy } | { error: string } {
	let policy: CrewPolicy = { ...current };
	for (const raw of args.trim().split(/\s+/).filter(Boolean)) {
		const token = raw.toLowerCase();
		const [key, value = ""] = token.split("=", 2) as [string, string | undefined];
		const list = value
			.split(",")
			.map(part => part.trim())
			.filter(Boolean);
		if (token === "show") continue;
		if (token === "clear" || token === "off" || token === "reset") policy = {};
		else if (["open-weight", "open-weights", "openweight", "open"].includes(token)) policy.openWeightOnly = true;
		else if (["any-weights", "closed-ok", "any"].includes(token)) delete policy.openWeightOnly;
		else if (token === "quality" || token === "prefer-quality") policy.preferQuality = true;
		else if (token === "no-quality") delete policy.preferQuality;
		else if (key === "providers" || key === "provider") {
			if (list.length > 0) policy.providers = list;
			else delete policy.providers;
		} else if (key === "exclude" || key === "exclude-providers") {
			if (list.length > 0) policy.excludeProviders = list;
			else delete policy.excludeProviders;
		} else if (key === "max-tier" || key === "maxtier") {
			if (value === "off" || value === "") delete policy.maxTier;
			else if (value === "1" || value === "2" || value === "3") policy.maxTier = Number(value) as Tier;
			else return { error: `max-tier must be 1, 2, 3 or off (got "${value}"). Usage: ${CREW_POLICY_USAGE}` };
		} else return { error: `Unknown policy option "${raw}". Usage: ${CREW_POLICY_USAGE}` };
	}
	return { policy };
}
