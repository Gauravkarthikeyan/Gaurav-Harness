import { describe, expect, it } from "bun:test";
import { type TileEvent, TileStore } from "../../../src/gk/stage/tiles";

function setup(): { store: TileStore; clock: { t: number }; events: TileEvent[] } {
	const clock = { t: 0 };
	const store = new TileStore({ now: () => clock.t });
	const events: TileEvent[] = [];
	store.on(e => events.push(e));
	store.add({ id: "main", kind: "transcript" });
	return { store, clock, events };
}

function chipAfter(store: TileStore, clock: { t: number }, id: string, ms: number): void {
	const start = clock.t;
	clock.t = start + ms - 1;
	store.tick();
	expect(store.isChip(id)).toBe(false);
	clock.t = start + ms;
	store.tick();
	expect(store.isChip(id)).toBe(true);
}

describe("TileStore chips", () => {
	it("demotes a command 4 s after done, 8 s after a failed exit", () => {
		const { store, clock } = setup();
		store.add({ id: "ok", kind: "command", parentId: "main" });
		store.add({ id: "bad", kind: "command", parentId: "main" });
		clock.t = 1000;
		store.update("ok", { state: "done", exitCode: 0 });
		store.update("bad", { state: "done", exitCode: 1 });
		chipAfter(store, clock, "ok", 4000);
		clock.t = 1000;
		chipAfter(store, clock, "bad", 8000);
	});

	it("demotes web after 4 s and pty after 10 s", () => {
		const { store, clock } = setup();
		store.add({ id: "w", kind: "web" });
		store.add({ id: "p", kind: "pty" });
		store.update("w", { state: "done" });
		store.update("p", { state: "done", exitCode: 0 });
		chipAfter(store, clock, "w", 4000);
		clock.t = 0;
		chipAfter(store, clock, "p", 10000);
	});

	it("demotes nested subagents after 10 s and workers after 30 s with no running descendant", () => {
		const { store, clock } = setup();
		store.add({ id: "ada", kind: "agent", parentId: "main", title: "Ada" });
		store.add({ id: "scout", kind: "agent", parentId: "ada", title: "Scout" });
		store.add({ id: "cmd", kind: "command", parentId: "ada" });
		expect(store.lineageTitle("scout")).toBe("Ada › Scout");
		store.update("scout", { state: "done" });
		chipAfter(store, clock, "scout", 10000);

		clock.t = 20000;
		store.update("ada", { state: "done" });
		clock.t = 50000;
		store.tick();
		expect(store.isChip("ada")).toBe(false); // cmd still running
		store.update("cmd", { state: "done", exitCode: 0 });
		store.tick();
		expect(store.isChip("ada")).toBe(true);
	});

	it("keeps error tiles until dismissed, and restore exempts a chip", () => {
		const { store, clock, events } = setup();
		store.add({ id: "err", kind: "error", state: "error" });
		clock.t = 600000;
		store.tick();
		expect(store.isChip("err")).toBe(false);
		store.dismiss("err");
		expect(store.isChip("err")).toBe(true);
		expect(events.some(e => e.type === "chipped" && e.id === "err")).toBe(true);
		store.restore("err");
		expect(store.isChip("err")).toBe(false);
		expect(events.some(e => e.type === "unchipped" && e.id === "err")).toBe(true);
	});

	it("never chips the transcript, focused or pinned tiles", () => {
		const { store, clock } = setup();
		store.add({ id: "a", kind: "command", pinned: true });
		store.add({ id: "b", kind: "command" });
		store.update("main", { state: "done" });
		store.update("a", { state: "done" });
		store.update("b", { state: "done" });
		store.focus("b");
		clock.t = 100000;
		store.tick();
		expect(store.chips()).toEqual([]);
	});

	it("reparents children on remove and emits events", () => {
		const { store, events } = setup();
		store.add({ id: "ada", kind: "agent", parentId: "main" });
		store.add({ id: "scout", kind: "agent", parentId: "ada" });
		store.remove("ada");
		expect(store.get("scout")?.parentId).toBe("main");
		expect(events.map(e => e.type)).toContain("removed");
	});
});
