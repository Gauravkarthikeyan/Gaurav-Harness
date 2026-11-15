import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { CREW_TOOL_NAMES, createCrewTools } from "../../src/gk/crew-tools";
import { harness, item, tick } from "./crew-fixtures";

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
