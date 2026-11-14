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
