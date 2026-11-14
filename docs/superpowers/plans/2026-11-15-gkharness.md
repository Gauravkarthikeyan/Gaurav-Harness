> DRAFT — revision in progress, see HANDOFF.md. Spec rev 2 (Stage, Core, finale, skills pack, launch anywhere) is NOT yet reflected in the tasks below; Task 12 (SplitLayout) is superseded by spec §5.5.

# GK Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork omp into `gk-code` (Gaurav's Harness): gold-themed TUI with an animated splash, Solo mode, and an Orchestra mode where a conductor model plans and cheap models build.

**Architecture:** Hard fork of oh-my-pi merged into this repo with an `upstream` remote. All new code under `packages/coding-agent/src/gk/` (logic, tools, UI) plus a theme JSON and splash scene in `packages/tui`. omp files are touched only at small hook points marked `// gk:` so upstream merges stay tractable. Orchestra workers reuse omp's `VibeSessionRegistry`.

**Tech Stack:** Bun ≥ 1.4.4, TypeScript, `@oh-my-pi/pi-tui`, `@oh-my-pi/pi-catalog`, `bun test`. Rust toolchain only for `bun setup`.

**Spec:** `docs/superpowers/specs/2026-11-15-gkharness-design.md`

## Global Constraints

- Upstream base: `https://github.com/can1357/oh-my-pi` commit `b7fe8c7f43c378faa0863e79f5509f9dde16ad9a` (v18.20.1).
- Binaries `gk-code` and `gk`; `APP_NAME = "gk"`; `CONFIG_DIR_NAME = ".gk"`.
- Never edit `packages/ai/src/providers/**`, `packages/ai/src/auth*`, or `USER_AGENT` in `packages/utils/src/dirs.ts`.
- Keep internal package names `@oh-my-pi/*`. Every edit to an omp-owned file carries a `// gk:` comment on the changed line or block.
- Credits copy, verbatim: `Gaurav's Harness`, `by Gaurav Karthikeyan · github.com/Gauravkarthikeyan`.
- Palette = the token table in spec §5.2 (`gold` dark on `#141210`, `gold-light` on `#FAF7F0`), hex values copied exactly. `text`, `muted`, `accent`, `success`, `error`, `warning`, `info` ≥ 4.5:1 against their theme background; `dim` ≥ 3:1 and never carries information. Gold is accent only (focus, selection, brand, active worker): no gold body text, no gold borders on unfocused panes.
- UX rules in spec §5.6 apply to every new surface: Esc closes every overlay, ≤ 4 key hints in a footer, every list has empty/loading/error copy naming cause + next key, no emoji in UI chrome, no looping animation.
- Size estimates: `S = {input: 60_000, output: 8_000}`, `M = {input: 250_000, output: 30_000}`, `L = {input: 800_000, output: 80_000}`.
- Default tier by catalog output price per 1M tokens: `< 2` → 1, `< 12` → 2, else 3; output price `0` → tier 2, `planIncluded: true`.
- Router score: `estCost × (1 − 0.3 × fit)`; ties → higher fit → lower tier → selector ascending.
- New settings (all under `gk.`): `launchMode: "ask"|"solo"|"orchestra"` (default `"ask"`), `splash: boolean` (default `true`), `budget.dailyUsd?: number`, `orchestra.maxRunUsd?: number`, `orchestra.autoApprove: boolean` (default `false`).
- No code from pi-harness (AGPL).
- Animations honour `tui.motion` off, non-TTY, `--quiet`, and resume; splash ≤ 1800 ms and skippable by any key.

## Review Focus

1. **No connected cheap models** (only the conductor is logged in): router must assign every item to the conductor with reason `"no eligible worker"` and the board still works — test in Task 7.
2. **Narrow terminal (< 100 cols) or resize mid-run:** Orchestra layout must switch to stacked mode without garbled lines — test in Task 12.
3. **Two parallel items writing the same folder:** must be rejected before spawn — test in Task 8.
4. **User hits Esc/Ctrl+C or exits Orchestra mid-run:** all workers cancelled, ledger records `"cancelled"` — test in Task 9.
5. **Zero-price (subscription/local) models:** must not crash cost math or show `NaN`; shown as "plan" in the board — tests in Tasks 6 and 11.
6. **MCP server that fails to start or needs OAuth:** Capabilities shows `failed: <reason>` / `needs login`, never hangs the overlay — test in Task 17.

---

### Task 0: Toolchain

- [ ] **Step 1:** `curl -fsSL https://bun.sh/install | bash` then `bun --version` → ≥ 1.4.4.
- [ ] **Step 2:** `rustup show` → toolchain matching `rust-toolchain.toml` (install with `curl https://sh.rustup.rs -sSf | sh` if missing).

### Task 1: Fork and boot

**Files:** repo root (merge of upstream).

- [ ] **Step 1:** In `/Users/gauravkarthik/Developer/Gk-code`: `git remote add upstream https://github.com/can1357/oh-my-pi && git fetch upstream main && git merge --allow-unrelated-histories b7fe8c7f43c378faa0863e79f5509f9dde16ad9a -m "chore: fork omp v18.20.1"`.
- [ ] **Step 2:** `bun setup` → exits 0.
- [ ] **Step 3:** `bun dev -- --version` → prints an omp version.
- [ ] **Step 4:** Append `© 2026 Gaurav Karthikeyan` to `LICENSE` (keep all existing lines). Commit `chore: fork omp as gk-code base`.

### Task 2: Identity rebrand + omp profile import

**Files:**
- Modify: `packages/utils/src/dirs.ts` (`APP_NAME`, `CONFIG_DIR_NAME`, `APP_URL` → `https://github.com/Gauravkarthikeyan`)
- Modify: `packages/coding-agent/package.json` (`bin`: `gk-code` and `gk` → `src/cli.ts`)
- Modify: version output in `packages/coding-agent/src/cli` (find the `--version` handler)
- Modify: `packages/tui/src/prompt/welcome.ts` (`PI_LOGO`, `WORDMARK` → GK mark)
- Create: `packages/coding-agent/src/gk/import-omp.ts`
- Test: `packages/coding-agent/test/gk/import-omp.test.ts`, `packages/utils/test/gk-dirs.test.ts`

**Interfaces — Produces:**
- `importOmpProfile(opts: { home: string; copy?: (src: string, dst: string) => Promise<void> }): Promise<{ imported: boolean; reason: "imported" | "gk-exists" | "no-omp" }>` — copies `<home>/.omp/agent` → `<home>/.gk/agent` only when `.gk` is absent.
- `GK_UPSTREAM_VERSION = "18.20.1"` exported from `packages/coding-agent/src/gk/brand.ts`.

- [ ] **Step 1: Failing tests**
  - `gk-dirs.test.ts`: `expect(APP_NAME).toBe("gk"); expect(CONFIG_DIR_NAME).toBe(".gk")`.
  - `import-omp.test.ts` (temp dirs): `.omp/agent/auth.json` exists, no `.gk` → `{imported: true, reason: "imported"}` and file exists under `.gk/agent`; `.gk` present → `reason: "gk-exists"`, nothing copied; neither → `reason: "no-omp"`.
- [ ] **Step 2:** Run `cd packages/coding-agent && bun test test/gk/import-omp.test.ts` and `cd packages/utils && bun test test/gk-dirs.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Call `importOmpProfile` at startup before settings load, interactive TTY only, after a yes/no prompt; print one notice line on import.
- [ ] **Step 4:** Tests PASS; `bun dev -- --version` prints `gk-code <version> (omp 18.20.1)`.
- [ ] **Step 5:** Commit `feat(gk): rebrand to gk-code and import omp profile`.

### Task 3: Gold theme

**Files:**
- Create: `packages/tui/src/theme/gold.json`, `packages/tui/src/theme/gold-light.json`
- Modify: `packages/tui/src/theme/loader.ts` (embed both; default dark theme `"gold"`, default light theme `"gold-light"`, chosen by omp's existing appearance detection)
- Test: `packages/tui/test/gk-gold-theme.test.ts`

- [ ] **Step 1: Failing test** — both themes pass `validateThemeJson`; default dark/light names resolve to `"gold"`/`"gold-light"`; table-driven contrast check (implement WCAG relative luminance in the test): `text`, `muted`, `accent`, `success`, `error`, `warning`, `userMessageText`, `toolOutput`, `mdLink` ≥ 4.5 and `dim` ≥ 3.0 against the theme background; `toolDiffAdded` = `success`, `toolDiffRemoved` = `error`.
- [ ] **Step 2:** `cd packages/tui && bun test test/gk-gold-theme.test.ts` → FAIL.
- [ ] **Step 3:** Write both JSONs with all tokens required by `theme-schema.json` from the §5.2 table. Backgrounds: `userMessageBg`/`customMessageBg`/`toolPendingBg` = surface, `selectedBg` = `#2A2418` (light `#EFE6CF`), `toolSuccessBg`/`toolErrorBg` = surface (state shown by glyph color, not a colored block). Status line: model = accent, everything else muted. Syntax: keywords accent, strings `#A7C080` (light `#4E7A2E`), numbers warning, types info, comments dim, rest text. Set `tui.colorfulMarkdown` default to `false` so headings use `mdHeading` = accent, not rainbow ANSI.
- [ ] **Step 4:** PASS. Launch `bun dev` in a dark and a light terminal profile; confirm gold appears only on focus/brand.
- [ ] **Step 5:** Commit `feat(gk): gold and gold-light themes`.

### Task 4: Splash + mode picker

**Files:**
- Create: `packages/tui/src/setup/scenes/gk-splash.ts`, `packages/tui/src/setup/scenes/gk-mode-picker.ts`
- Create: `packages/coding-agent/src/gk/launch-mode.ts`
- Modify: `packages/coding-agent/src/main.ts` (around `shouldShowStartupSplash`, ~line 2606) and `startup-splash.ts` to run the GK splash when `gk.splash` is true, then the picker
- Modify: CLI flag registration: `--solo`, `--orchestra`
- Test: `packages/coding-agent/test/gk/launch-mode.test.ts`, `packages/tui/test/gk-splash.test.ts`

**Interfaces — Produces:**
- `type LaunchMode = "solo" | "orchestra"`
- `resolveLaunchMode(i: { flag?: LaunchMode; setting: "ask" | LaunchMode; lastChoice?: LaunchMode; interactive: boolean }): LaunchMode | "ask"`
- `renderGkSplash(width: number, height: number, frame: number): string[]`
- `runModePicker(host: SetupUiHost, initial: LaunchMode): Promise<LaunchMode>`
- Last choice persisted at `<agentDir>/gk-state.json` as `{ "lastMode": "solo" | "orchestra" }`.

- [ ] **Step 1: Failing tests**
  - `resolveLaunchMode`: flag wins over everything; `setting: "solo"` → `"solo"`; `setting: "ask"`, interactive → `"ask"`; non-interactive with `"ask"` → `lastChoice ?? "solo"`.
  - `renderGkSplash(120, 30, 0)`: returns 30 lines, a line containing `Gaurav's Harness` after stripping ANSI, a line containing `github.com/Gauravkarthikeyan`; `renderGkSplash(50, 15, 0)` (below 56×22) returns a compact centered `GK` mark with no line wider than 50.
- [ ] **Step 2:** Run both test files → FAIL.
- [ ] **Step 3:** Implement. Splash: logo from spec §5.2 revealed row by row (first 600 ms), one shimmer sweep via `gradientLogo` (next 800 ms), then static; no sparkles, no loop; 1800 ms max; any key skips. Picker: two cards per spec ASCII, focused card gets `borderAccent` edge, unfocused cards use `border`; ←/→ or `s`/`o`, Enter. `"orchestra"` result enters Orchestra mode (Task 10 hook; until then log and fall back to solo).
- [ ] **Step 4:** PASS; run `bun dev` in a ≥ 120-col terminal, observe splash → picker → session.
- [ ] **Step 5:** Commit `feat(gk): animated splash and mode picker`.

### Task 5: Credits

**Files:** Create `packages/coding-agent/src/gk/credits.ts`; register `/credits` in `packages/coding-agent/src/slash-commands/builtin-registry.ts`; add `--credits` flag. Test: `packages/coding-agent/test/gk/credits.test.ts`.

**Produces:** `creditsLines(): string[]`.

- [ ] **Step 1: Failing test** — joined output contains `Gaurav's Harness`, `Gaurav Karthikeyan`, `github.com/Gauravkarthikeyan`, `oh-my-pi`, `Can Bölük`, `Mario Zechner`, `MIT`.
- [ ] **Step 2–4:** FAIL → implement (gold boxed card, also lists omp upstream version) → PASS.
- [ ] **Step 5:** Commit `feat(gk): credits`.

### Task 6: Roster and cost model

**Files:** Create `packages/coding-agent/src/gk/roster.ts`, `packages/coding-agent/src/gk/types.ts`. Test: `packages/coding-agent/test/gk/roster.test.ts`.

**Produces (`types.ts`):**
```ts
export type Skill = "frontend" | "backend" | "tests" | "docs" | "infra" | "refactor" | "research" | "review" | "design";
export type Tier = 1 | 2 | 3;
export type Size = "S" | "M" | "L";
export interface RosterEntry { selector: string; tier: Tier; strengths: Skill[]; enabled: boolean; maxConcurrent: number; planIncluded: boolean; cost: { input: number; output: number } }
export interface RosterOverride { selector: string; tier?: Tier; strengths?: Skill[]; enabled?: boolean; maxConcurrent?: number }
```
**Produces (`roster.ts`):**
- `SIZE_TOKENS: Record<Size, { input: number; output: number }>`
- `defaultTier(outputPerMTok: number): { tier: Tier; planIncluded: boolean }`
- `estimateCostUsd(cost: { input: number; output: number }, size: Size): number`
- `buildRoster(models: Array<{ selector: string; cost: { input: number; output: number } }>, overrides: RosterOverride[]): RosterEntry[]` — defaults: `strengths: []`, `enabled: true`, `maxConcurrent: 2`; overrides for unknown selectors are ignored.
- `loadRosterOverrides(path: string): Promise<RosterOverride[]>` — YAML `models:` list at `<agentDir>/roster.yml`; missing file → `[]`; invalid entries skipped with a logged warning.
- `availableRosterModels(registry: ModelRegistry): Array<{selector, cost}>` — only models with usable credentials (use the same availability check `/model` uses).

- [ ] **Step 1: Failing tests** — `defaultTier(1.25)` → tier 1; `defaultTier(10)` → 2; `defaultTier(75)` → 3; `defaultTier(0)` → `{tier: 2, planIncluded: true}`; `estimateCostUsd({input: 3, output: 15}, "M")` → `0.75 + 0.45 = 1.2`; zero cost → `0` (not NaN); override `{selector: "a/b", tier: 1, strengths: ["backend"]}` applied; unknown-selector override ignored; malformed YAML entry skipped.
- [ ] **Step 2–4:** FAIL → implement → PASS (`bun test test/gk/roster.test.ts`).
- [ ] **Step 5:** Commit `feat(gk): model roster and cost estimates`.

### Task 7: Router (`castCrew`)

**Files:** Create `packages/coding-agent/src/gk/router.ts`. Test: `packages/coding-agent/test/gk/router.test.ts`.

**Consumes:** Task 6 types, `estimateCostUsd`.
**Produces:**
```ts
export interface WorkItem { id: string; title: string; brief: string; skills: Skill[]; difficulty: Tier; size: Size; dependsOn: string[]; scope: string[] }
export interface Assignment { itemId: string; selector: string; tier: Tier; estCostUsd: number; planIncluded: boolean; reason: string }
export interface CastResult { assignments: Assignment[]; totalEstUsd: number; baselineEstUsd: number; overBudget: boolean }
export function castCrew(items: WorkItem[], roster: RosterEntry[], conductor: RosterEntry, opts?: { maxRunUsd?: number; exclude?: Record<string, string[]>; minTier?: Record<string, Tier> }): CastResult
```
Algorithm exactly as spec §5.4 Router (eligibility `tier ≥ max(difficulty, minTier[id])`, minus `exclude[id]`).

- [ ] **Step 1: Failing tests**
  - difficulty-1 backend item, roster `{haiku tier1 $5 out, strengths [backend]}`, `{flash tier1 $2.5 out}` → picks by score; reason string non-empty.
  - difficulty-3 item with only tier-1/2 workers → conductor, reason `"no eligible worker"`.
  - empty roster → every item to conductor (Review Focus 1).
  - tie on score → higher fit wins; then lower tier; then selector ascending.
  - `planIncluded` model eligible → chosen (score 0), `estCostUsd: 0`.
  - `baselineEstUsd` = Σ conductor estimates; `overBudget` true when `totalEstUsd > maxRunUsd`.
  - `exclude` + `minTier` respected (used by escalation).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(gk): deterministic crew router`.

### Task 8: Plan validation

**Files:** Create `packages/coding-agent/src/gk/plan-validate.ts`. Test: `packages/coding-agent/test/gk/plan-validate.test.ts`.

**Produces:**
- `type CrewPlanError = { code: "duplicate-id" | "unknown-dep" | "cycle" | "empty-brief" | "empty-scope" | "scope-overlap"; itemIds: string[]; message: string }`
- `validateCrewPlan(items: WorkItem[]): CrewPlanError[]`
- `scopesOverlap(a: string, b: string): boolean` — normalize (strip `./`, collapse `//`, trailing `/` on dirs kept); overlap iff equal or one is a path-segment prefix of the other (`src/api` vs `src/api2` → false).
- `canRunConcurrently(items: WorkItem[], a: string, b: string): boolean` — neither transitively depends on the other.

- [ ] **Step 1: Failing tests** — each error code from a minimal plan (`empty-scope` = a blank/whitespace-only scope entry; `scope: []` is a valid read-only item that never overlaps); `src/api/` vs `src/api/routes.ts` overlap; `src/api` vs `src/api2` no overlap; overlapping scopes allowed when B dependsOn A (also transitively via C) (Review Focus 3); valid 3-item plan → `[]`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(gk): crew plan validation`.

### Task 9: Crew runtime (workers, scheduler, ledger)

**Files:**
- Modify: `packages/coding-agent/src/vibe/runtime.ts` — `spawn` args gain optional `model?: string`; when set, `#resolveWorker` uses `getBundledAgent("task")` with `modelOverride: [model]` instead of the cli tier mapping (`// gk:`).
- Create: `packages/coding-agent/src/gk/crew-runtime.ts`, `packages/coding-agent/src/gk/ledger.ts`
- Test: `packages/coding-agent/test/gk/crew-runtime.test.ts`, `packages/coding-agent/test/gk/ledger.test.ts`

**Produces:**
```ts
export type CrewItemState = "waiting" | "running" | "done" | "failed" | "cancelled";
export interface CrewWorkerSpawner { spawn(a: { name: string; prompt: string; model: string }): Promise<{ workerId: string; settled: Promise<{ ok: boolean; costUsd: number; tokens: number; text: string }> }>; send(workerId: string, msg: string): Promise<void>; kill(workerId: string): Promise<void> }
export class CrewRun {
  constructor(opts: { runId: string; items: WorkItem[]; cast: CastResult; roster: RosterEntry[]; spawner: CrewWorkerSpawner; ledger: CrewLedger; onChange(): void });
  start(): void;                          // spawns all items with deps done, honouring maxConcurrent per selector
  state(itemId: string): CrewItemState;
  workerName(itemId: string): string;     // from src/task/name-generator.ts, stable per run
  send(itemId: string, msg: string): Promise<void>;
  escalate(itemId: string, note: string, recast: (exclude: string[], minTier: Tier) => Assignment): Promise<Assignment>;
  cancelAll(): Promise<void>;
  done: Promise<CrewRunSummary>;
}
export interface CrewRunSummary { runId: string; items: Array<{ itemId: string; name: string; selector: string; state: CrewItemState; costUsd: number; durationMs: number }>; actualUsd: number; baselineEstUsd: number; status: "completed" | "partial" | "cancelled" }
export class CrewLedger { constructor(path: string); append(entry: CrewRunSummary & { promptHead: string; at: string }): Promise<void>; list(limit: number): Promise<Array<CrewRunSummary & { promptHead: string; at: string }>> }
```
Worker prompt = item brief + scope rule ("only write inside: …") + "report files changed and how you verified".
A failed dependency marks dependents `failed` without spawning them. Production spawner wraps `VibeSessionRegistry.spawn/send/kill` with `model`.

- [ ] **Step 1: Failing tests** (fake spawner with manual promise control)
  - A→B dependency: B not spawned until A settles ok.
  - `maxConcurrent: 1` on a selector with two ready items → second waits.
  - A fails → B `failed`, never spawned; summary `status: "partial"`.
  - `cancelAll()` while running → spawner.kill called for each running worker, states `cancelled`, ledger entry `status: "cancelled"` (Review Focus 4).
  - `escalate` kills old worker, spawns new with recast selector, brief includes the note.
  - Ledger: append then `list(10)` returns newest first; corrupt line skipped.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(gk): crew runtime and ledger`.

### Task 10: Orchestra mode + crew tools + conductor prompt

**Files:**
- Create: `packages/coding-agent/src/gk/orchestra-mode.ts`, `packages/coding-agent/src/gk/crew-tools.ts`, `packages/coding-agent/src/prompts/gk/conductor.md`
- Modify: `packages/coding-agent/src/slash-commands/builtin-modes.ts` (register `/orchestra`, following `/vibe`), `packages/coding-agent/src/config/model-roles.ts` (add role `conductor`, tag `COND`, color `accent`), launch hook from Task 4
- Test: `packages/coding-agent/test/gk/crew-tools.test.ts`

**Consumes:** Tasks 6–9. **Produces:** tools, each JSON-schema'd like vibe tools:
- `crew_plan({ items: WorkItem[] })` → validate (errors returned as tool error text listing each `message`) → `castCrew` → `approve(cast): Promise<{ approved: true; cast: CastResult } | { approved: false; note: string }>` (UI callback, Task 11; auto-approves when `gk.orchestra.autoApprove` and not over budget) → `CrewRun.start()`; returns run id + roster summary immediately.
- `crew_send({ item, message })`, `crew_wait({ items?, timeout? })` (default 30 s), `crew_status({})`, `crew_escalate({ item, note })`, `crew_kill({ item })`.
- `enterOrchestraMode(session, opts: { firstPrompt?: string }): Promise<void>` / `exitOrchestraMode(session): Promise<void>` — mirrors vibe entry/exit: active tools = `read`, `todo`, `crew_*`; injects `conductor.md`; exit calls `cancelAll()`. Mutually exclusive with vibe/plan/goal modes.

`conductor.md` must say: you don't edit or run code; explore just enough to plan; one item per independent workstream; briefs are self-contained with acceptance criteria; declare scopes; rate difficulty honestly (1 mechanical, 2 normal engineering, 3 needs frontier judgment) because difficulty sets cost; verify each result by reading touched files; `crew_send` small fixes, `crew_escalate` when a worker fails twice; finish with a summary for Gaurav.

- [ ] **Step 1: Failing tests** — `crew_plan` with a cycle returns error text containing `cycle` and spawns nothing; `crew_plan` approve=false returns the note to the model and spawns nothing; approved plan calls spawner per ready item; `crew_escalate` uses `minTier = current + 1` and excludes current selector; active tool list in orchestra mode equals `["read", "todo", "crew_plan", "crew_send", "crew_wait", "crew_status", "crew_escalate", "crew_kill"]` (todo only when enabled).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Manual: `bun dev -- --orchestra`, prompt "add a hello endpoint and a page that calls it" in a scratch repo; crew spawns.
- [ ] **Step 6:** Commit `feat(gk): orchestra mode and crew tools`.

### Task 11: Casting Board overlay

**Files:** Create `packages/coding-agent/src/gk/ui/casting-board.ts`. Test: `packages/coding-agent/test/gk/casting-board.test.ts`.

**Produces:** `class CastingBoard implements Component` with `constructor(cast: CastResult, items: WorkItem[], names: Record<string, string>, roster: RosterEntry[])`, `render(width: number): string[]`, `handleInput(key: string)`, `result: Promise<{ approved: true; cast: CastResult } | { approved: false; note: string }>`; `formatUsd(n: number, planIncluded: boolean): string` (`"plan"` when planIncluded, `"$0.00"` style otherwise, never `NaN`).

Keys per spec §5.4. `e` opens omp's select list over roster selectors and re-scores the row; over-budget requires `!` then Enter.

- [ ] **Step 1: Failing tests** — render at width 100 contains each item title, worker name, selector, and footer with total, baseline, `saved` percentage; `formatUsd(0, true)` → `"plan"`; Enter resolves approved; `x` on row removes it from returned cast; `r` + typed note + Enter resolves `{approved: false, note}`; over-budget Enter alone does not resolve.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(gk): casting board`.

### Task 12: Split layout and worker panes

**Files:** Create `packages/coding-agent/src/gk/ui/split-layout.ts`, `packages/coding-agent/src/gk/ui/worker-pane.ts`, `packages/coding-agent/src/gk/ui/orchestra-header.ts`; hook into `interactive-mode.ts` when Orchestra mode is active (`// gk:`). Test: `packages/coding-agent/test/gk/split-layout.test.ts`.

**Produces:**
- `class SplitLayout implements Component` — `constructor(left: Component, right: Component, opts: { leftRatio: number; minSplitWidth: 100 })`; `render(width)` zips child lines with a `│` bronze divider, pads shorter side; below `minSplitWidth` returns stacked: left then right's `compact` render.
- `class WorkerPane implements Component` — `constructor(run: CrewRun, itemId: string)`; header `Name · model · skill … state elapsed`, last N activity lines from the worker's progress events (same source Agent Hub uses), footer cost; `renderCompact(width): string` one line.
- `class WorkerColumn` (stack of panes; grid mode toggled by `Ctrl+G`).
- Keybindings: `Alt+1…9` focus worker via `session-focus-controller`; `Esc` back.

- [ ] **Step 1: Failing tests** — `SplitLayout` at width 140 returns lines all exactly visible width 140 with divider at column `floor(140*0.4)`; at width 90 returns stacked layout, no line > 90 (Review Focus 2); ANSI-colored children don't break width math (use `visibleWidth`); `WorkerPane.renderCompact` for a waiting item contains `waiting on <dep name>`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Manual: run Task 10 scenario; observe split animation on approve, focus a worker with `Alt+1`, type a steering line, `Esc` back, resize terminal to 80 cols.
- [ ] **Step 6:** Commit `feat(gk): orchestra split layout`.

### Task 13: Payslip and `/crew history`

**Files:** Create `packages/coding-agent/src/gk/ui/payslip.ts`; register `/crew` (`history` subcommand) in builtin registry. Test: `packages/coding-agent/test/gk/payslip.test.ts`.

**Produces:** `renderPayslip(summary: CrewRunSummary, width: number): string[]`.

- [ ] **Step 1: Failing tests** — actual 0.50 vs baseline 4.00 → contains `You saved $3.50 (88%)`; actual 5.00 vs baseline 4.00 → contains `cost $1.00 more than the conductor alone`; one row per item with name, selector, state glyph, cost.
- [ ] **Step 2–4:** FAIL → implement (gold card appended to transcript when `CrewRun.done` resolves; `/crew history` lists last 20 ledger entries) → PASS.
- [ ] **Step 5:** Commit `feat(gk): payslip and crew history`.

### Task 14: Solo upgrades

**Files:** Create `packages/coding-agent/src/gk/daily-spend.ts`; status-line segment registration (follow `statusLineCost`); `/orchestra` already from Task 10 works from Solo. Test: `packages/coding-agent/test/gk/daily-spend.test.ts`.

**Produces:** `sumSpendForDay(records: Array<{ at: string; costUsd: number }>, day: string /* YYYY-MM-DD local */): number`; `budgetNotice(spent: number, limit?: number): string | undefined`.

- [ ] **Step 1: Failing tests** — records across two days sum only the requested day; `budgetNotice(12, 10)` → contains `$12.00` and `$10.00`; `budgetNotice(5, undefined)` → `undefined`.
- [ ] **Step 2–4:** FAIL → implement (records come from omp's session usage data — read how `omp-stats`/`packages/stats` aggregates and reuse it) → PASS.
- [ ] **Step 5:** Commit `feat(gk): daily spend meter`.

### Task 15: Quiet transcript, slim status line, toasts

**Files:** Create `packages/coding-agent/src/gk/ui/compact-tool-row.ts`, `packages/coding-agent/src/gk/ui/toast.ts`; hook into the tool-call rendering path (`modes/controllers/tool-call-block.ts`) and status-line host (`modes/status-line-host.ts`) (`// gk:`). New setting `gk.ui.compactTools: boolean` (default `true`). Test: `packages/coding-agent/test/gk/compact-ui.test.ts`.

**Produces:**
- `formatToolRow(c: { tool: string; target: string; state: "running" | "ok" | "error"; diff?: { added: number; removed: number }; ms?: number }, width: number): string` — `✓ edit  src/api/routes.ts  +12 −3  0.4s`; target middle-truncated to fit; running uses one spinner glyph; error rows are never compacted (caller renders full card).
- `GK_STATUS_SEGMENTS = ["mode", "model", "context", "spend"] as const` — the only default status-line segments; others reachable in the `?` overlay.
- `class ToastHost implements Component` — `show(text: string, kind: "info" | "success" | "warning", ms = 3000)`, renders one line above the composer, newest replaces older, entries also appended to the activity log.

- [ ] **Step 1: Failing tests** — `formatToolRow` at width 60 with a 90-char path keeps the filename and is ≤ 60 visible cols; diff counts render `+12 −3`; `state: "error"` returns the full-card sentinel (define `COMPACT_SKIP = Symbol("compact-skip")` and return it); `ToastHost.render` after 3001 ms (injected clock) is empty; status line built with default settings has exactly the 4 segments.
- [ ] **Step 2–4:** FAIL → implement (thinking blocks collapse to one dim `thinking · 4.2s` line, expand with Enter as omp does) → PASS.
- [ ] **Step 5:** Manual: `bun dev`, ask for a multi-file edit; transcript shows one row per tool; Enter on a row expands it.
- [ ] **Step 6:** Commit `feat(gk): quiet transcript, slim status line, toasts`.

### Task 16: `Ctrl+K` command palette

**Files:** Create `packages/coding-agent/src/gk/ui/command-palette.ts`, `packages/coding-agent/src/gk/palette-sources.ts`; bind `app.gk.palette: Ctrl+K` in the keybinding table (`packages/tui/src/app-keybindings.ts`, `// gk:`). Test: `packages/coding-agent/test/gk/command-palette.test.ts`.

**Produces:**
- `interface PaletteItem { id: string; kind: "command" | "skill" | "mcp" | "model" | "setting" | "session" | "key"; label: string; detail: string; shortcut?: string; run(): Promise<void> }`
- `collectPaletteItems(ctx: InteractiveModeContext): PaletteItem[]` — sources: slash-command registry, discovered skills, MCP servers, available models, settings keys, recent sessions, keybindings.
- `rankPalette(items: PaletteItem[], query: string, recent: string[]): PaletteItem[]` — omp's `fuzzy.ts` score; recent ids boosted; empty query → recents then commands.
- `class CommandPalette implements Component` — centered overlay, max 12 rows, kind label in muted at right, shortcut in dim, selected row `selectedBg` + accent label; Enter runs, Esc closes; empty-result copy `No match for "<q>". Try a command, skill, model or setting name.`

- [ ] **Step 1: Failing tests** — `rankPalette(items, "mcp")` puts the `Capabilities` / `/mcp` items first; recent id outranks an equal-score item; empty query lists recents first; render at width 80 has ≤ 12 item rows and shows empty-result copy for a no-match query.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(gk): command palette`.

### Task 17: Capabilities center (MCP · Skills · Plugins)

**Files:** Create `packages/coding-agent/src/gk/ui/capabilities.ts`, `packages/coding-agent/src/gk/capabilities-model.ts`; register `/caps` and a palette item. Reuse omp managers: MCP via `modes/controllers/mcp-command-controller.ts` / `src/mcp/*` (list, enable, disable, add, OAuth), skills via `slash-commands/builtin-skills.ts` / `src/discovery`, plugins via `slash-commands/builtin-marketplace.ts`. Add the skill-load chip in the transcript (`◆ skill  <name>`) where omp renders skill injection. Test: `packages/coding-agent/test/gk/capabilities.test.ts`.

**Produces:**
- `type McpRowState = { kind: "connected"; tools: number } | { kind: "needs-login" } | { kind: "failed"; reason: string } | { kind: "disabled" } | { kind: "connecting" }`
- `interface McpRow { name: string; scope: "global" | "project"; state: McpRowState }`, `interface SkillRow { name: string; source: string; description: string; enabled: boolean }`, `interface PluginRow { name: string; version: string; enabled: boolean; updateAvailable: boolean }`
- `mcpStateLabel(s: McpRowState): string` → `connected · 14 tools` / `needs login` / `failed: <reason ≤ 60 chars>` / `disabled` / `connecting…`
- `class CapabilitiesOverlay implements Component` — tabs `MCP · Skills · Plugins` (`1`/`2`/`3` or ←/→), keys per spec §5.7; each tab's empty state per spec §5.6 rule 4; connect attempts time out after 15 s into `failed: timed out after 15s` without blocking input.
- `capabilitySummary(): string` → `MCP 3/4 · skills 12 · plugins 2` for the `?` overlay.

- [ ] **Step 1: Failing tests** — `mcpStateLabel` for each variant (long reason truncated with `…`); overlay with a server whose connect promise never resolves shows `connecting…` then `failed: timed out after 15s` at 15 001 ms (injected clock) and still handles Esc (Review Focus 6); MCP tab empty state contains `Press a to add`; Space on a row calls the manager's enable/disable once; import (`i`) shows a preview list and writes nothing until Enter.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Manual: add a stdio MCP server through the `a` form, toggle it, list its tools; disable a skill for this project and confirm it is not offered in the `@` picker.
- [ ] **Step 6:** Commit `feat(gk): capabilities center for MCP, skills, plugins`.

### Task 18: Upstream sync + README

**Files:** Create `scripts/sync-upstream.sh`, `GK.md`; replace top of `README.md` with a GK section (logo text, modes, roster.yml example, credits) keeping omp docs below a "Based on oh-my-pi" heading.

- [ ] **Step 1:** Script: `git fetch upstream && git merge upstream/main`, then `git grep -n "// gk:"` listing hook points to recheck; exits non-zero on conflicts.
- [ ] **Step 2:** `GK.md`: list every `// gk:` hook file and why.
- [ ] **Step 3:** Full check: `bun run check` at repo root (or the root `check` script) → passes; `cd packages/coding-agent && bun test test/gk` and `cd packages/tui && bun test test/gk-gold-theme.test.ts` → all pass.
- [ ] **Step 4:** Commit `docs(gk): readme and upstream sync`.
