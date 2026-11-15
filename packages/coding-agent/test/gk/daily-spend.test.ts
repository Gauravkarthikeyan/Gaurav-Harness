import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { budgetNotice, DailySpendReader, localDay, sumSpendForDay } from "@oh-my-pi/pi-coding-agent/gk/daily-spend";
import { cfgGkBudgetDailyUsd } from "@oh-my-pi/pi-coding-agent/gk/settings";

/** ISO instant for a local wall-clock time, so day bucketing is checked in the runner's own time zone. */
function localIso(year: number, month: number, day: number, hour: number, minute = 0): string {
	return new Date(year, month - 1, day, hour, minute).toISOString();
}

describe("sumSpendForDay", () => {
	it("sums only the records of the requested local day", () => {
		const records = [
			{ at: localIso(2026, 11, 14, 23, 59), costUsd: 5 },
			{ at: localIso(2026, 11, 15, 0, 1), costUsd: 1.25 },
			{ at: localIso(2026, 11, 15, 12), costUsd: 0.5 },
			{ at: localIso(2026, 11, 15, 23, 58), costUsd: 0.25 },
			{ at: localIso(2026, 11, 16, 0, 0), costUsd: 7 },
		];
		expect(sumSpendForDay(records, "2026-11-15")).toBeCloseTo(2, 10);
		expect(sumSpendForDay(records, "2026-11-14")).toBe(5);
		expect(sumSpendForDay(records, "2026-11-17")).toBe(0);
	});

	it("ignores non-finite costs and unparsable timestamps", () => {
		const records = [
			{ at: localIso(2026, 11, 15, 9), costUsd: Number.NaN },
			{ at: "not a date", costUsd: 3 },
			{ at: localIso(2026, 11, 15, 10), costUsd: 1 },
		];
		expect(sumSpendForDay(records, "2026-11-15")).toBe(1);
	});
});

describe("localDay", () => {
	it("formats the local calendar day", () => {
		expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
	});
});

describe("budgetNotice", () => {
	it("names the spend and the limit once the limit is reached", () => {
		const notice = budgetNotice(12, 10);
		expect(notice).toContain("$12.00");
		expect(notice).toContain("$10.00");
		expect(budgetNotice(10, 10)).toContain("$10.00");
	});

	it("stays quiet without a limit or under it", () => {
		expect(budgetNotice(5, undefined)).toBeUndefined();
		expect(budgetNotice(5, 10)).toBeUndefined();
		expect(budgetNotice(5, 0)).toBeUndefined();
	});
});

describe("gk.budget.dailyUsd", () => {
	it("is registered without a default", () => {
		expect(cfgGkBudgetDailyUsd.id).toBe("gk.budget.dailyUsd");
	});
});

function assistant(id: string, at: Date, cost: number | undefined) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: at.toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				...(cost === undefined ? {} : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }),
			},
			stopReason: "stop",
			timestamp: at.getTime(),
		},
	};
}

const header = { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: "/tmp" };

describe("DailySpendReader", () => {
	let dir: string;
	let files: string[];
	let clock: number;
	const now = new Date();
	const today = (hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour);
	const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);

	async function writeSession(name: string, entries: unknown[]): Promise<string> {
		const file = path.join(dir, name);
		await Bun.write(file, `${[header, ...entries].map(e => JSON.stringify(e)).join("\n")}\n`);
		if (!files.includes(file)) files.push(file);
		return file;
	}

	function reader(ttlMs = 30_000) {
		return new DailySpendReader({ listFiles: async () => files, now: () => new Date(clock), ttlMs });
	}

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gk-daily-spend-"));
		files = [];
		clock = today(13).getTime();
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("sums today's recorded assistant costs across session files", async () => {
		await writeSession("a.jsonl", [assistant("a1", yesterday, 9), assistant("a2", today(9), 0.4)]);
		await writeSession("b.jsonl", [assistant("b1", today(10), 0.1), assistant("b2", today(11), undefined)]);
		expect(await reader().todayUsd()).toBeCloseTo(0.5, 10);
	});

	it("skips files not modified today", async () => {
		const old = await writeSession("old.jsonl", [assistant("o1", today(9), 3)]);
		await fs.utimes(old, yesterday, yesterday);
		await writeSession("new.jsonl", [assistant("n1", today(9), 1)]);
		expect(await reader().todayUsd()).toBe(1);
	});

	it("caches for the ttl, then reads appended entries", async () => {
		const file = await writeSession("a.jsonl", [assistant("a1", today(9), 1)]);
		const r = reader(30_000);
		expect(await r.todayUsd()).toBe(1);
		await fs.appendFile(file, `${JSON.stringify(assistant("a2", today(12), 2))}\n`);
		clock += 10_000;
		expect(await r.todayUsd()).toBe(1);
		clock += 25_000;
		expect(await r.todayUsd()).toBe(3);
	});

	it("shares one read between concurrent callers", async () => {
		let lists = 0;
		await writeSession("a.jsonl", [assistant("a1", today(9), 1)]);
		const r = new DailySpendReader({
			listFiles: async () => {
				lists++;
				return files;
			},
			now: () => new Date(clock),
		});
		const [x, y] = await Promise.all([r.todayUsd(), r.todayUsd()]);
		expect([x, y]).toEqual([1, 1]);
		expect(lists).toBe(1);
	});

	it("returns 0 when there are no sessions", async () => {
		expect(await reader().todayUsd()).toBe(0);
	});
});
