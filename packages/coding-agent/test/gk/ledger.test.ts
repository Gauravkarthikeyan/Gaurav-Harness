import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CrewLedger, type CrewLedgerEntry } from "../../src/gk/ledger";

function entry(runId: string): CrewLedgerEntry {
	return {
		runId,
		items: [{ itemId: "a", name: "CalmPanda", selector: "x/y", state: "done", costUsd: 0.1, durationMs: 5 }],
		actualUsd: 0.1,
		baselineEstUsd: 1,
		status: "completed",
		promptHead: `prompt ${runId}`,
		at: "2026-11-15T00:00:00.000Z",
	};
}

describe("CrewLedger", () => {
	const dirs: string[] = [];
	const ledgerPath = (): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-"));
		dirs.push(dir);
		return path.join(dir, "nested", "crew-ledger.jsonl");
	};

	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("returns [] when the ledger does not exist", async () => {
		expect(await new CrewLedger(ledgerPath()).list(10)).toEqual([]);
	});

	it("lists appended entries newest first", async () => {
		const ledger = new CrewLedger(ledgerPath());
		await ledger.append(entry("r1"));
		await ledger.append(entry("r2"));
		await ledger.append(entry("r3"));
		expect((await ledger.list(10)).map(e => e.runId)).toEqual(["r3", "r2", "r1"]);
		expect((await ledger.list(2)).map(e => e.runId)).toEqual(["r3", "r2"]);
		expect((await ledger.list(10))[0]).toEqual(entry("r3"));
	});

	it("skips corrupt lines", async () => {
		const file = ledgerPath();
		const ledger = new CrewLedger(file);
		await ledger.append(entry("r1"));
		fs.appendFileSync(file, '{"runId": "torn", "items": [\nnot json at all\n{"runId": 5}\n');
		await ledger.append(entry("r2"));
		expect((await ledger.list(10)).map(e => e.runId)).toEqual(["r2", "r1"]);
	});
});
