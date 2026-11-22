import { describe, expect, it } from "bun:test";
import type { FileEntry } from "../../src/session/session-entries";
import { extractSessionInit } from "../../src/session/session-manager";

describe("crew worker revival", () => {
	it("session_init keeps the conductor id so a revived worker gets ask_conductor back", () => {
		const entries = [
			{
				type: "session_init",
				id: "e1",
				parentId: null,
				timestamp: "2026-11-16T00:00:00.000Z",
				systemPrompt: ["sys"],
				task: "brief",
				tools: ["read", "write"],
				crewConductorId: "main",
			},
		] as unknown as FileEntry[];
		expect(extractSessionInit(entries)?.crewConductorId).toBe("main");
		const plain = [{ ...entries[0], crewConductorId: undefined }] as unknown as FileEntry[];
		expect(extractSessionInit(plain)).not.toHaveProperty("crewConductorId");
	});
});
