import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createVibeCrewSpawner } from "@oh-my-pi/pi-coding-agent/gk/crew-runtime";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

function makeParentSession(): ToolSession {
	return {
		cwd: "/tmp",
		settings: Settings.isolated({ modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" } }),
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-session",
		// No session file: spawn skips lifecycle persistence and stays in-memory.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

function mockSubprocess(exitCode: number, output: string): Promise<ExecutorOptions> {
	const captured = Promise.withResolvers<ExecutorOptions>();
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		captured.resolve(options);
		return {
			index: 0,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: options.task,
			exitCode,
			output,
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		} as SingleResult;
	});
	return captured.promise;
}

describe("createVibeCrewSpawner", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("pins the worker to the assigned model on the task agent, bypassing the tier mapping", async () => {
		const options = mockSubprocess(0, "changed src/a.ts; ran bun test");
		const spawner = createVibeCrewSpawner(VibeSessionRegistry.global(), makeParentSession());

		const { workerId, settled } = await spawner.spawn({
			name: "CalmPanda",
			prompt: "Build a.",
			model: "google/flash",
		});
		const captured = await options;
		expect(workerId).toBe("CalmPanda");
		expect(captured.agent.name).toBe("task");
		expect(captured.modelOverride).toEqual(["google/flash"]);
		expect(captured.modelRole).toBeUndefined();
		expect(captured.task).toBe("Build a.");

		const result = await settled;
		expect(result.ok).toBe(true);
		expect(result.text).toContain("changed src/a.ts");
		expect(result.costUsd).toBe(0);
		expect(result.tokens).toBe(0);
	});

	it("reports a failed turn as not ok", async () => {
		void mockSubprocess(1, "could not build");
		const spawner = createVibeCrewSpawner(VibeSessionRegistry.global(), makeParentSession());
		const { settled } = await spawner.spawn({ name: "SadOtter", prompt: "Build b.", model: "google/flash" });
		const result = await settled;
		expect(result.ok).toBe(false);
		expect(result.text.length).toBeGreaterThan(0);
	});
});
