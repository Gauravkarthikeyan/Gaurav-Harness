/**
 * Wires the Stage host to omp's interactive mode: which session, transcript and composer roots pane 0.0
 * draws, where todos and agents come from. Interactive mode calls {@link mountStage} once its UI has
 * started; everything else stays omp's.
 */
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { Component, Container, TUI } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import type { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { logger } from "@oh-my-pi/pi-utils";
import { setNativeSymbolPreset } from "@oh-my-pi/pi-tui/theme/theme";
import type { Settings } from "../../config/settings";
import type { MCPManager } from "../../mcp/manager";
import { cfgGkStageEnabled, cfgMotionResolved } from "../../modes/settings";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { copyToClipboard } from "../../utils/clipboard";
import type { EventBus } from "../../utils/event-bus";
import type { ErrorActions } from "./error-tile";
import { StageHost } from "./host";
import { themeStyle } from "./style";

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
	readonly editor: {
		setBorderVisible(visible: boolean): void;
		setPromptGutter(gutter: string | undefined): void;
		getText(): string;
	};
	readonly toolOutputExpanded: boolean;
	readonly todoPhases: readonly TodoPhase[];
	/** omp's subagent focus: the composer, transcript and interrupts retarget that agent's session. */
	focusAgentSession(id: string): Promise<void>;
	unfocusSession(): Promise<void>;
	readonly settings: Settings;
	readonly eventBus: EventBus | undefined;
	readonly mcpManager?: MCPManager;
	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void>;
	showModelSelector(options?: { temporaryOnly?: boolean }): void;
	showStatus(message: string): void;
	showWarning(message: string): void;
}

/** Error-tile keys run omp's own flows: the login selector, the model selector, `/retry`, MCP reconnect, the clipboard. */
function errorActions(ctx: StageModeContext): ErrorActions {
	const warn = (what: string) => (error: unknown) =>
		ctx.showWarning(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
	return {
		login: provider => {
			const oauth = provider ? getOAuthProviders().find(p => p.id === provider) : undefined;
			void ctx.showOAuthSelector("login", oauth?.id).catch(warn("Login"));
		},
		switchModel: () => ctx.showModelSelector({ temporaryOnly: true }),
		retry: error => {
			if (error.origin === "mcp" && error.server) {
				const manager = ctx.mcpManager;
				if (!manager) return ctx.showWarning("MCP is not running in this session.");
				ctx.showStatus(`Reconnecting ${error.server}…`);
				void manager.reconnectServer(error.server, { manual: true }).catch(warn("Reconnect"));
				return;
			}
			if (ctx.session.isStreaming) return ctx.showWarning("Wait for the current response to finish before retrying.");
			void ctx.session.retry().then(did => {
				if (!did) ctx.showStatus("Nothing to retry");
			}, warn("Retry"));
		},
		copy: text => {
			copyToClipboard(text).then(() => ctx.showStatus("Copied the error to the clipboard"), warn("Copy"));
		},
	};
}

/** Stage on: setting on (default) and a real terminal on both ends. `--print`, RPC and pipes never get here. */
export function shouldMountStage(settings: Settings): boolean {
	return cfgGkStageEnabled.get(settings) && process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/**
 * The composer roots below the transcript, in omp's order (`InteractiveMode.init` → `setRuntimeChildren`),
 * minus the todo and subagent HUDs — the Stage shows those as the todo widget and agent tiles — and minus omp's
 * status line: pane 0.0 draws the Stage pane statusline under the composer instead.
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
	];
}

/**
 * Mount the Stage. Its chrome is plain Unicode in any monospace font, so omp's components inside pane 0.0 switch
 * to the Unicode symbol preset (process-local, never persisted), and the composer drops its frame for a bare gold
 * `❯ ` prompt — its status band is replaced by the pane statusline.
 */
export function mountStage(ctx: StageModeContext): StageHost {
	setNativeSymbolPreset("unicode");
	ctx.editor.setBorderVisible(false);
	ctx.editor.setPromptGutter(`${themeStyle("accent", "❯")} `);
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
		motion: cfgMotionResolved.get(ctx.settings).effects,
		focusAgent: id => {
			void (id === null ? ctx.unfocusSession() : ctx.focusAgentSession(id)).catch((error: unknown) => {
				logger.warn("Stage could not focus agent", { id, error: String(error) });
			});
		},
		errorActions: errorActions(ctx),
		composerEmpty: () => ctx.editor.getText().trim() === "",
	});
	if (ctx.eventBus) host.watchMcp(ctx.eventBus);
	host.start();
	return host;
}
