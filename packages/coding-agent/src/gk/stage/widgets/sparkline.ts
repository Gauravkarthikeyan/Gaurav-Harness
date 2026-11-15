/** `throughput` panel: one tok/s sparkline per agent, shared scale, current value right-aligned. */
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { frame, padEnd, padStart, type StageStyle, type StageToken, sparkline } from "./common";

export interface ThroughputSeries {
	agent: string;
	agentToken?: StageToken;
	/** Oldest first; the newest values that fit are drawn. */
	values: readonly number[];
	/** Shown at the right; defaults to the last value. */
	current?: number;
}

export interface ThroughputData {
	series: readonly ThroughputSeries[];
	/** Bottom row, e.g. `cache hit 72% · ttft p50 1.1s · 0 retries`. */
	footer?: string;
}

export function renderThroughput(data: ThroughputData, width: number, height: number, style: StageStyle): string[] {
	const nameW = Math.max(0, ...data.series.map(s => visibleWidth(s.agent)));
	const currents = data.series.map(s => String(Math.round(s.current ?? s.values.at(-1) ?? 0)));
	const valueW = Math.max(3, ...currents.map(c => c.length));
	const cells = Math.max(0, width - nameW - 2 - 2 - valueW);
	const max = Math.max(0, ...data.series.flatMap(s => s.values.slice(-cells)));
	const rows = data.series.map((s, i) => {
		const token = s.agentToken ?? "text";
		return `${style(token, padEnd(s.agent, nameW))}  ${style(token, sparkline(s.values, cells, max))}  ${style("text", padStart(currents[i]!, valueW))}`;
	});
	if (data.footer && height > rows.length) {
		while (rows.length < height - 1) rows.push("");
		rows.push(style("dim", data.footer));
	}
	return frame(rows, width, height);
}
