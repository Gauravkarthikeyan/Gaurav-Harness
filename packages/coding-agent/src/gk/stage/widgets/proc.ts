/** `proc` panel: one row per agent/process with PID AGENT MODEL TOK/S S TIME. */
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { frame, padEnd, padStart, type StageStyle, type StageToken } from "./common";

/** R running · Q queued · X exited/killed · Z zombie (finished, awaiting reap) · S sleeping. */
export type ProcState = "R" | "Q" | "X" | "Z" | "S";

export interface ProcRow {
	pid?: number;
	agent: string;
	agentToken?: StageToken;
	model: string;
	tokPerSec?: number;
	state: ProcState;
	/** e.g. `02:14`. */
	time?: string;
}

export interface ProcData {
	rows: readonly ProcRow[];
}

const STATE_TOKEN: Record<ProcState, StageToken> = { R: "success", Q: "muted", X: "error", Z: "dim", S: "muted" };
const NONE = "–";

export function renderProc(data: ProcData, width: number, height: number, style: StageStyle): string[] {
	const pids = data.rows.map(r => (r.pid === undefined ? NONE : String(r.pid)));
	const tps = data.rows.map(r => (r.tokPerSec === undefined ? NONE : String(Math.round(r.tokPerSec))));
	const times = data.rows.map(r => r.time ?? NONE);
	const pidW = Math.max(3, ...pids.map(p => p.length));
	const agentW = Math.max(5, ...data.rows.map(r => visibleWidth(r.agent)));
	const modelW = Math.max(5, ...data.rows.map(r => visibleWidth(r.model)));
	const tpsW = Math.max(5, ...tps.map(t => t.length));
	const timeW = Math.max(4, ...times.map(t => t.length));
	// Fixed columns: PID, AGENT, S, TIME. MODEL then TOK/S drop when narrow.
	const fixed = pidW + 2 + agentW + 2 + 1 + 2 + timeW;
	const showModel = fixed + modelW + 2 + tpsW + 2 <= width;
	const showTps = fixed + (showModel ? modelW + 2 : 0) + tpsW + 2 <= width;

	const row = (cols: [string, StageToken][]) => cols.map(([t, tok]) => style(tok, t)).join("  ");
	const header: [string, StageToken][] = [
		[padEnd("PID", pidW), "dim"],
		[padEnd("AGENT", agentW), "dim"],
	];
	if (showModel) header.push([padEnd("MODEL", modelW), "dim"]);
	if (showTps) header.push([padStart("TOK/S", tpsW), "dim"]);
	header.push(["S", "dim"], [padStart("TIME", timeW), "dim"]);

	const rows = [row(header)];
	data.rows.forEach((r, i) => {
		const cols: [string, StageToken][] = [
			[padStart(pids[i]!, pidW), "muted"],
			[padEnd(r.agent, agentW), r.agentToken ?? "text"],
		];
		if (showModel) cols.push([padEnd(r.model, modelW), "muted"]);
		if (showTps) cols.push([padStart(tps[i]!, tpsW), "text"]);
		cols.push([r.state, STATE_TOKEN[r.state]], [padStart(times[i]!, timeW), "muted"]);
		rows.push(row(cols));
	});
	return frame(rows, width, height);
}
