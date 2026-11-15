/**
 * What the Stage host asks of Orchestra mode while a crew is on stage. The host stays mode-agnostic:
 * with no hook installed it draws Solo; with one it switches to the orchestra preset and lets the hook
 * title panes, draw worker bodies, fill the proc/throughput/dag widgets and the run chrome.
 * Implemented by `gk/orchestra/stage-adapter.ts`.
 */
import type { Tile } from "./tiles";
import type { ToolRecord } from "./tool-lines";
import type { HeaderData } from "./widgets/header";
import type { PaneStatusData } from "./widgets/pane-status";
import type { StageStyle, StageToken } from "./widgets/common";
import type { TabsData } from "./widgets/tabs";
import type { StatusBarData } from "./widgets/statusbar";

export interface StagePaneFrame {
	/** Title after the `0.N` pane index, e.g. `W-01 · hello.txt`. */
	title: string;
	/** Right side of the top border, already styled (e.g. the `@name` badge). */
	badge: string;
}

export interface StageAgentPane extends StagePaneFrame {
	/** Body rows (without the statusline), oldest first; the host shows the tail that fits. */
	rows: string[];
	/** Per-pane statusline; omitted = no statusline row. */
	status?: PaneStatusData;
}

export interface StageAgentInput {
	/** Registry agent id, or `crew-<itemId>` for an item that has no worker yet. */
	agentId: string;
	tile: Tile;
	/** The agent's live feed (thinking, text, streaming tool calls, nested insets) at `width`, oldest first. */
	body: (width: number) => string[];
	/** Live session stats when the agent has a session. */
	stats?: { model?: string; tokens?: number; cost?: number; ctx?: { used: number; limit: number } };
	now: number;
	width: number;
	style: StageStyle;
}

export interface StageOrchestra {
	/** Pane 0.0 frame. */
	transcriptFrame(style: StageStyle): StagePaneFrame;
	/** Header fields that differ from Solo. */
	header(): Pick<HeaderData, "mode" | "cost" | "saved">;
	tabs(): TabsData;
	/** Status-bar fields that differ from Solo. */
	footer(): Partial<Pick<StatusBarData, "window" | "role" | "crew" | "cost">>;
	/** Agent hue for an agent id (workers keep their Casting Board color). */
	agentToken(agentId: string): StageToken | undefined;
	/** Worker pane, or `undefined` to let the host draw a plain agent tile. */
	agentPane(input: StageAgentInput): StageAgentPane | undefined;
	/** `proc` / `dag` / `telemetry` (throughput) widgets; `undefined` falls back to the host. */
	widget(
		tile: Tile,
		width: number,
		height: number,
		now: number,
		style: StageStyle,
	): (StagePaneFrame & { rows: string[] }) | undefined;
	/** Rows that replace a transcript tool line in pane 0.0 (e.g. `crew_plan` + the PLAN table). */
	toolRows(record: ToolRecord, width: number, now: number, style: StageStyle): string[] | undefined;
	/** 500 ms heartbeat. */
	tick(now: number): void;
}
