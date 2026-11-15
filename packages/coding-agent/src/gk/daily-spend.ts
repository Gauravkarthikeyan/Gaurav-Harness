/**
 * Today's spend across every session, from the same session-usage records `omp-stats` ingests: the stats parser
 * reads each session file's assistant/model-usage entries, and the recorded `usage.cost.total` of each is summed by
 * local calendar day. Subscription and local models record a zero cost, so they count as $0 here.
 *
 * Only files modified today can hold today's records. Each is parsed once and then tailed through the parser's
 * cursor, so a refresh reads just the bytes appended since the last one.
 */
import * as fs from "node:fs/promises";
import { listAllSessionFiles, parseSessionFile, type SessionParserState } from "@oh-my-pi/omp-stats/parser";
import { logger } from "@oh-my-pi/pi-utils";

export interface SpendRecord {
	/** ISO-8601 instant of the request. */
	at: string;
	costUsd: number;
}

/** Local calendar day `YYYY-MM-DD`. */
export function localDay(date: Date = new Date()): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Sum of the records whose instant falls on `day` (local `YYYY-MM-DD`); non-finite costs and bad instants count 0. */
export function sumSpendForDay(records: readonly SpendRecord[], day: string): number {
	let total = 0;
	for (const record of records) {
		const at = new Date(record.at);
		if (Number.isNaN(at.getTime()) || !Number.isFinite(record.costUsd)) continue;
		if (localDay(at) === day) total += record.costUsd;
	}
	return total;
}

/** Warning once today's spend reaches the daily budget; `undefined` without a positive budget or below it. */
export function budgetNotice(spent: number, limit?: number): string | undefined {
	if (limit === undefined || !(limit > 0) || !(spent >= limit)) return undefined;
	return `! Daily budget reached: $${spent.toFixed(2)} spent today of $${limit.toFixed(2)} (gk.budget.dailyUsd)`;
}

interface FileCursor {
	state: SessionParserState;
	records: SpendRecord[];
}

export interface DailySpendReaderOptions {
	/** Session transcripts to scan; defaults to every file under the sessions directory. */
	listFiles?: () => Promise<string[]>;
	now?: () => Date;
	/** How long a computed total is reused. */
	ttlMs?: number;
}

export class DailySpendReader {
	readonly #listFiles: () => Promise<string[]>;
	readonly #now: () => Date;
	readonly #ttlMs: number;
	readonly #cursors = new Map<string, FileCursor>();
	#cached: { day: string; at: number; usd: number } | undefined;
	#inflight: Promise<number> | undefined;

	constructor(options: DailySpendReaderOptions = {}) {
		this.#listFiles = options.listFiles ?? listAllSessionFiles;
		this.#now = options.now ?? (() => new Date());
		this.#ttlMs = options.ttlMs ?? 30_000;
	}

	/** Today's total in USD, reused for `ttlMs`; concurrent callers share one read. */
	todayUsd(): Promise<number> {
		const now = this.#now();
		const day = localDay(now);
		const cached = this.#cached;
		if (cached && cached.day === day && now.getTime() - cached.at < this.#ttlMs) return Promise.resolve(cached.usd);
		if (!this.#inflight) {
			this.#inflight = this.#read(now, day).finally(() => {
				this.#inflight = undefined;
			});
		}
		return this.#inflight;
	}

	async #read(now: Date, day: string): Promise<number> {
		const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const files = await this.#listFiles();
		const live = new Set<string>();
		let usd = 0;
		await Promise.all(
			files.map(async file => {
				const records = await this.#recordsSince(file, startOfDay);
				if (!records) return;
				live.add(file);
				usd += sumSpendForDay(records, day);
			}),
		);
		for (const file of this.#cursors.keys()) if (!live.has(file)) this.#cursors.delete(file);
		this.#cached = { day, at: now.getTime(), usd };
		return usd;
	}

	/** The file's spend records, or `undefined` when it was not modified since `startOfDay` (or vanished). */
	async #recordsSince(file: string, startOfDay: number): Promise<SpendRecord[] | undefined> {
		let mtimeMs: number;
		try {
			mtimeMs = (await fs.stat(file)).mtimeMs;
		} catch {
			return undefined;
		}
		if (mtimeMs < startOfDay) return undefined;
		const cursor = this.#cursors.get(file);
		try {
			const result = await parseSessionFile(file, cursor?.state.offset ?? 0, cursor?.state);
			const fresh: SpendRecord[] = [];
			for (const stat of result.stats) {
				if (!Number.isFinite(stat.timestamp) || stat.timestamp < startOfDay) continue;
				fresh.push({ at: new Date(stat.timestamp).toISOString(), costUsd: stat.usage.cost?.total ?? 0 });
			}
			// Keep only today's records so a long-running process does not accumulate history.
			const kept = cursor && !result.reset ? cursor.records.filter(r => Date.parse(r.at) >= startOfDay) : [];
			const records = [...kept, ...fresh];
			if (result.parserState) this.#cursors.set(file, { state: result.parserState, records });
			return records;
		} catch (err) {
			logger.warn("gk daily spend: session file unreadable", { file, error: String(err) });
			return cursor?.records;
		}
	}
}

const sharedReader = new DailySpendReader();

/** Today's spend in USD across all sessions, cached for ~30 s. */
export function getTodaySpendUsd(): Promise<number> {
	return sharedReader.todayUsd();
}
