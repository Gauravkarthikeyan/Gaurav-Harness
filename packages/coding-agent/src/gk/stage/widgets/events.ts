/** `events` panel (`tail -f`): time, state glyph, agent in its hue, text. Rows are drawn in the order given. */
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { frame, glyph, padEnd, type StageStyle, type StageToken, type StateGlyph } from "./common";

export interface EventRow {
	/** `HH:MM:SS`. */
	time: string;
	glyph: StateGlyph;
	agent: string;
	agentToken?: StageToken;
	text: string;
}

export interface EventsData {
	rows: readonly EventRow[];
}

const AGENT_MIN = 6;

export function renderEvents(data: EventsData, width: number, height: number, style: StageStyle): string[] {
	const agentW = Math.max(AGENT_MIN, ...data.rows.map(r => visibleWidth(r.agent)));
	const rows = data.rows.map(
		r =>
			`${style("dim", r.time)} ${glyph(r.glyph, style)} ${style(r.agentToken ?? "muted", padEnd(r.agent, agentW))} ${style(r.glyph === "warning" ? "warning" : "text", r.text)}`,
	);
	return frame(rows, width, height);
}
