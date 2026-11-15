/** Per-pane statusline: `⎇ main  ✱ haiku-5.5  § 61.2k  $0.03  ◷ 18,402 (18%)  scope src/api/`. */
import { frame, joinSegments, type Segment, type StageStyle, type StageToken } from "./common";

export interface PaneStatusData {
	/** Agent name, drawn first in `agentToken` (e.g. `ada`). */
	agent?: string;
	agentToken?: StageToken;
	branch?: string;
	/** Uncommitted changes: draws a `●` after the branch. */
	dirty?: boolean;
	model?: string;
	/** Preformatted token count, e.g. `61.2k`. */
	tokens?: string;
	/** e.g. `$0.03`. */
	cost?: string;
	ctx?: { used: number; limit: number };
	scope?: string;
}

export function renderPaneStatus(data: PaneStatusData, width: number, height: number, style: StageStyle): string[] {
	const segs: Segment[] = [];
	if (data.agent) segs.push({ text: style(data.agentToken ?? "text", data.agent), priority: 9 });
	if (data.branch) {
		segs.push({
			text: `${style("muted", "⎇")} ${style("text", data.branch)}${data.dirty ? ` ${style("warning", "●")}` : ""}`,
			priority: 2,
		});
	}
	if (data.model) segs.push({ text: `${style("accent", "✱")} ${style("text", data.model)}`, priority: 8 });
	if (data.tokens) segs.push({ text: `${style("muted", "§")} ${style("text", data.tokens)}`, priority: 3 });
	if (data.cost) segs.push({ text: style("text", data.cost), priority: 6 });
	if (data.ctx) {
		const pct = data.ctx.limit > 0 ? Math.round((data.ctx.used / data.ctx.limit) * 100) : 0;
		segs.push({
			text: `${style("muted", "◷")} ${style("text", data.ctx.used.toLocaleString("en-US"))} ${style("muted", `(${pct}%)`)}`,
			priority: 5,
		});
	}
	if (data.scope) segs.push({ text: `${style("dim", "scope")} ${style("text", data.scope)}`, priority: 4 });
	return frame([joinSegments(segs, "  ", width)], width, height);
}
