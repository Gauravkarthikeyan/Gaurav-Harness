/**
 * Per-pane statusline: `⎇ main ●  ✱ gpt-5.6-luna · high  § 15.1k tok  $0.00  ◷ 15,140 (6%)  scope src/api/`,
 * plus, for the composer pane, a mode line under it: `-- INSERT --  tools 3 · edits 1 file`.
 */
import { frame, joinSegments, type Segment, type StageStyle, type StageToken } from "./common";

export interface PaneStatusData {
	/** Agent name, drawn first in `agentToken` (e.g. `ada`). */
	agent?: string;
	agentToken?: StageToken;
	branch?: string;
	/** Uncommitted changes: draws a `●` after the branch. */
	dirty?: boolean;
	model?: string;
	/** Thinking level shown after the model, e.g. `high`. */
	effort?: string;
	/** Preformatted token count, e.g. `61.2k` or `15.1k tok`. */
	tokens?: string;
	/** e.g. `$0.03`. */
	cost?: string;
	ctx?: { used: number; limit: number };
	scope?: string;
	/** Second row (composer pane only), drawn when `height >= 2`. */
	modeLine?: { mode: string; tools: number; editedFiles: number };
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
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
	if (data.model) {
		const effort = data.effort ? style("muted", ` · ${data.effort}`) : "";
		segs.push({ text: `${style("accent", "✱")} ${style("text", data.model)}${effort}`, priority: 8 });
	}
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
	const rows = [joinSegments(segs, "  ", width)];
	const mode = data.modeLine;
	if (mode) {
		rows.push(
			`${style("text", `-- ${mode.mode} --`)}  ${style("muted", `tools ${mode.tools} · edits ${plural(mode.editedFiles, "file")}`)}`,
		);
	}
	return frame(rows, width, height);
}
