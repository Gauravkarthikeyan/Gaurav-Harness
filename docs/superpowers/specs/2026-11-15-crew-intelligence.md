# Crew intelligence: how the conductor casts and delegates

Status: implemented 2026-11-15. Extends the Orchestra design (`2026-11-15-gkharness-design.md` §5.4).

## Why

Gaurav's first real Orchestra runs went badly:

1. One haiku worker built a whole landing page in one item. The result was mediocre: a quality drop for a small saving.
2. He asked for open-weight models. The router picked `commandcode/claude-fable-5-2` (listed at $0, so "free") and `gpt-5.6-terra`. He rejected the plan twice and the conductor resubmitted the same thing.
3. The conductor could not add a worker to a live run or choose models. It said so itself.
4. Casting was opaque. He could change a row's model, but only from a bare list.
5. The payslip said "This run cost $0.24 more than the conductor alone (est $0.01)". That compared a real spend against a size estimate.
6. The conductor knew nothing about the models it could use.

## Research

Sources read on 2026-11-15:

- MindStudio, "Use Opus as a Senior Adviser to Sonnet and Haiku" — https://www.mindstudio.ai/blog/anthropic-advisor-strategy-opus-adviser-sonnet-haiku
- Fazm, "Using Opus as Orchestrator, Delegating to Sonnet and Haiku" — https://fazm.ai/blog/opus-orchestrator-delegate-sonnet-haiku-cost
- Daniel Avila, "Sonnet-Main, Opus-advisor, Haiku-subagents" — https://medium.com/@dan.avila7/sonnet-main-opus-advisor-haiku-subagents-splits-your-claude-code-session-across-three-models-1e9e96a47f26 (member-only; only the setup survived: main model, advisor model and subagent model are three separate settings)
- r/codex, "Fable Plans > ChatGPT Execute" — https://www.reddit.com/r/codex/comments/1usxtte/fable_plans_chatgpt_execute_which_model/
- r/LocalLLM, "Setting up Claude as a Supervisor over Qwen?" — https://www.reddit.com/r/LocalLLM/comments/1xfjkoi/setting_up_claude_as_a_supervisor_over_qwen/
- Grand Linux, "Claude Plans + Local AI Executes" — https://www.grandlinux.com/en/blogs/claude-local-ai-planner-executor.html

What they agree on:

- **Planner/executor split.** The strong model plans, writes briefs and reviews. Cheaper models do the token-heavy reading and writing. Planning and review cost few tokens; execution costs most of them (Grand Linux: ~10k planner tokens instead of ~150k doing it alone). Fazm adds that the bigger win is context: each worker gets only what its task needs.
- **Advisor, not author.** In the advisor pattern the strong model gives specific advice and the executor does the work with that advice in context. Anthropic reports about 11% lower cost and about 2% better benchmark scores than the strong model alone (MindStudio). Generic advice ("be clear") does not help. The advice has to be specific to the task.
- **Briefs written for a colleague.** The working setups give each brief the plan section to read, the files the worker may touch, the neighbouring code to match, what must not happen, what good looks like, and the check commands that prove it is done (r/LocalLLM, Serious_Highway1239 and Character-Law-4020).
- **One self-contained piece per brief.** A function with clear inputs and outputs, not a cross-file refactor. Small pieces fail less and are easier to verify.
- **Never trust the executor's verdict.** The supervisor reads the actual diffs and re-runs the checks. Anything wrong goes back as a fix task, with a retry budget, then escalation (r/LocalLLM; Grand Linux "plan-execute mismatch").
- **Match the model to the difficulty.** Rote work goes to cheap or local models, judgment and review to frontier ones, normal implementation to a mid tier (r/codex: plan with Fable, validate with Sol, execute with Terra or Opus). Executors below a capability floor fail mid-task however good the plan is (Grand Linux: under ~14B parameters is usually not enough).
- **Mixing providers works.** Claude over Qwen, Fable over GPT, local Qwen with Claude review. Casting has to work for every provider, not just Claude tiers.

## What we adopted

| Pattern | Where |
|---|---|
| Planner/executor with an advisor | `prompts/gk/conductor.md`: the conductor plans, briefs, advises (`ask_conductor`) and reviews; it never edits |
| Rich, self-contained briefs | conductor.md brief template: goal, files to read first, contracts, acceptance criteria, quality bar, skills to load, out of scope. `crewWorkerPrompt` adds house rules: read first, load the named skills, verify each criterion, ask instead of guessing, report criteria + evidence |
| Small items across several workers | conductor.md: split by outcome (markup / styles / behaviour / review), not one giant item |
| Mandatory review loop | conductor.md: read the files, or `crew_add` a reviewer one tier up; up to 3 `crew_send` fix-up rounds; then `crew_escalate` or `crew_reassign` |
| Advisor channel | `ask_conductor(question)` worker tool (`gk/ask-conductor-tool.ts`): an IRC message to the conductor; the worker blocks until `crew_send` answers or the timeout passes |
| Difficulty → tier, quality first | `router.ts` `itemFloor`: difficulty sets the floor; frontend/design/architecture never below tier 2; `preferQuality` adds one. The cheapest model that clears the floor with the best strength fit wins. Money never pushes an item below its floor |
| Provider-agnostic model awareness | `crew_models` table: selector, provider, tier, $in/$out, est S/M/L, strengths, open weights, context, tok/s, for every connected model |
| Capability over price for open models | `roster.ts` `MODEL_HINTS`: open-weight flagships (Kimi K2+, GLM 4.5+/5, MiniMax M2+, DeepSeek V3/R1/V4-pro, Qwen coder/large, gpt-oss-120b, …) are tier 2 even when priced like tier 1. Frontier families listed at $0 by a gateway (opus, fable) stay tier 3 |

## Design

### Model awareness

`RosterEntry` gains `provider`, `openWeight`, `contextWindow` and `tps` (measured speed from `model_perf`). `openWeight` comes from `isOpenWeightModelId` (`@oh-my-pi/pi-catalog/provider-models/open-weight`, shared with the AI Credits provider). It is a family table: llama, qwen/qwq, deepseek, kimi, glm, minimax, mistral/ministral/mixtral/devstral/codestral, gemma, gpt-oss, phi, olmo, nemotron, granite, command-r, hermes, yi, internlm, exaone, falcon, starcoder. Closed SKUs are excluded: `*-latest`, Qwen max/plus/turbo/flash, Mistral Medium/Saba, dated Codestral 25xx, GLM turbo/flashx.

### Conductor chooses, router assists

- `WorkItem.model` + `reason`: a connected, policy-allowed pick wins ("conductor's pick: …"). Otherwise the router auto-casts and says why the pick was skipped.
- `CrewPolicy { openWeightOnly, providers, excludeProviders, maxTier, preferQuality }` is session state, set by `crew_policy` or `/crew policy …`. The router, the Casting Board, `crew_add`, `crew_reassign` and `crew_escalate` enforce it. If nothing satisfies it for an item, the tool fails with the list of models the policy allows.

### Dynamic crew

- `crew_add(items)` validates new items against the live run: ids are unique; deps may name any existing item; scopes may not clash with running or waiting items unless ordered by a dependency. It casts and shows only the new items on the board, then schedules them. With no active run it acts as `crew_plan`.
- `crew_reassign(item, model, note?)` switches a waiting item. A running or failed item is restarted on the new model with the note and the previous report.

### Rejections

- Rejecting (r or esc) asks for a note. The conductor gets "Gaurav rejected: <note>" plus his row edits and drops.
- His row edits carry into the next plan for the same item ids.
- A resubmission with the same items, briefs, models and policy as the last rejected plan is refused with his note.

### Casting Board

- The policy shows on top. Every row shows its casting reason. The footer shows the total, the baseline, and savings or the overrun ("conductor on a plan" when the conductor has no dollar price).
- `e` opens a searchable picker: type to search; ^o open-weight only, ^p provider, ^t tier, ^a roster/all connected. Rows show tier, open, ctx, $in/$out, strengths and the estimate.
- `p` toggles open-weight only for this run and re-casts the rows Gaurav did not pick by hand.

### Baseline math

- Estimate: the conductor-only baseline is every item at the conductor's catalog price on the same size estimates as the workers (`conductorBaseline`). A plan-priced (zero-price) conductor has no dollar baseline and no savings claim.
- Actual: the payslip and the header's SAVED compare actual crew spend against the same work repriced at the conductor's rates: each item's actual × (conductor estimate ÷ worker estimate) (`conductorEquivalentUsd`). Before this, a $0.249 actual was compared with a $0.01 size estimate. For the screenshot case (gpt-6-luna conductor at $0.1/$0.5, haiku at $1/$5, one S item, $0.249 actual), the payslip now reads "actual $0.25 (est $0.10) · conductor-only est $0.01 · same work at its rates ≈$0.02 — This run cost $0.22 more than the conductor alone would have (≈$0.02)". That is true: luna is ten times cheaper per token than haiku.

## Not done

- A crew worker revived from disk after a restart loses `ask_conductor`: `crewConductorId` is not persisted.
- `MODEL_HINTS` covers the families in today's catalog. New families fall back to price tiers until added or overridden in `roster.yml`.
