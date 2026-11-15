/**
 * Live transcript of one agent for its Stage pane: thinking and reply text mirrored from the session's
 * `message_update` deltas, tool calls (shared `ToolRecord`s whose args fill in while they stream) and
 * nested subagents, in arrival order. Bounded: at most {@link FEED_MAX_ENTRIES} entries, each text body
 * capped at {@link FEED_MAX_TEXT} characters (the tail is kept).
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { resultText, type ToolRecord } from "./tool-lines";

export const FEED_MAX_ENTRIES = 400;
export const FEED_MAX_TEXT = 16_000;
/** Transcript messages replayed when an agent's session is first seen mid-run. */
const BACKFILL_MESSAGES = 120;

export interface FeedThinking {
	kind: "thinking";
	text: string;
	startedAt: number;
	endedAt: number | null;
}

export interface FeedText {
	kind: "text";
	text: string;
	at: number;
	done: boolean;
}

export interface FeedTool {
	kind: "tool";
	record: ToolRecord;
}

export interface FeedAgent {
	kind: "agent";
	agentId: string;
	at: number;
}

export type FeedEntry = FeedThinking | FeedText | FeedTool | FeedAgent;

/** The slice of a session event the feed reads (an `AgentSessionEvent` satisfies it). */
export type FeedEvent =
	| { type: "message_start" | "message_end"; message: { role: string } }
	| {
			type: "message_update";
			message: { role: string };
			assistantMessageEvent: { type: string; contentIndex?: number; delta?: string; content?: unknown };
	  };

function capped(text: string): string {
	return text.length > FEED_MAX_TEXT ? text.slice(text.length - FEED_MAX_TEXT) : text;
}

export class AgentFeed {
	readonly entries: FeedEntry[] = [];
	readonly #tools = new Set<string>();
	readonly #agents = new Set<string>();
	/** Thinking/text entries of the in-flight assistant message by content index. */
	#open = new Map<number, FeedThinking | FeedText>();

	#push(entry: FeedEntry): void {
		this.entries.push(entry);
		if (this.entries.length > FEED_MAX_ENTRIES) {
			const dropped = this.entries.splice(0, this.entries.length - FEED_MAX_ENTRIES);
			for (const e of dropped) {
				if (e.kind === "tool") this.#tools.delete(e.record.id);
				else if (e.kind === "agent") this.#agents.delete(e.agentId);
			}
		}
	}

	/** Add a call once (the record object is shared with the host and fills in as it streams). */
	addTool(record: ToolRecord): void {
		if (this.#tools.has(record.id)) return;
		this.#tools.add(record.id);
		this.#push({ kind: "tool", record });
	}

	addAgent(agentId: string, at: number): void {
		if (this.#agents.has(agentId)) return;
		this.#agents.add(agentId);
		this.#push({ kind: "agent", agentId, at });
	}

	/**
	 * Replay a transcript (an agent whose session the Stage first sees mid-run): settled thinking and
	 * text, and its calls with their results. A feed that already mirrors a transcript is left alone.
	 * `adopt` registers each call with the host and returns the record to share (an existing one for an
	 * id it already tracks).
	 */
	backfill(messages: readonly unknown[], adopt: (record: ToolRecord) => ToolRecord): void {
		if (this.entries.some(e => e.kind !== "agent")) return;
		const calls = new Map<string, ToolRecord>();
		for (const message of messages.slice(-BACKFILL_MESSAGES)) {
			if (!isRecord(message)) continue;
			const at = typeof message.timestamp === "number" ? message.timestamp : 0;
			if (message.role === "toolResult" && typeof message.toolCallId === "string") {
				const record = calls.get(message.toolCallId);
				if (!record || record.endedAt !== null) continue;
				record.endedAt = Math.max(record.startedAt, at);
				record.isError = message.isError === true;
				record.output = resultText(message);
				record.details = message.details;
				continue;
			}
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			const end = at + (typeof message.duration === "number" ? message.duration : 0);
			for (const part of message.content) {
				if (!isRecord(part)) continue;
				if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
					this.#push({ kind: "thinking", text: capped(part.thinking), startedAt: at, endedAt: end });
				} else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
					this.#push({ kind: "text", text: capped(part.text), at, done: true });
				} else if (part.type === "toolCall" && typeof part.id === "string") {
					const record = adopt({
						id: part.id,
						name: typeof part.name === "string" ? part.name : "tool",
						args: isRecord(part.arguments) ? part.arguments : {},
						agentId: null,
						startedAt: at,
						endedAt: null,
						isError: false,
						output: "",
						details: undefined,
					});
					calls.set(part.id, record);
					this.addTool(record);
				}
			}
		}
	}

	#closeOpen(now: number): void {
		for (const entry of this.#open.values()) {
			if (entry.kind === "thinking") entry.endedAt ??= now;
			else entry.done = true;
		}
		this.#open = new Map();
	}

	/** Mirror one session event; returns whether anything visible changed. */
	apply(event: FeedEvent, now: number): boolean {
		if (event.message.role !== "assistant") return false;
		if (event.type !== "message_update") {
			// A new message, or the end of this one: whatever was streaming is finished.
			const had = this.#open.size > 0;
			this.#closeOpen(now);
			return had;
		}
		const e = event.assistantMessageEvent;
		const index = e.contentIndex ?? -1;
		switch (e.type) {
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end": {
				let entry = this.#open.get(index);
				if (!entry || entry.kind !== "thinking") {
					entry = { kind: "thinking", text: "", startedAt: now, endedAt: null };
					this.#open.set(index, entry);
					this.#push(entry);
				}
				if (e.type === "thinking_delta" && e.delta) entry.text = capped(entry.text + e.delta);
				if (e.type === "thinking_end") {
					if (!entry.text && typeof e.content === "string") entry.text = capped(e.content);
					entry.endedAt = now;
				}
				return true;
			}
			case "text_start":
			case "text_delta":
			case "text_end": {
				let entry = this.#open.get(index);
				if (!entry || entry.kind !== "text") {
					entry = { kind: "text", text: "", at: now, done: false };
					this.#open.set(index, entry);
					this.#push(entry);
				}
				if (e.type === "text_delta" && e.delta) entry.text = capped(entry.text + e.delta);
				if (e.type === "text_end") {
					if (!entry.text && typeof e.content === "string") entry.text = capped(e.content);
					entry.done = true;
				}
				return true;
			}
			default:
				return false;
		}
	}
}
