/**
 * Error tiles (spec §5.7): a harness-level failure becomes one Stage tile with a big plain headline, one
 * plain-English cause, and the fix key. Model/provider failures, tool crashes and MCP connection failures map
 * here; a command's non-zero exit never does. Unknown errors still get a headline ("Something broke in …"), and
 * the raw message only shows behind `d` (the stack trace goes to the log, never on screen).
 *
 * `classifyStageError` is the mapping; `renderErrorTile` draws the tile body (exact width, exact height);
 * `StageErrors` owns the live tiles: raising from session/MCP events, auto-dismiss on the next success, keys.
 */
import { visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { pixelTextWidth, renderPixelText } from "@oh-my-pi/pi-tui/gk/pixel-font";
import { logger } from "@oh-my-pi/pi-utils";
import { isMcpConnectionStatusEvent } from "../../mcp/startup-events";
import type { TileStore } from "./tiles";
import { resultText } from "./tool-lines";
import { bold, fit, type StageStyle } from "./widgets/common";

/** l log in · m switch model · r retry/reconnect · c copy. */
export type FixKey = "l" | "m" | "r" | "c";

export interface StageErrorInput {
	origin: "model" | "tool" | "mcp";
	/** Provider/tool/server error text (may hold a stack; only the first line reaches the screen, behind `d`). */
	message: string;
	/** HTTP status the provider reported, when known. */
	status?: number;
	/** Provider id, e.g. `anthropic`, `openai-codex`. */
	provider?: string;
	model?: string;
	/** Worker/subagent display name when it is not the main session. */
	agent?: string;
	tool?: string;
	/** MCP server name. */
	server?: string;
}

export interface StageError {
	/** Dedupe and auto-dismiss key: the next success from the same source clears the tile. */
	source: string;
	/** Short upper-case headline (≤ 15 chars). */
	headline: string;
	/** One plain-English line. */
	cause: string;
	/** The one fix action, e.g. `Press l to log in to Anthropic`. */
	fix: string;
	/** Keys the tile answers to, the fix key first. */
	keys: readonly FixKey[];
	origin: StageErrorInput["origin"];
	provider?: string;
	server?: string;
	/** Sanitized message lines for the `d` excerpt. */
	detail: readonly string[];
}

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"openai-codex": "OpenAI Codex",
	google: "Google",
	"google-gemini-cli": "Gemini",
	commandcode: "Command Code",
	openrouter: "OpenRouter",
	xai: "xAI",
	groq: "Groq",
	mistral: "Mistral",
	deepseek: "DeepSeek",
};

export function providerName(id: string | undefined): string {
	if (!id) return "The provider";
	return PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

const KEY_LABEL: Record<FixKey, string> = { l: "log in", m: "switch model", r: "retry", c: "copy" };

/** A JS runtime error or stack frame in a tool result: the tool itself broke, not the model's request. */
const CRASH =
	/\b(TypeError|ReferenceError|RangeError|SyntaxError|InternalError)\b|is not a function|Cannot read propert|undefined is not an object|is not defined\b|Maximum call stack|\n\s+at \S.*\(.*:\d+:\d+\)/;

/** Whether a failed tool result reads as the tool crashing (an exception) rather than a normal tool error. */
export function isToolCrash(text: string): boolean {
	return CRASH.test(text);
}

/** Strip escapes and control characters; drop stack frames. */
function sanitize(message: string): string[] {
	return message
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line.trim() !== "" && !/^\s+at \S/.test(line));
}

interface Mapped {
	headline: string;
	cause: string;
	keys: FixKey[];
}

function mapModel(input: StageErrorInput): Mapped {
	const text = input.message.toLowerCase();
	const p = providerName(input.provider);
	const status = input.status;
	if (
		/usage_limit_reached|usage limit|quota|insufficient_quota|billing|credit balance|out of credits|exceeded your current/.test(
			text,
		)
	) {
		return {
			headline: "OUT OF QUOTA",
			cause: `${p} says this account has hit its usage limit.`,
			keys: ["m", "r", "c"],
		};
	}
	if (
		status === 401 ||
		status === 403 ||
		/unauthori[sz]ed|invalid.{0,24}(api.?key|token|credential)|authentication|not logged in|please log ?in|token.{0,16}expired|invalid_grant|no api key|permission denied/.test(
			text,
		)
	) {
		return { headline: "SIGNED OUT", cause: `${p} rejected the saved credentials.`, keys: ["l", "m", "r", "c"] };
	}
	if (status === 429 || status === 529 || /rate.?limit|too many requests|overloaded|over capacity/.test(text)) {
		return { headline: "RATE LIMITED", cause: `${p} is throttling requests right now.`, keys: ["r", "m", "c"] };
	}
	if (
		/context.{0,24}(length|window|limit)|maximum context|context_length_exceeded|prompt is too long|too many tokens/.test(
			text,
		)
	) {
		return {
			headline: "CONTEXT FULL",
			cause: "The conversation no longer fits this model's context window.",
			keys: ["m", "c"],
		};
	}
	if (
		status === 404 ||
		/model.{0,40}(not found|does not exist|unknown|not supported|unavailable)|no such model|unknown model/.test(text)
	) {
		const model = input.model ? ` ${input.model}` : " this model";
		return { headline: "NO SUCH MODEL", cause: `${p} does not serve${model}.`, keys: ["m", "c"] };
	}
	if (
		/econnrefused|enotfound|econnreset|etimedout|network|fetch failed|socket hang up|timed? ?out|unable to connect|getaddrinfo/.test(
			text,
		)
	) {
		return { headline: "OFFLINE", cause: `Could not reach ${p}.`, keys: ["r", "m", "c"] };
	}
	if (status !== undefined && status >= 500) {
		return { headline: "PROVIDER DOWN", cause: `${p} returned a server error (${status}).`, keys: ["r", "m", "c"] };
	}
	return {
		headline: "SOMETHING BROKE",
		cause: `Something broke in ${p === "The provider" ? "the model call" : p}.`,
		keys: ["r", "m", "c"],
	};
}

function fixLine(key: FixKey, input: StageErrorInput): string {
	switch (key) {
		case "l":
			return `Press l to log in to ${providerName(input.provider)}`;
		case "m":
			return "Press m to switch model";
		case "r":
			return input.origin === "mcp" ? `Press r to reconnect ${input.server ?? "the server"}` : "Press r to retry";
		case "c":
			return "Press c to copy the error";
	}
}

/** Map a failure to its tile. */
export function classifyStageError(input: StageErrorInput): StageError {
	let mapped: Mapped;
	let source: string;
	if (input.origin === "tool") {
		mapped = {
			headline: "TOOL CRASHED",
			cause: `The ${input.tool ?? "tool"} tool broke before it finished.`,
			keys: ["r", "c"],
		};
		source = `tool:${input.agent ?? "main"}:${input.tool ?? "tool"}`;
	} else if (input.origin === "mcp") {
		mapped = {
			headline: "MCP OFFLINE",
			cause: `MCP server ${input.server ?? "?"} could not connect.`,
			keys: ["r", "c"],
		};
		source = `mcp:${input.server ?? "?"}`;
	} else {
		mapped = mapModel(input);
		source = `model:${input.agent ?? "main"}`;
	}
	const cause = input.agent && input.origin !== "mcp" ? `${input.agent}: ${mapped.cause}` : mapped.cause;
	return {
		source,
		headline: mapped.headline,
		cause,
		fix: fixLine(mapped.keys[0]!, input),
		keys: mapped.keys,
		origin: input.origin,
		provider: input.provider,
		server: input.server,
		detail: sanitize(input.message),
	};
}

/** Plain text a `c` copy puts on the clipboard. */
export function errorClipboardText(error: StageError): string {
	return [`${error.headline}: ${error.cause}`, ...error.detail].join("\n");
}

/** Glitch-in length; motion off draws the settled tile at once. */
export const GLITCH_MS = 300;
const SCRAMBLE = "▓▒░#%&@$/\\";
const HEADLINE_PIXEL_MIN = 60;

export interface ErrorTileView {
	error: StageError;
	/** ms since the tile appeared. */
	age: number;
	motion: boolean;
	/** `d` toggled the log excerpt. */
	expanded: boolean;
	/** Log file the full error and stack went to. */
	logPath?: string;
}

function center(text: string, width: number): string {
	const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
	return `${" ".repeat(pad)}${text}`;
}

/** Scramble a share of each row's visible cells; same age and row give the same noise. */
function glitch(rows: string[], width: number, age: number, style: StageStyle): string[] {
	const share = 1 - age / GLITCH_MS;
	return rows.map((row, r) => {
		const plain = [...Bun.stripANSI(row).padEnd(width)].slice(0, width);
		let seed = (r + 1) * 7919 + Math.floor(age / 33) * 104729;
		const next = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const out = plain.map(ch =>
			next() < share * (ch === " " ? 0.15 : 0.7) ? SCRAMBLE[Math.floor(next() * SCRAMBLE.length)]! : ch,
		);
		return style("error", out.join(""));
	});
}

/** The tile body: exactly `height` rows of exactly `width` columns. */
export function renderErrorTile(view: ErrorTileView, width: number, height: number, style: StageStyle): string[] {
	if (width <= 0 || height <= 0) return [];
	const s = style;
	const { error } = view;
	const rows: string[] = [""];
	const pixelWidth = pixelTextWidth(error.headline, 1, false);
	if (width >= HEADLINE_PIXEL_MIN && pixelWidth + 2 <= width && height >= 12) {
		for (const line of renderPixelText(error.headline, { scale: 1, shadow: false })) {
			rows.push(center(s("error", Bun.stripANSI(line)), width));
		}
	} else {
		rows.push(center(s("error", bold(error.headline)), width));
	}
	rows.push("");
	for (const line of wrapTextWithAnsi(error.cause, Math.max(1, width - 4))) rows.push(center(s("text", line), width));
	rows.push("");
	// `Press l to log in to Anthropic`: the key itself in bold gold.
	rows.push(
		center(`${s("text", "Press ")}${s("accent", bold(error.keys[0]!))}${s("text", error.fix.slice(7))}`, width),
	);
	const hints = [
		...error.keys.map(key => `${s("accent", key)} ${s("muted", KEY_LABEL[key])}`),
		`${s("accent", "d")} ${s("muted", view.expanded ? "hide details" : "details")}`,
		`${s("accent", "x")} ${s("muted", "dismiss")}`,
	];
	rows.push("");
	rows.push(center(hints.join(s("dim", "  ·  ")), width));
	if (view.expanded) {
		rows.push("");
		if (view.logPath) rows.push(`  ${s("dim", "log")} ${s("muted", view.logPath)}`);
		for (const line of error.detail) {
			for (const part of wrapTextWithAnsi(line, Math.max(1, width - 4))) rows.push(`  ${s("muted", part)}`);
		}
	}
	const framed = rows.slice(0, height).map(row => fit(row, width));
	while (framed.length < height) framed.push(" ".repeat(width));
	if (view.motion && view.age < GLITCH_MS) return glitch(framed, width, view.age, s).map(row => fit(row, width));
	return framed;
}

/** What the tile keys do; the host wires them to omp (login selector, model selector, retry, clipboard). */
export interface ErrorActions {
	login(provider: string | undefined): void;
	switchModel(): void;
	/** Retry the failed turn, or reconnect the MCP server. */
	retry(error: StageError): void;
	copy(text: string): void;
}

/** The slice of a session event error tiles read (an `AgentSessionEvent` satisfies it). */
export type ErrorEvent =
	| {
			type: "message_end";
			message: {
				role: string;
				stopReason?: string;
				errorMessage?: string;
				errorStatus?: number;
				provider?: string;
				model?: string;
			};
	  }
	| { type: "tool_execution_end"; toolName: string; result: unknown; isError?: boolean }
	| { type: string };

/** A user's Esc/Ctrl-C reads as `aborted` too; that is not a failure. */
const USER_ABORT = /abort|cancel|interrupt/i;

interface Live {
	error: StageError;
	expanded: boolean;
}

export class StageErrors {
	readonly #store: TileStore;
	readonly #actions: ErrorActions | undefined;
	readonly #logPath: (() => string | undefined) | undefined;
	readonly #live = new Map<string, Live>();
	readonly #bySource = new Map<string, string>();
	#seq = 0;

	constructor(opts: { store: TileStore; actions?: ErrorActions; logPath?: () => string | undefined }) {
		this.#store = opts.store;
		this.#actions = opts.actions;
		this.#logPath = opts.logPath;
	}

	/** Open (or refresh) the tile for a failure and focus it so its keys answer. Returns the tile id. */
	raise(input: StageErrorInput, parentId: string | null = null): string {
		const error = classifyStageError(input);
		logger.error("Stage error tile", { source: error.source, headline: error.headline, message: input.message });
		const existing = this.#bySource.get(error.source);
		if (existing && this.#store.get(existing) && !this.#store.get(existing)!.dismissed) {
			this.#live.set(existing, { error, expanded: this.#live.get(existing)?.expanded ?? false });
			this.#store.touch(existing);
			return existing;
		}
		if (existing) this.#drop(existing);
		const id = `err:${++this.#seq}`;
		const subject = input.origin === "tool" ? input.tool : input.origin === "mcp" ? input.server : input.provider;
		this.#store.add({
			id,
			kind: "error",
			parentId,
			state: "error",
			title: [input.agent ?? (input.origin === "mcp" ? "mcp" : "main"), subject].filter(Boolean).join(" · "),
		});
		this.#live.set(id, { error, expanded: false });
		this.#bySource.set(error.source, id);
		this.#store.focus(id);
		return id;
	}

	/** The same source succeeded: its tile goes away. Returns whether one did. */
	resolve(source: string): boolean {
		const id = this.#bySource.get(source);
		if (!id) return false;
		this.#drop(id);
		return true;
	}

	#drop(id: string): void {
		const live = this.#live.get(id);
		if (live && this.#bySource.get(live.error.source) === id) this.#bySource.delete(live.error.source);
		this.#live.delete(id);
		if (this.#store.get(id)) this.#store.remove(id);
	}

	/** Raise or resolve from one session event (`agent` = worker name, `undefined` = main). Returns whether a tile changed. */
	observe(agent: string | undefined, event: ErrorEvent, parentId: string | null = null): boolean {
		if (event.type === "message_end" && "message" in event) {
			const m = event.message;
			if (m.role !== "assistant") return false;
			const failed =
				m.stopReason === "error" ||
				(m.stopReason === "aborted" && m.errorMessage !== undefined && !USER_ABORT.test(m.errorMessage));
			if (failed) {
				this.raise(
					{
						origin: "model",
						message: m.errorMessage ?? "The model call failed without a message.",
						status: m.errorStatus,
						provider: m.provider,
						model: m.model,
						agent,
					},
					parentId,
				);
				return true;
			}
			return m.stopReason !== "aborted" && this.resolve(`model:${agent ?? "main"}`);
		}
		if (event.type === "tool_execution_end" && "toolName" in event) {
			if (!event.isError) return this.resolve(`tool:${agent ?? "main"}:${event.toolName}`);
			// A command's non-zero exit is the command pane's business, never an error tile.
			if (event.toolName === "bash") return false;
			const text = resultText(event.result);
			if (!isToolCrash(text)) return false;
			this.raise({ origin: "tool", message: text, tool: event.toolName, agent }, parentId);
			return true;
		}
		return false;
	}

	/** An `mcp:connection-status` bus event: `failed` opens the server's tile, `connected` clears it. */
	observeMcp(data: unknown): boolean {
		if (!isMcpConnectionStatusEvent(data)) return false;
		if (data.type === "failed") {
			this.raise({ origin: "mcp", message: data.error, server: data.serverName });
			return true;
		}
		return data.type === "connected" && this.resolve(`mcp:${data.serverName}`);
	}

	has(id: string): boolean {
		return this.#live.has(id);
	}

	/** Whether a tile is still glitching in (the host keeps frames coming until it settles). */
	animating(now: number): boolean {
		for (const id of this.#live.keys()) {
			const tile = this.#store.get(id);
			if (tile && now - tile.createdAt < GLITCH_MS) return true;
		}
		return false;
	}

	rows(id: string, width: number, height: number, now: number, motion: boolean, style: StageStyle): string[] {
		const live = this.#live.get(id);
		const tile = this.#store.get(id);
		if (!live || !tile) return [];
		return renderErrorTile(
			{ error: live.error, age: now - tile.createdAt, motion, expanded: live.expanded, logPath: this.#logPath?.() },
			width,
			height,
			style,
		);
	}

	/** A key on a focused error tile; returns whether it was one of the tile's keys. */
	key(id: string, data: string): boolean {
		const live = this.#live.get(id);
		if (!live) return false;
		switch (data) {
			case "x":
				this.#store.dismiss(id);
				this.#store.focus(null);
				return true;
			case "d":
				live.expanded = !live.expanded;
				this.#store.touch(id);
				return true;
			case "l":
			case "m":
			case "r":
			case "c": {
				if (!live.error.keys.includes(data)) return false;
				const actions = this.#actions;
				if (data === "l") actions?.login(live.error.provider);
				else if (data === "m") actions?.switchModel();
				else if (data === "r") actions?.retry(live.error);
				else actions?.copy(errorClipboardText(live.error));
				return true;
			}
			default:
				return false;
		}
	}
}
