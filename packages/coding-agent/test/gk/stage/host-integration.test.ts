import { describe, expect, it } from "bun:test";
import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { createCrewTools } from "../../../src/gk/crew-tools";
import { OrchestraStage } from "../../../src/gk/orchestra/stage-adapter";
import { type StageRegistry, StageHost } from "../../../src/gk/stage/host";
import { plainStyle } from "../../../src/gk/stage/style";
import type { AgentRef } from "../../../src/registry/agent-registry";
import type { AgentSessionEvent } from "../../../src/session/agent-session-events";
import { harness, item, tick } from "../crew-fixtures";

const T0 = new Date(2026, 10, 15, 14, 27, 0).getTime();
const plain = (rows: readonly string[]) => rows.map(r => r.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

const SIZES = [
	[212, 58],
	[120, 40],
	[80, 24],
] as const;

function noUsage() {
	return { cost: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } };
}

function makeHost(opts: { registry?: StageRegistry; now?: () => number; cols?: number; rows?: number } = {}) {
	const ui = {
		terminal: { columns: opts.cols ?? 212, rows: opts.rows ?? 58 },
		requestRender: () => {},
		showOverlay: () => ({ hide() {}, setHidden() {}, isHidden: () => false }) as never,
		addInputListener: () => () => {},
		hasOverlay: () => false,
	};
	const session = {
		subscribe: () => () => {},
		isStreaming: true,
		model: { id: "gpt-5.6-luna" },
		messages: [],
		getSessionStats: noUsage,
	};
	return new StageHost({
		ui,
		session: () => session,
		sessionId: () => "abc123",
		blocks: () => [] as Component[],
		chrome: () => [] as Component[],
		isAssistant: () => false,
		registry: opts.registry,
		cwd: "/tmp/x",
		git: null,
		timers: false,
		motion: false,
		style: plainStyle,
		now: opts.now,
	});
}

function toolStart(toolCallId: string, toolName: string, args: Record<string, unknown>): AgentSessionEvent {
	return { type: "tool_execution_start", toolCallId, toolName, args } as unknown as AgentSessionEvent;
}

function toolUpdate(toolCallId: string, text: string): AgentSessionEvent {
	return {
		type: "tool_execution_update",
		toolCallId,
		partialResult: { content: [{ type: "text", text }] },
	} as unknown as AgentSessionEvent;
}

function toolEnd(
	toolCallId: string,
	toolName: string,
	text: string,
	details: unknown,
	isError = false,
): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { content: [{ type: "text", text }], details },
		isError,
	} as unknown as AgentSessionEvent;
}

function subRef(id: string, displayName: string, parentId: string, createdAt: number): AgentRef {
	return {
		id,
		generation: 1,
		displayName,
		kind: "sub",
		parentId,
		status: "running",
		session: null,
		sessionFile: null,
		createdAt,
		lastActivity: createdAt,
	} as unknown as AgentRef;
}

describe("StageHost integration: bash command tile", () => {
	it("creates a command tile that streams output and shows the exit code in its frame", () => {
		const host = makeHost();
		host.handleEvent(null, toolStart("bash-1", "bash", { command: "ls -la" }));
		host.handleEvent(null, toolUpdate("bash-1", "alpha\nbeta\n"));

		const streaming = plain(host.render(212, 58));
		expect(host.store.get("cmd:bash-1")?.state).toBe("running");
		expect(streaming).toContain("$ ls -la");
		expect(streaming).toContain("alpha");
		expect(streaming).toContain("beta");

		host.handleEvent(null, toolEnd("bash-1", "bash", "alpha\nbeta\ngamma\n", { exitCode: 0 }));
		const done = plain(host.render(212, 58));
		expect(host.store.get("cmd:bash-1")).toMatchObject({ state: "done", exitCode: 0 });
		expect(done).toContain("exit 0");
		expect(done).toContain("gamma");
	});

	it("marks a failing command tile with its non-zero exit code", () => {
		const host = makeHost();
		host.handleEvent(null, toolStart("bash-2", "bash", { command: "false" }));
		host.handleEvent(null, toolEnd("bash-2", "bash", "", { exitCode: 3 }, true));
		expect(host.store.get("cmd:bash-2")).toMatchObject({ state: "error", exitCode: 3 });
		expect(plain(host.render(212, 58))).toContain("exit 3");
	});
});

describe("StageHost integration: nested subagent lineage", () => {
	it("titles a nested subagent tile `parent › child`", () => {
		const parent = subRef("scout-parent", "Ada", "Main", T0);
		const child = subRef("scout-child", "Scout", "scout-parent", T0 + 1000);
		const registry: StageRegistry = { list: () => [parent, child], onChange: () => () => {} };
		const host = makeHost({ registry, now: () => T0 + 2000 });
		host.start();

		const tile = host.store.get("agent:scout-child");
		expect(tile).toBeDefined();
		expect(tile?.parentId).toBe("agent:scout-parent");
		expect(host.store.lineageTitle("agent:scout-child")).toBe("Ada › Scout");
		expect(plain(host.render(212, 58))).toContain("Ada › Scout");
	});
});

describe("StageHost integration: web tile chip", () => {
	it("turns a finished web_search tile into a chip 4 s after done", () => {
		let now = T0;
		const host = makeHost({ now: () => now });
		host.handleEvent(null, toolStart("ws-1", "web_search", { query: "bun test runner" }));
		now = T0 + 1000;
		host.handleEvent(null, toolEnd("ws-1", "web_search", "result: bun test", {}));
		const doneAt = now;

		host.tick();
		expect(host.store.get("web:ws-1")?.state).toBe("done");
		expect(host.store.isChip("web:ws-1")).toBe(false);

		now = doneAt + 3_999;
		host.tick();
		expect(host.store.isChip("web:ws-1")).toBe(false);

		now = doneAt + 4_000;
		host.tick();
		expect(host.store.isChip("web:ws-1")).toBe(true);
	});
});

describe("StageHost integration: exact row widths", () => {
	for (const [cols, rows] of SIZES) {
		it(`Solo: every row is exactly ${cols} wide at ${cols}×${rows}`, () => {
			const host = makeHost({ cols, rows });
			host.handleEvent(null, toolStart("bash-w", "bash", { command: "echo hello" }));
			host.handleEvent(null, toolUpdate("bash-w", "hello\n"));
			const out = host.render(cols, rows);
			expect(out).toHaveLength(rows);
			for (const row of out) expect(visibleWidth(row)).toBe(cols);
		});
	}

	for (const [cols, rows] of SIZES) {
		it(`Orchestra: every row is exactly ${cols} wide at ${cols}×${rows}`, async () => {
			const h = harness();
			const plan = createCrewTools(h.crew).find(t => t.name === "crew_plan")!;
			await plan.execute("call-1", { items: [item("W-01", { title: "landing page", scope: ["index.html"] })] });
			await tick();
			const run = h.runs[0]!;
			const workerName = run.run.workerName("W-01");
			const worker = subRef("w1", workerName, "Main", T0);
			const registry: StageRegistry = { list: () => [worker], onChange: () => () => {} };
			const host = makeHost({ registry, cols, rows, now: () => T0 + 5000 });
			const adapter = new OrchestraStage(host, {
				conductorLabel: () => "conductor-1",
				conductorCostUsd: () => 0,
				conductorStreaming: () => true,
				conductorSession: () => undefined,
				agentSession: () => undefined,
				maxRunUsd: () => 2,
			});
			host.setOrchestra(adapter);
			adapter.attach(run);
			host.start();
			host.handleEvent("w1", toolStart("tw", "write", { path: "index.html", content: "<main>hi</main>" }));

			const out = host.render(cols, rows);
			expect(out).toHaveLength(rows);
			for (const row of out) expect(visibleWidth(row)).toBe(cols);
			expect(plain(out)).toContain("index.html");
		});
	}
});
