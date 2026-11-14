import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CrewRunSummary } from "./crew-runtime";

export type CrewLedgerEntry = CrewRunSummary & { promptHead: string; at: string };

function isLedgerEntry(value: unknown): value is CrewLedgerEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.runId === "string" &&
		typeof entry.at === "string" &&
		typeof entry.promptHead === "string" &&
		Array.isArray(entry.items) &&
		typeof entry.actualUsd === "number" &&
		typeof entry.baselineEstUsd === "number" &&
		(entry.status === "completed" || entry.status === "partial" || entry.status === "cancelled")
	);
}

/** Append-only JSONL record of finished crew runs (`~/.gk/agent/crew-ledger.jsonl`). */
export class CrewLedger {
	readonly #path: string;

	constructor(filePath: string) {
		this.#path = filePath;
	}

	async append(entry: CrewLedgerEntry): Promise<void> {
		await fs.mkdir(path.dirname(this.#path), { recursive: true });
		await fs.appendFile(this.#path, `${JSON.stringify(entry)}\n`, "utf8");
	}

	/** Newest first; unreadable or malformed lines are skipped. */
	async list(limit: number): Promise<CrewLedgerEntry[]> {
		let content: string;
		try {
			content = await fs.readFile(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const entries: CrewLedgerEntry[] = [];
		const lines = content.split("\n");
		for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isLedgerEntry(parsed)) entries.push(parsed);
			} catch {
				// Corrupt line (e.g. a torn write): skip it.
			}
		}
		return entries;
	}
}
