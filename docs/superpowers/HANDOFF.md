# GK Harness — Handoff (2026-11-15)

## Docs status
- Spec `specs/2026-11-15-gkharness-design.md` rev 2: **all 10 new requirements integrated** (launch §5.1, Stage §5.5
  with exact weights/layout/compositor, Core/narration/voice/persona §5.6, errors §5.7, diagrams §5.8, finale §5.9,
  computer use §5.10, PTY panes §5.11, skills pack §5.14, splash §5.2, Solo §5.3; motion rule relaxed; calls §7 #8–14).
- Plan `plans/2026-11-15-gkharness.md`: **not yet revised** (marked DRAFT). Still the old 0–18 task list.

## Planned new task list (not yet written into the plan; lanes in brackets)
0 Toolchain · 1 Fork · 2 Rebrand+import [base, serial] · 3 install-gk.sh wrappers · 4 Gold theme [base, parallel]
5 Tile store + weights → 6 Layout engine (pure) → 7 Compositor + Stage component → 8 Stage host + bridge + presets [stage, serial]
9 Agent tiles (nested lineage) · 10 Command tiles · 11 Web tiles · 12 Error tiles + big-text [adapters, parallel after 8]
13 Core + narration + persona [after 8]
15 Roster · 16 Router · 17 Plan validation · 18 Crew runtime · 19 Orchestra mode + crew tools + launch flags · 20 Casting Board · 21 Payslip [orchestra]
22 Crew DAG tile · 23 Git tile · 24 Timeline tile [diagrams, parallel after 8; 22 also after 18]
25 Finale + /ship + verify detection [after 12, 21]
26 Bundled skills pack [any time after 2]
27 Computer-use tile · 28 PTY panes + /open + pane_open + stage_focus [after 8]
29 Voice [after 13] · 30 Splash v2 + mode picker [after 13] · 31 Credits · 32 Daily spend · 33 Quiet transcript/toasts
34 Ctrl+K palette · 35 Capabilities · 36 Upstream sync + README (final check)
(14 intentionally unused.) Old→new: 3→4, 4→30 (flags → 19), 5→31, 6→15, 7→16, 8→17, 9→18, 10→19, 11→20, 12→removed (5–9), 13→21, 14→32, 15→33, 16→34, 17→35, 18→36.

## Verified reuse points (for the plan)
PtySession `crates/pi-natives/src/pty.rs` (start/startArgv/write/resize/kill); kitty-vt-wasm is a pi-tui
**devDependency** used only in `packages/tui/test/virtual-terminal.ts` → promote; AgentRegistry `parentId` + events
`src/registry/agent-registry.ts`; skill providers `src/discovery/builtin.ts:353`; computer tool `src/tools/computer.ts`;
tts `src/tts`, stt `src/stt/push-to-talk.ts`; `resolveMermaidAscii`; fullscreen alt-screen `packages/tui/src/tui.ts:507`.
Skill sources: antislop* `~/.omp/plugins/cache/plugins/anti-slop___antislop___3.2.26/skills/`; superpowers
`~/.omp/plugins/node_modules/superpowers/skills/` (v7.0.2); impeccable `~/.omp/agent/skills/impeccable`;
animate, break-ui, emil-design-eng `~/.agents/skills/`.

## Implementation status (git, read-only check)
- Committed: Tasks 0–2 (fork, bun, rebrand, omp import: 6a63597b00, 2b3d7f595b, b43aced83c, 3b1be95346);
  Tasks 6–8 roster/router/plan-validate (3970d4aabd); **Task 9 crew runtime + ledger landed (2d8bce2344)**.
- Uncommitted in tree: **Task 3 themes** (gold.json, gold-light.json, gk-defaults.ts, gk-gold-theme.test.ts, loader/theme/settings edits).
- **Task 5 credits: not landed** (no `gk/credits.ts`, no commit).
- Docs edits (spec rev 2, plan DRAFT marker, this file) uncommitted.

## Stage status
- **Engine committed 10c6cc8824** (`packages/coding-agent/src/gk/stage/`, 42 tests green, typecheck clean):
  - `tiles.ts`: `TileStore({now})` handles add/update/touch/dismiss/restore/focus/remove/tick/chips and emits events. `shouldChip` and `isLive` hold the chip timings from spec §5.5. Extra kinds: diff/proc/telemetry/events/todo.
  - `weights.ts`: `attentionWeight` (spec formula) and `subtreeWeights`.
  - `layout.ts`: `layoutStage(input)` returns header(2)/tabBar(1)/body/chipStrip/footer(2), widgetColumn (≥160 cols, 22% width), `tiles: Map<id,Rect>`, order/chips/hidden. Presets are calm/orchestra, matching the 212×58 references. CELL_ASPECT=3 (accepted). `toLayoutTiles(store, now)` projects a store into layout tiles.
  - `tween.ts`: `WeightTween` (re-runs the layout each frame) and `RectTween`, 150ms ease-out cubic.
  - `compositor.ts`: `CellBuffer.blit/toLines` (ANSI- and wide-char-safe), `drawFrame` (title, badge, status row, style callback), `paneTitle`.
- **layoutParentId decision (UNCOMMITTED, tests not run)**: `LayoutTile.layoutParentId` defaults to parentId. `toLayoutTiles` sets it to null for command/web/diff, so those tile as top-level siblings while keeping their lineage for badges and `→ pane 0.3` pointers. The edits are in layout.ts and there's a new test in test/gk/stage/layout.test.ts. Run the tests, then commit.
- **Widgets: none done, none WIP** (nothing written yet under `stage/widgets/`).
- **Left (widgets/chrome)**: `render(data, w, h, style)` with a `style(token, text)` callback (tokens accent/text/muted/dim/border/borderAccent/success/error/warning/info/agent1-6/diffAddBg/diffDelBg).
  - Chrome: header (2 rows: logo slot, cells, clock), tab row + summary, status bar, key hints (`gk-code 0.1.0`, no omp), pane statusline.
  - Transcript: event lines, inline diff, plan table.
  - Panels: proc, throughput, telemetry, todo, dag, git, events.
  - Golden tests with an identity style, plus width-exactness checks. `truncateToWidth(s, w, undefined, true)` pads and truncates to exactly w (verified).

## Debrand status
- Committed: f365dd17a8 (GK_VERSION 0.1.0 in gk/brand.ts, formatGkVersion → `gk-code 0.1.0`; self-update no-op behind GK_SELF_UPDATE=false in update-cli/auto-update; startup changelog hidden; tests updated), 407089b2ee (docs scheme omp:// → gk:// via DOCS_SCHEME, tmp root gk-local, system-prompt identity "You are GK Code…", cfg.md; 15 tests updated), 66ada83e5e (scripts/gk-brand-audit.ts + gk-brand-allowlist.txt; supports `glob#needle` and `glob#/regex/`).
- Uncommitted WIP (~266 modified files, unverified, NOT tested): 4 debrand workers (CLI help/commands, prompts+tools text, coding-agent core, tui+other pkgs) were stopped mid-run. Also mine, uncommitted: main.ts (checkForNewVersion → undefined, GK_VERSION to welcome, changelog hidden) and cli.ts (--version/run() use GK_VERSION) — mixed with worker edits in the same files; browser-relay extension manifest.json/options.html rebranded but extension-assets NOT regenerated (run packages/browser-relay/scripts/build-extension.ts).
- Left: review WIP diff (`git diff`), run coding-agent/tui/utils `bun test`, compare failures against /tmp/gk-base (known pre-existing: 8 in test/update-cli.test.ts, 1 in cfg-protocol "prepend to it"); finish audit (358 hits left) and add functional allowlist entries (update-cli.ts unreachable updater, gk/import-omp.ts source naming, x-omp headers/auth code, CDP OMP.*, LSP omp/*, persisted lock/schema names, stencil.so endpoints); check `bun dev -- --help` (use `grep -iw omp`; plain `grep -ic omp` matches "prompt"); throwaway system-prompt snippet check; commit in chunks.

## Visual status
- Committed: theme v2 gk-night/gk-day + palette + contrast test (8976ee8aba); visual v2 spec with palette, chrome,
  orchestra wireframes 212×58/120×40/80×24 (53fc54077f); pixel font + tests (d0fbe2bdc1); updates scene + omp outro
  mark removed, theme scene minVersion 3 (8e97a58cdf).
- WIP (uncommitted): `packages/tui/src/prompt/welcome.ts` lockup without builtin omp image — breaks
  `welcome.test.ts` "natively sets the version under the wordmark beside the logo"; update that test, then commit.
- Left: spec §5 is DRAFT — wireframes for solo, splash, mode picker, models & providers, setup wizard, error tile, finale
  (each at 212×58, 120×40, 80×24). 4 Settings test failures ("config file failure safety" ×3, "live persisted reload")
  were already failing on clean HEAD before our changes. Throwaway worktree at /tmp/gk-base can be removed.

## Stage host status
- **Approach**: the Stage is a pi-tui fullscreen overlay with new `OverlayOptions.base` (tui.ts, `// gk:`): never takes focus/keys,
  excluded from `hasOverlay()`, keeps the alt screen while dialogs stack above, lets the focused editor place the hardware cursor.
  Pane 0.0 = omp's `chatContainer` blocks (tool cards → one-liners via `gkToolCallIds` getters, prompts via `gkPrompt`, assistant
  render behind an accent bar) + omp composer roots (editor, status line, HUDs) rendered at pane width — omp input/autocomplete untouched.
  Mounted from `InteractiveMode.init` after `composer.start` when `gk.stage.enabled` (default true, modes/settings.ts) and TTY.
- **Committed d5817377de** (WIP): `gk/stage/{host,mount,style,tool-lines,transcript-pane,git-source}.ts`, tui.ts/chat getters,
  settings, interactive-mode hook. NOTE: interactive-mode.ts changed externally mid-edit — that commit may include another worker's hunks; check `git show d5817377de`.
- **Verified live** (tmux -L gkstage, 212×58, real HOME, gpt-5.6-luna): Stage renders, typing + cursor work, bash one-liner
  `✓ bash ls && git status … exit 0 · 0.2s`, telemetry/git/events column appears while busy, calm when idle.
- **Left**: host tests (fake terminal: bash → command tile, nested subagent lineage title, exact row widths at 212×58 and 120×40);
  re-verify the pending-toolcall one-liner + header tightening (last edits, type-checked, not run live); capture a screen mid-command
  (`sleep 8`) for the report; "Stage host" section in gk-visual-v2.md; scale-1 pixel logo looks noisy (font issue); tabs show only
  `0:session` (no fake tabs); TODAY spend shows `–` (no daily aggregator yet); proc widget not used in Solo.
- Uncommitted: none of mine besides this HANDOFF.md edit.

## Splash status
- **Done, committed**: 8e2a07e0a8 welcome lockup without omp image + test; 401e898e71 tui `gk/{canvas,logo,splash-frame,mode-picker,launch-screens}.ts`
  + tests (exact 212×58/120×40/80×24, check states, proportional bar, no "omp", picker keys, runner); 7a2b3a5e10 wiring (`gk/launch.ts`
  live checks: providers/roster/skills/MCP/computer; `gk/launch-mode.ts`; `gk.launchMode`/`gk.lastLaunchMode`; `--solo`/`--orchestra`;
  main.ts `// gk:`); e97b166adc docs (visual v2 §5 splash + picker wireframes, main spec §5.2 tagline removed, docs/settings.md).
  `startup.showSplash` default true landed inside d5817377de (Stage worker's commit picked up that hunk).
- **Verified**: `bun dev --no-session` in a 212×58 pty (real HOME): splash → picker → Ctrl+C exits 0; `--orchestra` skips the picker and
  shows "Orchestra mode is not wired yet". tui 68 + coding-agent 8 tests pass; both packages typecheck.
- **Left**: wire the real Orchestra entry (replace the notice + the picker's `status ! not wired yet` fact); checks settle before the first
  paint on this Mac (in-memory data), so pending ticks are rarely seen; Core-ignite transition not built. Pre-existing debrand test
  failures (`.omp` paths / `omp --help` strings in cli tests) untouched.
- **Uncommitted (mine)**: none besides this HANDOFF.md edit.

## Models screen status
- **Done, committed 8979799cb7**: pure `gk/ui/models-screen.ts` (state, key reducer, renderer: sidebar, role chips, filters, IN ROSTER/NOT IN ROSTER/NOT CONNECTED table, detail panel, footer) and `gk/ui/models-screen-controller.ts` (registry/auth/roster data, theme style, fullscreen component). `/models` command (alias removed from `/model`). `SelectorController.#assignModelRole` now holds the role-assignment logic, shared by the model hub and this screen. `roster.ts`: `getRosterPath`, `saveRosterOverrides`, `patchRosterOverride`. 15 screen tests plus roster save/patch tests; `test/gk` 181 pass; typecheck clean. The `showGkModelsScreen` delegate in interactive-mode.ts landed in another worker's commit.
- **Also done**: 2999ec7d1a `test(gk): align fixtures with .gk paths` (92 tests pass).
- **Left**: live pty check at 212×58. `bun dev` opens the mode picker first, so press `s`, then send `/models`; driver is `/tmp/gkdrive.py` (pyte venv at /tmp/gkvenv). Alt+M not rewired; it still opens the omp model hub. Roster default is `enabled: true` (buildRoster), so every connected model counts as in roster. ~/.gk/agent/roster.yml was not created.
- Uncommitted (mine): none besides this HANDOFF.md edit.
