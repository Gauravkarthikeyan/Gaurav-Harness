/**
 * Ctrl+K command palette data: every item the palette can run, collected from omp's own registries (slash
 * commands, skills, MCP servers, models, settings, recent sessions, keybindings), and the ranking over them.
 */
import { type FuzzyFilterResult, fuzzyRank } from "@oh-my-pi/pi-tui/fuzzy";
import { all as allSettings } from "../config/registry";
import type { InteractiveModeContext } from "../modes/types";
import { SessionManager } from "../session/session-manager";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../slash-commands/builtin-registry";

export type PaletteKind = "command" | "skill" | "mcp" | "model" | "setting" | "session" | "key";

export interface PaletteItem {
	id: string;
	kind: PaletteKind;
	label: string;
	detail: string;
	shortcut?: string;
	run(): Promise<void>;
}

export const CAPABILITIES_ITEM_ID = "command:caps";
const RECENT_LIMIT = 8;
const SESSION_LIMIT = 10;

/** Ids run from the palette this process, most recent first. */
const recentIds: string[] = [];

export function recentPaletteIds(): readonly string[] {
	return recentIds;
}

/** Record a run so it ranks first next time. */
export function rememberPaletteRun(id: string): void {
	const at = recentIds.indexOf(id);
	if (at >= 0) recentIds.splice(at, 1);
	recentIds.unshift(id);
	recentIds.length = Math.min(recentIds.length, RECENT_LIMIT);
}

/** Submit `text` as if typed in the composer, so slash commands take their normal dispatch path. */
async function submit(ctx: InteractiveModeContext, text: string): Promise<void> {
	ctx.editor.setText(text);
	await ctx.editor.onSubmit?.(text);
}

/** Put `text` in the composer for the user to finish (commands that take arguments). */
function prefill(ctx: InteractiveModeContext, text: string): void {
	ctx.editor.setText(text);
	ctx.ui.requestRender();
}

/** Recent sessions for this cwd, loaded before the palette opens (listing is async; collection is not). */
let sessionCache: { cwd: string; sessions: Array<{ path: string; title: string; modified: Date }> } | undefined;

export async function loadPaletteSessions(ctx: InteractiveModeContext): Promise<void> {
	const cwd = ctx.sessionManager.getCwd();
	const current = ctx.sessionManager.getSessionFile();
	const sessions = (await SessionManager.list(cwd))
		.filter(info => info.path !== current)
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, SESSION_LIMIT)
		.map(info => ({ path: info.path, title: info.title || info.id, modified: info.modified }));
	sessionCache = { cwd, sessions };
}

/** Every palette item for this session. */
export function collectPaletteItems(ctx: InteractiveModeContext): PaletteItem[] {
	const items: PaletteItem[] = [
		{
			id: CAPABILITIES_ITEM_ID,
			kind: "command",
			label: "Capabilities",
			detail: "MCP servers, skills and plugins (/caps)",
			run: () => submit(ctx, "/caps"),
		},
	];

	for (const command of BUILTIN_SLASH_COMMAND_DEFS) {
		const takesArgs = command.allowArgs === true || (command.subcommands?.length ?? 0) > 0;
		items.push({
			id: `command:${command.name}`,
			kind: "command",
			label: `/${command.name}`,
			detail: command.description,
			run: async () => (takesArgs ? prefill(ctx, `/${command.name} `) : submit(ctx, `/${command.name}`)),
		});
	}

	for (const skill of ctx.session.skills) {
		items.push({
			id: `skill:${skill.name}`,
			kind: "skill",
			label: skill.name,
			detail: skill.description,
			run: async () => prefill(ctx, `/skill:${skill.name} `),
		});
	}

	const mcp = ctx.mcpManager;
	for (const name of mcp?.getAllServerNames() ?? []) {
		items.push({
			id: `mcp:${name}`,
			kind: "mcp",
			label: name,
			detail: `MCP server · ${mcp?.getConnectionStatus(name) ?? "unknown"}`,
			run: () => submit(ctx, "/caps"),
		});
	}

	for (const model of ctx.session.modelRegistry.getAvailable()) {
		const selector = `${model.provider}/${model.id}`;
		items.push({
			id: `model:${selector}`,
			kind: "model",
			label: model.name ?? model.id,
			detail: selector,
			run: () => submit(ctx, `/model ${selector}`),
		});
	}

	for (const setting of allSettings()) {
		const ui = setting.definition.ui;
		if (!ui) continue;
		items.push({
			id: `setting:${setting.id}`,
			kind: "setting",
			label: ui.label,
			detail: setting.id,
			run: async () => ctx.showSettingsSelector(),
		});
	}

	if (sessionCache?.cwd === ctx.sessionManager.getCwd()) {
		for (const session of sessionCache.sessions) {
			items.push({
				id: `session:${session.path}`,
				kind: "session",
				label: session.title,
				detail: `resume · ${session.modified.toLocaleString()}`,
				run: () => ctx.handleResumeSession(session.path),
			});
		}
	}

	for (const [action, keys] of Object.entries(ctx.keybindings.getResolvedBindings())) {
		const list = Array.isArray(keys) ? keys : keys ? [keys] : [];
		if (list.length === 0) continue;
		items.push({
			id: `key:${action}`,
			kind: "key",
			label: ctx.keybindings.getDefinition(action as never).description ?? action,
			detail: action,
			shortcut: list.join(" / "),
			run: async () => ctx.handleHotkeysCommand(),
		});
	}
	return items;
}

/**
 * Fuzzy-rank `items` against `query` (omp's `fuzzy.ts`); among equal scores a recent id comes first. An empty
 * query lists recents (most recent first), then commands, then everything else.
 */
export function rankPalette(items: readonly PaletteItem[], query: string, recent: readonly string[]): PaletteItem[] {
	const recency = (item: PaletteItem): number => {
		const at = recent.indexOf(item.id);
		return at < 0 ? Number.POSITIVE_INFINITY : at;
	};
	if (!query.trim()) {
		const recents = items.filter(item => recent.includes(item.id)).sort((a, b) => recency(a) - recency(b));
		const rest = items.filter(item => !recent.includes(item.id));
		return [
			...recents,
			...rest.filter(item => item.kind === "command"),
			...rest.filter(item => item.kind !== "command"),
		];
	}
	const ranked: FuzzyFilterResult<PaletteItem>[] = fuzzyRank(items, query, item => `${item.label} ${item.detail}`);
	const order = new Map(ranked.map((result, index) => [result.item, index]));
	// fuzzyRank returns best first; keep that order and only reorder runs of equal score by recency.
	return ranked
		.slice()
		.sort((a, b) =>
			a.score === b.score
				? recency(a.item) - recency(b.item) || order.get(a.item)! - order.get(b.item)!
				: order.get(a.item)! - order.get(b.item)!,
		)
		.map(result => result.item);
}
