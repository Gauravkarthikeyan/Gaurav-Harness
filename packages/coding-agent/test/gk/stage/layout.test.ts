import { describe, expect, it } from "bun:test";
import {
	type LayoutTile,
	layoutStage,
	MIN_TILE_H,
	MIN_TILE_W,
	type Rect,
	type StageLayout,
	type StageLayoutInput,
	toLayoutTiles,
} from "../../../src/gk/stage/layout";
import { TileStore } from "../../../src/gk/stage/tiles";

let seq = 0;
function tile(id: string, kind: LayoutTile["kind"], extra: Partial<LayoutTile> = {}): LayoutTile {
	seq++;
	return { id, kind, parentId: "main", weight: 1, createdAt: seq, lastActivityAt: seq, live: true, ...extra };
}

function area(r: Rect): number {
	return r.w * r.h;
}

function overlaps(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function inside(inner: Rect, outer: Rect): boolean {
	return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

function expectValidTiling(layout: StageLayout): void {
	const rects = [...layout.tiles.values()];
	for (let i = 0; i < rects.length; i++) {
		expect(inside(rects[i], layout.body)).toBe(true);
		for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
	}
	expect(rects.reduce((s, r) => s + area(r), 0)).toBe(area(layout.body));
}

function bbox(rects: Rect[]): Rect {
	const x = Math.min(...rects.map(r => r.x));
	const y = Math.min(...rects.map(r => r.y));
	const x2 = Math.max(...rects.map(r => r.x + r.w));
	const y2 = Math.max(...rects.map(r => r.y + r.h));
	return { x, y, w: x2 - x, h: y2 - y };
}

function rect(layout: StageLayout, id: string): Rect {
	const r = layout.tiles.get(id);
	if (!r) throw new Error(`no rect for ${id}`);
	return r;
}

function orchestraInput(): StageLayoutInput {
	seq = 0;
	return {
		cols: 212,
		rows: 58,
		preset: "orchestra",
		tiles: [
			tile("main", "transcript", { parentId: null, weight: 8 }),
			tile("w01", "agent", { weight: 6.4 }),
			tile("w02", "agent", { weight: 6.4 }),
			tile("scout", "agent", { parentId: "w02", chip: true }),
			tile("cmd", "command", { weight: 3.2 }),
			tile("w03", "agent", { weight: 1.2, live: false }),
			tile("proc", "proc", { preferredRows: 9 }),
			tile("tput", "telemetry", { preferredRows: 6 }),
			tile("dag", "dag", { preferredRows: 3 }),
			tile("git", "git", { preferredRows: 7 }),
			tile("events", "events"),
		],
	};
}

describe("layoutStage bands", () => {
	it("reserves 2 header rows, 1 tab row and 2 footer rows", () => {
		const layout = layoutStage(orchestraInput());
		expect(layout.header).toEqual({ x: 0, y: 0, w: 212, h: 2 });
		expect(layout.tabBar).toEqual({ x: 0, y: 2, w: 212, h: 1 });
		expect(layout.footer).toEqual({ x: 0, y: 56, w: 212, h: 2 });
		expect(layout.chipStrip).toEqual({ x: 0, y: 55, w: 212, h: 1 });
		expect(layout.body).toEqual({ x: 0, y: 3, w: 212, h: 52 });
		expect(layout.chips).toEqual(["scout"]);
	});
});

describe("layoutStage orchestra reference (212×58)", () => {
	const layout = layoutStage(orchestraInput());

	it("is deterministic", () => {
		expect(layoutStage(orchestraInput())).toEqual(layout);
	});

	it("tiles the body exactly", () => {
		expectValidTiling(layout);
	});

	it("puts the conductor left (~35%) and widgets in a right column", () => {
		const main = rect(layout, "main");
		expect(main.x).toBe(0);
		expect(main.w).toBe(76);
		expect(main.h).toBe(layout.body.h);
		expect(layout.widgetColumn).toEqual({ x: 165, y: 3, w: 47, h: 52 });
		const col = layout.widgetColumn as Rect;
		const ids = ["proc", "tput", "dag", "git", "events"];
		const rs = ids.map(id => rect(layout, id));
		for (const r of rs) expect(r.x === col.x && r.w === col.w).toBe(true);
		for (let i = 1; i < rs.length; i++) expect(rs[i].y).toBe(rs[i - 1].y + rs[i - 1].h);
		expect(rs.map(r => r.h)).toEqual([9, 6, 3, 7, 27]);
	});

	it("stacks W-01 over W-02 with command and W-03 side by side below", () => {
		const w01 = rect(layout, "w01");
		const w02 = rect(layout, "w02");
		const cmd = rect(layout, "cmd");
		const w03 = rect(layout, "w03");
		expect(w01).toMatchObject({ x: 76, y: 3, w: 89 });
		expect(w02).toMatchObject({ x: 76, y: w01.y + w01.h, w: 89 });
		expect(cmd.y).toBe(w02.y + w02.h);
		expect(w03.y).toBe(cmd.y);
		expect(w03.x).toBe(cmd.x + cmd.w);
		expect(layout.order).toEqual(["main", "w01", "w02", "cmd", "w03", "proc", "tput", "dag", "git", "events"]);
	});
});

describe("layoutStage solo reference (212×58)", () => {
	seq = 0;
	const input: StageLayoutInput = {
		cols: 212,
		rows: 58,
		preset: "calm",
		tiles: [
			tile("main", "transcript", { parentId: null, weight: 8 }),
			tile("tele", "telemetry", { preferredRows: 7 }),
			tile("todo", "todo", { preferredRows: 6 }),
			tile("git", "git", { preferredRows: 9 }),
			tile("events", "events"),
			tile("cmd", "command", { weight: 3.2 }),
			tile("diff", "diff", { weight: 1, live: false }),
		],
	};
	const layout = layoutStage(input);

	it("puts the session left (~47%), command over diff, widgets right", () => {
		expectValidTiling(layout);
		expect(rect(layout, "main")).toEqual({ x: 0, y: 3, w: 100, h: 53 });
		const cmd = rect(layout, "cmd");
		const diff = rect(layout, "diff");
		expect(cmd).toMatchObject({ x: 100, y: 3, w: 65 });
		expect(diff).toMatchObject({ x: 100, y: cmd.y + cmd.h, w: 65 });
		expect(layout.widgetColumn?.x).toBe(165);
		expect(["tele", "todo", "git", "events"].map(id => rect(layout, id).y)).toEqual([3, 10, 16, 25]);
	});

	it("hides everything but the transcript when nothing is live", () => {
		const calm = layoutStage({
			...input,
			tiles: input.tiles.filter(t => t.id !== "cmd" && t.id !== "diff").map(t => ({ ...t, live: false })),
		});
		expect([...calm.tiles.keys()]).toEqual(["main"]);
		expect(calm.widgetColumn).toBeNull();
		expect(calm.hidden.sort()).toEqual(["events", "git", "todo", "tele"].sort());
	});

	it("gates git/events in calm preset on liveness", () => {
		const gated = layoutStage({
			...input,
			tiles: input.tiles.map(t => (t.id === "git" ? { ...t, live: false } : t)),
		});
		expect(gated.tiles.has("git")).toBe(false);
		expect(gated.hidden).toContain("git");
		expectValidTiling(gated);
	});
});

describe("layoutStage widths", () => {
	it("has no widget column at 120 cols; widgets join the tiling", () => {
		const input = orchestraInput();
		const layout = layoutStage({ ...input, cols: 120 });
		expect(layout.widgetColumn).toBeNull();
		expectValidTiling(layout);
		for (const r of layout.tiles.values()) {
			expect(r.w).toBeGreaterThanOrEqual(MIN_TILE_W);
			expect(r.h).toBeGreaterThanOrEqual(MIN_TILE_H);
		}
		expect(rect(layout, "main")).toMatchObject({ x: 0, w: 43 });
	});

	it("stacks the transcript on top at 80 cols", () => {
		seq = 0;
		const tiles = [tile("main", "transcript", { parentId: null, weight: 8 }), tile("cmd", "command"), tile("ada", "agent")];
		for (const preset of ["orchestra", "calm"] as const) {
			const layout = layoutStage({ cols: 80, rows: 40, preset, tiles });
			expect(layout.stacked).toBe(true);
			expect(layout.widgetColumn).toBeNull();
			const main = rect(layout, "main");
			expect(main).toMatchObject({ x: 0, y: 3, w: 80 });
			expectValidTiling(layout);
			for (const id of ["cmd", "ada"]) expect(rect(layout, id).y).toBeGreaterThanOrEqual(main.y + main.h);
		}
	});
});

describe("layoutStage invariants", () => {
	it("respects minimum sizes by demoting the lowest-weight tiles to chips", () => {
		seq = 0;
		const tiles = [tile("main", "transcript", { parentId: null, weight: 8 })];
		for (let i = 0; i < 30; i++) tiles.push(tile(`c${i}`, "command", { weight: 1 + (i % 7) / 10 }));
		tiles.push(tile("pin", "command", { weight: 0.01, pinned: true }));
		const layout = layoutStage({ cols: 120, rows: 40, preset: "orchestra", tiles });
		expectValidTiling(layout);
		for (const r of layout.tiles.values()) {
			expect(r.w).toBeGreaterThanOrEqual(MIN_TILE_W);
			expect(r.h).toBeGreaterThanOrEqual(MIN_TILE_H);
		}
		expect(layout.chips.length).toBeGreaterThan(0);
		expect(layout.tiles.has("pin")).toBe(true);
		expect(layout.tiles.has("main")).toBe(true);
	});

	it("demotes an agent together with its subtree", () => {
		seq = 0;
		const tiles = [
			tile("main", "transcript", { parentId: null, weight: 8 }),
			tile("big", "agent", { weight: 5 }),
			tile("low", "agent", { weight: 0.1 }),
			tile("kid", "command", { parentId: "low", weight: 3 }),
		];
		const layout = layoutStage({ cols: 100, rows: 13, preset: "orchestra", tiles });
		expect(layout.chips).toContain("low");
		expect(layout.chips).toContain("kid");
	});

	it("keeps pane order stable when a weight changes", () => {
		seq = 0;
		const base = [
			tile("main", "transcript", { parentId: null, weight: 8 }),
			tile("a", "agent", { weight: 2 }),
			tile("b", "agent", { weight: 2 }),
			tile("c", "command", { weight: 2 }),
			tile("d", "web", { weight: 2 }),
		];
		const before = layoutStage({ cols: 212, rows: 58, preset: "orchestra", tiles: base });
		const after = layoutStage({
			cols: 212,
			rows: 58,
			preset: "orchestra",
			tiles: base.map(t => (t.id === "c" ? { ...t, weight: 9 } : t)),
		});
		expect(after.order).toEqual(before.order);
		for (const layout of [before, after]) {
			const ids = ["a", "b", "c", "d"];
			for (let i = 0; i < ids.length; i++) {
				for (let j = i + 1; j < ids.length; j++) {
					const p = rect(layout, ids[i]);
					const q = rect(layout, ids[j]);
					expect(p.x + p.w <= q.x || p.y + p.h <= q.y).toBe(true);
				}
			}
		}
		expect(rect(after, "c")).not.toEqual(rect(before, "c"));
	});

	it("places children inside their parent's area", () => {
		seq = 0;
		const tiles = [
			tile("main", "transcript", { parentId: null, weight: 8 }),
			tile("ada", "agent", { weight: 3 }),
			tile("linus", "agent", { weight: 3 }),
			tile("scout", "agent", { parentId: "ada", weight: 2 }),
			tile("cmd", "command", { parentId: "scout", weight: 1 }),
			tile("t2", "command", { parentId: "linus", weight: 1 }),
		];
		const layout = layoutStage({ cols: 200, rows: 60, preset: "orchestra", tiles });
		expectValidTiling(layout);
		const adaRects = ["ada", "scout", "cmd"].map(id => rect(layout, id));
		const adaBox = bbox(adaRects);
		expect(adaRects.reduce((s, r) => s + area(r), 0)).toBe(area(adaBox));
		for (const id of ["linus", "t2"]) expect(overlaps(adaBox, rect(layout, id))).toBe(false);
		const scoutBox = bbox(["scout", "cmd"].map(id => rect(layout, id)));
		expect(overlaps(scoutBox, rect(layout, "ada"))).toBe(false);
		expect(layout.order).toEqual(["main", "ada", "scout", "cmd", "linus", "t2"]);
	});

	it("zooms a tile to the whole body", () => {
		const input = orchestraInput();
		const layout = layoutStage({ ...input, zoomedId: "cmd" });
		expect([...layout.tiles.entries()]).toEqual([["cmd", layout.body]]);
		expect(layout.hidden).toContain("main");
	});

	it("keeps the previous rects under small edge moves (hysteresis)", () => {
		const input = orchestraInput();
		const first = layoutStage(input);
		const nudged = input.tiles.map(t => (t.id === "w01" ? { ...t, weight: 6.6 } : t));
		const fresh = layoutStage({ ...input, tiles: nudged });
		const kept = layoutStage({ ...input, tiles: nudged, previous: first });
		expect(kept.tiles).toEqual(first.tiles);
		expect(fresh.tiles).not.toEqual(first.tiles);
		const moved = layoutStage({
			...input,
			tiles: input.tiles.map(t => (t.id === "w01" ? { ...t, weight: 20 } : t)),
			previous: first,
		});
		expect(moved.tiles).not.toEqual(first.tiles);
	});

	it("collapses zero-weight tiles mid-tween instead of demoting", () => {
		seq = 0;
		const tiles = [
			tile("main", "transcript", { parentId: null, weight: 8 }),
			tile("a", "agent", { weight: 2 }),
			tile("new", "command", { weight: 0 }),
		];
		const layout = layoutStage({ cols: 160, rows: 40, preset: "orchestra", tiles, suspendDemotion: true });
		expect(layout.tiles.has("new")).toBe(false);
		expect(layout.chips).toEqual([]);
		expectValidTiling(layout);
	});

	it("projects a tile store", () => {
		const clock = { t: 0 };
		const store = new TileStore({ now: () => clock.t });
		store.add({ id: "main", kind: "transcript" });
		store.add({ id: "c", kind: "command", parentId: "main" });
		const tiles = toLayoutTiles(store, 0);
		expect(tiles.map(t => [t.id, t.weight])).toEqual([
			["main", 4 * 1.6 * 2],
			["c", 1 * 1.6 * 2],
		]);
		const layout = layoutStage({ cols: 120, rows: 40, preset: "calm", tiles });
		expectValidTiling(layout);
	});

	it("tiles worker commands as top-level siblings while keeping lineage", () => {
		const store = new TileStore({ now: () => 0 });
		store.add({ id: "main", kind: "transcript" });
		store.add({ id: "ada", kind: "agent", parentId: "main" });
		store.add({ id: "scout", kind: "agent", parentId: "ada" });
		store.add({ id: "cmd", kind: "command", parentId: "ada" });
		const tiles = toLayoutTiles(store, 0);
		const cmd = tiles.find(t => t.id === "cmd");
		expect(cmd?.parentId).toBe("ada");
		expect(cmd?.layoutParentId).toBeNull();
		expect(tiles.find(t => t.id === "scout")?.layoutParentId).toBe("ada");
		const layout = layoutStage({ cols: 212, rows: 58, preset: "orchestra", tiles });
		expect(layout.order).toEqual(["main", "ada", "scout", "cmd"]);
	});
});
