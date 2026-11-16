import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { CREW_TOOL_NAMES, createCrewTools } from "../../src/gk/crew-tools";
import { entry, harness, item, ROSTER, tick } from "./crew-fixtures";

function tool(tools: AgentTool[], name: string): AgentTool {
	const found = tools.find(t => t.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => part.text ?? "").join("");
}

describe("crew tools", () => {
	it("exposes exactly the crew tool names", () => {
		const { crew } = harness();
		expect(createCrewTools(crew).map(t => t.name)).toEqual([...CREW_TOOL_NAMES]);
	});

	it("rejects an invalid plan with every reason and spawns nothing", async () => {
		const h = harness();
		const plan = tool(createCrewTools(h.crew), "crew_plan");
		const items = [item("a", { dependsOn: ["b"] }), item("b", { dependsOn: ["a"] }), item("c", { brief: " " })];
		const error = await plan.execute("call-1", { items }).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("cycle");
		expect((error as Error).message).toContain("empty brief");
		expect(h.requests).toHaveLength(0);
		expect(h.spawner.spawned).toHaveLength(0);
	});

	it("rejects overlapping scopes of items that can run together", async () => {
		const h = harness();
		const plan = tool(createCrewTools(h.crew), "crew_plan");
		const items = [item("a", { scope: ["src/"] }), item("b", { scope: ["src/api/"] })];
		await expect(plan.execute("c", { items })).rejects.toThrow(/overlapping paths/);
		expect(h.spawner.spawned).toHaveLength(0);
	});

	it("returns the board's rejection note to the conductor and spawns nothing", async () => {
		const h = harness({ approve: () => ({ approved: false, note: "use one item, not two" }) });
		const plan = tool(createCrewTools(h.crew), "crew_plan");
		const error = await plan.execute("c", { items: [item("a"), item("b")] }).catch((e: Error) => e);
		expect((error as Error).message).toContain("use one item, not two");
		expect((error as Error).message).toContain("nothing was spawned");
		expect(h.requests).toHaveLength(1);
		expect(h.runs).toHaveLength(0);
		expect(h.spawner.spawned).toHaveLength(0);
	});

	it("starts an approved plan: spawns ready items, holds dependents until their deps finish", async () => {
		const h = harness();
		const plan = tool(createCrewTools(h.crew), "crew_plan");
		const result = await plan.execute("c", { items: [item("a"), item("b"), item("c", { dependsOn: ["a"] })] });
		await tick();
		expect(textOf(result)).toContain("Plan #1 approved");
		expect(h.requests[0]!.names.a).toBeTruthy();
		expect(h.spawner.spawned.map(w => w.model)).toEqual(["cheap/one", "cheap/one"]);
		expect(h.spawner.spawned[0]!.name).toBe(h.requests[0]!.names.a!);
		h.spawner.spawned[0]!.finish();
		await tick();
		expect(h.spawner.spawned).toHaveLength(3);
		expect(h.spawner.spawned[2]!.prompt).toContain("do c");
	});

	it("auto-approves within budget without showing the board", async () => {
		const h = harness({ autoApprove: true, maxRunUsd: 5 });
		await tool(createCrewTools(h.crew), "crew_plan").execute("c", { items: [item("a")] });
		expect(h.requests).toHaveLength(0);
		expect(h.runs).toHaveLength(1);
	});

	it("still asks when auto-approve is on but the plan is over budget", async () => {
		const h = harness({ autoApprove: true, maxRunUsd: 0.0001 });
		await tool(createCrewTools(h.crew), "crew_plan").execute("c", { items: [item("a")] });
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]!.cast.overBudget).toBe(true);
	});

	it("refuses an over-budget plan when there is no board", async () => {
		const h = harness({ noUi: true, maxRunUsd: 0.0001 });
		await expect(tool(createCrewTools(h.crew), "crew_plan").execute("c", { items: [item("a")] })).rejects.toThrow(
			/over the/,
		);
		expect(h.spawner.spawned).toHaveLength(0);
	});

	it("drops rows removed on the board and strips dependencies on them", async () => {
		const h = harness({
			approve: req => ({
				approved: true,
				cast: { ...req.cast, assignments: req.cast.assignments.filter(a => a.itemId !== "a") },
				autoApprove: true,
			}),
		});
		const result = await tool(createCrewTools(h.crew), "crew_plan").execute("c", {
			items: [item("a"), item("b", { dependsOn: ["a"] })],
		});
		await tick();
		expect(textOf(result)).toContain("Dropped on the board");
		expect(h.runs[0]!.items.map(i => i.id)).toEqual(["b"]);
		expect(h.spawner.spawned).toHaveLength(1);
		expect(h.autoApproveSet).toEqual([true]);
	});

	it("escalates to tier + 1, excluding the current model", async () => {
		const h = harness();
		const tools = createCrewTools(h.crew);
		await tool(tools, "crew_plan").execute("c", { items: [item("a")] });
		await tick();
		expect(h.spawner.spawned[0]!.model).toBe("cheap/one");
		const result = await tool(tools, "crew_escalate").execute("e", { item: "a", note: "tests still fail" });
		await tick();
		expect(textOf(result)).toContain("cheap/one (tier 1) → mid/two (tier 2");
		expect(h.spawner.killed).toEqual(["w1"]);
		const next = h.spawner.spawned[1]!;
		expect(next.model).toBe("mid/two");
		expect(next.prompt).toContain("tests still fail");
	});

	it("sends, reports status, waits for a settle and kills", async () => {
		const h = harness();
		const tools = createCrewTools(h.crew);
		await tool(tools, "crew_plan").execute("c", { items: [item("a"), item("b")] });
		await tick();
		await tool(tools, "crew_send").execute("s", { item: "a", message: "also add a test" });
		expect(h.spawner.sent).toEqual([{ workerId: "w1", msg: "also add a test" }]);
		expect(textOf(await tool(tools, "crew_status").execute("st", {}))).toContain("a ");
		const waiting = tool(tools, "crew_wait").execute("w", { items: ["a"], timeout: 5 });
		h.spawner.spawned[0]!.finish();
		expect(textOf(await waiting)).toContain("done");
		await tool(tools, "crew_kill").execute("k", { item: "b" });
		expect(h.spawner.killed).toContain("w2");
		expect(h.crew.run?.state("b")).toBe("cancelled");
		await h.crew.finishIfSettled();
		expect(h.crew.run?.finished).toBe(true);
	});

	it("refuses a second plan while a run is in progress", async () => {
		const h = harness();
		const plan = tool(createCrewTools(h.crew), "crew_plan");
		await plan.execute("c", { items: [item("a")] });
		await expect(plan.execute("c2", { items: [item("z")] })).rejects.toThrow(/still in progress/);
	});
});

describe("conductor control", () => {
	const open = entry("open/qwen-coder", 2, 2, { openWeight: true });

	it("crew_models lists every connected model with tier, price, estimates and open weights", async () => {
		const h = harness({ roster: [...ROSTER, open] });
		const out = textOf(await tool(createCrewTools(h.crew), "crew_models").execute("m", {}));
		expect(out).toContain("selector | provider | tier | $in/$out | est S/M/L | strengths | open | ctx | tok/s");
		expect(out).toContain("open/qwen-coder | open | t2 | 0.4/2 |");
		expect(out).toContain("| open |");
		expect(out).toContain("cheap/one | cheap | t1");
		const filtered = textOf(
			await tool(createCrewTools(h.crew), "crew_models").execute("m", { filter: { openWeight: true } }),
		);
		expect(filtered).toContain("1 of 4 connected model(s)");
		expect(filtered).not.toContain("top/three");
	});

	it("crew_policy persists and every later plan honours it", async () => {
		const h = harness({ roster: [...ROSTER, open] });
		const tools = createCrewTools(h.crew);
		const set = textOf(await tool(tools, "crew_policy").execute("p", { openWeightOnly: true }));
		expect(set).toContain("Crew policy set: open-weight only");
		expect(h.policy).toEqual({ openWeightOnly: true });
		await tool(tools, "crew_plan").execute("c", { items: [item("a")] });
		expect(h.requests[0]!.cast.assignments[0]!.selector).toBe("open/qwen-coder");
		expect(h.requests[0]!.policy).toEqual({ openWeightOnly: true });
	});

	it("crew_policy refuses a policy nothing satisfies and keeps the old one", async () => {
		const h = harness();
		await expect(tool(createCrewTools(h.crew), "crew_policy").execute("p", { openWeightOnly: true })).rejects.toThrow(
			/No connected model satisfies that policy/,
		);
		expect(h.policy).toEqual({});
	});

	it("crew_plan errors with what is available when the policy rules out every model for an item", async () => {
		const h = harness({ roster: [...ROSTER, open] });
		const tools = createCrewTools(h.crew);
		await tool(tools, "crew_policy").execute("p", { openWeightOnly: true });
		const error = await tool(tools, "crew_plan")
			.execute("c", { items: [item("a", { difficulty: 3 })] })
			.catch((e: Error) => e);
		expect((error as Error).message).toContain("No connected model satisfies the crew policy");
		expect((error as Error).message).toContain("open/qwen-coder (tier 2, open-weight)");
		expect(h.requests).toHaveLength(0);
	});

	it("uses the conductor's per-item model and shows the reason on the board", async () => {
		const h = harness();
		await tool(createCrewTools(h.crew), "crew_plan").execute("c", {
			items: [{ ...item("a"), model: "top/three", reason: "hardest part" }],
		});
		expect(h.requests[0]!.cast.assignments[0]).toMatchObject({
			selector: "top/three",
			reason: "conductor's pick: hardest part",
		});
	});

	it("passes the rejection note and row edits back, refuses an identical resubmission, honours the edits", async () => {
		let calls = 0;
		const h = harness({
			approve: req => {
				calls++;
				if (calls === 1)
					return { approved: false, note: "use open models", edits: [{ itemId: "a", selector: "mid/two" }] };
				return { approved: true, cast: req.cast };
			},
		});
		const plan = tool(createCrewTools(h.crew), "crew_plan");
		const first = await plan.execute("c", { items: [item("a")] }).catch((e: Error) => e);
		expect((first as Error).message).toContain("Gaurav rejected: use open models");
		expect((first as Error).message).toContain("a → mid/two");
		// Same items: the board pick changes the cast, so this is not identical; it goes to the board on mid/two.
		await plan.execute("c2", { items: [item("a")] });
		expect(h.requests[1]!.cast.assignments[0]!.selector).toBe("mid/two");
	});

	it("refuses an identical resubmission after a rejection without edits", async () => {
		const h = harness({ approve: () => ({ approved: false, note: "too expensive" }) });
		const plan = tool(createCrewTools(h.crew), "crew_plan");
		await plan.execute("c", { items: [item("a")] }).catch(() => undefined);
		const second = await plan.execute("c2", { items: [item("a")] }).catch((e: Error) => e);
		expect((second as Error).message).toContain("same plan Gaurav rejected as plan #1");
		expect((second as Error).message).toContain("too expensive");
		expect(h.requests).toHaveLength(1);
		// Changing the model is a real change: it reaches the board.
		await plan.execute("c3", { items: [{ ...item("a"), model: "mid/two" }] }).catch(() => undefined);
		expect(h.requests).toHaveLength(2);
	});

	it("crew_add casts only the new items, shows them on the board and runs them in the live run", async () => {
		const h = harness();
		const tools = createCrewTools(h.crew);
		await tool(tools, "crew_plan").execute("c", { items: [item("a")] });
		await tick();
		const result = await tool(tools, "crew_add").execute("add", {
			items: [item("b", { dependsOn: ["a"] }), { ...item("c"), model: "mid/two" }],
		});
		await tick();
		expect(h.requests[1]!.addingTo).toBe(h.crew.run!.runId);
		expect(h.requests[1]!.items.map(i => i.id)).toEqual(["b", "c"]);
		expect(textOf(result)).toContain("Added 2 item(s)");
		expect(h.crew.run!.snapshot().map(e => e.item.id)).toEqual(["a", "b", "c"]);
		expect(h.spawner.spawned.map(w => w.model)).toEqual(["cheap/one", "mid/two"]);
		h.spawner.spawned[0]!.finish();
		await tick();
		expect(h.spawner.spawned).toHaveLength(3);
		expect(new Set(h.crew.run!.snapshot().map(e => e.name)).size).toBe(3);
	});

	it("crew_add rejects duplicate ids and scope clashes with running items", async () => {
		const h = harness();
		const tools = createCrewTools(h.crew);
		await tool(tools, "crew_plan").execute("c", { items: [item("a", { scope: ["src/"] })] });
		await expect(tool(tools, "crew_add").execute("x", { items: [item("a")] })).rejects.toThrow(/already in this run/);
		await expect(tool(tools, "crew_add").execute("x", { items: [item("b", { scope: ["src/b/"] })] })).rejects.toThrow(
			/overlapping paths/,
		);
		// A dependency on the running item makes the overlap safe.
		await tool(tools, "crew_add").execute("x", { items: [item("b", { scope: ["src/b/"], dependsOn: ["a"] })] });
		expect(h.crew.run!.snapshot()).toHaveLength(2);
	});

	it("crew_add without an active run starts a plan", async () => {
		const h = harness();
		await tool(createCrewTools(h.crew), "crew_add").execute("x", { items: [item("a")] });
		expect(h.runs).toHaveLength(1);
	});

	it("crew_reassign swaps a waiting item and restarts a running one with notes", async () => {
		const h = harness();
		const tools = createCrewTools(h.crew);
		await tool(tools, "crew_plan").execute("c", { items: [item("a"), item("b", { dependsOn: ["a"] })] });
		await tick();
		const swap = textOf(await tool(tools, "crew_reassign").execute("r", { item: "b", model: "top/three" }));
		expect(swap).toContain("will start on top/three");
		const restart = textOf(
			await tool(tools, "crew_reassign").execute("r2", { item: "a", model: "mid/two", note: "keep the API" }),
		);
		await tick();
		expect(restart).toContain("restarted on mid/two");
		expect(h.spawner.killed).toEqual(["w1"]);
		expect(h.spawner.spawned[1]).toMatchObject({ model: "mid/two" });
		expect(h.spawner.spawned[1]!.prompt).toContain("keep the API");
		h.spawner.spawned[1]!.finish();
		await tick();
		expect(h.spawner.spawned[2]!.model).toBe("top/three");
	});

	it("crew_reassign enforces the policy and refuses unknown models", async () => {
		const h = harness({ roster: [...ROSTER, open] });
		const tools = createCrewTools(h.crew);
		await tool(tools, "crew_policy").execute("p", { openWeightOnly: true });
		await tool(tools, "crew_plan").execute("c", { items: [item("a")] });
		await expect(tool(tools, "crew_reassign").execute("r", { item: "a", model: "top/three" })).rejects.toThrow(
			/closed weights/,
		);
		await expect(tool(tools, "crew_reassign").execute("r", { item: "a", model: "x/y" })).rejects.toThrow(
			/not a connected model/,
		);
	});
});
