/**
 * Wires the Stage host to omp's interactive mode: which session, transcript and composer roots pane 0.0
 * draws, where todos and agents come from. Interactive mode calls {@link mountStage} once its UI has
 * started; everything else stays omp's.
 */
import type { Component, Container, TUI } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import type { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { Settings } from "../../config/settings";
import { cfgGkStageEnabled } from "../../modes/settings";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { StageHost } from "./host";

/** The interactive-mode fields the Stage reads (all public on `InteractiveMode`). */
export interface StageModeContext {
	readonly ui: TUI;
	readonly session: AgentSession;
	readonly sessionManager: { getSessionId(): string; getCwd(): string };
	readonly chatContainer: TranscriptContainer;
	readonly pendingShellContainer: Container;
	readonly pendingMessagesContainer: Container;
	readonly btwContainer: Container;
	readonly reportContainer: Container;
	readonly omfgContainer: Container;
	readonly cleanseContainer: Container;
	readonly errorBannerContainer: Container;
	readonly modelCycleContainer: Container;
	readonly deferredCommandContainer: Container;
	readonly progressHudContainer: Container;
	readonly statusContainer: Container;
	readonly attachmentChipsContainer: Container;
	readonly editorTopGapContainer: Container;
	readonly hookWidgetContainerAbove: Container;
	readonly editorContainer: Container;
	readonly hookWidgetContainerBelow: Container;
	readonly statusLine: Component;
	readonly toolOutputExpanded: boolean;
	readonly todoPhases: readonly TodoPhase[];
}

/** Stage on: setting on (default) and a real terminal on both ends. `--print`, RPC and pipes never get here. */
export function shouldMountStage(settings: Settings): boolean {
	return cfgGkStageEnabled.get(settings) && process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/**
 * The composer roots below the transcript, in omp's order (`InteractiveMode.init` → `setRuntimeChildren`),
 * minus the todo and subagent HUDs — the Stage shows those as the todo widget and agent tiles — plus the
 * status line the composer mounts last.
 */
function chromeRoots(ctx: StageModeContext): Component[] {
	return [
		ctx.pendingShellContainer,
		ctx.pendingMessagesContainer,
		ctx.btwContainer,
		ctx.reportContainer,
		ctx.omfgContainer,
		ctx.cleanseContainer,
		ctx.errorBannerContainer,
		ctx.modelCycleContainer,
		ctx.deferredCommandContainer,
		ctx.progressHudContainer,
		ctx.statusContainer,
		ctx.attachmentChipsContainer,
		ctx.editorTopGapContainer,
		ctx.hookWidgetContainerAbove,
		ctx.editorContainer,
		ctx.hookWidgetContainerBelow,
		ctx.statusLine,
	];
}

export function mountStage(ctx: StageModeContext): StageHost {
	const host = new StageHost({
		ui: ctx.ui,
		session: () => ctx.session,
		sessionId: () => ctx.sessionManager.getSessionId(),
		blocks: () => ctx.chatContainer.children,
		chrome: () => chromeRoots(ctx),
		isAssistant: component => component instanceof AssistantMessageComponent,
		expandTools: () => ctx.toolOutputExpanded,
		todos: () => ctx.todoPhases,
		registry: AgentRegistry.global(),
		cwd: ctx.sessionManager.getCwd(),
	});
	host.start();
	return host;
}
