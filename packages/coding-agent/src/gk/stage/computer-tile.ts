/**
 * Computer-use tile body (spec §5.10): the latest screenshot, a caption for the action in flight, and a
 * tail of the action log. One tile per calling agent; each `computer` call appends to its log.
 *
 * Graphics: kitty Unicode placeholders compose as text inside a tile, so they are the only inline
 * image path here. Other terminals (and sixel, which needs the whole screen) get a text placeholder
 * with the screenshot size and the saved PNG path.
 */
import { Image, ImageProtocol, TERMINAL, visibleWidth } from "@oh-my-pi/pi-tui";
import { isRecord } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import { cfgTerminalShowImages } from "../../modes/settings";
import { clockTime } from "./tool-lines";
import { fit, glyph, type StageStyle } from "./widgets/common";

/** Log rows under the image; the image gets the rest of the tile. */
const LOG_ROWS = 3;
/** Tiles shorter than this drop the log and keep the image plus caption. */
const LOG_MIN_HEIGHT = 6;
/** Log entries kept per tile; the tail is what renders. */
const LOG_MAX = 20;
const CAPTION_MAX = 80;

export type ComputerLogState = "running" | "done" | "error";

export interface ComputerShot {
	data: string;
	mimeType: string;
	widthPx: number;
	heightPx: number;
	path?: string;
}

export interface ComputerLogEntry {
	callId: string;
	at: number;
	caption: string;
	state: ComputerLogState;
}

export interface ComputerBodyOptions {
	/** Draw the screenshot as a kitty graphic (placeholders); otherwise the text placeholder. */
	graphics: boolean;
	style: StageStyle;
	requestRender?: () => void;
}

/** Graphics are kitty-only and respect `terminal.showImages`. */
export function computerGraphicsAvailable(): boolean {
	return TERMINAL.imageProtocol === ImageProtocol.Kitty && cfgTerminalShowImages.get(settings);
}

/** Tile id for the agent that owns the computer calls (`null` = main). */
export function computerTileId(agentId: string | null): string {
	return `computer:${agentId ?? "main"}`;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Human caption for one computer call: `click (812, 404)`, `type "hello"`, `key cmd+s`. */
export function computerCaption(args: unknown): string {
	if (!isRecord(args)) return "computer";
	if (args.action === "run") {
		if (typeof args.fn === "string" && args.fn.trim()) return "run fn";
		if (typeof args.code === "string" && args.code.trim())
			return oneLine(args.code.trim().split("\n", 1)[0] ?? "", CAPTION_MAX);
		return "run";
	}
	if (args.action !== "call" || !Array.isArray(args.chain) || args.chain.length === 0) {
		return typeof args.action === "string" ? args.action : "computer";
	}
	const step = args.chain[args.chain.length - 1];
	if (!isRecord(step) || typeof step.method !== "string") return "computer";
	const params: unknown[] = Array.isArray(step.args) ? step.args : [];
	const [first, second] = params;
	switch (step.method) {
		case "click":
		case "doubleClick":
		case "rightClick":
		case "move":
			if (typeof first === "number" && typeof second === "number") return `${step.method} (${first}, ${second})`;
			break;
		case "type":
		case "setValue":
		case "clipboard.write":
			if (typeof first === "string") return `${step.method === "setValue" ? "set" : "type"} "${oneLine(first, 48)}"`;
			break;
		case "press":
			if (typeof first === "string") return `key ${first}`;
			break;
	}
	const rendered = params.map(p => (typeof p === "string" ? JSON.stringify(oneLine(p, 24)) : JSON.stringify(p)));
	return oneLine(`${step.method}(${rendered.join(", ")})`, CAPTION_MAX);
}

/** Latest screenshot in a computer tool result, sized by the last screenshot entry in `details`. */
export function computerShotOf(result: unknown): ComputerShot | undefined {
	if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
	let data: string | undefined;
	let mimeType = "image/png";
	for (const block of result.content) {
		if (isRecord(block) && block.type === "image" && typeof block.data === "string") {
			data = block.data;
			if (typeof block.mimeType === "string") mimeType = block.mimeType;
		}
	}
	if (data === undefined) return undefined;
	const details = isRecord(result.details) ? result.details : undefined;
	const shots = details && Array.isArray(details.screenshots) ? details.screenshots : [];
	const last: unknown = shots.at(-1);
	const record = isRecord(last) ? last : undefined;
	return {
		data,
		mimeType,
		widthPx: typeof record?.width === "number" ? record.width : 0,
		heightPx: typeof record?.height === "number" ? record.height : 0,
		path: typeof record?.path === "string" ? record.path : undefined,
	};
}

const IDENTITY_THEME = { fallbackColor: (text: string) => text };

/** Per-tile state: the action log and the latest screenshot. The graphic is cached per shot and size. */
export class ComputerTileState {
	readonly #log: ComputerLogEntry[] = [];
	#shot: ComputerShot | undefined;
	#graphic: { shot: ComputerShot; width: number; rows: number; image: Image } | undefined;

	get log(): readonly ComputerLogEntry[] {
		return this.#log;
	}

	get shot(): ComputerShot | undefined {
		return this.#shot;
	}

	/** Whether any call is still in flight (the tile stays running until the last one ends). */
	get busy(): boolean {
		return this.#log.some(entry => entry.state === "running");
	}

	/** The action in flight, or the most recent one once everything has finished. */
	get current(): ComputerLogEntry | undefined {
		return this.#log.findLast(entry => entry.state === "running") ?? this.#log.at(-1);
	}

	begin(callId: string, caption: string, at: number): void {
		this.#log.push({ callId, at, caption, state: "running" });
		if (this.#log.length > LOG_MAX) this.#log.splice(0, this.#log.length - LOG_MAX);
	}

	finish(callId: string, outcome: { isError: boolean; shot?: ComputerShot }): void {
		const entry = this.#log.findLast(e => e.callId === callId);
		if (entry) entry.state = outcome.isError ? "error" : "done";
		if (outcome.shot) this.#shot = outcome.shot;
	}

	graphic(width: number, rows: number, requestRender: (() => void) | undefined): Image | undefined {
		const shot = this.#shot;
		if (!shot) return undefined;
		const cached = this.#graphic;
		if (cached && cached.shot === shot && cached.width === width && cached.rows === rows) return cached.image;
		const image = new Image(
			shot.data,
			shot.mimeType,
			IDENTITY_THEME,
			{ maxWidthCells: width, maxHeightCells: rows, requestRender },
			{ widthPx: shot.widthPx, heightPx: shot.heightPx },
		);
		this.#graphic = { shot, width, rows, image };
		return image;
	}
}

/** Pad or cut `lines` to exactly `rows` rows of `width` columns. */
function fitRows(lines: readonly string[], width: number, rows: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < rows; i++) {
		const line = lines[i] ?? "";
		out.push(visibleWidth(line) > width ? fit(line, width) : line + " ".repeat(width - visibleWidth(line)));
	}
	return out;
}

function imageArea(state: ComputerTileState, width: number, rows: number, options: ComputerBodyOptions): string[] {
	const s = options.style;
	const shot = state.shot;
	if (shot && options.graphics) {
		const image = state.graphic(width, rows, options.requestRender);
		if (image) return fitRows(image.render(width), width, rows);
	}
	const lines: string[] = [];
	if (!shot) lines.push(s("muted", "no screenshot yet"));
	else {
		lines.push(s("muted", `screenshot ${shot.widthPx}×${shot.heightPx}`));
		if (shot.path) lines.push(s("dim", fit(`→ ${shot.path}`, width)));
	}
	return fitRows(lines, width, rows);
}

/**
 * Tile body for a `w`×`h` inner rect: the image area (caption on its last row) above the log tail.
 * Always returns exactly `h` rows, each exactly `w` columns.
 */
export function renderComputerBody(
	state: ComputerTileState,
	w: number,
	h: number,
	options: ComputerBodyOptions,
): string[] {
	if (w <= 0 || h <= 0) return [];
	const s = options.style;
	const logRows = h >= LOG_MIN_HEIGHT ? LOG_ROWS : 0;
	const imageRows = h - logRows;
	const rows = imageArea(state, w, imageRows, options);

	const current = state.current;
	if (current && imageRows > 0) {
		const mark =
			current.state === "running"
				? s("accent", "▶")
				: current.state === "error"
					? s("error", "✗")
					: s("success", "✓");
		rows[imageRows - 1] = fit(`${mark} ${s("text", current.caption)}`, w);
	}

	const tail = state.log.slice(-logRows);
	const pad = logRows - tail.length;
	for (let i = 0; i < logRows; i++) {
		const entry = i < pad ? undefined : tail[i - pad];
		if (!entry) {
			rows.push(" ".repeat(w));
			continue;
		}
		const stateGlyph = entry.state === "error" ? "failed" : entry.state;
		rows.push(fit(`${s("dim", clockTime(entry.at))} ${glyph(stateGlyph, s)} ${s("muted", entry.caption)}`, w));
	}
	return rows;
}
