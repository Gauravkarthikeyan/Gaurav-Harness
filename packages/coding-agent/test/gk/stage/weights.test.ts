import { describe, expect, it } from "bun:test";
import { attentionWeight, KIND_BASE, STATE_MUL, subtreeWeights } from "../../../src/gk/stage/weights";

describe("attentionWeight", () => {
	it("matches the spec formula for a fresh running agent", () => {
		const w = attentionWeight({ kind: "agent", state: "running", lastActivityAt: 1000, focused: false }, 1000);
		expect(w).toBeCloseTo(2 * 1.6 * 2, 10);
	});

	it("decays with an 8 s time constant", () => {
		const w = attentionWeight({ kind: "command", state: "done", lastActivityAt: 0, focused: false }, 8000);
		expect(w).toBeCloseTo(1 * 0.35 * (1 + Math.exp(-1)), 10);
	});

	it("multiplies focus by 2.5", () => {
		const w = attentionWeight({ kind: "transcript", state: "idle", lastActivityAt: 0, focused: true }, 16000);
		expect(w).toBeCloseTo(4 * 0.6 * (1 + Math.exp(-2)) * 2.5, 10);
	});

	it("uses the spec constants", () => {
		expect(KIND_BASE).toMatchObject({
			transcript: 4,
			error: 2.5,
			agent: 2,
			pty: 2,
			computer: 2,
			dag: 1.5,
			git: 1,
			command: 1,
			timeline: 0.8,
			web: 0.6,
		});
		expect(STATE_MUL).toEqual({ error: 2, running: 1.6, idle: 0.6, done: 0.35 });
	});
});

describe("subtreeWeights", () => {
	it("sums descendants and treats unknown parents as roots", () => {
		const out = subtreeWeights([
			{ id: "a", parentId: null, weight: 1 },
			{ id: "b", parentId: "a", weight: 2 },
			{ id: "c", parentId: "b", weight: 3 },
			{ id: "d", parentId: "missing", weight: 4 },
		]);
		expect(out.get("c")).toBe(3);
		expect(out.get("b")).toBe(5);
		expect(out.get("a")).toBe(6);
		expect(out.get("d")).toBe(4);
	});

	it("terminates on cycles", () => {
		const out = subtreeWeights([
			{ id: "a", parentId: "b", weight: 1 },
			{ id: "b", parentId: "a", weight: 1 },
		]);
		expect(out.size).toBe(2);
	});
});
