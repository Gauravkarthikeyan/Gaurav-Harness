/** `telemetry` panel: tok/s, ctx and $/min sparklines plus an in/out/cached token line. */
import { frame, padEnd, padStart, type StageStyle, type StageToken, sparkline } from "./common";

export interface TelemetrySeries {
	values: readonly number[];
	/** Preformatted current value, e.g. `94`, `9%`, `.04`. */
	current: string;
	/** Scale ceiling; defaults to the window max (ctx usually passes 1 for fractions). */
	max?: number;
}

export interface TelemetryData {
	tokPerSec: TelemetrySeries;
	ctx: TelemetrySeries;
	costPerMin: TelemetrySeries;
	/** Preformatted token totals, e.g. `162.1k`. */
	io: { in: string; out: string; cached: string };
}

const LABEL_W = 6;

export function renderTelemetry(data: TelemetryData, width: number, height: number, style: StageStyle): string[] {
	const lines: [string, TelemetrySeries, StageToken][] = [
		["tok/s", data.tokPerSec, "accent"],
		["ctx", data.ctx, "info"],
		["$/min", data.costPerMin, "success"],
	];
	const valueW = Math.max(3, ...lines.map(([, s]) => s.current.length));
	const cells = Math.max(0, width - LABEL_W - 1 - valueW);
	const rows = lines.map(
		([label, s, token]) =>
			`${style("muted", padEnd(label, LABEL_W))}${style(token, sparkline(s.values, cells, s.max))} ${style("text", padStart(s.current, valueW))}`,
	);
	const dot = style("dim", " · ");
	rows.push(
		[
			`${style("dim", "in")} ${style("text", data.io.in)}`,
			`${style("dim", "out")} ${style("text", data.io.out)}`,
			`${style("dim", "cached")} ${style("text", data.io.cached)}`,
		].join(dot),
	);
	return frame(rows, width, height);
}
