import { describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import {
	ComputerTileState,
	computerCaption,
	computerShotOf,
	renderComputerBody,
} from "../../../src/gk/stage/computer-tile";
import { StageHost } from "../../../src/gk/stage/host";
import { plainStyle } from "../../../src/gk/stage/style";
import type { AgentSessionEvent } from "../../../src/session/agent-session-events";
import { identity } from "./widgets/helpers";

const T0 = new Date(2026, 10, 15, 14, 27, 0).getTime();
const PNG = "iVBORw0KGgo=";

function fixture(graphics: boolean) {
	let clock = T0;
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
		model: { id: "m" },
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
		style: plainStyle,
		todaySpend: null,
		now: () => clock,
		computerGraphics: () => graphics,
	});
	return {
		host,
		advance(ms: number) {
			clock += ms;
		},
	};
}

function start(id: string, args: Record<string, unknown>): AgentSessionEvent {
	return { type: "tool_execution_start", toolCallId: id, toolName: "computer", args } as unknown as AgentSessionEvent;
}

function end(id: string, result: unknown, isError = false): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: "computer",
		result,
		isError,
	} as unknown as AgentSessionEvent;
}

function shotResult(width: number, height: number, path: string) {
	return {
		content: [
			{ type: "text", text: "ok" },
			{ type: "image", data: PNG, mimeType: "image/png" },
		],
		details: {
			screenshots: [{ path, width, height, coordinateWidth: width, coordinateHeight: height, target: "screen" }],
		},
	};
}

const plain = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();

describe("computer caption", () => {
	it("names a click, type, and key press from the last chain step", () => {
		expect(computerCaption({ action: "call", chain: [{ method: "click", args: [812, 404] }] })).toBe(
			"click (812, 404)",
		);
		expect(computerCaption({ action: "call", chain: [{ method: "type", args: ["hello"] }] })).toBe('type "hello"');
		expect(computerCaption({ action: "call", chain: [{ method: "press", args: ["cmd+s"] }] })).toBe("key cmd+s");
	});

	it("falls back to the first line of run code", () => {
		expect(computerCaption({ action: "run", code: "await click(1, 2)\nawait type('x')" })).toBe("await click(1, 2)");
	});
});

describe("computer shot", () => {
	it("takes the image block and the last screenshot size", () => {
		const shot = computerShotOf(shotResult(1280, 800, "/tmp/a.png"));
		expect(shot).toEqual({ data: PNG, mimeType: "image/png", widthPx: 1280, heightPx: 800, path: "/tmp/a.png" });
	});

	it("is undefined when the result carries no image", () => {
		expect(computerShotOf({ content: [{ type: "text", text: "no" }] })).toBeUndefined();
	});
});

describe("computer tile body", () => {
	it("renders exact rows with the placeholder when graphics are off", () => {
		const state = new ComputerTileState();
		state.begin("c1", "click (812, 404)", T0);
		state.finish("c1", {
			isError: false,
			shot: { data: PNG, mimeType: "image/png", widthPx: 1280, heightPx: 800, path: "/tmp/a.png" },
		});
		const rows = renderComputerBody(state, 40, 12, { graphics: false, style: identity });
		expect(rows).toHaveLength(12);
		for (const row of rows) expect(visibleWidth(row)).toBe(40);
		const text = rows.map(plain);
		expect(text[0]).toBe("screenshot 1280×800");
		expect(text[1]).toBe("→ /tmp/a.png");
		expect(text[8]).toBe("✓ click (812, 404)");
		expect(text[11]).toContain("click (812, 404)");
	});

	it("keeps exact width with graphics requested but no terminal protocol", () => {
		const state = new ComputerTileState();
		state.begin("c1", "key cmd+s", T0);
		state.finish("c1", { isError: false, shot: { data: PNG, mimeType: "image/png", widthPx: 100, heightPx: 50 } });
		const rows = renderComputerBody(state, 30, 10, { graphics: true, style: identity });
		expect(rows).toHaveLength(10);
		for (const row of rows) expect(visibleWidth(row)).toBe(30);
	});

	it("shows an empty-state line before the first screenshot", () => {
		const state = new ComputerTileState();
		const rows = renderComputerBody(state, 30, 4, { graphics: false, style: identity });
		expect(plain(rows[0]!)).toBe("no screenshot yet");
	});
});

describe("computer tile in the stage", () => {
	it("appears under the calling agent and shows the caption, placeholder, and log", () => {
		const { host, advance } = fixture(false);
		host.handleEvent(null, start("c1", { action: "call", chain: [{ method: "click", args: [812, 404] }] }));
		advance(100);
		host.handleEvent(null, end("c1", shotResult(1280, 800, "/tmp/s1.png")));
		advance(100);
		host.handleEvent(null, start("c2", { action: "call", chain: [{ method: "type", args: ["hello"] }] }));

		const tile = host.store.get("computer:main");
		expect(tile?.kind).toBe("computer");
		expect(tile?.state).toBe("running");

		const frame = host.render(212, 58).map(plain).join("\n");
		expect(frame).toContain("computer");
		expect(frame).toContain('▶ type "hello"');
		expect(frame).toContain("screenshot 1280×800");
		expect(frame).toContain("→ /tmp/s1.png");
		expect(frame).toContain("click (812, 404)");
	});

	it("chips 10 s after the last action and reactivates on the next one", () => {
		const { host, advance } = fixture(false);
		host.handleEvent(null, start("c1", { action: "call", chain: [{ method: "click", args: [1, 2] }] }));
		host.handleEvent(null, end("c1", shotResult(10, 10, "/tmp/s.png")));
		advance(9_000);
		host.tick();
		expect(host.store.isChip("computer:main")).toBe(false);
		advance(1_000);
		host.tick();
		expect(host.store.isChip("computer:main")).toBe(true);

		host.handleEvent(null, start("c2", { action: "call", chain: [{ method: "press", args: ["enter"] }] }));
		host.tick();
		expect(host.store.isChip("computer:main")).toBe(false);
	});

	it("keeps the tile running while another call is still in flight", () => {
		const { host } = fixture(false);
		host.handleEvent(null, start("c1", { action: "call", chain: [{ method: "click", args: [1, 2] }] }));
		host.handleEvent(null, start("c2", { action: "call", chain: [{ method: "click", args: [3, 4] }] }));
		host.handleEvent(null, end("c1", shotResult(10, 10, "/tmp/a.png")));
		expect(host.store.get("computer:main")?.state).toBe("running");
		host.handleEvent(null, end("c2", shotResult(10, 10, "/tmp/b.png")));
		expect(host.store.get("computer:main")?.state).toBe("done");
	});
});
