import { describe, expect, it } from "bun:test";
import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import {
	classifyStageError,
	type ErrorActions,
	GLITCH_MS,
	isToolCrash,
	renderErrorTile,
	StageErrors,
} from "../../../src/gk/stage/error-tile";
import { StageHost } from "../../../src/gk/stage/host";
import { plainStyle } from "../../../src/gk/stage/style";
import { TileStore } from "../../../src/gk/stage/tiles";
import type { AgentSessionEvent } from "../../../src/session/agent-session-events";
import { identity } from "./widgets/helpers";

const STACK = "TypeError: x is not a function\n    at run (/src/tools/foo.ts:12:5)\n    at main (/src/index.ts:3:1)";

function assistantEnd(extra: Record<string, unknown>): AgentSessionEvent {
	return {
		type: "message_end",
		message: { role: "assistant", content: [], ...extra },
	} as unknown as AgentSessionEvent;
}

describe("classifyStageError", () => {
	it.each([
		[
			{
				message: "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
				provider: "openai-codex",
			},
			"OUT OF QUOTA",
			"m",
			"Press m to switch model",
		],
		[
			{ message: "401 Unauthorized: invalid x-api-key", status: 401, provider: "anthropic" },
			"SIGNED OUT",
			"l",
			"Press l to log in to Anthropic",
		],
		[
			{ message: "429 Too Many Requests", status: 429, provider: "anthropic" },
			"RATE LIMITED",
			"r",
			"Press r to retry",
		],
		[
			{ message: "prompt is too long: 210000 tokens > 200000 maximum", provider: "anthropic" },
			"CONTEXT FULL",
			"m",
			"Press m to switch model",
		],
		[
			{ message: "model: nonexistent-x not found", status: 404, provider: "anthropic", model: "nonexistent-x" },
			"NO SUCH MODEL",
			"m",
			"Press m to switch model",
		],
		[{ message: "fetch failed: ECONNREFUSED 127.0.0.1:443", provider: "openai" }, "OFFLINE", "r", "Press r to retry"],
		[{ message: "Internal server error", status: 503, provider: "google" }, "PROVIDER DOWN", "r", "Press r to retry"],
		[{ message: "weird", provider: "anthropic" }, "SOMETHING BROKE", "r", "Press r to retry"],
	])("%o → %s", (input, headline, key, fix) => {
		const error = classifyStageError({ origin: "model", ...input });
		expect(error.headline).toBe(headline);
		expect<string | undefined>(error.keys[0]).toBe(key);
		expect(error.fix).toBe(fix);
		expect(error.keys).toContain("c");
		expect(error.headline.length).toBeLessThanOrEqual(15);
	});

	it("names the worker, the tool and the MCP server", () => {
		expect(classifyStageError({ origin: "model", message: "429", status: 429, agent: "ada" }).cause).toBe(
			"ada: The provider is throttling requests right now.",
		);
		const tool = classifyStageError({ origin: "tool", message: STACK, tool: "grep" });
		expect(tool).toMatchObject({ headline: "TOOL CRASHED", source: "tool:main:grep", fix: "Press r to retry" });
		expect(tool.detail).toEqual(["TypeError: x is not a function"]);
		const mcp = classifyStageError({ origin: "mcp", message: "spawn ENOENT", server: "context7" });
		expect(mcp).toMatchObject({
			headline: "MCP OFFLINE",
			source: "mcp:context7",
			fix: "Press r to reconnect context7",
		});
	});

	it("tells a tool crash from an ordinary tool error", () => {
		expect(isToolCrash(STACK)).toBe(true);
		expect(isToolCrash("Cannot read properties of undefined (reading 'x')")).toBe(true);
		expect(isToolCrash("File not found: src/a.ts")).toBe(false);
		expect(isToolCrash("Edit rejected: hash mismatch")).toBe(false);
	});
});

describe("StageErrors", () => {
	function setup() {
		let now = 1000;
		const store = new TileStore({ now: () => now });
		const calls: string[] = [];
		const actions: ErrorActions = {
			login: p => calls.push(`login ${p}`),
			switchModel: () => calls.push("model"),
			retry: e => calls.push(`retry ${e.source}`),
			copy: t => calls.push(`copy ${t.split("\n")[0]}`),
		};
		const errors = new StageErrors({ store, actions, logPath: () => "/tmp/gk.log" });
		return { store, errors, calls, advance: (ms: number) => (now += ms) };
	}

	it("opens a focused tile for a failed turn and clears it when the same source next succeeds", () => {
		const { store, errors } = setup();
		expect(
			errors.observe(undefined, {
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "429", errorStatus: 429 },
			}),
		).toBe(true);
		const tile = store.all().find(t => t.kind === "error")!;
		expect(tile).toMatchObject({ state: "error", focused: true, title: "main" });
		// The same failure again refreshes the tile instead of stacking another.
		errors.observe(undefined, {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "429", errorStatus: 429 },
		});
		expect(store.all().filter(t => t.kind === "error")).toHaveLength(1);
		expect(
			errors.observe(undefined, { type: "message_end", message: { role: "assistant", stopReason: "stop" } }),
		).toBe(true);
		expect(store.all().filter(t => t.kind === "error")).toHaveLength(0);
	});

	it("never opens a tile for a user abort, a command's non-zero exit or an ordinary tool error", () => {
		const { store, errors } = setup();
		errors.observe(undefined, {
			type: "message_end",
			message: { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" },
		});
		errors.observe(undefined, {
			type: "tool_execution_end",
			toolName: "bash",
			isError: true,
			result: { content: [{ type: "text", text: STACK }] },
		});
		errors.observe(undefined, {
			type: "tool_execution_end",
			toolName: "read",
			isError: true,
			result: { content: [{ type: "text", text: "File not found" }] },
		});
		expect(store.all().filter(t => t.kind === "error")).toHaveLength(0);
		errors.observe("ada", {
			type: "tool_execution_end",
			toolName: "grep",
			isError: true,
			result: { content: [{ type: "text", text: STACK }] },
		});
		expect(store.all().find(t => t.kind === "error")?.title).toBe("ada · grep");
	});

	it("follows MCP connection status", () => {
		const { store, errors } = setup();
		expect(errors.observeMcp({ type: "failed", serverName: "context7", error: "spawn ENOENT" })).toBe(true);
		expect(store.all().find(t => t.kind === "error")?.title).toBe("mcp · context7");
		expect(errors.observeMcp({ type: "bogus" })).toBe(false);
		expect(errors.observeMcp({ type: "connected", serverName: "context7" })).toBe(true);
		expect(store.all().filter(t => t.kind === "error")).toHaveLength(0);
	});

	it("routes l/m/r/c to the fix actions, d to the log excerpt and x to dismiss", () => {
		const { store, errors, calls, advance } = setup();
		const id = errors.raise({
			origin: "model",
			message: `401 Unauthorized\n${STACK}`,
			status: 401,
			provider: "anthropic",
		});
		for (const key of ["l", "m", "r", "c"]) expect(errors.key(id, key)).toBe(true);
		expect(calls).toEqual([
			"login anthropic",
			"model",
			"retry model:main",
			"copy SIGNED OUT: Anthropic rejected the saved credentials.",
		]);
		expect(errors.key(id, "q")).toBe(false);
		advance(GLITCH_MS);
		const closed = errors.rows(id, 80, 20, 1000 + GLITCH_MS, true, identity).join("\n");
		expect(closed).not.toContain("401 Unauthorized");
		expect(errors.key(id, "d")).toBe(true);
		const open = errors.rows(id, 80, 20, 1000 + GLITCH_MS, true, identity).join("\n");
		expect(open).toContain("log /tmp/gk.log");
		expect(open).toContain("401 Unauthorized");
		// The stack trace stays in the log.
		expect(open).not.toContain("at run (");
		expect(errors.key(id, "x")).toBe(true);
		expect(store.get(id)?.dismissed).toBe(true);
		// A key the tile does not offer (no `l` for a rate limit) is not consumed.
		const rate = errors.raise({ origin: "model", message: "429", status: 429, agent: "ada" });
		expect(errors.key(rate, "l")).toBe(false);
	});
});

describe("renderErrorTile", () => {
	const error = classifyStageError({
		origin: "model",
		message: "401 Unauthorized",
		status: 401,
		provider: "anthropic",
	});
	for (const [width, height] of [
		[100, 16],
		[60, 12],
		[40, 9],
		[12, 3],
	] as const) {
		it(`is exactly ${height}×${width}, settled and glitching`, () => {
			for (const age of [0, GLITCH_MS / 2, GLITCH_MS]) {
				const rows = renderErrorTile({ error, age, motion: true, expanded: false }, width, height, plainStyle);
				expect(rows).toHaveLength(height);
				for (const row of rows) expect(visibleWidth(row)).toBe(width);
			}
		});
	}

	it("draws a block-letter headline when wide, bold text when narrow, and the fix key line", () => {
		const wide = Bun.stripANSI(
			renderErrorTile({ error, age: GLITCH_MS, motion: true, expanded: false }, 100, 16, plainStyle).join("\n"),
		);
		expect(wide).toContain("█");
		expect(wide).toContain("Anthropic rejected the saved credentials.");
		expect(wide).toContain("Press l to log in to Anthropic");
		expect(wide).toMatch(
			/l log in {2}· {2}m switch model {2}· {2}r retry {2}· {2}c copy {2}· {2}d details {2}· {2}x dismiss/,
		);
		const narrow = renderErrorTile({ error, age: 0, motion: false, expanded: false }, 40, 9, plainStyle).join("\n");
		expect(narrow).toContain("SIGNED OUT");
		expect(narrow).not.toContain("█");
	});
});

describe("StageHost error tiles", () => {
	it("opens an error tile from a failed turn with a red frame at 212×58 and dismisses it with x", () => {
		let input: ((data: string) => unknown) | undefined;
		let now = 5000;
		const host = new StageHost({
			ui: {
				terminal: { columns: 212, rows: 58 },
				requestRender: () => {},
				showOverlay: () => ({ hide() {}, setHidden() {}, isHidden: () => false }) as never,
				addInputListener: listener => {
					input = listener as (data: string) => unknown;
					return () => {};
				},
				hasOverlay: () => false,
			},
			session: () => ({
				subscribe: () => () => {},
				isStreaming: false,
				model: { id: "claude-haiku-4-5" },
				messages: [],
				getSessionStats: () => ({ cost: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } }),
			}),
			sessionId: () => "abc123",
			blocks: () => [] as Component[],
			chrome: () => [] as Component[],
			isAssistant: () => false,
			cwd: "/tmp/x",
			git: null,
			timers: false,
			motion: false,
			now: () => now,
			todaySpend: null,
			style: plainStyle,
		});
		host.start();
		host.handleEvent(
			null,
			assistantEnd({
				stopReason: "error",
				errorMessage: "Codex error event: usage_limit_reached",
				provider: "openai-codex",
			}),
		);
		now += 1000;
		const rows = host.render(212, 58);
		expect(rows).toHaveLength(58);
		for (const row of rows) expect(visibleWidth(row)).toBe(212);
		const text = Bun.stripANSI(rows.join("\n"));
		expect(text).toMatch(/0\.1 error · main · openai-codex/);
		expect(text).toContain("OpenAI Codex says this account has hit its usage limit.");
		expect(text).toContain("Press m to switch model");
		input?.("x");
		expect(Bun.stripANSI(host.render(212, 58).join("\n"))).not.toContain("usage limit");
	});
});
