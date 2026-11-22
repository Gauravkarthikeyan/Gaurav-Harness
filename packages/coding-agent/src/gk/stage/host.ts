/**
 * The Stage host (spec §5.3 Solo, §5.5 The Stage): one full-screen, alternate-screen surface the harness
 * tiles by itself. It owns a `TileStore`, feeds it from the live session, the agent registry, todos and
 * git, runs `layoutStage` on resize, on every event and on a 500 ms tick (plus tween frames only while a
 * layout change animates), and composites the chrome, panes and widgets into exact-width rows.
 *
 * The surface is a pi-tui fullscreen overlay with `base: true`: it never takes focus, so omp keeps every
 * key, autocomplete, selector and dialog; pane 0.0 draws omp's transcript and composer roots
 * (see `transcript-pane.ts`), and dialogs stack above the Stage unchanged.
 */
import * as os from "node:os";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	CURSOR_MARKER,
	matchesKey,
	type OverlayHandle,
	type OverlayOptions,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { parseSgrMouse, type SgrMouseEvent } from "@oh-my-pi/pi-tui/mouse";
import { gkPaletteFor } from "@oh-my-pi/pi-tui/theme/gk-palette";
import { getCurrentThemeName, highlightCode } from "@oh-my-pi/pi-tui/theme/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { getLogPath, isRecord, logger } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import { formatGkVersion } from "../brand";
import { budgetNotice, getTodaySpendUsd, localDay } from "../daily-spend";
import { cfgGkBudgetDailyUsd } from "../settings";
import type { AgentRef, RegistryEvent } from "../../registry/agent-registry";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL } from "../../mcp/startup-events";
import { CellBuffer } from "./compositor";
import {
	ComputerTileState,
	computerCaption,
	computerGraphicsAvailable,
	computerShotOf,
	computerTileId,
	renderComputerBody,
} from "./computer-tile";
import { branchLabel, type GitLoader, type GitSnapshot, loadGitSnapshot } from "./git-source";
import { type ErrorActions, type StageErrorInput, StageErrors } from "./error-tile";
import { layoutStage, type Rect, type StageLayout, toLayoutTiles } from "./layout";
import { AgentFeed } from "./live-feed";
import type { StageOrchestra } from "./orchestra-hooks";
import { type HostStyle, type HostToken, themeStyle } from "./style";
import { type Tile, type TileState, TileStore } from "./tiles";
import {
	clockTime,
	commandOf,
	diffStat,
	diffMetric,
	diffTextOf,
	editPathOf,
	exitCodeOf,
	formatDuration,
	formatElapsed,
	isEditCall,
	isWebCall,
	latestHunk,
	resultText,
	type ToolRecord,
	toolEvent,
	toolLabel,
} from "./tool-lines";
import { composerRows, renderTranscriptPane } from "./transcript-pane";
import { WeightTween } from "./tween";
import { agentToken, bold, glyph, type StageToken, type StateGlyph } from "./widgets/common";
import { renderEvents } from "./widgets/events";
import { type FeedOptions, feedRows, type NestedView, toolBodyRows } from "./widgets/feed";
import { renderGit } from "./widgets/git";
import {
	formatBranch,
	fullPixelLogo,
	type HeaderData,
	headerWidth,
	LOGO_TEXT,
	pixelLogo,
	renderHeader,
} from "./widgets/header";
import { renderPaneStatus } from "./widgets/pane-status";
import { renderStatusBar } from "./widgets/statusbar";
import { renderTabs, type TabSummaryItem } from "./widgets/tabs";
import { renderTelemetry } from "./widgets/telemetry";
import { renderTodo, type TodoItem } from "./widgets/todo";
import { diffRows } from "./widgets/transcript-lines";

export const TRANSCRIPT_ID = "transcript";
export const MAIN_AGENT_ID = "Main";
const W_TELEMETRY = "w:telemetry";
const W_TODO = "w:todo";
const W_GIT = "w:git";
const W_EVENTS = "w:events";

const TICK_MS = 500;
const FRAME_MS = 16;
/** Streaming redraws are coalesced to at most ~30 fps. */
const STREAM_FRAME_MS = 33;
const SAMPLE_EVERY_TICKS = 4; // 2 s telemetry buckets → 30 buckets per 60 s window
const SERIES_MAX = 60;
const EVENTS_MAX = 200;
const GIT_MIN_INTERVAL_MS = 3_000;
/** From this width the header is 3 rows: the full pixel wordmark beside 3 field rows. */
const FULL_LOGO_MIN_COLS = 200;
/** From this width (below {@link FULL_LOGO_MIN_COLS}) the 2-row compact pixel wordmark; narrower, the text one. */
const PIXEL_LOGO_MIN_COLS = 180;
const TODAY_REFRESH_MS = 30_000;
const WHEEL_ROWS = 3;

/** What the host reads from the live session (an `AgentSession` satisfies it). */
export interface StageSession {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	readonly isStreaming: boolean;
	readonly model: { id: string; name?: string } | undefined;
	readonly thinkingLevel?: string | undefined;
	readonly messages: readonly AgentMessage[];
	getSessionStats(): {
		cost: number;
		toolCalls: number;
		tokens: { input: number; output: number; cacheRead: number; total: number };
	};
	getContextUsage?(): { tokens: number; contextWindow: number } | undefined;
}

export interface StageRegistry {
	list(): AgentRef[];
	onChange(listener: (event: RegistryEvent) => void): () => void;
}

type InputResult = { consume?: boolean; data?: string } | undefined;

/** The slice of pi-tui's `TUI` the host drives. */
export interface StageUi {
	readonly terminal: { readonly columns: number; readonly rows: number };
	requestRender(force?: boolean): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	addInputListener(listener: (data: string) => InputResult, options?: { prepend?: boolean }): () => void;
	/** Whether a dialog (any non-base overlay) is up; keys then belong to it. */
	hasOverlay(): boolean;
}

export interface StageHostOptions {
	ui: StageUi;
	/** Current session; re-read every tick so a session switch re-subscribes. */
	session: () => StageSession;
	sessionId: () => string;
	/** omp transcript blocks, oldest first. */
	blocks: () => readonly Component[];
	/** omp composer roots drawn under the transcript in pane 0.0. */
	chrome: () => readonly Component[];
	isAssistant: (component: Component) => boolean;
	expandTools?: () => boolean;
	todos?: () => readonly TodoPhase[];
	registry?: StageRegistry;
	cwd: string;
	/** `null` disables git; default runs git in `cwd`. */
	git?: GitLoader | null;
	now?: () => number;
	motion?: boolean;
	style?: HostStyle;
	/** Start the 500 ms tick (tests drive `tick()` themselves). Default true. */
	timers?: boolean;
	/** Syntax highlighter for streaming code; default omp's native one with the theme style, plain otherwise. */
	highlight?: ((code: string, lang: string | undefined) => string[]) | null;
	/** Point omp's input at an agent's session (`null` = back to main): typing in a zoomed agent pane steers it. */
	focusAgent?: (agentId: string | null) => void;
	/** What an error tile's keys do (log in, switch model, retry, copy); without it those keys do nothing. */
	errorActions?: ErrorActions;
	/** Whether omp's composer is empty; a focused error tile only takes its keys then. Default: always. */
	composerEmpty?: () => boolean;
	/**
	 * TODAY's sources: spend across all sessions and the `gk.budget.dailyUsd` limit. Default reads omp-stats
	 * session usage and the global settings; `null` leaves TODAY at `–`.
	 */
	todaySpend?: { usd: () => Promise<number>; budgetUsd: () => number | undefined } | null;
	/** Inline screenshots in computer tiles. Default: kitty graphics when `terminal.showImages` is on. */
	computerGraphics?: () => boolean;
}

interface AgentInfo {
	ref: AgentRef;
	/** Tile state last seen, for spawn/done events of agents drawn inset (no tile of their own). */
	state?: TileState;
	/** Session the host is subscribed to (the registry attaches sessions without emitting). */
	session?: AgentRef["session"];
	unsubscribe?: () => void;
	stats?: { model?: string; tokens?: number; cost?: number; ctx?: { used: number; limit: number } };
}

interface StageEvent {
	at: number;
	agent: string;
	agentToken?: StageToken;
	glyph: StateGlyph;
	text: string;
	/** Tool the row follows; its glyph tracks the call's state. */
	toolId?: string;
}

interface Series {
	tok: number[];
	ctx: number[];
	cost: number[];
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
	return String(Math.round(n));
}

function money(n: number): string {
	return `$${n.toFixed(2)}`;
}

/** Short model label: `claude-opus-5-5` → `opus-5.5`. */
export function modelLabel(model: { id: string; name?: string } | undefined): string {
	if (!model) return "no model";
	const id = model.id.replace(/^.*\//, "").replace(/^claude-/, "");
	return id.replace(/-(\d+)-(\d+)(?=$|-)/, "-$1.$2");
}

function stripControl(line: string): string {
	const cr = line.lastIndexOf("\r");
	return (cr >= 0 ? line.slice(cr + 1) : line).replace(/\x1b\[[0-9;?]*[A-HJKSTfhlns]/g, "");
}

export class StageHost {
	readonly store: TileStore;
	readonly #opts: StageHostOptions;
	readonly #ui: StageUi;
	readonly #now: () => number;
	readonly #style: HostStyle;
	readonly #tween: WeightTween;
	readonly #tools = new Map<string, ToolRecord>();
	readonly #computers = new Map<string, ComputerTileState>();
	readonly #computerGraphics: () => boolean;
	/** Calls still streaming their arguments (no `tool_execution_start` yet). */
	readonly #pending = new Map<string, ToolRecord>();
	readonly #agents = new Map<string, AgentInfo>();
	readonly #feeds = new Map<string, AgentFeed>();
	readonly #errors: StageErrors;
	readonly #motion: boolean;
	#unsubBus: (() => void) | undefined;
	#commandSeq = 0;
	readonly #highlight: FeedOptions["highlight"];
	readonly #diffByPath = new Map<string, string>();
	readonly #events: StageEvent[] = [];
	readonly #seen = new WeakMap<Component, number>();
	readonly #series: Series = { tok: [], ctx: [], cost: [] };
	readonly #startedAt: number;
	readonly #surface: Component;
	#overlay: OverlayHandle | undefined;
	#session: StageSession | undefined;
	#unsubSession: (() => void) | undefined;
	#unsubRegistry: (() => void) | undefined;
	#unsubInput: (() => void) | undefined;
	#timer: NodeJS.Timeout | undefined;
	#frameTimer: NodeJS.Timeout | undefined;
	#streamTimer: NodeJS.Timeout | undefined;
	#ticks = 0;
	#streamedChars = 0;
	#lastCost = 0;
	#git: GitSnapshot | null = null;
	#gitInFlight = false;
	#gitQueued = false;
	#gitLastAt = 0;
	#layout: StageLayout | null = null;
	#layoutKey = "";
	#zoomedId: string | null = null;
	#scroll = 0;
	#maxScroll = 0;
	/** Rows a zoomed agent pane is scrolled up from its live tail. */
	#zoomScroll = 0;
	#zoomMaxScroll = 0;
	#zoomPage = 10;
	/** Agent whose session omp's input is pointed at (zoomed agent pane). */
	#steering: string | null = null;
	#narration = "";
	#orchestra: StageOrchestra | null = null;
	#logo: { key: string; rows: string[] } | undefined;
	#messageIndex: { count: number; calls: Map<string, ToolRecord> } = { count: -1, calls: new Map() };
	/** TODAY's value once the first read lands (`$3.46`, or `! $12.00 / $10.00` over budget); render never waits on it. */
	#todayLabel: string | undefined;
	/** `budgetNotice` text while today's spend is at or over `gk.budget.dailyUsd`. */
	#todayNotice: string | undefined;
	/** Local day the budget notice was last posted to the events tail, so it shows once a day. */
	#budgetNoticeDay: string | undefined;
	#todayTimer: NodeJS.Timeout | undefined;

	constructor(options: StageHostOptions) {
		this.#opts = options;
		this.#ui = options.ui;
		this.#now = options.now ?? Date.now;
		this.#style = options.style ?? themeStyle;
		this.#computerGraphics = options.computerGraphics ?? computerGraphicsAvailable;
		this.#startedAt = this.#now();
		this.store = new TileStore({ now: this.#now });
		this.#motion = options.motion ?? true;
		this.#tween = new WeightTween({ now: this.#now, motion: this.#motion });
		this.#errors = new StageErrors({ store: this.store, actions: options.errorActions, logPath: () => getLogPath() });
		this.#highlight =
			options.highlight === undefined
				? options.style
					? undefined
					: (code, lang) => highlightCode(code, lang)
				: (options.highlight ?? undefined);
		this.store.add({ id: TRANSCRIPT_ID, kind: "transcript", title: "session", state: "idle", pinned: true });
		this.store.add({ id: W_TELEMETRY, kind: "telemetry", title: "telemetry", state: "idle" });
		this.store.add({ id: W_EVENTS, kind: "events", title: "events", state: "idle" });
		this.#surface = {
			render: width => this.render(width, this.#ui.terminal.rows),
			invalidate: () => {},
		};
	}

	/** Mount the surface and start listening. */
	start(): void {
		if (this.#overlay) return;
		this.#overlay = this.#ui.showOverlay(this.#surface, {
			fullscreen: true,
			base: true,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			anchor: "top-left",
		});
		this.#bindSession();
		if (this.#opts.registry) {
			this.#unsubRegistry = this.#opts.registry.onChange(() => {
				this.#syncAgents();
				this.#changed();
			});
			this.#syncAgents();
		}
		this.#unsubInput = this.#ui.addInputListener(data => this.#onInput(data), { prepend: true });
		if (this.#opts.timers !== false) {
			this.#timer = setInterval(() => this.tick(), TICK_MS);
			this.#timer.unref?.();
		}
		this.refreshGit();
		this.#refreshToday();
		if (this.#opts.timers !== false) {
			this.#todayTimer = setInterval(() => this.#refreshToday(), TODAY_REFRESH_MS);
			this.#todayTimer.unref?.();
		}
	}

	stop(): void {
		this.#overlay?.hide();
		this.#overlay = undefined;
		this.#unsubSession?.();
		this.#unsubSession = undefined;
		this.#unsubRegistry?.();
		this.#unsubInput?.();
		this.#unsubBus?.();
		this.#unsubBus = undefined;
		for (const info of this.#agents.values()) info.unsubscribe?.();
		clearInterval(this.#timer);
		clearInterval(this.#todayTimer);
		this.#todayTimer = undefined;
		clearTimeout(this.#frameTimer);
		clearTimeout(this.#streamTimer);
		this.#timer = undefined;
		this.#frameTimer = undefined;
		this.#streamTimer = undefined;
	}

	/** 500 ms heartbeat: chip timers, telemetry buckets, agent stats, session switches. */
	tick(): void {
		this.#bindSession();
		this.#ticks++;
		if (this.#ticks % SAMPLE_EVERY_TICKS === 0) this.#sample();
		for (const info of this.#agents.values()) this.#bindAgent(info);
		this.#refreshAgentStats();
		this.#orchestra?.tick(this.#now());
		this.store.tick();
		this.#ui.requestRender();
	}

	// ── Sources ─────────────────────────────────────────────────────────────

	#bindSession(): void {
		const session = this.#opts.session();
		if (session === this.#session) return;
		this.#unsubSession?.();
		this.#session = session;
		this.#unsubSession = session.subscribe(event => this.handleEvent(null, event));
	}

	/** Route one session event (`agentId` null = the main session). Public for tests and bridges. */
	handleEvent(agentId: string | null, event: AgentSessionEvent): void {
		if (event.type === "message_end" || event.type === "tool_execution_end") {
			const parent = this.#parentTile(agentId);
			const agent = agentId === null ? undefined : this.#agentName(agentId);
			if (this.#errors.observe(agent, event, parent === TRANSCRIPT_ID ? null : parent)) this.#changed();
		}
		switch (event.type) {
			case "tool_execution_start":
				this.#toolStart(agentId, event.toolCallId, event.toolName, event.args, event.intent);
				break;
			case "tool_execution_update":
				this.#toolUpdate(event.toolCallId, event.partialResult);
				this.#streamRender();
				return;
			case "tool_execution_end":
				this.#toolEnd(event.toolCallId, event.result, event.isError === true);
				break;
			case "message_update": {
				const e = event.assistantMessageEvent;
				if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") {
					this.#streamedChars += e.delta.length;
				}
				if (e.type === "toolcall_start" || e.type === "toolcall_delta" || e.type === "toolcall_end") {
					this.#trackPending(agentId, e.partial.content);
				}
				if (agentId !== null) this.#feedOf(agentId).apply(event, this.#now());
				this.#streamRender();
				return;
			}
			case "message_start":
				if (agentId === null && event.message.role === "user") {
					this.#scroll = 0;
					this.#pushEvent({ at: this.#now(), agent: "you", glyph: "prompt", text: "prompt" });
				}
				if (agentId !== null) this.#feedOf(agentId).apply(event, this.#now());
				break;
			case "message_end":
				if (agentId === null || !this.#feedOf(agentId).apply(event, this.#now())) return;
				break;
			case "agent_start":
				if (agentId === null) this.#setBusy(true);
				break;
			case "agent_end":
				if (agentId === null) {
					this.#setBusy(false);
					this.#pending.clear();
					this.refreshGit();
					this.#refreshToday();
				} else {
					// Calls whose args streamed but never ran (aborted turn) stop spinning.
					for (const [id, record] of this.#pending) {
						if (record.agentId !== agentId) continue;
						record.endedAt = this.#now();
						record.isError = true;
						this.#pending.delete(id);
					}
				}
				break;
			default:
				return;
		}
		this.#changed();
	}

	/** Coalesce streaming redraws to ≤ 30 fps; nothing is scheduled while idle. */
	#streamRender(): void {
		if (this.#streamTimer) return;
		this.#streamTimer = setTimeout(() => {
			this.#streamTimer = undefined;
			this.#ui.requestRender();
		}, STREAM_FRAME_MS);
		this.#streamTimer.unref?.();
	}

	#feedOf(agentId: string): AgentFeed {
		let feed = this.#feeds.get(agentId);
		if (!feed) {
			feed = new AgentFeed();
			this.#feeds.set(agentId, feed);
		}
		return feed;
	}

	#agentName(agentId: string | null): string {
		if (agentId === null) return "main";
		return this.#agents.get(agentId)?.ref.displayName ?? agentId;
	}

	#agentTokenOf(agentId: string | null): StageToken {
		if (agentId === null) return "accent";
		const crew = this.#orchestra?.agentToken(agentId);
		if (crew) return crew;
		const index = [...this.#agents.keys()].indexOf(agentId);
		return agentToken(Math.max(0, index));
	}

	#parentTile(agentId: string | null): string {
		if (agentId === null) return TRANSCRIPT_ID;
		const id = `agent:${agentId}`;
		return this.store.get(id) ? id : TRANSCRIPT_ID;
	}

	#toolStart(agentId: string | null, id: string, name: string, args: unknown, intent: string | undefined): void {
		const now = this.#now();
		// A call whose args streamed keeps its record (the feed already shows it); it now runs.
		const pending = this.#pending.get(id);
		const record: ToolRecord = pending ?? {
			id,
			name,
			args: {},
			agentId,
			startedAt: now,
			endedAt: null,
			isError: false,
			output: "",
			details: undefined,
		};
		record.name = name;
		if (isRecord(args)) record.args = args;
		record.intent = intent;
		record.agentId = agentId;
		record.startedAt = now;
		this.#tools.set(id, record);
		this.#pending.delete(id);
		const parentId = this.#parentTile(agentId);
		if (name === "bash" && !this.store.get(`cmd:${id}`)) {
			this.store.add({ id: `cmd:${id}`, kind: "command", parentId, title: `$ ${commandOf(record)}` });
		} else if (isWebCall(record) && !this.store.get(`web:${id}`)) {
			this.store.add({ id: `web:${id}`, kind: "web", parentId, title: toolLabel(record) });
		}
		if (name === "computer") this.#computerStart(agentId, id, record.args);
		if (agentId !== null) {
			this.#feedOf(agentId).addTool(record);
			this.store.touch(`agent:${agentId}`);
		}
		if (intent) {
			const who = agentId === null ? "" : `${this.#agentName(agentId)}: `;
			this.#narration = `${who}${intent}`;
		}
		this.#pushEvent({
			at: now,
			agent: this.#agentName(agentId),
			agentToken: this.#agentTokenOf(agentId),
			glyph: "running",
			text: toolLabel(record),
			toolId: id,
		});
	}

	#toolUpdate(id: string, partial: unknown): void {
		const record = this.#tools.get(id);
		if (!record) return;
		const text = resultText(partial);
		if (text) record.output = text;
		if (isRecord(partial) && partial.details !== undefined) record.details = partial.details;
		if (record.name === "computer") this.store.touch(computerTileId(record.agentId));
		if (this.store.get(`cmd:${id}`)) this.store.touch(`cmd:${id}`);
		if (this.store.get(`web:${id}`)) this.store.touch(`web:${id}`);
	}

	#toolEnd(id: string, result: unknown, isError: boolean): void {
		const record = this.#tools.get(id);
		if (!record) return;
		record.endedAt = this.#now();
		record.isError = isError;
		const text = resultText(result);
		if (text) record.output = text;
		if (isRecord(result)) record.details = result.details;
		if (this.store.get(`cmd:${id}`)) {
			const exitCode = exitCodeOf(record.details) ?? (isError ? 1 : 0);
			this.store.update(`cmd:${id}`, { state: isError ? "error" : "done", exitCode });
		}
		if (this.store.get(`web:${id}`)) this.store.update(`web:${id}`, { state: isError ? "error" : "done" });
		if (isEditCall(record.name) && !isError) this.#showDiff(record);
		if (record.name === "computer") this.#computerEnd(record, result, isError);
		if (record.agentId !== null) this.store.touch(`agent:${record.agentId}`);
		if (record.name === "bash" || isEditCall(record.name)) this.refreshGit();
	}

	/** One computer tile per calling agent; every call appends its caption to that tile's log. */
	#computerStart(agentId: string | null, callId: string, args: unknown): void {
		const tileId = computerTileId(agentId);
		let state = this.#computers.get(tileId);
		if (!state) {
			state = new ComputerTileState();
			this.#computers.set(tileId, state);
		}
		state.begin(callId, computerCaption(args), this.#now());
		if (this.store.get(tileId)) this.store.update(tileId, { state: "running" });
		else this.store.add({ id: tileId, kind: "computer", parentId: this.#parentTile(agentId), title: "computer" });
	}

	#computerEnd(record: ToolRecord, result: unknown, isError: boolean): void {
		const tileId = computerTileId(record.agentId);
		const state = this.#computers.get(tileId);
		if (!state) return;
		state.finish(record.id, { isError, shot: computerShotOf(result) });
		this.store.update(tileId, { state: state.busy ? "running" : isError ? "error" : "done" });
	}

	/** One diff tile per file, replaced by the latest edit so it re-enters with fresh timers. */
	#showDiff(record: ToolRecord): void {
		const path = editPathOf(record);
		if (!path || !diffTextOf(record.details)) return;
		const previous = this.#diffByPath.get(path);
		if (previous) this.store.remove(previous);
		const id = `diff:${record.id}`;
		this.#diffByPath.set(path, id);
		this.store.add({ id, kind: "diff", parentId: this.#parentTile(record.agentId), state: "done", title: path });
	}

	#setBusy(busy: boolean): void {
		for (const id of [W_EVENTS, W_GIT]) {
			if (this.store.get(id)) this.store.update(id, { state: busy ? "running" : "idle", activity: false });
		}
	}

	#pushEvent(event: StageEvent): void {
		this.#events.unshift(event);
		if (this.#events.length > EVENTS_MAX) this.#events.length = EVENTS_MAX;
	}

	/** Add a row to the events tail (Orchestra run milestones). */
	note(event: { agent: string; agentToken?: StageToken; glyph: StateGlyph; text: string }): void {
		this.#pushEvent({ at: this.#now(), ...event });
		this.#changed();
	}

	requestRender(): void {
		this.#ui.requestRender();
	}

	/** gk: follow `mcp:connection-status` on omp's event bus: a failed server opens an error tile. */
	watchMcp(bus: { on(channel: string, handler: (data: unknown) => void): () => void }): void {
		this.#unsubBus?.();
		this.#unsubBus = bus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, data => {
			if (this.#errors.observeMcp(data)) this.#changed();
		});
	}

	/** Open an error tile directly (failures the harness itself catches). Returns the tile id. */
	raiseError(input: StageErrorInput): string {
		const id = this.#errors.raise(input);
		this.#changed();
		return id;
	}

	/**
	 * gk: a command pane for a command the harness runs itself (`/ship`'s verify). Output streams in with
	 * `append`; `end` settles it with the exit code (non-zero is a failed command, never an error tile).
	 */
	commandPane(command: string): { append(text: string): void; end(exitCode: number): void } {
		const id = `gk-cmd-${++this.#commandSeq}`;
		this.#toolStart(null, id, "bash", { command }, undefined);
		this.#changed();
		return {
			append: text => {
				const record = this.#tools.get(id);
				if (!record) return;
				record.output += text;
				if (this.store.get(`cmd:${id}`)) this.store.touch(`cmd:${id}`);
				this.#streamRender();
			},
			end: exitCode => {
				const output = this.#tools.get(id)?.output ?? "";
				this.#toolEnd(id, { content: [{ type: "text", text: output }], details: { exitCode } }, exitCode !== 0);
				this.#changed();
			},
		};
	}

	/** gk: hand the Stage to Orchestra mode (orchestra preset, crew panes and widgets); `null` returns to Solo. */
	setOrchestra(orchestra: StageOrchestra | null): void {
		this.#orchestra = orchestra;
		this.#layoutKey = "";
		this.#changed();
	}

	#syncAgents(): void {
		const registry = this.#opts.registry;
		if (!registry) return;
		const refs = registry
			.list()
			.filter(ref => ref.kind === "sub")
			.sort((a, b) => a.createdAt - b.createdAt);
		for (const ref of refs) {
			const id = `agent:${ref.id}`;
			const state: TileState = ref.status === "running" ? "running" : ref.status === "aborted" ? "error" : "done";
			let info = this.#agents.get(ref.id);
			const isNew = !info;
			if (!info) {
				info = { ref };
				this.#agents.set(ref.id, info);
			}
			info.ref = ref;
			const previous = info.state;
			info.state = state;
			const nested = ref.parentId !== undefined && ref.parentId !== MAIN_AGENT_ID && this.#agents.has(ref.parentId);
			// A subagent of an Orchestra worker draws as an inset in the worker's pane, not a tile of its own.
			const inset = nested && this.#orchestra?.agentToken(ref.parentId!) !== undefined;
			if (nested) this.#feedOf(ref.parentId!).addAgent(ref.id, ref.createdAt);
			const parentId = nested && this.store.get(`agent:${ref.parentId}`) ? `agent:${ref.parentId}` : TRANSCRIPT_ID;
			const parentName = parentId === TRANSCRIPT_ID && !inset ? "main" : this.#agentName(ref.parentId ?? null);
			if (isNew) {
				this.#pushEvent({
					at: this.#now(),
					agent: parentName,
					agentToken: parentName === "main" ? "accent" : this.#agentTokenOf(ref.parentId ?? null),
					glyph: "spawn",
					text: `spawn ${ref.displayName}`,
				});
			} else if (state === "done" && previous === "running") {
				this.#pushEvent({
					at: this.#now(),
					agent: ref.displayName,
					agentToken: this.#agentTokenOf(ref.id),
					glyph: "done",
					text: `done → ${parentName}`,
				});
			}
			const existing = this.store.get(id);
			if (inset) {
				if (existing) this.store.remove(id);
			} else if (!existing) {
				this.store.add({ id, kind: "agent", parentId, state, title: ref.displayName });
			} else if (existing.state !== state || existing.title !== ref.displayName || existing.parentId !== parentId) {
				this.store.update(id, { state, title: ref.displayName, parentId });
			}
			this.#bindAgent(info);
		}
	}

	/**
	 * Follow an agent's live session. `AgentRegistry.attachSession` emits nothing, so this also runs on
	 * the tick; a session first seen mid-run replays its transcript into the feed.
	 */
	#bindAgent(info: AgentInfo): void {
		const session = info.ref.session;
		if (session === (info.session ?? null)) return;
		info.unsubscribe?.();
		info.unsubscribe = undefined;
		info.session = session ?? undefined;
		if (!session) return;
		const agentId = info.ref.id;
		this.#feedOf(agentId).backfill(session.messages, record => {
			const known = this.#tools.get(record.id);
			if (known) return known;
			record.agentId = agentId;
			this.#tools.set(record.id, record);
			return record;
		});
		info.unsubscribe = session.subscribe(event => this.handleEvent(agentId, event));
		this.#changed();
	}

	#refreshAgentStats(): void {
		for (const info of this.#agents.values()) {
			const session = info.ref.session;
			const metrics = info.ref.history?.metrics;
			if (session) {
				const stats = session.getSessionStats();
				info.stats = {
					model: modelLabel(session.model),
					tokens: stats.tokens.total,
					cost: stats.cost,
					ctx: stats.contextUsage ? { used: stats.contextUsage.tokens, limit: stats.contextUsage.contextWindow } : undefined,
				};
			} else if (metrics) {
				info.stats = {
					model: info.ref.history?.resolvedModel,
					tokens: metrics.tokens,
					cost: metrics.cost,
					ctx:
						metrics.contextTokens !== undefined && metrics.contextWindow
							? { used: metrics.contextTokens, limit: metrics.contextWindow }
							: undefined,
				};
			}
		}
	}

	#sample(): void {
		const session = this.#session;
		if (!session) return;
		const stats = session.getSessionStats();
		const ctx = session.getContextUsage?.();
		const bucketSec = (TICK_MS * SAMPLE_EVERY_TICKS) / 1000;
		const push = (series: number[], value: number) => {
			series.push(value);
			if (series.length > SERIES_MAX) series.shift();
		};
		push(this.#series.tok, this.#streamedChars / 4 / bucketSec);
		push(this.#series.ctx, ctx && ctx.contextWindow > 0 ? ctx.tokens / ctx.contextWindow : 0);
		push(this.#series.cost, Math.max(0, stats.cost - this.#lastCost) * (60 / bucketSec));
		this.#streamedChars = 0;
		this.#lastCost = stats.cost;
	}

	/** Re-read git (throttled; at most one run in flight, one queued). */
	refreshGit(): void {
		const loader = this.#opts.git === undefined ? loadGitSnapshot : this.#opts.git;
		if (!loader) return;
		if (this.#gitInFlight) {
			this.#gitQueued = true;
			return;
		}
		const wait = this.#gitLastAt + GIT_MIN_INTERVAL_MS - this.#now();
		if (wait > 0 && this.#gitLastAt > 0) {
			if (!this.#gitQueued) {
				this.#gitQueued = true;
				setTimeout(() => {
					this.#gitQueued = false;
					this.refreshGit();
				}, wait).unref?.();
			}
			return;
		}
		this.#gitInFlight = true;
		this.#gitLastAt = this.#now();
		void loader(this.#opts.cwd)
			.then(snapshot => this.applyGit(snapshot))
			.finally(() => {
				this.#gitInFlight = false;
				if (this.#gitQueued) {
					this.#gitQueued = false;
					this.refreshGit();
				}
			});
	}

	/** Install a git snapshot (public for tests). */
	applyGit(snapshot: GitSnapshot | null): void {
		const before = JSON.stringify(this.#git);
		this.#git = snapshot;
		if (!snapshot) {
			if (this.store.get(W_GIT)) this.store.remove(W_GIT);
		} else if (!this.store.get(W_GIT)) {
			this.store.add({ id: W_GIT, kind: "git", title: "git", state: this.#session?.isStreaming ? "running" : "idle" });
		} else if (JSON.stringify(snapshot) !== before) {
			this.store.touch(W_GIT);
		}
		this.#changed();
	}

	#changed(): void {
		this.#ui.requestRender();
	}

	// ── Tool lookup (live events first, transcript messages for resumed calls) ──

	toolRecord(id: string): ToolRecord | undefined {
		const live = this.#tools.get(id) ?? this.#pending.get(id);
		if (live) return live;
		const messages = this.#session?.messages ?? [];
		if (this.#messageIndex.count !== messages.length) this.#indexMessages(messages);
		return this.#messageIndex.calls.get(id);
	}

	#trackPending(agentId: string | null, content: readonly unknown[]): void {
		for (const part of content) {
			if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string" || this.#tools.has(part.id)) continue;
			const args = isRecord(part.arguments) ? part.arguments : {};
			const existing = this.#pending.get(part.id);
			if (existing) {
				existing.args = args;
				continue;
			}
			const record: ToolRecord = {
				id: part.id,
				name: typeof part.name === "string" ? part.name : "tool",
				args,
				agentId,
				startedAt: this.#now(),
				endedAt: null,
				isError: false,
				output: "",
				details: undefined,
			};
			this.#pending.set(part.id, record);
			if (agentId !== null) this.#feedOf(agentId).addTool(record);
		}
	}

	#indexMessages(messages: readonly AgentMessage[]): void {
		const calls = new Map<string, ToolRecord>();
		for (const message of messages) {
			if (message.role === "assistant") {
				const at = typeof message.timestamp === "number" ? message.timestamp : this.#now();
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					calls.set(part.id, {
						id: part.id,
						name: part.name,
						args: part.arguments,
						intent: part.intent,
						agentId: null,
						startedAt: at,
						endedAt: null,
						isError: false,
						output: "",
						details: undefined,
					});
				}
			} else if (message.role === "toolResult") {
				const call = calls.get(message.toolCallId);
				if (!call) continue;
				const at = typeof message.timestamp === "number" ? message.timestamp : call.startedAt;
				call.endedAt = Math.max(call.startedAt, at);
				call.isError = message.isError;
				call.output = resultText(message);
				call.details = message.details;
			}
		}
		this.#messageIndex = { count: messages.length, calls };
	}

	// ── Layout ─────────────────────────────────────────────────────────────

	#todoItems(): TodoItem[] {
		const phases = this.#opts.todos?.() ?? [];
		const items: TodoItem[] = [];
		for (const phase of phases) {
			for (const task of phase.tasks) {
				const state =
					task.status === "completed" || task.status === "abandoned"
						? "done"
						: task.status === "in_progress"
							? "current"
							: "pending";
				items.push({ text: task.content, state });
			}
		}
		return items;
	}

	#syncTodoTile(items: readonly TodoItem[]): void {
		const tile = this.store.get(W_TODO);
		if (items.length === 0) {
			if (tile) this.store.remove(W_TODO);
			return;
		}
		const state: TileState = items.some(i => i.state === "current") ? "running" : "idle";
		if (!tile) this.store.add({ id: W_TODO, kind: "todo", title: "todo", state });
		else if (tile.state !== state) this.store.update(W_TODO, { state, activity: false });
	}

	#preferredRows(todos: readonly TodoItem[]): Map<string, number> {
		const git = this.#git;
		const gitRows = git ? Math.min(git.graph.length, 3) + Math.min(git.files.length, 5) : 0;
		return new Map([
			[W_TELEMETRY, 6],
			[W_TODO, Math.min(todos.length, 8) + 2],
			[W_GIT, Math.max(1, gitRows) + 2],
		]);
	}

	layoutFor(cols: number, rows: number): StageLayout {
		const now = this.#now();
		const todos = this.#todoItems();
		this.#syncTodoTile(todos);
		const tiles = toLayoutTiles(this.store, now, this.#preferredRows(todos));
		if (this.#zoomedId && !this.store.get(this.#zoomedId)) this.#setZoom(null);
		const input = {
			cols,
			rows,
			preset: this.#orchestra ? ("orchestra" as const) : ("calm" as const),
			tiles,
			zoomedId: this.#zoomedId,
			headerRows: cols >= FULL_LOGO_MIN_COLS ? 3 : 2,
			tabRows: 1,
			footerRows: 2,
			previous: this.#layout,
		};
		const target = layoutStage(input);
		const key = `${cols}x${rows}|${this.#zoomedId ?? ""}|${[...target.tiles.keys()].sort().join(",")}`;
		if (key !== this.#layoutKey) {
			const weights = new Map(tiles.map(t => [t.id, t.weight]));
			const resized = !this.#layout || this.#layout.cols !== cols || this.#layout.rows !== rows;
			if (resized || this.#zoomedId !== null) this.#tween.set(weights, target.railFraction);
			else this.#tween.start(weights, target.railFraction);
			this.#layoutKey = key;
		}
		this.#layout = target;
		if (!this.#tween.active) return target;
		const sample = this.#tween.sample();
		this.#scheduleFrame();
		return layoutStage({
			...input,
			tiles: tiles.map(t => ({ ...t, weight: sample.weights.get(t.id) ?? t.weight })),
			railFraction: sample.railFraction,
			suspendDemotion: true,
			previous: null,
		});
	}

	#scheduleFrame(): void {
		if (this.#frameTimer) return;
		this.#frameTimer = setTimeout(() => {
			this.#frameTimer = undefined;
			this.#ui.requestRender();
		}, FRAME_MS);
		this.#frameTimer.unref?.();
	}

	// ── Compositing ───────────────────────────────────────────────────────

	/** Compose the whole screen: exactly `rows` rows of exactly `cols` columns. */
	render(cols: number, rows: number): string[] {
		if (cols <= 0 || rows <= 0) return [];
		const now = this.#now();
		const layout = this.layoutFor(cols, rows);
		if (this.#motion && this.#errors.animating(now)) this.#scheduleFrame();
		const buf = new CellBuffer(cols, rows, this.#baseSgr());
		this.#drawHeader(buf, layout.header, now);
		this.#band(buf, layout.tabBar, this.#tabs(layout.tabBar.w), "panelBg");

		const index = new Map<string, number>();
		let pane = 0;
		for (const id of layout.order) {
			const tile = this.store.get(id);
			if (!tile || tile.kind === "telemetry" || tile.kind === "todo" || tile.kind === "git" || tile.kind === "events") continue;
			index.set(id, pane++);
		}
		let cursor: { row: number; col: number } | null = null;
		for (const id of layout.order) {
			const rect = layout.tiles.get(id);
			const tile = this.store.get(id);
			if (!rect || !tile) continue;
			const at = this.#drawTile(buf, tile, rect, index.get(id), layout, index, now);
			cursor ??= at;
		}
		if (layout.chipStrip) this.#band(buf, layout.chipStrip, [this.#chips(layout, cols)], null);
		// Status row on the lifted surface, key hints on the pane background (reference 212×58).
		const footer = this.#footer(cols, now);
		const { footer: f } = layout;
		this.#band(buf, { ...f, h: Math.min(1, f.h) }, footer, "surfaceBg");
		if (f.h > 1) this.#band(buf, { ...f, y: f.y + 1, h: f.h - 1 }, footer.slice(1), null);

		const lines = buf.toLines();
		if (cursor && cursor.row >= 0 && cursor.row < lines.length) {
			const line = lines[cursor.row]!;
			lines[cursor.row] = `${sliceByColumn(line, 0, cursor.col)}${CURSOR_MARKER}${sliceByColumn(line, cursor.col, cols - cursor.col)}`;
		}
		return lines;
	}

	/** Opener of the style's `paneBg` (empty for unstyled renders): every cell's fallback background. */
	#baseSgr(): string {
		const probe = this.#style("paneBg", " ");
		return probe.slice(0, probe.indexOf(" "));
	}

	/** Blit full-width rows into a band, optionally on a background token (else the pane background). */
	#band(buf: CellBuffer, rect: Rect, rows: readonly string[], bg: HostToken | null): void {
		if (rect.h <= 0) return;
		const s = this.#style;
		const out = [];
		for (let r = 0; r < rect.h; r++) {
			const row = truncateToWidth(rows[r] ?? "", rect.w, undefined, true);
			out.push(bg ? s(bg, row) : row);
		}
		buf.blit(out, rect);
	}

	/** {@link fullPixelLogo} (3 rows) or {@link pixelLogo} (2 rows) in the theme's gold, cached per theme. */
	#pixelLogo(full: boolean): string[] {
		const themeName = getCurrentThemeName() ?? "";
		const key = `${themeName}|${full ? "full" : "compact"}`;
		if (this.#logo?.key === key) return this.#logo.rows;
		const palette = gkPaletteFor(themeName);
		const colors = palette ? { face: palette.accent, shadow: palette.pixelShadow } : undefined;
		const rows = full ? fullPixelLogo(this.#style, colors) : pixelLogo(this.#style, colors);
		this.#logo = { key, rows };
		return rows;
	}

	/** One-row wordmark for headers narrower than {@link PIXEL_LOGO_MIN_COLS}: bold gold, letter-spaced when asked. */
	#textLogo(spaced: boolean): string {
		const s = this.#style;
		const word = spaced ? [...LOGO_TEXT].join(" ") : LOGO_TEXT;
		return `${s("accent", "</>")}  ${s("accent", bold(word))}`;
	}

	/** Header fields without a logo. Reads cached state only (`#todayLabel`, `#git`); never waits on I/O. */
	#headerData(now: number): HeaderData {
		const session = this.#session;
		const stats = session?.getSessionStats();
		const ctx = session?.getContextUsage?.();
		const tokens = stats?.tokens;
		const cacheBase = tokens ? tokens.input + tokens.cacheRead : 0;
		const date = new Date(now);
		const day = date.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
		const month = date.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
		const up = Math.floor((now - this.#startedAt) / 1000);
		const home = os.homedir();
		const cwd = this.#opts.cwd.startsWith(home) ? `~${this.#opts.cwd.slice(home.length)}` : this.#opts.cwd;
		const git = this.#git;
		return {
			logo: [],
			session: `gk-${this.#opts.sessionId().replace(/[^0-9a-z]/gi, "").slice(0, 6).toLowerCase()}`,
			mode: "SOLO",
			host: `${os.hostname().replace(/\.local$/, "")} · ${process.arch}`,
			cwd,
			branch: git ? formatBranch(git.branch, git.ahead, git.changed + git.untracked) : "–",
			uptime: `${pad2(Math.floor(up / 3600))}:${pad2(Math.floor((up % 3600) / 60))}:${pad2(up % 60)}`,
			cost: {
				label: "SESSION",
				spent: money(stats?.cost ?? 0),
				usage: `${compact(tokens?.total ?? 0)} tok · ${stats?.toolCalls ?? 0} call${stats?.toolCalls === 1 ? "" : "s"}`,
			},
			...this.#orchestra?.header(),
			today: this.#todayLabel ?? "–",
			todayWarning: this.#todayNotice !== undefined,
			notice: this.#todayNotice,
			ctx: {
				used: ctx?.tokens ?? 0,
				limit: ctx?.contextWindow ?? 0,
				label: ctx ? `${compact(ctx.tokens)}/${compact(ctx.contextWindow)}` : "–",
			},
			cache: cacheBase > 0 ? `${Math.round(((tokens?.cacheRead ?? 0) / cacheBase) * 100)}% hit` : undefined,
			clock: clockTime(now),
			date: `${day} ${date.getDate()} ${month}`,
		};
	}

	/**
	 * Re-read today's spend in the background (mount, every 30 s, main-agent turn end). The header shows the
	 * last value; reaching `gk.budget.dailyUsd` turns TODAY warning-coloured and posts the notice once a day.
	 */
	#refreshToday(): void {
		const source =
			this.#opts.todaySpend === undefined
				? { usd: getTodaySpendUsd, budgetUsd: () => cfgGkBudgetDailyUsd.get(settings) }
				: this.#opts.todaySpend;
		if (!source) return;
		source
			.usd()
			.then(usd => {
				const limit = source.budgetUsd();
				const notice = budgetNotice(usd, limit);
				this.#todayLabel = notice && limit ? `! ${money(usd)} / ${money(limit)}` : money(usd);
				this.#todayNotice = notice;
				const day = localDay(new Date(this.#now()));
				if (notice && this.#budgetNoticeDay !== day) {
					this.#budgetNoticeDay = day;
					this.#pushEvent({
						at: this.#now(),
						agent: "budget",
						agentToken: "warning",
						glyph: "warning",
						text: notice,
					});
				}
				this.#changed();
			})
			.catch(error => logger.warn("gk stage: today's spend unavailable", { error: String(error) }));
	}

	#drawHeader(buf: CellBuffer, rect: Rect, now: number): void {
		if (rect.h <= 0) return;
		this.#band(buf, rect, [], null);
		const data = this.#headerData(now);
		const fieldRows = rect.h >= 3 && rect.w >= FULL_LOGO_MIN_COLS ? 3 : 2;
		if (fieldRows === 3 || rect.w >= PIXEL_LOGO_MIN_COLS) {
			data.logo = this.#pixelLogo(fieldRows === 3);
		} else {
			// Letter-spaced wordmark only while it leaves room for every field.
			const spaced = [this.#textLogo(true), ""];
			data.logo = headerWidth({ ...data, logo: spaced }) <= rect.w ? spaced : [this.#textLogo(false), ""];
		}
		const rows = renderHeader(data, rect.w, fieldRows, this.#style, fieldRows);
		buf.blit(rows, { x: rect.x, y: rect.y, w: rect.w, h: fieldRows });
	}

	#tabs(width: number): string[] {
		const groups: TabSummaryItem[][] = [];
		const busy = this.#session?.isStreaming === true;
		if (this.#narration) {
			groups.push([{ glyph: busy ? "thinking" : undefined, text: this.#narration, token: busy ? "muted" : "dim" }]);
		}
		const running = this.store.all().filter(t => t.state === "running");
		const commands = running.filter(t => t.kind === "command").length;
		const agents = running.filter(t => t.kind === "agent").length;
		const counts: TabSummaryItem[] = [];
		if (commands > 0) counts.push({ glyph: "running", text: `${commands} command${commands === 1 ? "" : "s"} running` });
		if (agents > 0) counts.push({ glyph: "running", text: `${agents} agent${agents === 1 ? "" : "s"} running` });
		if (counts.length > 0) groups.push(counts);
		const todos = this.#todoItems();
		if (todos.length > 0) {
			groups.push([{ text: `todo ${todos.filter(t => t.state === "done").length}/${todos.length}` }]);
		}
		if (this.#orchestra) return renderTabs(this.#orchestra.tabs(), width, 1, this.#style);
		return renderTabs({ tabs: [{ index: 0, name: "session", active: true }], summary: groups }, width, 1, this.#style);
	}

	#footer(cols: number, now: number): string[] {
		const session = this.#session;
		const stats = session?.getSessionStats();
		const ctx = session?.getContextUsage?.();
		const date = new Date(now);
		const month = date.toLocaleDateString("en-US", { month: "short" });
		const role = [session?.thinkingLevel, ctx && ctx.contextWindow > 0 ? `ctx ${Math.round((ctx.tokens / ctx.contextWindow) * 100)}%` : ""]
			.filter(Boolean)
			.join(" · ");
		return renderStatusBar(
			{
				window: "0:session",
				...this.#orchestra?.footer(),
				branch: this.#git ? branchLabel(this.#git) : undefined,
				model: modelLabel(session?.model),
				role: role || undefined,
				cost: money(stats?.cost ?? 0),
				clock: `${pad2(date.getHours())}:${pad2(date.getMinutes())} ${pad2(date.getDate())}-${month}-${String(date.getFullYear()).slice(2)}`,
				hints: [
					{ key: "⏎", label: "zoom pane" },
					{ key: "esc", label: "back" },
					{ key: "^O", label: "expand" },
					{ key: "M-a", label: "agent hub" },
					{ key: "/btw", label: "side question" },
				],
				version: formatGkVersion(),
			},
			cols,
			2,
			this.#style,
		);
	}

	#chips(layout: StageLayout, cols: number): string {
		const s = this.#style;
		const parts: string[] = [];
		for (const id of layout.chips) {
			const tile = this.store.get(id);
			if (!tile) continue;
			const failed = tile.state === "error" || (tile.exitCode !== null && tile.exitCode !== 0);
			const g = tile.state === "running" ? glyph("running", s) : failed ? glyph("failed", s) : glyph("done", s);
			const dur = tile.endedAt !== null ? ` ${formatDuration(tile.endedAt - tile.createdAt)}` : "";
			const label = tile.kind === "agent" ? this.store.lineageTitle(id) : tile.kind === "diff" ? `diff ${tile.title}` : tile.title;
			parts.push(`${g} ${s("muted", label)}${s("dim", dur)}`);
		}
		const sep = s("dim", " · ");
		let line = " ";
		for (let i = 0; i < parts.length; i++) {
			const more = parts.length - i - 1;
			const next = `${i === 0 ? "" : sep}${parts[i]}`;
			const tail = more > 0 ? s("dim", ` +${more}`) : "";
			if (visibleWidth(line + next) + visibleWidth(tail) > cols - 1) {
				line += s("dim", ` +${parts.length - i}`);
				break;
			}
			line += next;
		}
		return line;
	}

	/** Pane 0.0 statusline (on `badgeBg`) and mode line, replacing omp's status bar inside the pane. */
	#transcriptStatus(width: number): string[] {
		const s = this.#style;
		const session = this.#session;
		const stats = session?.getSessionStats();
		const ctx = session?.getContextUsage?.();
		const git = this.#git;
		const [status, mode] = renderPaneStatus(
			{
				branch: git?.branch,
				dirty: git ? git.changed + git.untracked > 0 : false,
				model: modelLabel(session?.model),
				effort: session?.thinkingLevel,
				tokens: `${compact(stats?.tokens.total ?? 0)} tok`,
				cost: money(stats?.cost ?? 0),
				ctx: ctx ? { used: ctx.tokens, limit: ctx.contextWindow } : undefined,
				modeLine: { mode: "INSERT", tools: stats?.toolCalls ?? 0, editedFiles: this.#diffByPath.size },
			},
			Math.max(0, width - 2),
			2,
			s,
		);
		return [s("badgeBg", ` ${status} `), ` ${mode}`];
	}

	/** Square light frame (v2 §2); focused panes draw it in `borderAccent`. Returns the inner rect. */
	#frame(buf: CellBuffer, rect: Rect, title: string, badge: string, token: StageToken): Rect {
		const s = this.#style;
		const { x, y, w, h } = rect;
		if (w < 2 || h < 2) return { x, y, w: 0, h: 0 };
		const inner = w - 2;
		const b = (t: string) => s(token, t);
		let t = title ? ` ${title} ` : "";
		let bd = badge ? ` ${badge} ` : "";
		if (visibleWidth(t) + visibleWidth(bd) + 2 > inner) bd = "";
		if (visibleWidth(t) + 1 > inner) t = inner > 3 ? truncateToWidth(t, inner - 1) : "";
		const fill = inner - 1 - visibleWidth(t) - (bd ? visibleWidth(bd) + 1 : 0);
		const top = `${b("┌─")}${t}${b("─".repeat(Math.max(0, fill)))}${bd}${bd ? b("─") : ""}${b("┐")}`;
		buf.blit([top], { x, y, w, h: 1 });
		const side = b("│");
		for (let r = 1; r < h - 1; r++) {
			buf.blit([side], { x, y: y + r, w: 1, h: 1 });
			buf.blit([side], { x: x + w - 1, y: y + r, w: 1, h: 1 });
		}
		buf.blit([b(`└${"─".repeat(inner)}┘`)], { x, y: y + h - 1, w, h: 1 });
		return { x: x + 1, y: y + 1, w: inner, h: h - 2 };
	}

	#paneTitle(index: number | undefined, name: string, detail: string, focused: boolean): string {
		const s = this.#style;
		const label = index === undefined ? "" : `${s(focused ? "accent" : "text", `\x1b[1m0.${index}\x1b[22m`)} `;
		return `${label}${s(focused ? "accent" : "text", name)}${detail ? s("muted", ` · ${detail}`) : ""}`;
	}

	/**
	 * Agent pane body: feed rows tail-anchored (a zoomed pane scrolls with PgUp/PgDn), omp's composer under
	 * them while the pane steers its agent, the statusline last. Returns the editor's cursor.
	 */
	#drawAgentBody(
		buf: CellBuffer,
		inner: Rect,
		rows: readonly string[],
		status: readonly string[],
		zoomed: boolean,
		steer: boolean,
	): { row: number; col: number } | null {
		const room = Math.max(0, inner.h - status.length);
		const composed = steer ? composerRows(this.#opts.chrome(), undefined, inner.w, Math.max(0, room - 1)) : null;
		const chromeH = composed?.rows.length ?? 0;
		const bodyH = Math.max(0, room - chromeH);
		const maxScroll = Math.max(0, rows.length - bodyH);
		let scroll = 0;
		if (zoomed) {
			this.#zoomMaxScroll = maxScroll;
			this.#zoomPage = Math.max(1, bodyH - 2);
			scroll = Math.min(this.#zoomScroll, maxScroll);
		}
		const end = rows.length - scroll;
		buf.blit(rows.slice(Math.max(0, end - bodyH), end), { ...inner, h: bodyH });
		if (composed) buf.blit(composed.rows, { ...inner, y: inner.y + bodyH, h: chromeH });
		if (status.length > 0) buf.blit(status, { ...inner, y: inner.y + inner.h - status.length, h: status.length });
		return composed?.cursor ? { row: inner.y + bodyH + composed.cursor.row, col: inner.x + composed.cursor.col } : null;
	}

	/** Inset of a nested subagent in its parent's pane; `undefined` when it has a tile of its own. */
	#nestedView(agentId: string, now: number): NestedView | undefined {
		const info = this.#agents.get(agentId);
		if (!info || this.store.get(`agent:${agentId}`)) return undefined;
		const { ref, stats } = info;
		const running = info.state === "running";
		const end = running ? now : (ref.lifecycle?.terminalAt ?? ref.lastActivity);
		const cost = stats?.cost;
		return {
			label: `${this.#agentName(ref.parentId ?? null)} › ${ref.displayName}`,
			token: this.#agentTokenOf(ref.parentId ?? null),
			model: stats?.model,
			glyph: running ? "running" : info.state === "error" ? "failed" : "done",
			metric: [formatElapsed(end - ref.createdAt), cost ? `$${cost.toFixed(cost < 0.1 ? 3 : 2)}` : ""]
				.filter(Boolean)
				.join(" · "),
			entries: this.#feeds.get(agentId)?.entries ?? [],
		};
	}

	#drawTile(
		buf: CellBuffer,
		tile: Tile,
		rect: Rect,
		index: number | undefined,
		layout: StageLayout,
		panes: ReadonlyMap<string, number>,
		now: number,
	): { row: number; col: number } | null {
		const s = this.#style;
		const anyFocused = this.store.focused() !== undefined;
		const focused = tile.focused || (tile.kind === "transcript" && !anyFocused);
		const border: StageToken = tile.state === "error" && tile.kind !== "command" ? "error" : focused ? "borderAccent" : "border";
		const paneOf = (id: string) => {
			const n = panes.get(`cmd:${id}`) ?? panes.get(`web:${id}`);
			return n === undefined || (!layout.tiles.has(`cmd:${id}`) && !layout.tiles.has(`web:${id}`)) ? undefined : `0.${n}`;
		};
		if (this.#orchestra && (tile.kind === "proc" || tile.kind === "dag" || tile.kind === "telemetry")) {
			const widget = this.#orchestra.widget(tile, Math.max(0, rect.w - 2), Math.max(0, rect.h - 2), now, s);
			if (widget) {
				const inner = this.#frame(buf, rect, this.#paneTitle(undefined, widget.title, "", false), widget.badge, "border");
				buf.blit(widget.rows, inner);
				return null;
			}
		}
		switch (tile.kind) {
			case "transcript": {
				const session = this.#session;
				const orchestraFrame = this.#orchestra?.transcriptFrame(s);
				const title = orchestraFrame
					? this.#paneTitle(index, orchestraFrame.title, "", focused)
					: this.#paneTitle(index, "session", modelLabel(session?.model), focused);
				const inner = this.#frame(buf, rect, title, s("badgeBg", s("accent", " @main ")), border);
				const out = renderTranscriptPane(
					{
						blocks: this.#opts.blocks(),
						chrome: this.#opts.chrome(),
						status: this.#transcriptStatus(inner.w),
						tool: id => this.toolRecord(id),
						toolRows: this.#orchestra
							? (record, width) => this.#orchestra?.toolRows(record, width, now, s)
							: undefined,
						toolBody: (record, width) =>
							toolBodyRows(record, width, { now, style: s, highlight: this.#highlight, paneOf }),
						isAssistant: this.#opts.isAssistant,
						expandTools: this.#opts.expandTools?.() ?? false,
						scroll: this.#scroll,
						lineContext: { now, paneOf },
						seenAt: c => {
							let at = this.#seen.get(c);
							if (at === undefined) {
								at = now;
								this.#seen.set(c, at);
							}
							return at;
						},
						style: s,
					},
					inner.w,
					inner.h,
				);
				this.#maxScroll = out.maxScroll;
				buf.blit(out.rows, inner);
				return out.cursor ? { row: inner.y + out.cursor.row, col: inner.x + out.cursor.col } : null;
			}
			case "command": {
				const id = tile.id.slice(4);
				const record = this.#tools.get(id);
				const running = tile.state === "running";
				const code = tile.exitCode ?? 0;
				const elapsed = (tile.endedAt ?? now) - tile.createdAt;
				const badge = running
					? `${s("accent", "●")} ${s("muted", formatElapsed(elapsed))}`
					: `${s(code === 0 ? "success" : "error", `exit ${code}`)} ${s("muted", `· ${formatDuration(elapsed)}`)}`;
				const inner = this.#frame(buf, rect, this.#paneTitle(index, tile.title, "", focused), badge, border);
				const lines = (record?.output ?? "").replace(/\n+$/, "").split("\n").map(stripControl);
				const shown = lines.slice(Math.max(0, lines.length - inner.h)).map(l => s("text", l));
				buf.blit(shown, inner);
				return null;
			}
			case "web": {
				const id = tile.id.slice(4);
				const record = this.#tools.get(id);
				const running = tile.state === "running";
				const elapsed = (tile.endedAt ?? now) - tile.createdAt;
				const badge = running ? `${s("accent", "●")} ${s("muted", formatElapsed(elapsed))}` : s("muted", formatDuration(elapsed));
				const inner = this.#frame(buf, rect, this.#paneTitle(index, tile.title, "", focused), badge, border);
				const preview = (record?.output ?? "")
					.split("\n")
					.map(stripControl)
					.filter(l => l.trim() !== "")
					.slice(0, Math.max(0, inner.h - 1))
					.map(l => s("muted", l));
				const head = running ? `${glyph("running", s)} ${s("muted", "fetching")}` : `${glyph(tile.state === "error" ? "failed" : "done", s)} ${s("muted", "result")}`;
				buf.blit([head, ...preview], inner);
				return null;
			}
			case "diff": {
				const record = this.#tools.get(tile.id.slice(5));
				const diff = diffTextOf(record?.details);
				const hunk = latestHunk(diff);
				const stat = diffStat(diff);
				const badgeParts = [
					stat.add ? s("success", `+${stat.add}`) : "",
					stat.del ? s("error", `−${stat.del}`) : "",
					hunk ? s("muted", `· hunk ${hunk.index}/${hunk.count}`) : "",
				].filter(Boolean);
				const inner = this.#frame(buf, rect, this.#paneTitle(index, "diff", tile.title, focused), badgeParts.join(" "), border);
				buf.blit(hunk ? diffRows(hunk.block, inner.w, s) : [], inner);
				return null;
			}
			case "agent": {
				const agentId = tile.id.slice(6);
				const info = this.#agents.get(agentId);
				const zoomed = this.#zoomedId === tile.id;
				const width = Math.max(0, rect.w - 2);
				const body = (w: number) =>
					feedRows(this.#feeds.get(agentId)?.entries ?? [], w, {
						now,
						style: s,
						limit: zoomed ? undefined : rect.h,
						expanded: zoomed,
						highlight: this.#highlight,
						paneOf,
						nested: child => this.#nestedView(child, now),
					});
				const view = this.#orchestra?.agentPane({ agentId, tile, body, stats: info?.stats, now, width, style: s });
				let inner: Rect;
				let rows: string[];
				let status: string[];
				if (view) {
					// gk: Orchestra worker pane (title, @name badge, body, statusline from the crew adapter).
					inner = this.#frame(buf, rect, this.#paneTitle(index, view.title, "", focused), view.badge, border);
					rows = view.rows;
					status = view.status ? renderPaneStatus(view.status, inner.w, 1, s) : [];
				} else {
					const lineage = this.store.lineageTitle(tile.id);
					const elapsed = (tile.endedAt ?? now) - tile.createdAt;
					const badge =
						tile.state === "running"
							? `${s("accent", "●")} ${s("muted", formatElapsed(elapsed))}`
							: `${glyph(tile.state === "error" ? "failed" : "done", s)} ${s("muted", formatElapsed(elapsed))}`;
					const stats = info?.stats;
					inner = this.#frame(buf, rect, this.#paneTitle(index, lineage, stats?.model ?? "", focused), badge, border);
					rows = body(inner.w);
					if (rows.length === 0 && info?.ref.activity) rows = [s("muted", info.ref.activity)];
					status = renderPaneStatus(
						{
							agent: info?.ref.displayName,
							agentToken: this.#agentTokenOf(agentId),
							model: stats?.model,
							tokens: stats?.tokens !== undefined ? compact(stats.tokens) : undefined,
							cost: stats?.cost !== undefined ? money(stats.cost) : undefined,
							ctx: stats?.ctx,
						},
						inner.w,
						1,
						s,
					);
				}
				return this.#drawAgentBody(buf, inner, rows, inner.h >= 2 ? status : [], zoomed, this.#steering === agentId);
			}
			case "telemetry": {
				const stats = this.#session?.getSessionStats();
				const ctx = this.#session?.getContextUsage?.();
				const inner = this.#frame(buf, rect, this.#paneTitle(undefined, "telemetry", "60s", false), s("muted", modelLabel(this.#session?.model)), "border");
				const last = (xs: number[]) => xs[xs.length - 1] ?? 0;
				const pct = ctx && ctx.contextWindow > 0 ? ctx.tokens / ctx.contextWindow : 0;
				buf.blit(
					renderTelemetry(
						{
							tokPerSec: { values: this.#series.tok, current: String(Math.round(last(this.#series.tok))) },
							ctx: { values: this.#series.ctx, current: `${Math.round(pct * 100)}%`, max: 1 },
							costPerMin: { values: this.#series.cost, current: last(this.#series.cost).toFixed(2).replace(/^0/, "") },
							io: {
								in: compact(stats?.tokens.input ?? 0),
								out: compact(stats?.tokens.output ?? 0),
								cached: compact(stats?.tokens.cacheRead ?? 0),
							},
						},
						inner.w,
						inner.h,
						s,
					),
					inner,
				);
				return null;
			}
			case "todo": {
				const items = this.#todoItems();
				const done = items.filter(i => i.state === "done").length;
				const inner = this.#frame(buf, rect, this.#paneTitle(undefined, "todo", "", false), s("muted", `${done}/${items.length}`), "border");
				buf.blit(renderTodo({ items }, inner.w, inner.h, s), inner);
				return null;
			}
			case "git": {
				const git = this.#git;
				const add = git?.files.reduce((n, f) => n + f.add, 0) ?? 0;
				const del = git?.files.reduce((n, f) => n + f.del, 0) ?? 0;
				const badge = [add ? s("success", `+${add}`) : "", del ? s("error", `−${del}`) : ""].filter(Boolean).join(" ");
				const inner = this.#frame(buf, rect, this.#paneTitle(undefined, "git", git?.branch ?? "", false), badge, "border");
				if (git) {
					const graph = git.graph.slice(0, 3);
					buf.blit(renderGit({ graph, files: git.files.slice(0, Math.max(0, inner.h - graph.length)) }, inner.w, inner.h, s), inner);
				}
				return null;
			}
			case "events": {
				const inner = this.#frame(buf, rect, this.#paneTitle(undefined, "events", "", false), s("muted", "tail -f"), "border");
				const rows = this.#events.slice(0, inner.h).map(e => {
					const record = e.toolId ? this.#tools.get(e.toolId) : undefined;
					const g: StateGlyph = record ? toolEvent(record, { now }).glyph : e.glyph;
					return { time: clockTime(e.at), glyph: g, agent: e.agent, agentToken: e.agentToken, text: e.text };
				});
				buf.blit(renderEvents({ rows }, inner.w, inner.h, s), inner);
				return null;
			}
			case "error": {
				const ago = formatElapsed(now - tile.createdAt);
				const badge = `${glyph("failed", s)} ${s("muted", ago)}`;
				const inner = this.#frame(buf, rect, this.#paneTitle(index, "error", tile.title, focused), badge, "error");
				buf.blit(this.#errors.rows(tile.id, inner.w, inner.h, now, this.#motion, s), inner);
				return null;
			}
			case "computer": {
				const state = this.#computers.get(tile.id);
				const running = tile.state === "running";
				const elapsed = (tile.endedAt ?? now) - tile.createdAt;
				const badge = running
					? `${s("accent", "●")} ${s("muted", formatElapsed(elapsed))}`
					: s("muted", formatDuration(elapsed));
				const inner = this.#frame(buf, rect, this.#paneTitle(index, tile.title, "", focused), badge, border);
				if (state) {
					const graphics = this.#computerGraphics();
					const rows = renderComputerBody(state, inner.w, inner.h, {
						graphics,
						style: s,
						requestRender: () => this.#ui.requestRender(),
					});
					buf.blit(rows, inner);
				}
				return null;
			}
			default: {
				this.#frame(buf, rect, this.#paneTitle(index, tile.title, tile.kind, focused), "", border);
				return null;
			}
		}
	}

	// ── Input: click focus, Enter zoom, Esc back, wheel scroll ────────────

	#tileAt(col: number, row: number): string | undefined {
		const layout = this.#layout;
		if (!layout) return undefined;
		for (const [id, r] of layout.tiles) {
			if (col >= r.x && col < r.x + r.w && row >= r.y && row < r.y + r.h) return id;
		}
		return undefined;
	}

	#onMouse(event: SgrMouseEvent): void {
		const id = this.#tileAt(event.col, event.row);
		if (event.wheel !== null) {
			if (this.#zoomedId && id === this.#zoomedId && this.store.get(id)?.kind === "agent") {
				this.#zoomScroll = Math.max(0, Math.min(this.#zoomMaxScroll, this.#zoomScroll - event.wheel * WHEEL_ROWS));
				this.#changed();
			} else if (id === TRANSCRIPT_ID || id === undefined) {
				this.#scroll = Math.max(0, Math.min(this.#maxScroll, this.#scroll - event.wheel * WHEEL_ROWS));
				this.#changed();
			}
			return;
		}
		if (!event.leftClick) return;
		const chip = this.#layout?.chipStrip;
		if (chip && event.row >= chip.y && event.row < chip.y + chip.h && this.#layout?.chips[0]) {
			const chips = this.#layout.chips;
			const slot = Math.min(chips.length - 1, Math.floor((event.col / Math.max(1, chip.w)) * chips.length));
			this.store.restore(chips[slot]!);
			this.store.focus(chips[slot]!);
			this.#changed();
			return;
		}
		if (id === undefined) return;
		const tile = this.store.get(id);
		// A second click on a focused agent pane zooms it.
		if (tile?.kind === "agent" && tile.focused && this.#zoomedId !== id) {
			this.zoom(id);
			return;
		}
		this.store.focus(id === TRANSCRIPT_ID ? null : id);
		this.#changed();
	}

	#onInput(data: string): InputResult {
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (!event) return undefined;
			if (this.#ui.hasOverlay()) return undefined;
			this.#onMouse(event);
			return { consume: true };
		}
		if (this.#ui.hasOverlay()) return undefined;
		const focused = this.store.focused();
		// A focused error tile answers its own keys (l/m/r/c, d details, x dismiss) while the composer is empty, so a
		// prompt being typed never loses letters to it; anything else types on.
		const composing = this.#opts.composerEmpty?.() === false;
		if (focused?.kind === "error" && !composing && this.#errors.key(focused.id, data)) {
			this.#changed();
			return { consume: true };
		}
		if (!this.#zoomedId && !focused) return undefined;
		const zoomedAgent = this.#zoomedId !== null && this.store.get(this.#zoomedId)?.kind === "agent";
		if (zoomedAgent && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
			const step = matchesKey(data, "pageUp") ? this.#zoomPage : -this.#zoomPage;
			this.#zoomScroll = Math.max(0, Math.min(this.#zoomMaxScroll, this.#zoomScroll + step));
			this.#changed();
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			// While a zoomed pane steers its agent, Enter submits the composer to that agent.
			if (zoomedAgent && this.#steering) return undefined;
			if (focused) {
				this.zoom(this.#zoomedId === focused.id ? null : focused.id);
				return { consume: true };
			}
			return undefined;
		}
		if (matchesKey(data, "escape")) {
			if (this.#zoomedId) this.zoom(null);
			else {
				this.store.focus(null);
				this.#changed();
			}
			return { consume: true };
		}
		return undefined;
	}

	/** Zoom a tile full-body (`null` returns to the tiling). */
	zoom(id: string | null): void {
		this.#setZoom(id);
		this.#changed();
	}

	/** Zooming an agent pane with a live session points omp's input at it, so typing steers that agent. */
	#setZoom(id: string | null): void {
		this.#zoomedId = id;
		this.#zoomScroll = 0;
		const agentId = id?.startsWith("agent:") ? id.slice(6) : null;
		const steer = agentId !== null && this.#opts.focusAgent && this.#agents.get(agentId)?.ref.session ? agentId : null;
		if (steer === this.#steering) return;
		this.#steering = steer;
		this.#opts.focusAgent?.(steer);
	}
}
