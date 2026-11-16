import { describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { StageHost } from "../../../src/gk/stage/host";
import { plainStyle } from "../../../src/gk/stage/style";
import type { AgentSessionEvent } from "../../../src/session/agent-session-events";

function host(todaySpend: ConstructorParameters<typeof StageHost>[0]["todaySpend"]) {
	const ui = {
		terminal: { columns: 212, rows: 58 },
		requestRender: () => {},
		showOverlay: () => ({ hide() {}, setHidden() {}, isHidden: () => false }) as never,
		addInputListener: () => () => {},
		hasOverlay: () => false,
	};
	const session = {
		subscribe: () => () => {},
		isStreaming: false,
		model: { id: "m" },
		messages: [],
		getSessionStats: () => ({ cost: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } }),
	};
	return new StageHost({
		ui,
		session: () => session,
		sessionId: () => "abc123",
		blocks: () => [] as Component[],
		chrome: () => [] as Component[],
		isAssistant: () => false,
		cwd: "/tmp/x",
		git: null,
		timers: false,
		motion: false,
		style: plainStyle,
		todaySpend,
	});
}

describe("StageHost TODAY", () => {
	it("renders – until the first read lands, then the amount; turn end re-reads", async () => {
		const reads: Array<PromiseWithResolvers<number>> = [];
		const stage = host({
			usd: () => {
				const read = Promise.withResolvers<number>();
				reads.push(read);
				return read.promise;
			},
			budgetUsd: () => undefined,
		});
		stage.start();
		expect(reads).toHaveLength(1);
		expect(stage.render(212, 58).join("\n")).toContain("TODAY   –");

		reads[0]!.resolve(3.456);
		await reads[0]!.promise;
		const text = stage.render(212, 58).join("\n");
		expect(text).toContain("TODAY   $3.46");
		expect(text).not.toContain("Daily budget reached");

		stage.handleEvent(null, { type: "agent_end" } as unknown as AgentSessionEvent);
		expect(reads).toHaveLength(2);
		stage.stop();
	});

	it("marks TODAY over gk.budget.dailyUsd and shows the notice once where it fits", async () => {
		const stage = host({ usd: async () => 12, budgetUsd: () => 10 });
		stage.start();
		await Promise.resolve();
		stage.handleEvent(null, { type: "agent_end" } as unknown as AgentSessionEvent);
		await Promise.resolve();
		expect(stage.render(212, 58).join("\n")).toContain("TODAY   ! $12.00 / $10.00");
		// Wide enough for the whole notice in the header's free space; the calm Solo layout hides the events rail.
		const wide = stage.render(300, 58).join("\n");
		expect(wide.match(/! Daily budget reached: \$12\.00 spent today of \$10\.00/g)).toHaveLength(1);
		stage.stop();
	});

	it("leaves TODAY at – when disabled", () => {
		const stage = host(null);
		stage.start();
		expect(stage.render(212, 58).join("\n")).toContain("TODAY   –");
		stage.stop();
	});
});
