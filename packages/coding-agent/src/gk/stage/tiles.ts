/**
 * Stage tile model (spec §5.5): every live thing on the Stage is a tile with a lineage parent,
 * a lifecycle state and activity timestamps. Short-lived tiles demote to one-line chips on a
 * timer; the clock is injected so the rules stay deterministic under test.
 */

export type TileKind =
	| "transcript"
	| "agent"
	| "command"
	| "web"
	| "error"
	| "diff"
	| "git"
	| "dag"
	| "timeline"
	| "computer"
	| "pty"
	| "proc"
	| "telemetry"
	| "events"
	| "todo";

export type TileState = "running" | "idle" | "done" | "error";

/** Kinds that live in the right-hand widget column when the terminal is wide enough. */
export const WIDGET_KINDS: ReadonlySet<TileKind> = new Set<TileKind>(["proc", "telemetry", "todo", "dag", "git", "events"]);

/** Top-to-bottom order of widgets in the widget column (matches the reference screens). */
export const WIDGET_ORDER: readonly TileKind[] = ["proc", "telemetry", "todo", "dag", "git", "events"];

/** Chip demotion delays in ms (spec §5.5 "Chips"). */
export const CHIP_DELAY = {
	command: 4_000,
	commandFailed: 8_000,
	web: 4_000,
	diff: 10_000,
	nestedAgent: 10_000,
	worker: 30_000,
	pty: 10_000,
} as const;

/** How long a `git` tile counts as live after its last change. */
export const GIT_LIVE_MS = 8_000;

export interface Tile {
	id: string;
	kind: TileKind;
	parentId: string | null;
	state: TileState;
	title: string;
	createdAt: number;
	lastActivityAt: number;
	endedAt: number | null;
	/** Exit code for `command`/`pty` tiles; non-zero lingers longer but is not an error tile. */
	exitCode: number | null;
	focused: boolean;
	pinned: boolean;
	/** Error tiles only demote after the user dismisses them. */
	dismissed: boolean;
	/** Set when a chip was restored by the user; exempts the tile from auto-demotion until its state changes. */
	restoredAt: number | null;
	/** Bumped on every mutation; renderers cache on `(w, h, version)`. */
	version: number;
}

export interface TileInit {
	id: string;
	kind: TileKind;
	parentId?: string | null;
	state?: TileState;
	title?: string;
	exitCode?: number | null;
	pinned?: boolean;
}

export interface TilePatch {
	state?: TileState;
	title?: string;
	exitCode?: number | null;
	parentId?: string | null;
	pinned?: boolean;
	/** Whether the patch counts as activity (bumps `lastActivityAt`). Default true. */
	activity?: boolean;
}

export type TileEvent =
	| { type: "added"; tile: Tile }
	| { type: "updated"; tile: Tile }
	| { type: "removed"; id: string }
	| { type: "chipped"; id: string }
	| { type: "unchipped"; id: string }
	| { type: "focus"; id: string | null };

export type TileListener = (event: TileEvent) => void;

export interface TileStoreOptions {
	now?: () => number;
}

/** Read-only view the chip rules need. */
export interface TileLookup {
	get(id: string): Tile | undefined;
	children(id: string): readonly Tile[];
}

function hasRunningDescendant(lookup: TileLookup, id: string, seen: Set<string> = new Set()): boolean {
	for (const child of lookup.children(id)) {
		if (seen.has(child.id)) continue;
		seen.add(child.id);
		if (child.state === "running") return true;
		if (hasRunningDescendant(lookup, child.id, seen)) return true;
	}
	return false;
}

/**
 * Whether `tile` should currently be a chip rather than a tiled pane. Pure function of the
 * tile, its lineage and `now`.
 */
export function shouldChip(tile: Tile, lookup: TileLookup, now: number): boolean {
	if (tile.kind === "transcript" || tile.pinned || tile.focused) return false;
	if (tile.restoredAt !== null) return false;
	if (tile.kind === "error") return tile.dismissed;
	if (tile.endedAt === null) return false;
	const since = now - tile.endedAt;
	switch (tile.kind) {
		case "command": {
			const failed = tile.state === "error" || (tile.exitCode !== null && tile.exitCode !== 0);
			return since >= (failed ? CHIP_DELAY.commandFailed : CHIP_DELAY.command);
		}
		case "web":
			return since >= CHIP_DELAY.web;
		case "diff":
			return since >= CHIP_DELAY.diff;
		case "pty":
			return since >= CHIP_DELAY.pty;
		case "agent": {
			const parent = tile.parentId === null ? undefined : lookup.get(tile.parentId);
			if (parent?.kind === "agent") return since >= CHIP_DELAY.nestedAgent;
			return since >= CHIP_DELAY.worker && !hasRunningDescendant(lookup, tile.id);
		}
		default:
			return false;
	}
}

/** Liveness used by the calm preset: running/erroring tiles, and `git` for 8 s after a change. */
export function isLive(tile: Tile, now: number): boolean {
	if (tile.state === "running" || tile.state === "error") return true;
	if (tile.kind === "git") return now - tile.lastActivityAt < GIT_LIVE_MS;
	return false;
}

export class TileStore implements TileLookup {
	readonly #now: () => number;
	readonly #tiles = new Map<string, Tile>();
	readonly #listeners = new Set<TileListener>();
	#chips = new Set<string>();

	constructor(options: TileStoreOptions = {}) {
		this.#now = options.now ?? Date.now;
	}

	now(): number {
		return this.#now();
	}

	on(listener: TileListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	get(id: string): Tile | undefined {
		return this.#tiles.get(id);
	}

	/** All tiles in insertion (`createdAt`) order. */
	all(): Tile[] {
		return [...this.#tiles.values()];
	}

	children(id: string): Tile[] {
		const out: Tile[] = [];
		for (const tile of this.#tiles.values()) if (tile.parentId === id) out.push(tile);
		return out;
	}

	/** Ancestors from the immediate parent up to the root. */
	ancestors(id: string): Tile[] {
		const out: Tile[] = [];
		const seen = new Set<string>([id]);
		let cur = this.#tiles.get(id);
		while (cur?.parentId) {
			if (seen.has(cur.parentId)) break;
			seen.add(cur.parentId);
			const parent = this.#tiles.get(cur.parentId);
			if (!parent) break;
			out.push(parent);
			cur = parent;
		}
		return out;
	}

	/** `Ada › Scout` style lineage title through agent ancestors. */
	lineageTitle(id: string): string {
		const tile = this.#tiles.get(id);
		if (!tile) return "";
		const names = this.ancestors(id)
			.filter(t => t.kind === "agent")
			.map(t => t.title)
			.reverse();
		names.push(tile.title);
		return names.join(" › ");
	}

	add(init: TileInit): Tile {
		if (this.#tiles.has(init.id)) throw new Error(`Tile already exists: ${init.id}`);
		const now = this.#now();
		const state = init.state ?? "running";
		const tile: Tile = {
			id: init.id,
			kind: init.kind,
			parentId: init.parentId ?? null,
			state,
			title: init.title ?? init.id,
			createdAt: now,
			lastActivityAt: now,
			endedAt: state === "done" || state === "error" ? now : null,
			exitCode: init.exitCode ?? null,
			focused: false,
			pinned: init.pinned ?? false,
			dismissed: false,
			restoredAt: null,
			version: 0,
		};
		this.#tiles.set(tile.id, tile);
		this.#emit({ type: "added", tile });
		this.tick();
		return tile;
	}

	update(id: string, patch: TilePatch): Tile | undefined {
		const tile = this.#tiles.get(id);
		if (!tile) return undefined;
		const now = this.#now();
		if (patch.state !== undefined && patch.state !== tile.state) {
			tile.state = patch.state;
			tile.restoredAt = null;
			if (patch.state === "done" || patch.state === "error") tile.endedAt = now;
			else tile.endedAt = null;
		}
		if (patch.title !== undefined) tile.title = patch.title;
		if (patch.exitCode !== undefined) tile.exitCode = patch.exitCode;
		if (patch.parentId !== undefined) tile.parentId = patch.parentId;
		if (patch.pinned !== undefined) tile.pinned = patch.pinned;
		if (patch.activity ?? true) tile.lastActivityAt = now;
		tile.version++;
		this.#emit({ type: "updated", tile });
		this.tick();
		return tile;
	}

	/** Record activity (new output) without other changes. */
	touch(id: string): void {
		this.update(id, {});
	}

	/** Dismiss an error tile so it can demote to a chip. */
	dismiss(id: string): void {
		const tile = this.#tiles.get(id);
		if (!tile) return;
		tile.dismissed = true;
		tile.restoredAt = null;
		tile.version++;
		this.#emit({ type: "updated", tile });
		this.tick();
	}

	/** Restore a chip as a tile (user clicked or named it). */
	restore(id: string): void {
		const tile = this.#tiles.get(id);
		if (!tile) return;
		tile.restoredAt = this.#now();
		tile.dismissed = false;
		tile.version++;
		this.#emit({ type: "updated", tile });
		this.tick();
	}

	/** Focus one tile (or clear focus with `null`). */
	focus(id: string | null): void {
		for (const tile of this.#tiles.values()) {
			const next = tile.id === id;
			if (tile.focused !== next) {
				tile.focused = next;
				tile.version++;
			}
		}
		this.#emit({ type: "focus", id });
		this.tick();
	}

	focused(): Tile | undefined {
		for (const tile of this.#tiles.values()) if (tile.focused) return tile;
		return undefined;
	}

	/** Remove a tile; its children are re-parented to its parent so lineage stays connected. */
	remove(id: string): void {
		const tile = this.#tiles.get(id);
		if (!tile) return;
		this.#tiles.delete(id);
		for (const other of this.#tiles.values()) {
			if (other.parentId === id) {
				other.parentId = tile.parentId;
				other.version++;
			}
		}
		this.#chips.delete(id);
		this.#emit({ type: "removed", id });
		this.tick();
	}

	isChip(id: string): boolean {
		return this.#chips.has(id);
	}

	/** Chips, newest activity first. */
	chips(): Tile[] {
		const out: Tile[] = [];
		for (const id of this.#chips) {
			const tile = this.#tiles.get(id);
			if (tile) out.push(tile);
		}
		return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	/** Re-evaluate chip demotion against the clock; emits `chipped`/`unchipped` on transitions. */
	tick(): void {
		const now = this.#now();
		const next = new Set<string>();
		for (const tile of this.#tiles.values()) if (shouldChip(tile, this, now)) next.add(tile.id);
		const prev = this.#chips;
		this.#chips = next;
		for (const id of next) if (!prev.has(id)) this.#emit({ type: "chipped", id });
		for (const id of prev) if (!next.has(id) && this.#tiles.has(id)) this.#emit({ type: "unchipped", id });
	}

	#emit(event: TileEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}
