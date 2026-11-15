import { describe, expect, it } from "bun:test";
import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { createCrewTools } from "../../../src/gk/crew-tools";
import { OrchestraStage } from "../../../src/gk/orchestra/stage-adapter";
import type { AgentRef } from "../../../src/registry/agent-registry";
import type { AgentSessionEvent } from "../../../src/session/agent-session-events";
import { type StageRegistry, StageHost } from "../../../src/gk/stage/host";
import { AgentFeed } from "../../../src/gk/stage/live-feed";
import { plainStyle } from "../../../src/gk/stage/style";
import { clockTime, type ToolRecord } from "../../../src/gk/stage/tool-lines";
import type { StageStyle } from "../../../src/gk/stage/widgets/common";
import { feedRows } from "../../../src/gk/stage/widgets/feed";
import { harness, item, tick } from "../crew-fixtures";
import { identity } from "./widgets/helpers";

const T0 = new Date(2026, 10, 15, 14, 27, 0).getTime();

function update(type: string, extra: Record<string, unknown> = {}): AgentSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type, contentIndex: 0, partial: { content: [] }, ...extra },
	} as unknown as AgentSessionEvent;
}

function message(type: "message_start" | "message_end"): AgentSessionEvent {
	return { type, message: { role: "assistant" } } as unknown as AgentSessionEvent;
}

function writeDelta(id: string, path: string, content: string): AgentSessionEvent {
	return update("toolcall_delta", {
		contentIndex: 1,
		delta: "x",
		partial: { content: [{ type: "toolCall", id, name: "write", arguments: { path, content } }] },
	});
}

function record(overrides: Partial<ToolRecord>): ToolRecord {
	return {
		id: "t1",
		name: "edit",
		args: {},
		agentId: "w1",
		startedAt: T0,
		endedAt: null,
		isError: false,
		output: "",
		details: undefined,
		...overrides,
	};
}

/** Marks diff backgrounds with zero-width SGR so widths stay exact. */
const ADD = "\x1b[42m";
const DEL = "\x1b[41m";
const tagBg: StageStyle = (token, text) =>
	token === "diffAddBg" ? `${ADD}${text}\x1b[49m` : token === "diffDelBg" ? `${DEL}${text}\x1b[49m` : text;
const plain = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();

function expectWidth(rows: readonly string[], width: number): void {
	for (const row of rows) expect(visibleWidth(row)).toBe(width);
}

describe("live agent feed", () => {
	it("streams thinking dim italic under ▸ thinking, then collapses to one line", () => {
		const feed = new AgentFeed();
		feed.apply(message("message_start") as never, T0);
		feed.apply(update("thinking_start") as never, T0);
		feed.apply(update("thinking_delta", { delta: "Plan the hero section.\nThen the footer." }) as never, T0 + 500);
		const live = feedRows(feed.entries, 60, { now: T0 + 2000, style: identity });
		expectWidth(live, 60);
		expect(live[0]!.trimEnd()).toBe(`${clockTime(T0)} ▸ thinking${" ".repeat(60 - 23)}2.0s`);
		expect(live[1]!.trimEnd()).toBe(`${" ".repeat(11)}\x1b[3mPlan the hero section.\x1b[23m`);
		expect(live[2]!.trimEnd()).toBe(`${" ".repeat(11)}\x1b[3mThen the footer.\x1b[23m`);

		feed.apply(update("thinking_delta", { delta: "x".repeat(4400 - 38) }) as never, T0 + 6000);
		feed.apply(update("thinking_end") as never, T0 + 6200);
		const done = feedRows(feed.entries, 60, { now: T0 + 9000, style: identity });
		expect(done).toHaveLength(1);
		expectWidth(done, 60);
		expect(done[0]!.trimEnd()).toBe(`${clockTime(T0)} ▸ thought 6.2s · 1.1k tok`);
	});

	it("streams write content as a line-numbered tail that follows the newest line", () => {
		const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const feed = new AgentFeed();
		feed.addTool(record({ id: "w", name: "write", args: { path: "index.html", content } }));
		const rows = feedRows(feed.entries, 50, { now: T0 + 1000, style: identity });
		expectWidth(rows, 50);
		expect(rows[0]!.trimEnd()).toBe(`${clockTime(T0)} ● write index.html`);
		expect(rows).toHaveLength(13);
		expect(rows[1]!.trimEnd()).toBe("      19  line 19");
		expect(rows[12]!.trimEnd()).toBe("      30  line 30");
		// A highlighter colors the shown tail only.
		const seen: string[] = [];
		feedRows(feed.entries, 50, {
			now: T0,
			style: identity,
			highlight: (code, lang) => {
				seen.push(`${lang}:${code.split("\n").length}`);
				return code.split("\n");
			},
		});
		expect(seen).toEqual(["html:12"]);
	});

	it("shows a streaming edit as add/del rows and a finished edit as its diff hunk", () => {
		const feed = new AgentFeed();
		const edit = record({
			args: { path: "src/app.ts", input: "[src/app.ts#AB12]\nPUT 3.=3:\n-old line\n+new line" },
		});
		feed.addTool(edit);
		const live = feedRows(feed.entries, 40, { now: T0, style: tagBg });
		expectWidth(live, 40);
		expect(live.some(r => r.startsWith(DEL) && plain(r) === `${" ".repeat(10)}− old line`)).toBe(true);
		expect(live.some(r => r.startsWith(ADD) && plain(r) === `${" ".repeat(10)}+ new line`)).toBe(true);
		expect(live.some(r => plain(r) === `${" ".repeat(12)}PUT 3.=3:`)).toBe(true);

		edit.endedAt = T0 + 300;
		edit.details = { diff: " 2|keep\n-3|old line\n+3|new line" };
		const done = feedRows(feed.entries, 40, { now: T0 + 300, style: tagBg });
		expectWidth(done, 40);
		expect(done[0]).toContain("edit src/app.ts");
		expect(done[0]!.trimEnd().endsWith("+1 −1")).toBe(true);
		expect(done.slice(1).map(plain)).toEqual(["       2    keep", "       3  − old line", "       3  + new line"]);
		expect(done[2]!.startsWith(DEL)).toBe(true);
		expect(done[3]!.startsWith(ADD)).toBe(true);
	});
});

describe("StageHost live worker panes", () => {
	async function stage() {
		const h = harness();
		const plan = createCrewTools(h.crew).find(t => t.name === "crew_plan")!;
		await plan.execute("call-1", { items: [item("W-01", { title: "landing page", scope: ["index.html"] })] });
		await tick();
		const run = h.runs[0]!;
		const workerName = run.run.workerName("W-01");
		const fakeSession = {
			subscribe: () => () => {},
			messages: [],
			getSessionStats: () => ({ cost: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } }),
			model: { id: "claude-haiku-4-5" },
		};
		const ref = (id: string, displayName: string, parentId: string, createdAt: number) =>
			({
				id,
				generation: 1,
				displayName,
				kind: "sub",
				parentId,
				status: "running",
				session: fakeSession,
				sessionFile: null,
				createdAt,
				lastActivity: createdAt,
			}) as unknown as AgentRef;
		const refs = [ref("w1", workerName, "Main", T0), ref("scout1", "scout", "w1", T0 + 1000)];
		const registry: StageRegistry = { list: () => refs, onChange: () => () => {} };
		let now = T0 + 5000;
		let input: ((data: string) => unknown) | undefined;
		const ui = {
			terminal: { columns: 212, rows: 58 },
			requestRender: () => {},
			showOverlay: () => ({ hide() {}, setHidden() {}, isHidden: () => false }) as never,
			addInputListener: (listener: (data: string) => unknown) => {
				input = listener;
				return () => {};
			},
			hasOverlay: () => false,
		};
		const session = {
			subscribe: () => () => {},
			isStreaming: true,
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
			registry,
			cwd: "/tmp/x",
			git: null,
			timers: false,
			motion: false,
			now: () => now,
			style: plainStyle,
		});
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
		return {
			host,
			refs,
			workerName,
			advance: (ms: number) => (now += ms),
			key: (data: string) => input?.(data),
		};
	}

	it("follows a session the registry attached silently, replaying its transcript first", async () => {
		const { host, refs } = await stage();
		let listener: ((event: AgentSessionEvent) => void) | undefined;
		const late = {
			subscribe: (l: (event: AgentSessionEvent) => void) => {
				listener = l;
				return () => {};
			},
			getSessionStats: () => ({
				cost: 0.01,
				toolCalls: 1,
				tokens: { input: 0, output: 0, cacheRead: 0, total: 900 },
			}),
			model: { id: "claude-sonnet-4-5" },
			messages: [
				{
					role: "assistant",
					timestamp: T0,
					duration: 1500,
					content: [
						{ type: "thinking", thinking: "outline first" },
						{ type: "toolCall", id: "r1", name: "read", arguments: { path: "brief.md" } },
					],
				},
				{
					role: "toolResult",
					toolCallId: "r1",
					timestamp: T0 + 1700,
					isError: false,
					content: [{ type: "text", text: "a\nb" }],
				},
			],
		};
		// A test double for the live session handle: only the members the host reads.
		refs[0]!.session = late as unknown as AgentRef["session"];
		host.tick();
		expect(listener).toBeDefined();
		listener!(writeDelta("tw", "index.html", "<main>hello</main>"));
		const screen = host
			.render(212, 58)
			.map(r => r.replace(/\x1b\[[0-9;]*m/g, ""))
			.join("\n");
		expect(screen).toContain("▸ thought 1.5s · 4 tok");
		expect(screen).toMatch(/✓ read brief\.md +2L 1\.7s/);
		expect(screen).toContain("● write index.html");
		expect(screen).toMatch(/ 1 {2}<main>hello<\/main>/);
	});

	it("draws thinking, streaming code and a nested subagent inset in the worker pane at exact width", async () => {
		const { host, workerName, advance } = await stage();
		host.handleEvent("w1", message("message_start"));
		host.handleEvent("w1", update("thinking_start"));
		host.handleEvent("w1", update("thinking_delta", { delta: "Lay out a centered hero." }));
		advance(3000);
		host.handleEvent("w1", update("thinking_end"));
		host.handleEvent("w1", writeDelta("tw", "index.html", "<!doctype html>\n<html>\n<body>"));
		host.handleEvent("scout1", message("message_start"));
		host.handleEvent("scout1", update("text_delta", { delta: "found 2 fetch helpers" }));

		const rows = host.render(212, 58);
		expect(rows).toHaveLength(58);
		expectWidth(rows, 212);
		const plain = rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("0.1 W-01 · landing page");
		expect(plain).toMatch(/▸ thought 3\.0s · 6 tok/);
		expect(plain).toContain("● write index.html");
		expect(plain).toMatch(/ 1 {2}<!doctype html>/);
		expect(plain).toMatch(/ 3 {2}<body>/);
		expect(plain).toContain(`${workerName} › scout`);
		expect(plain).toContain("│ found 2 fetch helpers");
		// The nested scout draws inset, not as a pane of its own.
		expect(plain).not.toMatch(/0\.\d scout/);

		// The call starting reuses the streamed record: one write line, now running with its full args.
		host.handleEvent("w1", {
			type: "tool_execution_start",
			toolCallId: "tw",
			toolName: "write",
			args: { path: "index.html", content: "<!doctype html>\n<html>\n<body>\n</body>" },
		} as AgentSessionEvent);
		const again = host
			.render(212, 58)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(again.match(/write index\.html/g)?.length).toBeGreaterThanOrEqual(1);
		expect(again).toMatch(/ 4 {2}<\/body>/);
	});

	it("zooms a worker pane to its full scrollable transcript", async () => {
		const { host, key } = await stage();
		const screen = () =>
			host
				.render(212, 58)
				.map(r => r.replace(/\x1b\[[0-9;]*m/g, ""))
				.join("\n");
		host.handleEvent("w1", message("message_start"));
		host.handleEvent("w1", update("text_start"));
		host.handleEvent(
			"w1",
			update("text_delta", { delta: Array.from({ length: 80 }, (_, i) => `row ${i}`).join("\n") }),
		);
		host.zoom("agent:w1");
		const tail = screen();
		expect(tail).toMatch(/row 79 /);
		expect(tail).toMatch(/row 35 /);
		expect(tail).not.toMatch(/row 20 /);
		key("\x1b[5~"); // PgUp
		const up = screen();
		expect(up).toMatch(/row 20 /);
		expect(up).not.toMatch(/row 79 /);
		key("\x1b"); // Esc back to the tiling
		expect(screen()).toContain("conductor · read-only");
	});
});
