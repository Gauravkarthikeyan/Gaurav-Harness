import { beforeAll, describe, expect, it, vi } from "bun:test";
import {
	type CapabilitiesSource,
	MCP_CONNECT_TIMEOUT_MS,
	type McpImportCandidate,
	type McpRow,
	mcpStateLabel,
} from "@oh-my-pi/pi-coding-agent/gk/capabilities-model";
import { CapabilitiesOverlay, type CapsTimers } from "@oh-my-pi/pi-coding-agent/gk/ui/capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

const ESC = "\x1b";
const ENTER = "\r";

/** Fake clock: `advance` fires every timer whose deadline has passed. */
function fakeClock(): CapsTimers & { advance(ms: number): void } {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		setTimeout(fn, ms) {
			const id = ++nextId;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		},
		advance(ms) {
			now += ms;
			for (const [id, timer] of timers) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.fn();
			}
		},
	};
}

function fakeSource(overrides: Partial<CapabilitiesSource> = {}): CapabilitiesSource {
	return {
		mcp: async () => [],
		skills: () => [],
		plugins: async () => [],
		setMcpEnabled: vi.fn(async () => {}),
		connectMcp: vi.fn(async () => {}),
		setPluginEnabled: vi.fn(async () => {}),
		addMcp: vi.fn(),
		importCandidates: async () => [],
		importMcp: vi.fn(async () => {}),
		...overrides,
	};
}

function open(source: CapabilitiesSource, timers?: CapsTimers) {
	const onClose = vi.fn();
	let wake: (() => void) | undefined;
	const overlay = new CapabilitiesOverlay(source, { onClose, requestRender: () => wake?.(), timers });
	const text = () =>
		overlay
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
	/** Resolve once the overlay has re-rendered into a screen with no loading line (its async loads landed). */
	const settle = async () => {
		while (/loading MCP servers…|loading plugins…|reading Claude, Cursor/.test(text())) {
			const { promise, resolve } = Promise.withResolvers<void>();
			wake = resolve;
			await promise;
		}
	};
	return { overlay, onClose, text, settle };
}

describe("mcpStateLabel", () => {
	it("labels every state", () => {
		expect(mcpStateLabel({ kind: "connected", tools: 14 })).toBe("connected · 14 tools");
		expect(mcpStateLabel({ kind: "connected", tools: 1 })).toBe("connected · 1 tool");
		expect(mcpStateLabel({ kind: "needs-login" })).toBe("needs login");
		expect(mcpStateLabel({ kind: "failed", reason: "ENOENT: npx" })).toBe("failed: ENOENT: npx");
		expect(mcpStateLabel({ kind: "disabled" })).toBe("disabled");
		expect(mcpStateLabel({ kind: "connecting" })).toBe("connecting…");
	});

	it("truncates a long failure reason to 60 characters with an ellipsis", () => {
		const label = mcpStateLabel({ kind: "failed", reason: "x".repeat(200) });
		const reason = label.slice("failed: ".length);
		expect([...reason].length).toBe(60);
		expect(reason.endsWith("…")).toBe(true);
		expect(mcpStateLabel({ kind: "failed", reason: "y".repeat(60) })).toBe(`failed: ${"y".repeat(60)}`);
	});
});

describe("CapabilitiesOverlay", () => {
	it("turns a connect that never settles into a 15 s timeout, and Esc still closes", async () => {
		const clock = fakeClock();
		const rows: McpRow[] = [{ name: "slow-server", scope: "global", state: { kind: "connected", tools: 3 } }];
		const connectMcp = vi.fn(() => new Promise<void>(() => {}));
		const { overlay, onClose, text, settle } = open(fakeSource({ mcp: async () => rows, connectMcp }), clock);
		await settle();

		overlay.handleInput("r");
		expect(connectMcp).toHaveBeenCalledTimes(1);
		expect(text()).toContain("connecting…");

		clock.advance(MCP_CONNECT_TIMEOUT_MS - 1);
		expect(text()).toContain("connecting…");
		clock.advance(2); // 15 001 ms
		expect(text()).toContain("failed: timed out after 15s");

		overlay.handleInput(ESC);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("applies the same deadline to a server the manager reports as still connecting", async () => {
		const clock = fakeClock();
		const rows: McpRow[] = [{ name: "stuck", scope: "project", state: { kind: "connecting" } }];
		const { overlay, onClose, text, settle } = open(fakeSource({ mcp: async () => rows }), clock);
		await settle();
		expect(text()).toContain("connecting…");
		clock.advance(MCP_CONNECT_TIMEOUT_MS + 1);
		expect(text()).toContain("failed: timed out after 15s");
		overlay.handleInput(ESC);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("toggles the selected server exactly once per Space", async () => {
		const setMcpEnabled = vi.fn(async () => {});
		const rows: McpRow[] = [
			{ name: "alpha", scope: "global", state: { kind: "connected", tools: 2 } },
			{ name: "beta", scope: "project", state: { kind: "disabled" } },
		];
		const { overlay, settle } = open(fakeSource({ mcp: async () => rows, setMcpEnabled }));
		await settle();

		overlay.handleInput(" ");
		expect(setMcpEnabled).toHaveBeenCalledTimes(1);
		expect(setMcpEnabled).toHaveBeenLastCalledWith("alpha", false);

		overlay.handleInput("\x1b[B");
		overlay.handleInput(" ");
		expect(setMcpEnabled).toHaveBeenCalledTimes(2);
		expect(setMcpEnabled).toHaveBeenLastCalledWith("beta", true);
	});

	it("shows each tab's empty state with the next key to press", async () => {
		const { overlay, text, settle } = open(fakeSource());
		await settle();
		expect(text()).toContain("No MCP servers yet. Press a to add one or i to import from Claude/Cursor configs.");
		overlay.handleInput("2");
		expect(text()).toContain("No skills discovered.");
		overlay.handleInput("3");
		expect(text()).toContain("No plugins installed. Browse with /marketplace discover.");
	});

	it("previews an import and writes nothing until Enter", async () => {
		const candidates: McpImportCandidate[] = [
			{ name: "github", from: "Claude Code", detail: "npx -y @modelcontextprotocol/server-github" },
			{ name: "linear", from: "Cursor", detail: "https://mcp.linear.app/sse" },
		];
		const importMcp = vi.fn(async () => {});
		const { overlay, onClose, text, settle } = open(
			fakeSource({ importCandidates: async () => candidates, importMcp }),
		);
		await settle();

		overlay.handleInput("i");
		await settle();
		const preview = text();
		expect(preview).toContain("Import 2 servers into GK, disabled until tested. Nothing is written until Enter.");
		expect(preview).toContain("github");
		expect(preview).toContain("Claude Code");
		expect(preview).toContain("https://mcp.linear.app/sse");
		expect(importMcp).not.toHaveBeenCalled();

		// Esc backs out of the preview only: nothing written, overlay still open.
		overlay.handleInput(ESC);
		expect(importMcp).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(text()).not.toContain("Nothing is written until Enter");

		overlay.handleInput("i");
		await settle();
		overlay.handleInput(" ");
		expect(importMcp).not.toHaveBeenCalled();
		overlay.handleInput(ENTER);
		expect(importMcp).toHaveBeenCalledTimes(1);
		expect(importMcp).toHaveBeenCalledWith(candidates);
	});

	it("says when there is nothing to import, and Enter writes nothing", async () => {
		const importMcp = vi.fn(async () => {});
		const { overlay, text, settle } = open(fakeSource({ importMcp }));
		await settle();
		overlay.handleInput("i");
		await settle();
		expect(text()).toContain("Nothing to import");
		overlay.handleInput(ENTER);
		expect(importMcp).not.toHaveBeenCalled();
	});
});
