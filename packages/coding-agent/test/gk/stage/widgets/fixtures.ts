import type { DagData } from "../../../../src/gk/stage/widgets/dag";
import type { EventsData } from "../../../../src/gk/stage/widgets/events";
import type { GitData } from "../../../../src/gk/stage/widgets/git";
import type { HeaderData } from "../../../../src/gk/stage/widgets/header";
import type { PaneStatusData } from "../../../../src/gk/stage/widgets/pane-status";
import type { ProcData } from "../../../../src/gk/stage/widgets/proc";
import type { ThroughputData } from "../../../../src/gk/stage/widgets/sparkline";
import type { StatusBarData } from "../../../../src/gk/stage/widgets/statusbar";
import type { TabsData } from "../../../../src/gk/stage/widgets/tabs";
import type { TelemetryData } from "../../../../src/gk/stage/widgets/telemetry";
import type { TodoData } from "../../../../src/gk/stage/widgets/todo";
import type { DiffBlock, PlanTable, TranscriptEvent } from "../../../../src/gk/stage/widgets/transcript-lines";

export const header: HeaderData = {
	logo: ["</> GK", "    ──"],
	session: "gk-7f3a2c",
	mode: "ORCHESTRA",
	host: "MacBook-Air · arm64",
	cwd: "~/Developer/Gk-code",
	branch: "main ↑2 ✱4 ?1",
	uptime: "00:14:22 · pid 48190",
	cost: { label: "RUN", spent: "$0.42", budget: "$2.00", fraction: 0.21 },
	saved: "−88% vs opus-only",
	today: "$1.84 · 6 runs",
	ctx: { used: 34_000, limit: 200_000, label: "34k/200k" },
	cache: "72% hit",
	clock: "03:11:42",
	date: "SUN 15 NOV",
};

export const tabs: TabsData = {
	tabs: [
		{ index: 0, name: "stage", active: true },
		{ index: 1, name: "crew" },
		{ index: 2, name: "logs" },
		{ index: 3, name: "git" },
		{ index: 4, name: "pty:claude" },
	],
	summary: [
		[
			{ glyph: "running", text: "2 running" },
			{ glyph: "queued", text: "1 queued" },
			{ glyph: "done", text: "1 done" },
		],
		[{ text: "plan#1 · 4 items" }],
	],
};

export const statusBar: StatusBarData = {
	window: "0:stage",
	branch: "main ↑2",
	mcp: { up: 3, total: 4 },
	skills: 19,
	model: "opus-5.5",
	role: "conductor",
	crew: { running: 2, queued: 1, done: 1 },
	cost: "$0.42",
	clock: "03:11 15-Nov-26",
	hints: [
		{ key: "^K", label: "palette" },
		{ key: "⏎", label: "zoom pane" },
		{ key: "^O", label: "expand" },
		{ key: "M-a", label: "agent hub" },
		{ key: "?", label: "help" },
	],
	version: "gk-code 0.1.0",
};

export const paneStatus: PaneStatusData = {
	branch: "main",
	model: "haiku-5.5",
	tokens: "61.2k",
	cost: "$0.03",
	ctx: { used: 18_402, limit: 100_000 },
	scope: "src/api/",
};

export const events: TranscriptEvent[] = [
	{ time: "03:10:02", glyph: "done", text: "read src/server.ts", metric: "0.1s" },
	{ time: "03:10:41", glyph: "done", text: "edit src/api/routes.ts", metric: "+12 −3" },
	{
		time: "03:11:02",
		glyph: "running",
		text: "verifying @ada",
		continuation: ["route matches the existing router style"],
	},
	{ time: "03:11:38", glyph: "running", text: "bash bun test api", metric: "→ pane 0.3" },
];

export const diff: DiffBlock = {
	lines: [
		{ kind: "ctx", lineNo: 41, text: 'router.get("/health", health)' },
		{ kind: "del", lineNo: 42, text: "// TODO: hello endpoint" },
		{ kind: "add", lineNo: 42, text: 'router.get("/hello", hello)' },
	],
};

export const plan: PlanTable = {
	title: "PLAN #1 · 4 items · 2 waves",
	note: "−88% vs baseline",
	rows: [
		{ id: "W-01", owner: "ada", model: "haiku-5.5", scope: "src/api/", state: "running", stateText: "run 1:12" },
		{ id: "W-03", owner: "grace", model: "sonnet-5.5", scope: "test/", state: "queued", stateText: "← W-01 W-02" },
		{ id: "W-04", owner: "wren", model: "gemma-3-1b", scope: "docs/", state: "done", stateText: "done $0.00" },
	],
};

export const proc: ProcData = {
	rows: [
		{ pid: 48190, agent: "cond", model: "opus-5.5", tokPerSec: 94, state: "R", time: "02:14" },
		{ pid: 48213, agent: "bun", model: "test api", state: "R", time: "00:04" },
		{ agent: "grace", model: "sonnet-5.5", state: "Q" },
	],
};

export const throughput: ThroughputData = {
	series: [
		{ agent: "cond", values: [0, 1, 2, 3, 4, 5, 6, 7] },
		{ agent: "ada", values: [7, 7, 7, 7] },
	],
	footer: "cache hit 72%",
};

export const telemetry: TelemetryData = {
	tokPerSec: { values: [1, 2, 4, 8], current: "94" },
	ctx: { values: [0.05, 0.07, 0.09], current: "9%", max: 1 },
	costPerMin: { values: [0, 0, 4], current: ".04" },
	io: { in: "162.1k", out: "26.3k", cached: "131k" },
};

export const todo: TodoData = {
	items: [
		{ text: "reproduce loop with curl", state: "done" },
		{ text: "regression test green", state: "current" },
		{ text: "ship", state: "pending" },
	],
};

export const dag: DagData = {
	nodes: [
		{ id: "W-04", agent: "wren", state: "done" },
		{ id: "W-01", agent: "ada", state: "running" },
		{ id: "W-02", agent: "linus", state: "running" },
		{ id: "W-03", agent: "grace", state: "queued" },
	],
	edges: [
		{ from: "W-04", to: "W-03" },
		{ from: "W-01", to: "W-03" },
		{ from: "W-02", to: "W-03" },
	],
};

export const git: GitData = {
	graph: [
		{ graph: "*", sha: "a3f9c1e", refs: "HEAD→main", subject: "add health check" },
		{ graph: "*", sha: "77e0b21", subject: "split api module" },
		{ graph: "│" },
	],
	files: [
		{ status: "M", path: "src/api/routes.ts", add: 12, del: 3 },
		{ status: "A", path: "src/ui/Hello.tsx", add: 64, del: 0 },
		{ status: "D", path: "old.ts", add: 0, del: 8 },
	],
};

export const eventsPanel: EventsData = {
	rows: [
		{ time: "03:11:42", glyph: "running", agent: "ada", text: "bash bun test api" },
		{ time: "03:11:31", glyph: "done", agent: "scout", text: "done → linus" },
		{ time: "03:04:51", glyph: "warning", agent: "mcp", text: "grovv 401" },
	],
};
