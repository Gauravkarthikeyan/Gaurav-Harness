/**
 * Capabilities center data (MCP · Skills · Plugins): row types, labels and the source interface the overlay
 * reads through. The live source (`gk/ui/capabilities.ts`) adapts omp's MCP manager, session skills and the
 * plugin installer; tests pass their own.
 */

export type McpRowState =
	| { kind: "connected"; tools: number }
	| { kind: "needs-login" }
	| { kind: "failed"; reason: string }
	| { kind: "disabled" }
	| { kind: "connecting" };

export interface McpRow {
	name: string;
	scope: "global" | "project";
	state: McpRowState;
}

export interface SkillRow {
	name: string;
	source: string;
	description: string;
	enabled: boolean;
}

export interface PluginRow {
	name: string;
	version: string;
	enabled: boolean;
	updateAvailable: boolean;
}

/** A connect attempt that has not settled by then is shown as failed; input is never blocked on it. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_TIMEOUT_REASON = "timed out after 15s";
const REASON_MAX = 60;

export function mcpStateLabel(state: McpRowState): string {
	switch (state.kind) {
		case "connected":
			return `connected · ${state.tools} tool${state.tools === 1 ? "" : "s"}`;
		case "needs-login":
			return "needs login";
		case "failed": {
			const chars = [...state.reason];
			const reason = chars.length > REASON_MAX ? `${chars.slice(0, REASON_MAX - 1).join("")}…` : state.reason;
			return `failed: ${reason}`;
		}
		case "disabled":
			return "disabled";
		case "connecting":
			return "connecting…";
	}
}

/** `MCP 3/4 · skills 12 · plugins 2` (connected / known MCP servers, enabled skills, enabled plugins). */
export function capabilitySummary(
	mcp: readonly McpRow[],
	skills: readonly SkillRow[],
	plugins: readonly PluginRow[],
): string {
	const connected = mcp.filter(row => row.state.kind === "connected").length;
	const skillCount = skills.filter(row => row.enabled).length;
	const pluginCount = plugins.filter(row => row.enabled).length;
	return `MCP ${connected}/${mcp.length} · skills ${skillCount} · plugins ${pluginCount}`;
}

export interface CapabilitiesSource {
	mcp(): Promise<McpRow[]>;
	skills(): SkillRow[];
	plugins(): Promise<PluginRow[]>;
	setMcpEnabled(name: string, enabled: boolean): Promise<void>;
	/** (Re)connect one server; settles when the attempt does. */
	connectMcp(name: string): Promise<void>;
	setPluginEnabled(name: string, enabled: boolean): Promise<void>;
	/** Start the add-server flow (`/mcp add`). */
	addMcp(): void;
}
