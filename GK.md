# GK Code hook points

GK Code is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi). GK-only code lives under
`packages/coding-agent/src/gk/`. Each place where GK changes upstream code is marked with a `// gk:` comment
that says why. After an upstream merge, recheck these first: they are where upstream changes can silently
undo GK behaviour.

## Syncing upstream

```sh
scripts/sync-upstream.sh
```

The script adds the `upstream` remote (`https://github.com/can1357/oh-my-pi`) if it is missing, refuses to run
on a dirty tree, fetches, merges `upstream/main`, then prints every `// gk:` line and the hook files the merge
changed. It exits non-zero on conflicts. Generated catalogs (`packages/catalog/src/compat/rules.json`,
`packages/catalog/src/models.json`) conflict as binary files. Take upstream's copy, then run `bun run gen:compat`
and `bun run gen:models --provider aicredits` to bring back GK's providers. Then run `bun run check` and the
gk tests (`cd packages/coding-agent && bun test test/gk`).

To refresh this file, list the hooks with `git grep -n "// gk:" -- ':!docs'` and update the summaries below.

## Feature hooks

### Launch, version and updates

- `packages/coding-agent/src/cli.ts`: prints the `gk-code <version>` string; imports an existing omp profile on first run.
- `packages/coding-agent/src/main.ts`: Solo/Orchestra launch mode, the GK version string, and debranded messages.
- `packages/coding-agent/src/cli/args.ts`, `src/cli/flag-tables.ts`, `src/commands/launch-help.ts`: launch-mode flags (`--solo`, `--orchestra`, …) and their help.
- `packages/coding-agent/src/config/all-settings.ts`: registers the `gk.*` launch-mode settings.
- `packages/coding-agent/src/cli/auto-update.ts`, `src/cli/update-cli.ts`, `src/commands/update.ts`, `src/modes/utils/ui-helpers.ts`: self-update is off because upstream channels ship omp builds. GK Code updates from its git checkout; plugins still update.
- `packages/coding-agent/test/cli/update-cli.test.ts`: tests that self-update stays disabled.
- `packages/tui/src/setup/wizard.ts`: removes the setup wizard's updates scene (GK updates with `git pull`).
- `scripts/setup.ts`: links only `gk` and `gk-code`, never `omp`, so a real omp install is not shadowed.

### Orchestra (conductor and crew)

- `packages/coding-agent/src/config/model-roles.ts`, `packages/tui/src/overlays/model-browser.ts`: the Orchestra conductor model role (unset = the session's default model).
- `packages/coding-agent/src/modes/interactive-mode.ts`: turns on the conductor and the per-session crew policy (`/crew policy`); mounts the full-screen Stage.
- `packages/coding-agent/src/session/agent-session.ts`: conductor prompt and crew state, rebuilt on every prompt the way Vibe's is.
- `packages/coding-agent/src/session/session-tools.ts`: registers the crew tools.
- `packages/coding-agent/src/sdk.ts`, `src/task/executor.ts`, `src/tools/builtin-names.ts`, `src/tools/index.ts`: the `ask_conductor` advisor channel that every crew worker carries.
- `packages/coding-agent/src/vibe/runtime.ts`: an explicit model selector (a crew worker's) bypasses the fast/good tier mapping; adds the advisor channel.
- `packages/coding-agent/src/gk/stage/host.ts`: the Orchestra worker pane (title, `@name` badge, body and statusline from the crew adapter).

### Commands, palette and screens

- `packages/coding-agent/src/slash-commands/builtin-modes.ts`: `/credits` and `/caps` (Capabilities center); the palette's Capabilities and MCP rows submit `/caps`.
- `packages/coding-agent/src/modes/controllers/input-controller.ts`, `packages/tui/src/app-keybindings.ts`: Ctrl+K opens the command palette from an empty composer; with text, it stays kill-line.
- `packages/coding-agent/src/modes/controllers/selector-controller.ts`: the Models & providers screen.
- `packages/tui/src/tui.ts`: the Stage base surface never takes focus or holds keys.

### Skills

- `packages/coding-agent/src/discovery/builtin.ts`, `src/extensibility/skills.ts`: skills bundled from `src/gk/skills` resolve at the lowest priority, so a user-installed skill of the same name wins.

### Theme and brand

- `packages/coding-agent/src/modes/settings.ts`, `packages/tui/src/theme/theme.ts`, `src/theme/loader.ts`, `src/setup/scenes/theme.ts`: `gk-night` / `gk-day` replace omp's titanium/light/dark defaults.
- `packages/tui/src/prompt/welcome.ts`, `packages/tui/test/welcome.test.ts`: the GK block mark and `gk` wordmark on the welcome screen.

### Paths, schemes and logs

- `packages/utils/src/dirs.ts`: config root and XDG app dir rebrand (`~/.omp` → `~/.gk`).
- `packages/utils/src/logger.ts`: log files are named `<APP_NAME>.<day>.<pid>.log`, matching `getLogPath()`.
- `packages/coding-agent/src/internal-urls/omp-protocol.ts`, `docs-index.ts`, `omp-scope.ts`: the `gk://` internal-URL scheme (upstream `omp://`).
- `packages/coding-agent/src/internal-urls/local-protocol.ts`: debranded temp root.
- `packages/coding-agent/src/cli/help-extra.ts`: help text uses `APP_NAME` / `CONFIG_DIR_NAME`.
- `packages/utils/test/*` (`dirs*`, `env`, `logger-*`, `natives-dir-override`, `profiles`, `stderr-guard*`, `fixtures/*`), `packages/coding-agent/test/debug/report-bundle-logs.test.ts`: tests follow `APP_NAME` for the log prefix, XDG app dir and config root.

## Debrand-only hooks

The files below have only `// gk: debrand` hooks: user-visible omp names, commands and paths replaced with GK
Code's. When upstream rewrites one of these lines, keep upstream's change and apply the GK name again.

### `packages/ai`

- `src/utils/http-inspector.ts`

### `packages/coding-agent`

- `src/advisor/watchdog.ts`
- `src/cli-commands.ts`
- `src/cli/agents-cli.ts`
- `src/cli/auth-broker-cli.ts`
- `src/cli/auth-gateway-cli.ts`
- `src/cli/bench-cli.ts`
- `src/cli/browser-relay-cli.ts`
- `src/cli/collab-cli.ts`
- `src/cli/command-help.ts`
- `src/cli/commands/init-xdg.ts`
- `src/cli/gallery-fixtures/status-line.ts`
- `src/cli/gallery-screenshot.ts`
- `src/cli/grievances-cli.ts`
- `src/cli/license.ts`
- `src/cli/models-cli.ts`
- `src/cli/plugin-cli.ts`
- `src/cli/predict-cli.ts`
- `src/cli/profile-alias.ts`
- `src/cli/ps-cli.ts`
- `src/cli/skill-cli.ts`
- `src/cli/skill-list.ts`
- `src/cli/ssh-cli.ts`
- `src/cli/startup-cwd.ts`
- `src/cli/ttsr-cli.ts`
- `src/cli/usage-cli.ts`
- `src/collab/host.ts`
- `src/collab/settings.ts`
- `src/commands/agents.ts`
- `src/commands/anonymize.ts`
- `src/commands/auth-broker.ts`
- `src/commands/auth-gateway.ts`
- `src/commands/auth.ts`
- `src/commands/bench.ts`
- `src/commands/browser-relay.ts`
- `src/commands/cleanse.ts`
- `src/commands/clip.ts`
- `src/commands/collab.ts`
- `src/commands/compress.ts`
- `src/commands/config.ts`
- `src/commands/dry-balance.ts`
- `src/commands/git.ts`
- `src/commands/grievances.ts`
- `src/commands/if-bench.ts`
- `src/commands/images.ts`
- `src/commands/install.ts`
- `src/commands/models.ts`
- `src/commands/play.ts`
- `src/commands/predict.ts`
- `src/commands/ps.ts`
- `src/commands/read.ts`
- `src/commands/render.ts`
- `src/commands/say.ts`
- `src/commands/session.ts`
- `src/commands/setup.ts`
- `src/commands/skill.ts`
- `src/commands/stream.ts`
- `src/commands/token.ts`
- `src/commands/toks.ts`
- `src/commands/ttsr.ts`
- `src/commands/usage.ts`
- `src/commands/worktree.ts`
- `src/config/model-resolver.ts`
- `src/config/model-settings.ts`
- `src/debug/index.ts`
- `src/debug/system-info.ts`
- `src/discovery/helpers.ts`
- `src/discovery/omp-extension-roots.ts`
- `src/discovery/omp-plugins.ts`
- `src/discovery/skillshare.ts`
- `src/discovery/ssh.ts`
- `src/eval/js/error-text.ts`
- `src/eval/js/package-installer.ts`
- `src/eval/startup-warning.ts`
- `src/extensibility/extensions/loader.ts`
- `src/extensibility/legacy-pi-coding-agent-shim.ts`
- `src/extensibility/plugins/legacy-pi-compat.ts`
- `src/extensibility/plugins/manager.ts`
- `src/extensibility/settings.ts`
- `src/extensibility/utils.ts`
- `src/ida/client.ts`
- `src/ida/host.ts`
- `src/ida/settings.ts`
- `src/if-bench/index.ts`
- `src/if-bench/runner.ts`
- `src/internal-urls/security-protocol.ts`
- `src/job-widgets/spec.ts`
- `src/launch/client.ts`
- `src/launch/services.ts`
- `src/lsp/settings.ts`
- `src/mcp/oauth-reauth.ts`
- `src/modes/acp/acp-agent.ts`
- `src/modes/acp/acp-mode.ts`
- `src/modes/controllers/command-controller.ts`
- `src/modes/controllers/event-controller.ts`
- `src/modes/controllers/omfg-controller.ts`
- `src/modes/persistence-failure.ts`
- `src/modes/rpc/host-uris.ts`
- `src/modes/warp-events.ts`
- `src/ovnfs/daemon.ts`
- `src/plan-mode/settings.ts`
- `src/predict/daemon.ts`
- `src/ratchet/ratchet.ts`
- `src/secrets/index.ts`
- `src/security/coordinator.ts`
- `src/security/provenance.ts`
- `src/session/auth-broker-config.ts`
- `src/session/exit-diagnostics.ts`
- `src/session/session-manager.ts`
- `src/session/session-transfer.ts`
- `src/session/session-worktree.ts`
- `src/session/settings.ts`
- `src/skillshare/pack.ts`
- `src/task/discovery.ts`
- `src/task/isolation-runner.ts`
- `src/task/ovnfs.ts`
- `src/task/settings.ts`
- `src/task/widget-inputs.ts`
- `src/task/worktree.ts`
- `src/tools/ask.ts`
- `src/tools/browser.ts`
- `src/tools/security-scan.ts`
- `src/tools/settings.ts`
- `src/tools/write.ts`
- `src/utils/changelog.ts`
- `src/web/kagi.ts`
- `src/web/parallel.ts`
- `src/web/search/providers/kimi.ts`
- `src/web/search/providers/synthetic.ts`
- `src/web/search/providers/zai.ts`

### `packages/collab-web`

- `src/app.tsx`

### `packages/stats`

- `src/client/routes/FrustrationRoute.tsx`
- `src/client/routes/ProvidersRoute.tsx`
- `src/frustration.ts`
- `src/server.ts`

### `packages/tui`

- `src/apps/debug/protocol-probe.ts`
- `src/apps/ps-top.ts`
- `src/desktop-notify.ts`
- `src/multiplexers/notify.ts`
- `src/native/backend.ts`
- `src/overlays/agent-hub.ts`
- `src/overlays/composer-shape-preview.ts`
- `src/overlays/extensions/inspector-model.ts`
- `src/overlays/mcp-add-wizard.ts`
- `src/overlays/plugin-settings.ts`
- `src/overlays/queue-mode-selector.ts`
- `src/overlays/settings-defs.ts`
- `src/overlays/settings-selector.ts`
- `src/status-line/prompt-cache.ts`
- `src/terminal-capabilities.ts`
