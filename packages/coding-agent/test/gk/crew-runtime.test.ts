import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CrewEvent,
	CrewRun,
	type CrewWorkerResult,
	type CrewWorkerSpawner,
	crewWorkerPrompt,
} from "../../src/gk/crew-runtime";
import { CrewLedger } from "../../src/gk/ledger";
import type { Assignment, WorkItem } from "../../src/gk/router";
import type { RosterEntry, Tier } from "../../src/gk/types";

interface FakeWorker {
	name: string;
	prompt: string;
	model: string;
	workerId: string;
	finish(ok?: boolean, costUsd?: number): void;
}

/** Spawner whose workers settle only when the test calls `finish`. */
class FakeSpawner implements CrewWorkerSpawner {
	readonly spawned: FakeWorker[] = [];
	readonly killed: string[] = [];
	readonly sent: Array<{ workerId: string; msg: string }> = [];

	async spawn(a: { name: string; prompt: string; model: string }) {
		const { promise, resolve } = Promise.withResolvers<CrewWorkerResult>();
		const workerId = `w${this.spawned.length + 1}`;
		this.spawned.push({
			...a,
			workerId,
			finish: (ok = true, costUsd = 0.1) => resolve({ ok, costUsd, tokens: 100, text: ok ? "all good" : "broke" }),
		});
		return { workerId, settled: promise };
	}

	async send(workerId: string, msg: string): Promise<void> {
		this.sent.push({ workerId, msg });
	}

	async kill(workerId: string): Promise<void> {
		this.killed.push(workerId);
		this.worker(workerId).finish(false, 0.01);
	}

	worker(workerId: string): FakeWorker {
		const found = this.spawned.find(w => w.workerId === workerId);
		if (!found) throw new Error(`no worker ${workerId}`);
		return found;
	}
}

/** Drain pending microtasks (spawn → settle → pump chains); the runtime uses no timers. */
async function tick(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function item(id: string, extra: Partial<WorkItem> = {}): WorkItem {
	return {
		id,
		title: `Item ${id}`,
		brief: `Build ${id}.`,
		skills: ["backend"],
		difficulty: 1,
		size: "S",
		dependsOn: [],
		scope: [`src/${id}/`],
		...extra,
	};
}

function rosterEntry(selector: string, tier: Tier, maxConcurrent: number): RosterEntry {
	return {
		selector,
		tier,
		strengths: [],
		enabled: true,
		maxConcurrent,
		planIncluded: false,
		cost: { input: 1, output: 4 },
	};
}

function assignment(itemId: string, selector = "cheap/t1", tier: Tier = 1): Assignment {
	return { itemId, selector, tier, estCostUsd: 0.1, planIncluded: false, reason: "test" };
}

describe("CrewRun", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function setup(items: WorkItem[], opts: { maxConcurrent?: number } = {}) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-"));
		dirs.push(dir);
		const ledger = new CrewLedger(path.join(dir, "crew-ledger.jsonl"));
		const spawner = new FakeSpawner();
		let changes = 0;
		const run = new CrewRun({
			runId: "run-1",
			items,
			cast: {
				assignments: items.map(i => assignment(i.id)),
				totalEstUsd: 0.1 * items.length,
				baselineEstUsd: 2,
				overBudget: false,
			},
			roster: [rosterEntry("cheap/t1", 1, opts.maxConcurrent ?? 2), rosterEntry("mid/t2", 2, 2)],
			spawner,
			ledger,
			onChange: () => {
				changes++;
			},
			promptHead: "build the thing",
		});
		return { run, spawner, ledger, changes: () => changes };
	}

	it("does not spawn B until A settles ok", async () => {
		const { run, spawner, ledger, changes } = setup([item("a"), item("b", { dependsOn: ["a"] })]);
		run.start();
		await tick();
		expect(spawner.spawned.map(w => w.name)).toEqual([run.workerName("a")]);
		expect(run.state("a")).toBe("running");
		expect(run.state("b")).toBe("waiting");

		spawner.spawned[0].finish(true, 0.2);
		await tick();
		expect(run.state("a")).toBe("done");
		expect(spawner.spawned.map(w => w.name)).toEqual([run.workerName("a"), run.workerName("b")]);
		expect(run.state("b")).toBe("running");

		spawner.spawned[1].finish(true, 0.3);
		const summary = await run.done;
		expect(summary.status).toBe("completed");
		expect(summary.actualUsd).toBeCloseTo(0.5, 10);
		expect(summary.baselineEstUsd).toBe(2);
		expect(summary.items.map(i => [i.itemId, i.state, i.selector])).toEqual([
			["a", "done", "cheap/t1"],
			["b", "done", "cheap/t1"],
		]);
		expect(changes()).toBeGreaterThan(0);

		const [logged] = await ledger.list(10);
		expect(logged.runId).toBe("run-1");
		expect(logged.promptHead).toBe("build the thing");
		expect(logged.status).toBe("completed");
	});

	it("holds the second ready item while maxConcurrent: 1 is in use", async () => {
		const { run, spawner } = setup([item("a"), item("b")], { maxConcurrent: 1 });
		run.start();
		await tick();
		expect(spawner.spawned).toHaveLength(1);
		expect(run.state("b")).toBe("waiting");

		spawner.spawned[0].finish();
		await tick();
		expect(spawner.spawned).toHaveLength(2);
		expect(run.state("b")).toBe("running");
		spawner.spawned[1].finish();
		expect((await run.done).status).toBe("completed");
	});

	it("fails dependents of a failed item without spawning them", async () => {
		const { run, spawner, ledger } = setup([
			item("a"),
			item("b", { dependsOn: ["a"] }),
			item("c", { dependsOn: ["b"] }),
		]);
		let ended = false;
		void run.done.then(() => {
			ended = true;
		});
		run.start();
		await tick();
		spawner.spawned[0].finish(false);
		await tick();
		expect(spawner.spawned).toHaveLength(1);
		expect(run.state("a")).toBe("failed");
		expect(run.state("b")).toBe("failed");
		expect(run.state("c")).toBe("failed");
		// Stays open so the conductor can still escalate the failed item.
		expect(ended).toBe(false);

		const summary = await run.finish();
		expect(summary.status).toBe("partial");
		expect(await run.done).toBe(summary);
		expect((await ledger.list(10))[0].status).toBe("partial");
	});

	it("refuses to finish while items are still running", async () => {
		const { run, spawner } = setup([item("a")]);
		run.start();
		await tick();
		await expect(run.finish()).rejects.toThrow("still running");
		spawner.spawned[0].finish();
		expect((await run.done).status).toBe("completed");
	});

	it("cancelAll kills every running worker and records a cancelled run", async () => {
		const { run, spawner, ledger } = setup([item("a"), item("b"), item("c", { dependsOn: ["a"] })]);
		run.start();
		await tick();
		expect(spawner.spawned).toHaveLength(2);

		await run.cancelAll();
		expect([...spawner.killed].sort()).toEqual(["w1", "w2"]);
		expect(run.state("a")).toBe("cancelled");
		expect(run.state("b")).toBe("cancelled");
		expect(run.state("c")).toBe("cancelled");
		expect(spawner.spawned).toHaveLength(2);

		const summary = await run.done;
		expect(summary.status).toBe("cancelled");
		const [logged] = await ledger.list(10);
		expect(logged.status).toBe("cancelled");
		expect(logged.items.map(i => i.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
	});

	it("escalate kills the old worker and respawns on the recast model with the note", async () => {
		const { run, spawner } = setup([item("a")]);
		run.start();
		await tick();
		spawner.spawned[0].finish(false);
		await tick();
		expect(run.state("a")).toBe("failed");

		const calls: Array<{ exclude: string[]; minTier: Tier }> = [];
		const next = await run.escalate("a", "Handle the empty-list case.", (exclude, minTier) => {
			calls.push({ exclude, minTier });
			return assignment("a", "mid/t2", 2);
		});
		await tick();

		expect(calls).toEqual([{ exclude: ["cheap/t1"], minTier: 2 }]);
		expect(next.selector).toBe("mid/t2");
		expect(run.assignment("a").selector).toBe("mid/t2");
		expect(spawner.killed).toEqual(["w1"]);
		expect(spawner.spawned).toHaveLength(2);
		const respawned = spawner.spawned[1];
		expect(respawned.model).toBe("mid/t2");
		expect(respawned.name).toBe(run.workerName("a"));
		expect(respawned.prompt).toContain("Build a.");
		expect(respawned.prompt).toContain("Handle the empty-list case.");
		expect(respawned.prompt).toContain("broke");
		expect(run.state("a")).toBe("running");

		respawned.finish(true, 0.5);
		const summary = await run.done;
		expect(summary.status).toBe("completed");
		expect(summary.items[0].selector).toBe("mid/t2");
		expect(summary.items[0].costUsd).toBeCloseTo(0.6, 10);
	});

	it("escalating a running worker ignores the old worker's settlement and revives failed dependents", async () => {
		const { run, spawner } = setup([item("a"), item("b", { dependsOn: ["a"] })]);
		run.start();
		await tick();

		await run.escalate("a", "Try harder.", () => assignment("a", "mid/t2", 2));
		await tick();
		expect(spawner.killed).toEqual(["w1"]);
		expect(run.state("a")).toBe("running");
		expect(run.state("b")).toBe("waiting");

		spawner.spawned[1].finish(false);
		await tick();
		expect(run.state("b")).toBe("failed");

		await run.escalate("a", "Once more.", (exclude, minTier) => {
			expect(exclude).toEqual(["cheap/t1", "mid/t2"]);
			expect(minTier).toBe(3);
			return assignment("a", "mid/t2", 2);
		});
		await tick();
		expect(run.state("b")).toBe("waiting");
		spawner.spawned[2].finish();
		await tick();
		expect(run.state("b")).toBe("running");
		spawner.spawned[3].finish();
		expect((await run.done).status).toBe("completed");
	});

	it("routes send to the item's worker", async () => {
		const { run, spawner } = setup([item("a")]);
		run.start();
		await run.send("a", "also add tests");
		expect(spawner.sent).toEqual([{ workerId: "w1", msg: "also add tests" }]);
		spawner.spawned[0].finish();
		await run.done;
	});

	it("gives each item a stable, unique worker name", () => {
		const { run } = setup([item("a"), item("b"), item("c")]);
		const names = ["a", "b", "c"].map(id => run.workerName(id));
		expect(new Set(names).size).toBe(3);
		expect(names.every(name => name.length > 0)).toBe(true);
		expect(["a", "b", "c"].map(id => run.workerName(id))).toEqual(names);
	});

	it("emits item-state and run-done events until unsubscribed", async () => {
		const { run, spawner } = setup([item("a")]);
		const events: CrewEvent[] = [];
		const off = run.events.on(event => events.push(event));
		run.start();
		await tick();
		spawner.spawned[0].finish();
		const summary = await run.done;
		expect(events).toEqual([
			{ type: "item-state", itemId: "a", state: "running" },
			{ type: "item-worker", itemId: "a", workerId: "w1" },
			{ type: "item-state", itemId: "a", state: "done" },
			{ type: "run-done", summary },
		]);

		off();
		const second = setup([item("b")]);
		second.run.events.on(() => {});
		expect(events).toHaveLength(4);
	});

	it("finishes immediately for an empty plan", async () => {
		const { run, spawner } = setup([]);
		run.start();
		expect((await run.done).status).toBe("completed");
		expect(spawner.spawned).toHaveLength(0);
	});
});

describe("crewWorkerPrompt", () => {
	it("restricts writes to the item's scope and asks for a verification report", () => {
		const prompt = crewWorkerPrompt(item("a", { scope: ["src/a/", "package.json"] }));
		expect(prompt).toContain("Build a.");
		expect(prompt).toContain("Only write inside: src/a/, package.json");
		expect(prompt).toContain("report the files you changed and how you verified");
	});

	it("tells read-only items not to modify files", () => {
		const prompt = crewWorkerPrompt(item("r", { scope: [] }));
		expect(prompt).toContain("Do not modify any files; report findings only.");
		expect(prompt).not.toContain("Only write inside");
	});
});
