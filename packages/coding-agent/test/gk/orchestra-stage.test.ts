import { describe, expect, it } from "bun:test";
import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { createCrewTools } from "../../src/gk/crew-tools";
import { OrchestraStage, W_DAG, W_PROC } from "../../src/gk/orchestra/stage-adapter";
import { StageHost } from "../../src/gk/stage/host";
import { TileStore } from "../../src/gk/stage/tiles";
import type { ToolRecord } from "../../src/gk/stage/tool-lines";
import { harness, item, tick } from "./crew-fixtures";
import { identity, sgr } from "./stage/widgets/helpers";

const sources = {
	conductorLabel: () => "conductor-1",
	conductorCostUsd: () => 0.05,
	conductorStreaming: () => true,
	conductorSession: () => undefined,
	agentSession: () => undefined,
	maxRunUsd: () => 2,
};

async function startedRun(items = [item("a"), item("b"), item("c", { dependsOn: ["a", "b"] })]) {
	const h = harness();
	const store = new TileStore();
	const notes: string[] = [];
	const stage = new OrchestraStage(
		{ store, note: e => notes.push(`${e.agent} ${e.text}`), requestRender: () => {} },
		sources,
	);
	const plan = createCrewTools(h.crew).find(t => t.name === "crew_plan")!;
	const result = await plan.execute("call-1", { items });
	stage.attach(h.runs[0]!);
	return { h, store, notes, stage, result };
}

describe("OrchestraStage", () => {
	it("creates queued tiles for items without a worker and drops them once workers register", async () => {
		const { h, store, stage } = await startedRun();
		expect(store.get(W_PROC)?.kind).toBe("proc");
		expect(store.get(W_DAG)?.kind).toBe("dag");
		await tick();
		stage.sync();
		// a and b spawned (worker ids known); c waits on both.
		expect(store.get("agent:crew-a")).toBeUndefined();
		expect(store.get("agent:crew-b")).toBeUndefined();
		expect(store.get("agent:crew-c")?.state).toBe("idle");
		h.spawner.spawned[0]!.finish();
		h.spawner.spawned[1]!.finish();
		await tick();
		expect(store.get("agent:crew-c")).toBeUndefined();
	});

	it("titles worker panes W-id · title with the @name badge, tool lines, inline diff and statusline", async () => {
		const { h, store, stage } = await startedRun([item("W-01", { title: "hello.txt" })]);
		await tick();
		const name = h.runs[0]!.run.workerName("W-01");
		const edit: ToolRecord = {
			id: "t1",
			name: "edit",
			args: { path: "W-01/hello.txt" },
			agentId: "w1",
			startedAt: 0,
			endedAt: 100,
			isError: false,
			output: "",
			details: { diff: "+1|hi" },
		};
		const pane = stage.agentPane({
			agentId: "w1",
			tile: store.all()[0]!,
			tools: [edit],
			stats: { model: "one", tokens: 1200, cost: 0.01 },
			now: 1000,
			width: 80,
			style: identity,
		})!;
		expect(pane.title).toBe("W-01 · hello.txt");
		expect(pane.badge).toBe(`@${name}`);
		expect(pane.rows.join("\n")).toContain("edit W-01/hello.txt");
		expect(pane.rows.join("\n")).toContain("+ hi");
		expect(pane.status).toMatchObject({ agent: name, model: "one", tokens: "1.2k", cost: "$0.01", scope: "W-01/" });
		expect(
			stage.agentPane({ agentId: "nobody", tile: store.all()[0]!, tools: [], now: 0, width: 80, style: identity }),
		).toBeUndefined();
	});

	it("shows the PLAN table under the approved crew_plan line", async () => {
		const { h, stage, result } = await startedRun();
		const record: ToolRecord = {
			id: "call-1",
			name: "crew_plan",
			args: {},
			agentId: null,
			startedAt: 0,
			endedAt: 10,
			isError: false,
			output: "",
			details: result.details,
		};
		const rows = stage.toolRows(record, 90, 20, identity)!;
		const text = rows.join("\n");
		expect(text).toContain("crew_plan#1 approved");
		expect(text).toContain("PLAN #1 · 3 items · 2 waves");
		expect(text).toContain(`@${h.runs[0]!.run.workerName("a")}`);
		expect(text).toContain("← a b");
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(90);
	});

	it("feeds header, tabs, footer and widgets from the run", async () => {
		const { stage, store, notes } = await startedRun();
		await tick();
		const header = stage.header();
		expect(header.mode).toBe("ORCHESTRA");
		expect(header.cost).toMatchObject({ label: "RUN", budget: "$2.00" });
		expect(header.saved).toMatch(/vs conductor-1-only est \$/);
		expect(stage.tabs().tabs.map(t => t.name)).toEqual(["stage", "crew", "logs", "git"]);
		expect(stage.footer()).toMatchObject({
			window: "0:stage",
			role: "conductor",
			crew: { running: 2, queued: 1, done: 0 },
		});
		const proc = stage.widget(store.get(W_PROC)!, 46, 6, 0, identity)!;
		expect(proc.rows.join("\n")).toContain("cond");
		const dag = stage.widget(store.get(W_DAG)!, 46, 6, 0, identity)!;
		expect(dag.badge).toBe("wave 1/2");
		expect(dag.rows.join("\n")).toContain("c @");
		expect(notes[0]).toBe("plan approved 3 items");
	});
});

describe("StageHost with Orchestra", () => {
	it("draws the orchestra preset at exact width with worker and queued panes", async () => {
		const { h } = await startedRun();
		await tick();
		const ui = {
			terminal: { columns: 212, rows: 58 },
			requestRender: () => {},
			showOverlay: () => ({ hide() {}, setHidden() {}, isHidden: () => false }) as never,
			addInputListener: () => () => {},
			hasOverlay: () => false,
		};
		const session = {
			subscribe: () => () => {},
			isStreaming: false,
			model: { id: "conductor-1" },
			messages: [],
			getSessionStats: () => ({ cost: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } }),
		};
		const host = new StageHost({
			ui,
			session: () => session,
			sessionId: () => "abc123",
			blocks: () => [] as Component[],
			chrome: () => [] as Component[],
			isAssistant: () => false,
			cwd: "/tmp/x",
			git: null,
			timers: false,
			motion: false,
			style: sgr,
		});
		const adapter = new OrchestraStage(host, sources);
		host.setOrchestra(adapter);
		adapter.attach(h.runs[0]!);
		const rows = host.render(212, 58);
		expect(rows).toHaveLength(58);
		for (const row of rows) expect(visibleWidth(row)).toBe(212);
		const plain = rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("conductor · read-only");
		expect(plain).toContain("c · title c");
		expect(plain).toContain("ORCHESTRA");
		expect(plain).toContain("0:stage*");
		expect(plain).toContain("proc");
		expect(plain).toContain("dag · plan#1");
	});
});
