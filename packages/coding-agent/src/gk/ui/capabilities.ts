/**
 * `/caps` Capabilities center (gk-night): MCP · Skills · Plugins tabs over omp's MCP manager, the session's
 * skills and the plugin installer. Connect attempts run in the background and turn into
 * `failed: timed out after 15s` when they have not settled by then; keys stay live throughout.
 */
import { type Component, matchesKey, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { listPlugins } from "../../extensibility/plugins/installer";
import { loadAllMCPConfigs } from "../../mcp/config";
import { addMCPServer, readMCPConfigFile } from "../../mcp/config-writer";
import type { MCPServerConfig } from "../../mcp/types";
import type { InteractiveModeContext } from "../../modes/types";
import {
	type CapabilitiesSource,
	type McpImportCandidate,
	MCP_CONNECT_TIMEOUT_MS,
	MCP_TIMEOUT_REASON,
	type McpRow,
	type McpRowState,
	mcpStateLabel,
	type PluginRow,
	type SkillRow,
} from "../capabilities-model";

export type CapsTab = "mcp" | "skills" | "plugins";
const TABS: readonly CapsTab[] = ["mcp", "skills", "plugins"];
const TAB_LABELS: Readonly<Record<CapsTab, string>> = { mcp: "MCP", skills: "Skills", plugins: "Plugins" };
const OVERLAY_WIDTH = 100;
const MAX_ROWS = 16;

export interface CapsTimers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface CapabilitiesOverlayOptions {
	onClose(): void;
	requestRender(): void;
	timers?: CapsTimers;
	onError?(message: string): void;
}

function cut(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	let out = "";
	for (const char of text) {
		if (visibleWidth(out + char) > width - 1) break;
		out += char;
	}
	return `${out}…`;
}

function stateTone(state: McpRowState): "success" | "warning" | "error" | "muted" | "accent" {
	switch (state.kind) {
		case "connected":
			return "success";
		case "needs-login":
			return "warning";
		case "failed":
			return "error";
		case "connecting":
			return "accent";
		case "disabled":
			return "muted";
	}
}

/** `i` import preview; `candidates` is undefined while other tools' configs are being read. */
interface ImportPreview {
	candidates: McpImportCandidate[] | undefined;
	saving: boolean;
}

export class CapabilitiesOverlay implements Component {
	readonly #source: CapabilitiesSource;
	readonly #options: CapabilitiesOverlayOptions;
	readonly #timers: CapsTimers;
	#tab: CapsTab = "mcp";
	#selected: Record<CapsTab, number> = { mcp: 0, skills: 0, plugins: 0 };
	#mcp: McpRow[] | undefined;
	#skills: SkillRow[];
	#plugins: PluginRow[] | undefined;
	#loadError: string | undefined;
	/** Connect attempts in flight or timed out, by server name; overrides the manager's state. */
	readonly #attempts = new Map<string, { state: McpRowState; timer: unknown; generation: number }>();
	#generation = 0;
	/** Open `i` import preview, if any. */
	#import: ImportPreview | undefined;
	#disposed = false;

	constructor(source: CapabilitiesSource, options: CapabilitiesOverlayOptions) {
		this.#source = source;
		this.#options = options;
		this.#timers = options.timers ?? {
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
		};
		this.#skills = source.skills();
		void this.#reload();
	}

	invalidate(): void {}

	dispose(): void {
		this.#disposed = true;
		for (const attempt of this.#attempts.values()) this.#timers.clearTimeout(attempt.timer);
		this.#attempts.clear();
	}

	async #reload(): Promise<void> {
		try {
			const [mcp, plugins] = await Promise.all([this.#source.mcp(), this.#source.plugins()]);
			if (this.#disposed) return;
			this.#mcp = mcp;
			this.#plugins = plugins;
			this.#loadError = undefined;
			// A server the manager still reports as connecting gets the same 15 s deadline as one we started.
			for (const row of mcp)
				if (row.state.kind === "connecting" && !this.#attempts.has(row.name)) this.#track(row.name);
		} catch (error) {
			this.#loadError = error instanceof Error ? error.message : String(error);
		}
		this.#options.requestRender();
	}

	/** Start the 15 s deadline for `name`; returns the attempt's generation. */
	#track(name: string): number {
		const previous = this.#attempts.get(name);
		if (previous) this.#timers.clearTimeout(previous.timer);
		const generation = ++this.#generation;
		const timer = this.#timers.setTimeout(() => {
			const attempt = this.#attempts.get(name);
			if (!attempt || attempt.generation !== generation || this.#disposed) return;
			attempt.state = { kind: "failed", reason: MCP_TIMEOUT_REASON };
			this.#options.requestRender();
		}, MCP_CONNECT_TIMEOUT_MS);
		this.#attempts.set(name, { state: { kind: "connecting" }, timer, generation });
		return generation;
	}

	#connect(name: string): void {
		const generation = this.#track(name);
		this.#options.requestRender();
		this.#source.connectMcp(name).then(
			() => {
				const attempt = this.#attempts.get(name);
				if (!attempt || attempt.generation !== generation) return;
				this.#timers.clearTimeout(attempt.timer);
				this.#attempts.delete(name);
				void this.#reload();
			},
			error => {
				const attempt = this.#attempts.get(name);
				if (!attempt || attempt.generation !== generation) return;
				this.#timers.clearTimeout(attempt.timer);
				attempt.state = { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
				this.#options.requestRender();
			},
		);
	}

	#mcpState(row: McpRow): McpRowState {
		return this.#attempts.get(row.name)?.state ?? row.state;
	}

	#rowCount(): number {
		if (this.#tab === "mcp") return this.#mcp?.length ?? 0;
		if (this.#tab === "skills") return this.#skills.length;
		return this.#plugins?.length ?? 0;
	}

	#run(task: Promise<void>): void {
		task.then(
			() => this.#reload(),
			error => this.#options.onError?.(error instanceof Error ? error.message : String(error)),
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") || (matchesKey(data, "escape") && !this.#import)) {
			this.dispose();
			this.#options.onClose();
			return;
		}
		if (this.#import) {
			this.#handleImportInput(data);
			this.#options.requestRender();
			return;
		}
		const tabIndex = TABS.indexOf(this.#tab);
		if (data === "1" || data === "2" || data === "3") this.#tab = TABS[Number(data) - 1]!;
		else if (matchesKey(data, "left")) this.#tab = TABS[(tabIndex + TABS.length - 1) % TABS.length]!;
		else if (matchesKey(data, "right") || matchesKey(data, "tab")) this.#tab = TABS[(tabIndex + 1) % TABS.length]!;
		else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const total = this.#rowCount();
			if (total > 0) {
				const delta = matchesKey(data, "up") ? -1 : 1;
				this.#selected[this.#tab] = (this.#selected[this.#tab] + delta + total) % total;
			}
		} else if (matchesKey(data, "space")) this.#toggle();
		else if (data === "r" && this.#tab === "mcp") {
			const row = this.#mcp?.[this.#selected.mcp];
			if (row && row.state.kind !== "disabled") this.#connect(row.name);
		} else if (data === "i" && this.#tab === "mcp") this.#openImport();
		else if (data === "a" && this.#tab === "mcp") {
			this.dispose();
			this.#options.onClose();
			this.#source.addMcp();
			return;
		}
		this.#options.requestRender();
	}

	#openImport(): void {
		const preview: ImportPreview = { candidates: undefined, saving: false };
		this.#import = preview;
		this.#source.importCandidates().then(
			candidates => {
				if (this.#import !== preview || this.#disposed) return;
				preview.candidates = candidates;
				this.#options.requestRender();
			},
			error => {
				if (this.#import === preview) this.#import = undefined;
				this.#options.onError?.(error instanceof Error ? error.message : String(error));
				this.#options.requestRender();
			},
		);
	}

	/** Esc cancels the preview without writing; Enter writes every listed server. */
	#handleImportInput(data: string): void {
		const preview = this.#import!;
		if (matchesKey(data, "escape")) {
			this.#import = undefined;
			return;
		}
		if (!matchesKey(data, "enter") || preview.saving || !preview.candidates?.length) return;
		preview.saving = true;
		this.#source.importMcp(preview.candidates).then(
			() => {
				if (this.#import === preview) this.#import = undefined;
				void this.#reload();
			},
			error => {
				preview.saving = false;
				this.#options.onError?.(error instanceof Error ? error.message : String(error));
				this.#options.requestRender();
			},
		);
	}

	#toggle(): void {
		if (this.#tab === "mcp") {
			const row = this.#mcp?.[this.#selected.mcp];
			if (row) this.#run(this.#source.setMcpEnabled(row.name, row.state.kind === "disabled"));
		} else if (this.#tab === "plugins") {
			const row = this.#plugins?.[this.#selected.plugins];
			if (row) this.#run(this.#source.setPluginEnabled(row.name, !row.enabled));
		}
	}

	render(width: number): string[] {
		const boxWidth = Math.max(40, Math.min(width, OVERLAY_WIDTH));
		const inner = boxWidth - 4;
		const edge = (text: string) => theme.fg("borderAccent", text);
		const row = (content: string) =>
			`${edge("│")} ${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))} ${edge("│")}`;
		const title = " capabilities ";
		const lines = [
			`${edge("┌─")}${theme.fg("text", title)}${edge(`${"─".repeat(Math.max(0, boxWidth - 3 - title.length))}┐`)}`,
		];
		const tabs = TABS.map((tab, index) => {
			const label = `${index + 1} ${TAB_LABELS[tab]}`;
			return tab === this.#tab ? theme.bold(theme.fg("accent", label)) : theme.fg("muted", label);
		}).join(theme.fg("dim", "  ·  "));
		lines.push(row(tabs));
		lines.push(row(theme.fg("borderMuted", "─".repeat(inner))));
		for (const body of this.#body(inner)) lines.push(row(body));
		lines.push(row(""));
		lines.push(row(this.#hints()));
		lines.push(edge(`└${"─".repeat(boxWidth - 2)}┘`));
		return lines;
	}

	#hints(): string {
		const hint = (key: string, label: string) => `${theme.fg("accent", key)} ${theme.fg("muted", label)}`;
		const keys = this.#import
			? [hint("enter", "import all"), hint("esc", "cancel")]
			: this.#tab === "mcp"
				? [hint("space", "on/off"), hint("r", "reconnect"), hint("a", "add"), hint("i", "import")]
				: this.#tab === "plugins"
					? [hint("space", "enable/disable"), hint("1-3", "tabs"), hint("esc", "close")]
					: [hint("↑↓", "select"), hint("1-3", "tabs"), hint("esc", "close")];
		return keys.join("   ");
	}

	#window<T>(rows: readonly T[], selected: number): Array<[T, number]> {
		const first = Math.max(0, Math.min(selected - Math.floor(MAX_ROWS / 2), rows.length - MAX_ROWS));
		return rows.slice(first, first + MAX_ROWS).map((value, offset) => [value, first + offset]);
	}

	#importBody(inner: number): string[] {
		const { candidates, saving } = this.#import!;
		if (!candidates) return [theme.fg("muted", "reading Claude, Cursor and VS Code MCP configs…")];
		if (candidates.length === 0)
			return [
				theme.fg(
					"muted",
					cut(
						"Nothing to import: no Claude, Cursor or VS Code MCP servers that GK does not already have. Esc goes back.",
						inner,
					),
				),
			];
		const plural = candidates.length === 1 ? "" : "s";
		const head = saving
			? `importing ${candidates.length} server${plural}…`
			: `Import ${candidates.length} server${plural} into GK, disabled until tested. Nothing is written until Enter.`;
		const rows = candidates.slice(0, MAX_ROWS).map(candidate => {
			const name = cut(candidate.name, 24).padEnd(24);
			const from = cut(candidate.from, 14).padEnd(14);
			return `  ${theme.fg("text", name)} ${theme.fg("muted", from)} ${theme.fg("dim", cut(candidate.detail, Math.max(0, inner - 2 - 24 - 1 - 14 - 1)))}`;
		});
		if (candidates.length > MAX_ROWS) rows.push(theme.fg("muted", `  … and ${candidates.length - MAX_ROWS} more`));
		return [theme.fg("accent", cut(head, inner)), ...rows];
	}

	#body(inner: number): string[] {
		if (this.#loadError)
			return [
				theme.fg(
					"error",
					cut(`Could not read capabilities: ${this.#loadError}. Esc closes; reopen with /caps.`, inner),
				),
			];
		const cursor = (selected: boolean) => (selected ? theme.fg("accent", "▸ ") : "  ");
		if (this.#import) return this.#importBody(inner);
		if (this.#tab === "mcp") {
			if (!this.#mcp) return [theme.fg("muted", "loading MCP servers…")];
			if (this.#mcp.length === 0)
				return [
					theme.fg(
						"muted",
						cut("No MCP servers yet. Press a to add one or i to import from Claude/Cursor configs.", inner),
					),
				];
			return this.#window(this.#mcp, this.#selected.mcp).map(([server, index]) => {
				const selected = index === this.#selected.mcp;
				const state = this.#mcpState(server);
				const name = cut(server.name, 28).padEnd(28);
				const scope = server.scope.padEnd(8);
				const label = cut(mcpStateLabel(state), Math.max(0, inner - 2 - 28 - 1 - 8 - 1));
				return `${cursor(selected)}${selected ? theme.fg("accent", name) : theme.fg("text", name)} ${theme.fg("muted", scope)} ${theme.fg(stateTone(state), label)}`;
			});
		}
		if (this.#tab === "skills") {
			if (this.#skills.length === 0)
				return [
					theme.fg(
						"muted",
						"No skills discovered. Add one under ~/.gk/agent/skills or search with /skills search.",
					),
				];
			return this.#window(this.#skills, this.#selected.skills).map(([skill, index]) => {
				const selected = index === this.#selected.skills;
				const name = cut(skill.name, 28).padEnd(28);
				const source = cut(skill.source, 12).padEnd(12);
				const description = cut(skill.description, Math.max(0, inner - 2 - 28 - 1 - 12 - 1));
				const dot = skill.enabled ? theme.fg("success", "◆") : theme.fg("muted", "◇");
				return `${cursor(selected)}${dot} ${selected ? theme.fg("accent", name.slice(0, 26)) : theme.fg("text", name.slice(0, 26))} ${theme.fg("muted", source)} ${theme.fg("muted", description)}`;
			});
		}
		if (!this.#plugins) return [theme.fg("muted", "loading plugins…")];
		if (this.#plugins.length === 0)
			return [theme.fg("muted", "No plugins installed. Browse with /marketplace discover.")];
		return this.#window(this.#plugins, this.#selected.plugins).map(([plugin, index]) => {
			const selected = index === this.#selected.plugins;
			const name = cut(plugin.name, 32).padEnd(32);
			const state = plugin.enabled ? theme.fg("success", "enabled") : theme.fg("muted", "disabled");
			const update = plugin.updateAvailable ? theme.fg("warning", "  ! update available") : "";
			return `${cursor(selected)}${selected ? theme.fg("accent", name) : theme.fg("text", name)} ${theme.fg("muted", cut(plugin.version, 12).padEnd(12))} ${state}${update}`;
		});
	}
}

/** Submit `text` as if typed, so omp's `/mcp` and `/plugins` handlers do the work. */
async function submit(ctx: InteractiveModeContext, text: string): Promise<void> {
	await ctx.editor.onSubmit?.(text);
}

/** Live source over omp's MCP manager, session skills and plugin installer. */
export function createCapabilitiesSource(ctx: InteractiveModeContext): CapabilitiesSource {
	/** Configs behind the last import preview, so Enter writes exactly what was shown. */
	const importable = new Map<string, MCPServerConfig>();
	return {
		async mcp() {
			const manager = ctx.mcpManager;
			const cwd = getProjectDir();
			const [user, project] = await Promise.all([
				readMCPConfigFile(getMCPConfigPath("user", cwd)),
				readMCPConfigFile(getMCPConfigPath("project", cwd)),
			]);
			const rows: McpRow[] = [];
			const seen = new Set<string>();
			for (const name of manager?.getAllServerNames() ?? []) {
				seen.add(name);
				const status = manager!.getConnectionStatus(name);
				const scope = manager!.getSource(name)?.level === "project" ? "project" : "global";
				let state: McpRowState;
				if (status === "connected")
					state = { kind: "connected", tools: manager!.getConnection(name)?.tools?.length ?? 0 };
				else if (status === "connecting") state = { kind: "connecting" };
				else if (manager!.getServerConfig(name)?.auth) state = { kind: "needs-login" };
				else state = { kind: "failed", reason: "not connected" };
				rows.push({ name, scope, state });
			}
			const disabled = new Set(user.disabledServers ?? []);
			for (const [config, scope] of [
				[user, "global"],
				[project, "project"],
			] as const) {
				for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
					if (seen.has(name)) continue;
					if (server?.enabled === false || disabled.has(name)) {
						seen.add(name);
						rows.push({ name, scope, state: { kind: "disabled" } });
					}
				}
			}
			for (const name of disabled)
				if (!seen.has(name)) rows.push({ name, scope: "global", state: { kind: "disabled" } });
			return rows.sort((a, b) => a.name.localeCompare(b.name));
		},
		skills() {
			return ctx.session.skills.map(skill => ({
				name: skill.name,
				source: skill.source,
				description: skill.description,
				enabled: skill.hide !== true,
			}));
		},
		async plugins() {
			return (await listPlugins()).map(plugin => ({
				name: plugin.name,
				version: plugin.version,
				enabled: plugin.enabled,
				updateAvailable: false,
			}));
		},
		setMcpEnabled: (name, enabled) => submit(ctx, `/mcp ${enabled ? "enable" : "disable"} ${name}`),
		async connectMcp(name) {
			await ctx.mcpManager?.reconnectServer(name);
		},
		setPluginEnabled: (name, enabled) => submit(ctx, `/plugins ${enabled ? "enable" : "disable"} ${name}`),
		addMcp() {
			ctx.editor.setText("/mcp add ");
			ctx.ui.requestRender();
		},
		async importCandidates() {
			const cwd = getProjectDir();
			const [{ configs, sources }, user] = await Promise.all([
				loadAllMCPConfigs(cwd, { filterExa: false }),
				readMCPConfigFile(getMCPConfigPath("user", cwd)),
			]);
			importable.clear();
			const candidates: McpImportCandidate[] = [];
			for (const [name, config] of Object.entries(configs)) {
				const source = sources[name];
				if (!source || !IMPORT_PROVIDERS[source.provider] || user.mcpServers?.[name]) continue;
				importable.set(name, config);
				const detail =
					config.type === "http" || config.type === "sse"
						? config.url
						: [config.command, ...(config.args ?? [])].join(" ");
				candidates.push({ name, from: source.providerName, detail });
			}
			return candidates.sort((a, b) => a.name.localeCompare(b.name));
		},
		async importMcp(candidates) {
			const path = getMCPConfigPath("user", getProjectDir());
			for (const candidate of candidates) {
				const config = importable.get(candidate.name);
				if (config) await addMCPServer(path, candidate.name, { ...config, enabled: false });
			}
		},
	};
}

/** Tools whose MCP configs `i` offers to import (spec §5.13). */
const IMPORT_PROVIDERS: Readonly<Record<string, true>> = { claude: true, cursor: true, vscode: true };

/** Open the Capabilities center (`/caps`, palette). */
export function showCapabilities(ctx: InteractiveModeContext): void {
	const overlay = new CapabilitiesOverlay(createCapabilitiesSource(ctx), {
		requestRender: () => ctx.ui.requestRender(),
		onError: message => ctx.showError(message),
		onClose: () => {
			handle.hide();
			ctx.ui.setFocus(ctx.editor);
			ctx.ui.requestRender();
		},
	});
	const handle = ctx.ui.showOverlay(overlay, { anchor: "center", width: OVERLAY_WIDTH, maxHeight: "90%" });
	ctx.ui.setFocus(overlay);
	ctx.ui.requestRender();
}
