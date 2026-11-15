/**
 * Open-weight model policy for gateways that resell both open-weight and
 * proprietary models (AI Credits). A model qualifies when its ID names an
 * open-weight family and is not one of the closed, API-only SKUs those
 * vendors publish under the same family names.
 */

/** Open-weight family tokens, matched at an ID segment boundary (`/`, `-`, `_`, `.`, `:` or start). */
const OPEN_WEIGHT_FAMILIES = [
	"llama",
	"qwen",
	"qwq",
	"deepseek",
	"kimi",
	"glm",
	"minimax",
	"mistral",
	"ministral",
	"mixtral",
	"devstral",
	"codestral",
	"gemma",
	"gpt-oss",
	"phi",
	"olmo",
	"nemotron",
	"granite",
	"command-r",
	"hermes",
	"yi",
	"internlm",
	"exaone",
	"falcon",
	"starcoder",
] as const;

const OPEN_WEIGHT_FAMILY_RE = new RegExp(`(?:^|[/_.:-])(?:${OPEN_WEIGHT_FAMILIES.join("|")})(?=$|[\\d/_.:-])`);

/**
 * Closed SKUs sold under open-weight family names:
 * - `*-latest` aliases roll to whatever the vendor promotes, including closed models.
 * - Qwen `max` / `plus` / `turbo` / `flash` tiers are Alibaba Cloud API-only.
 * - Mistral Medium, Saba, and dated Codestral 25xx releases have no published weights.
 * - Z.ai GLM `turbo` / `flashx` tiers are API-only.
 */
const PROPRIETARY_SKU_RES: readonly RegExp[] = [
	/-latest$/,
	/(?:^|\/)qw(?:en|q)[\w.-]*-(?:max|plus|turbo|flash)(?:$|-)/,
	/(?:^|\/)mistral-(?:medium|saba)(?:$|-)/,
	/(?:^|\/)codestral-25\d\d$/,
	/(?:^|\/)glm-[\w.-]*(?:turbo|flashx)(?:$|-)/,
];

/** Whether a gateway model ID belongs to an open-weight model family. */
export function isOpenWeightModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!OPEN_WEIGHT_FAMILY_RE.test(normalized)) return false;
	return !PROPRIETARY_SKU_RES.some(re => re.test(normalized));
}
