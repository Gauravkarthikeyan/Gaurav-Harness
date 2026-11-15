/**
 * Pure Stage layout (spec §5.5 "Layout algorithm"). Same input → same rects; no clock reads.
 *
 * Screen bands, top to bottom: header (2 rows), tab bar (1 row), body, chip strip (1 row, only while
 * chips exist), footer (status bar + key hints, 2 rows). Inside the body: an optional right-hand
 * widget column (≥ 160 cols), the transcript per preset, and the lineage tree tiled by an ordered
 * weighted binary split.
 */
import { isLive, type Tile, type TileKind, type TileStore, WIDGET_KINDS, WIDGET_ORDER } from "./tiles";
import { attentionWeight } from "./weights";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type StagePreset = "calm" | "orchestra";

export interface LayoutTile {
	id: string;
	kind: TileKind;
	parentId: string | null;
	/**
	 * Parent used for tiling only (defaults to `parentId`). Lets lineage children such as a worker's
	 * commands sit as top-level panes while keeping their real lineage for titles and badges.
	 */
	layoutParentId?: string | null;
	weight: number;
	createdAt: number;
	lastActivityAt: number;
	/** Calm preset gate: running/erroring, or `git` shortly after a change. */
	live: boolean;
	focused?: boolean;
	pinned?: boolean;
	/** Already demoted to a chip by the tile store's timers. */
	chip?: boolean;
	/** Natural height for widget-column tiles (frame included). Unset = flexible. */
	preferredRows?: number;
}

export interface StageLayoutInput {
	cols: number;
	rows: number;
	preset: StagePreset;
	tiles: readonly LayoutTile[];
	zoomedId?: string | null;
	headerRows?: number;
	tabRows?: number;
	footerRows?: number;
	/** Previous layout, for hysteresis. */
	previous?: StageLayout | null;
	/** Mid-tween: skip minimum-size demotion. */
	suspendDemotion?: boolean;
	/** Tween override for the non-transcript share of the main region (0..1). */
	railFraction?: number;
}

export interface StageLayout {
	cols: number;
	rows: number;
	preset: StagePreset;
	header: Rect;
	tabBar: Rect;
	body: Rect;
	chipStrip: Rect | null;
	footer: Rect;
	widgetColumn: Rect | null;
	/** Transcript stacked above the rest (narrow terminals). */
	stacked: boolean;
	/** Share of the main region (excluding the widget column) given to non-transcript tiles. */
	railFraction: number;
	/** Rect per visible tile id. Zero-area rects are omitted. */
	tiles: Map<string, Rect>;
	/** Pane order (transcript first, lineage DFS, then widgets); pane label is `0.<index>`. */
	order: string[];
	/** Chip ids, newest activity first. */
	chips: string[];
	/** Tiles not chipped but not shown (zoom, calm gating). */
	hidden: string[];
	zoomedId: string | null;
}

export const MIN_TILE_W = 24;
export const MIN_TILE_H = 5;
export const MIN_WIDGET_H = 3;
export const WIDGET_COLUMN_MIN_COLS = 160;
export const WIDGET_COLUMN_FRACTION = 0.22;
export const WIDGET_COLUMN_MIN_W = 32;
export const WIDGET_COLUMN_MAX_W = 56;
/**
 * Cut horizontally when `h × CELL_ASPECT ≥ w`. The spec says ~2 (cell shape); 3 biases toward
 * full-width rows, which suits line-oriented pane content and reproduces the reference Stage.
 */
export const CELL_ASPECT = 3;
export const CALM_STACK_BELOW_COLS = 90;
export const ORCHESTRA_STACK_BELOW_COLS = 100;
/** Calm transcript share of the full width when the widget column is present (reference Solo screen). */
export const CALM_WIDE_TRANSCRIPT_FRACTION = 0.47;
export const ORCHESTRA_TRANSCRIPT_FRACTION = 0.36;

const CALM_GATED_KINDS: ReadonlySet<TileKind> = new Set<TileKind>(["git", "dag", "timeline", "events"]);
/** Passive widgets never open the calm rail on their own. */
const CALM_PASSIVE_KINDS: ReadonlySet<TileKind> = new Set<TileKind>(["proc", "telemetry", "todo"]);

function clamp(value: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, value));
}

/** Kinds tiled as top-level panes regardless of which agent started them (reference Stage). */
const FLAT_KINDS: ReadonlySet<TileKind> = new Set<TileKind>(["command", "web", "diff"]);

function layoutParent(tile: LayoutTile): string | null {
	return tile.layoutParentId !== undefined ? tile.layoutParentId : tile.parentId;
}

function compareCreated(a: LayoutTile, b: LayoutTile): number {
	return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface Item {
	tile: LayoutTile;
	children: Item[];
	/** Place only the tile itself (its children were split off as siblings). */
	own: boolean;
}

function itemWeight(item: Item): number {
	let sum = Math.max(0, item.tile.weight);
	if (!item.own) for (const child of item.children) sum += itemWeight(child);
	return sum;
}

/** Ordered weighted binary split (spec step 5). */
function placeItems(items: readonly Item[], rect: Rect, out: Map<string, Rect>): void {
	if (items.length === 0) return;
	if (items.length === 1) {
		const item = items[0];
		if (item.own || item.children.length === 0) {
			out.set(item.tile.id, rect);
			return;
		}
		placeItems([{ tile: item.tile, children: [], own: true }, ...item.children], rect, out);
		return;
	}
	const weights = items.map(itemWeight);
	const total = weights.reduce((a, b) => a + b, 0);
	let k = 1;
	let leftWeight = 0;
	let best = Number.POSITIVE_INFINITY;
	let prefix = 0;
	for (let i = 1; i < items.length; i++) {
		prefix += weights[i - 1];
		const diff = Math.abs(prefix - (total - prefix));
		if (diff < best - 1e-9) {
			best = diff;
			k = i;
			leftWeight = prefix;
		}
	}
	const horizontal = rect.h * CELL_ASPECT >= rect.w;
	const dim = horizontal ? rect.h : rect.w;
	const min = horizontal ? MIN_TILE_H : MIN_TILE_W;
	let first = total > 0 ? Math.round((dim * leftWeight) / total) : Math.round((dim * k) / items.length);
	// A zero-weight side is a tile tweening in/out: let it collapse instead of forcing the minimum.
	const bothWeighted = total <= 0 || (leftWeight > 0 && total - leftWeight > 0);
	if (bothWeighted && dim >= 2 * min) first = clamp(first, min, dim - min);
	first = clamp(first, 0, dim);
	const a: Rect = horizontal
		? { x: rect.x, y: rect.y, w: rect.w, h: first }
		: { x: rect.x, y: rect.y, w: first, h: rect.h };
	const b: Rect = horizontal
		? { x: rect.x, y: rect.y + first, w: rect.w, h: rect.h - first }
		: { x: rect.x + first, y: rect.y, w: rect.w - first, h: rect.h };
	placeItems(items.slice(0, k), a, out);
	placeItems(items.slice(k), b, out);
}

function collectOrder(items: readonly Item[], order: string[]): void {
	for (const item of items) {
		order.push(item.tile.id);
		collectOrder(item.children, order);
	}
}

/** Stack widgets top-down at their natural heights; flexible widgets share the remainder by weight. */
function placeColumn(widgets: readonly LayoutTile[], rect: Rect, out: Map<string, Rect>): string | null {
	const needs = widgets.map(w => (w.preferredRows === undefined ? MIN_TILE_H : Math.max(MIN_WIDGET_H, w.preferredRows)));
	const needed = needs.reduce((a, b) => a + b, 0);
	if (needed > rect.h) {
		let victim = widgets[0];
		for (const w of widgets) if (w.weight < victim.weight) victim = w;
		return victim.id;
	}
	const heights = [...needs];
	let extra = rect.h - needed;
	const flex = widgets.flatMap((w, i) => (w.preferredRows === undefined ? [i] : []));
	if (flex.length === 0) {
		heights[heights.length - 1] += extra;
	} else {
		const flexWeight = flex.reduce((sum, i) => sum + Math.max(0, widgets[i].weight), 0);
		for (let j = 0; j < flex.length; j++) {
			const i = flex[j];
			const share =
				j === flex.length - 1
					? extra
					: Math.round(
							flexWeight > 0
								? (extra * Math.max(0, widgets[i].weight)) / flexWeight
								: extra / (flex.length - j),
						);
			heights[i] += share;
			extra -= share;
		}
	}
	let y = rect.y;
	for (let i = 0; i < widgets.length; i++) {
		out.set(widgets[i].id, { x: rect.x, y, w: rect.w, h: heights[i] });
		y += heights[i];
	}
	return null;
}

interface Attempt {
	layout: StageLayout;
	/** Tiles that may be demoted (placed, not protected). */
	placed: LayoutTile[];
	undersized: boolean;
	columnOverflow: string | null;
}

function attempt(input: StageLayoutInput, demoted: ReadonlySet<string>): Attempt {
	const { cols, rows, preset } = input;
	const headerRows = input.headerRows ?? 2;
	const tabRows = input.tabRows ?? 1;
	const footerRows = input.footerRows ?? 2;

	const visible: LayoutTile[] = [];
	const chipTiles: LayoutTile[] = [];
	for (const tile of input.tiles) (tile.chip || demoted.has(tile.id) ? chipTiles : visible).push(tile);
	visible.sort(compareCreated);
	chipTiles.sort((a, b) => b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const chips = chipTiles.map(t => t.id);

	const top = Math.min(rows, headerRows + tabRows);
	const footerY = Math.max(top, rows - footerRows);
	const chipY = chips.length > 0 ? Math.max(top, footerY - 1) : footerY;
	const header: Rect = { x: 0, y: 0, w: cols, h: Math.min(rows, headerRows) };
	const tabBar: Rect = { x: 0, y: header.h, w: cols, h: top - header.h };
	const footer: Rect = { x: 0, y: footerY, w: cols, h: rows - footerY };
	const chipStrip: Rect | null = chips.length > 0 ? { x: 0, y: chipY, w: cols, h: footerY - chipY } : null;
	const body: Rect = { x: 0, y: top, w: cols, h: chipY - top };

	const tiles = new Map<string, Rect>();
	const order: string[] = [];
	const hidden: string[] = [];
	const base = {
		cols,
		rows,
		preset,
		header,
		tabBar,
		body,
		chipStrip,
		footer,
		chips,
	};

	const zoomed = input.zoomedId ? visible.find(t => t.id === input.zoomedId) : undefined;
	if (zoomed) {
		tiles.set(zoomed.id, body);
		order.push(zoomed.id);
		for (const t of visible) if (t !== zoomed) hidden.push(t.id);
		return {
			layout: { ...base, widgetColumn: null, stacked: false, railFraction: 0, tiles, order, hidden, zoomedId: zoomed.id },
			placed: [],
			undersized: false,
			columnOverflow: null,
		};
	}

	const transcript = visible.find(t => t.kind === "transcript");
	let candidates = visible.filter(t => t !== transcript);
	if (preset === "calm") {
		const gatedOut = candidates.filter(t => CALM_GATED_KINDS.has(t.kind) && !t.live);
		candidates = candidates.filter(t => !gatedOut.includes(t));
		const triggered = candidates.some(t => !CALM_PASSIVE_KINDS.has(t.kind));
		if (!triggered) {
			gatedOut.push(...candidates);
			candidates = [];
		}
		for (const t of gatedOut) hidden.push(t.id);
	}

	let main = body;
	let widgetColumn: Rect | null = null;
	let columnWidgets: LayoutTile[] = [];
	if (cols >= WIDGET_COLUMN_MIN_COLS) {
		columnWidgets = candidates.filter(t => WIDGET_KINDS.has(t.kind));
		if (columnWidgets.length > 0) {
			const colW = Math.min(
				body.w,
				clamp(Math.round(cols * WIDGET_COLUMN_FRACTION), WIDGET_COLUMN_MIN_W, WIDGET_COLUMN_MAX_W),
			);
			widgetColumn = { x: body.x + body.w - colW, y: body.y, w: colW, h: body.h };
			main = { x: body.x, y: body.y, w: body.w - colW, h: body.h };
			columnWidgets.sort(
				(a, b) => WIDGET_ORDER.indexOf(a.kind) - WIDGET_ORDER.indexOf(b.kind) || compareCreated(a, b),
			);
		}
	}
	const treeTiles = candidates.filter(t => !columnWidgets.includes(t));

	let region: Rect | null = main;
	let stacked = false;
	let railFraction = 0;
	if (transcript) {
		if (treeTiles.length === 0) {
			tiles.set(transcript.id, main);
			region = null;
		} else {
			const stackBelow = preset === "calm" ? CALM_STACK_BELOW_COLS : ORCHESTRA_STACK_BELOW_COLS;
			stacked = cols < stackBelow;
			const dim = stacked ? main.h : main.w;
			let side: number;
			if (input.railFraction !== undefined) side = Math.round(dim * input.railFraction);
			else if (stacked) {
				side =
					preset === "calm"
						? clamp(Math.round(main.h * 0.35), 6, main.h - 10)
						: main.h - Math.max(10, Math.round(main.h * 0.45));
			} else if (preset === "calm") {
				side = widgetColumn
					? main.w - Math.round(cols * CALM_WIDE_TRANSCRIPT_FRACTION)
					: clamp(Math.round(cols * 0.34), 30, cols - 60);
			} else {
				side = main.w - clamp(Math.round(cols * ORCHESTRA_TRANSCRIPT_FRACTION), 40, Math.round(cols * 0.5));
			}
			side = clamp(side, 0, dim);
			railFraction = dim > 0 ? side / dim : 0;
			if (stacked) {
				tiles.set(transcript.id, { x: main.x, y: main.y, w: main.w, h: main.h - side });
				region = { x: main.x, y: main.y + main.h - side, w: main.w, h: side };
			} else {
				tiles.set(transcript.id, { x: main.x, y: main.y, w: main.w - side, h: main.h });
				region = { x: main.x + main.w - side, y: main.y, w: side, h: main.h };
			}
		}
		order.push(transcript.id);
	}

	// Lineage tree (spec step 4): attach each tile to its nearest ancestor in the tree.
	const all = new Map<string, LayoutTile>();
	for (const t of input.tiles) all.set(t.id, t);
	const inTree = new Set(treeTiles.map(t => t.id));
	const items = new Map<string, Item>();
	for (const t of treeTiles) items.set(t.id, { tile: t, children: [], own: false });
	const roots: Item[] = [];
	for (const item of items.values()) {
		let parentId = layoutParent(item.tile);
		const seen = new Set<string>([item.tile.id]);
		while (parentId !== null && !inTree.has(parentId) && !seen.has(parentId)) {
			seen.add(parentId);
			const ancestor = all.get(parentId);
			parentId = ancestor ? layoutParent(ancestor) : null;
		}
		const parent = parentId !== null && !seen.has(parentId) ? items.get(parentId) : undefined;
		(parent ? parent.children : roots).push(item);
	}
	if (region) placeItems(roots, region, tiles);
	collectOrder(roots, order);

	let columnOverflow: string | null = null;
	if (widgetColumn) {
		columnOverflow = placeColumn(columnWidgets, widgetColumn, tiles);
		for (const w of columnWidgets) order.push(w.id);
	}

	let undersized = false;
	for (const [id, rect] of tiles) {
		if (rect.w <= 0 || rect.h <= 0) {
			tiles.delete(id);
			undersized = true;
			continue;
		}
		const inColumn = widgetColumn !== null && rect.x >= widgetColumn.x;
		if (rect.w < MIN_TILE_W || rect.h < (inColumn ? MIN_WIDGET_H : MIN_TILE_H)) undersized = true;
	}

	return {
		layout: { ...base, widgetColumn, stacked, railFraction, tiles, order, hidden, zoomedId: null },
		placed: [...treeTiles, ...columnWidgets].filter(t => !t.focused && !t.pinned),
		undersized,
		columnOverflow,
	};
}

function pickVictim(placed: readonly LayoutTile[]): LayoutTile | undefined {
	let victim: LayoutTile | undefined;
	for (const t of placed) {
		if (!victim) {
			victim = t;
			continue;
		}
		const tErr = t.kind === "error" ? 1 : 0;
		const vErr = victim.kind === "error" ? 1 : 0;
		if (tErr !== vErr) {
			if (tErr < vErr) victim = t;
			continue;
		}
		if (t.weight !== victim.weight) {
			if (t.weight < victim.weight) victim = t;
			continue;
		}
		// Equal weight: the newest tile goes first.
		if (compareCreated(t, victim) > 0) victim = t;
	}
	return victim;
}

function withHysteresis(layout: StageLayout, previous: StageLayout | null | undefined): StageLayout {
	if (!previous || previous.cols !== layout.cols || previous.rows !== layout.rows) return layout;
	const pb = previous.body;
	const b = layout.body;
	if (pb.x !== b.x || pb.y !== b.y || pb.w !== b.w || pb.h !== b.h) return layout;
	if (previous.tiles.size !== layout.tiles.size) return layout;
	for (const [id, r] of layout.tiles) {
		const p = previous.tiles.get(id);
		if (!p) return layout;
		if (
			Math.abs(p.x - r.x) >= 2 ||
			Math.abs(p.y - r.y) >= 2 ||
			Math.abs(p.x + p.w - (r.x + r.w)) >= 2 ||
			Math.abs(p.y + p.h - (r.y + r.h)) >= 2
		) {
			return layout;
		}
	}
	return { ...layout, tiles: new Map(previous.tiles) };
}

export function layoutStage(input: StageLayoutInput): StageLayout {
	const demoted = new Set<string>();
	const byId = new Map<string, LayoutTile>();
	for (const t of input.tiles) byId.set(t.id, t);
	for (;;) {
		const result = attempt(input, demoted);
		if (input.suspendDemotion) return withHysteresis(result.layout, input.previous);
		if (result.columnOverflow !== null) {
			demoted.add(result.columnOverflow);
			continue;
		}
		const victim = result.undersized ? pickVictim(result.placed) : undefined;
		if (!victim) return withHysteresis(result.layout, input.previous);
		demoted.add(victim.id);
		if (victim.kind === "agent") {
			// Demoting an agent demotes its whole subtree.
			let grew = true;
			while (grew) {
				grew = false;
				for (const t of input.tiles) {
					const parentId = layoutParent(t);
					if (!demoted.has(t.id) && parentId !== null && demoted.has(parentId) && byId.has(parentId)) {
						demoted.add(t.id);
						grew = true;
					}
				}
			}
		}
	}
}

/** Project tile-store state into layout input at `now`. */
export function toLayoutTiles(
	store: TileStore,
	now: number,
	preferredRows?: ReadonlyMap<string, number>,
): LayoutTile[] {
	return store.all().map((tile: Tile) => ({
		id: tile.id,
		kind: tile.kind,
		parentId: tile.parentId,
		layoutParentId: FLAT_KINDS.has(tile.kind) ? null : tile.parentId,
		weight: attentionWeight(tile, now),
		createdAt: tile.createdAt,
		lastActivityAt: tile.lastActivityAt,
		live: isLive(tile, now),
		focused: tile.focused,
		pinned: tile.pinned,
		chip: store.isChip(tile.id),
		preferredRows: preferredRows?.get(tile.id),
	}));
}
