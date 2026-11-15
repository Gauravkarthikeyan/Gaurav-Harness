/** Bottom chrome: status row (H-2) and key-hint row (H-1). */
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { frame, joinSegments, type Segment, type StageStyle, spread } from "./common";

export interface KeyHint {
	key: string;
	label: string;
}

export interface StatusBarData {
	/** Active window label, e.g. `0:stage`. */
	window: string;
	/** e.g. `main ↑2`. */
	branch?: string;
	mcp?: { up: number; total: number };
	skills?: number;
	model: string;
	/** e.g. `conductor`, `high`. */
	role?: string;
	crew?: { running: number; queued: number; done: number };
	/** e.g. `$0.42`. */
	cost?: string;
	/** e.g. `03:11 15-Nov-26`. */
	clock?: string;
	hints: readonly KeyHint[];
	/** e.g. `gk-code 0.1.0`. */
	version: string;
}

const SEP = "  ";

export function renderStatusBar(data: StatusBarData, width: number, height: number, style: StageStyle): string[] {
	const left: Segment[] = [
		{ text: style("accent", "[gk]"), priority: 9 },
		{ text: style("text", `${data.window}*`), priority: 8 },
	];
	if (data.branch) left.push({ text: `${style("muted", "⎇")} ${style("text", data.branch)}`, priority: 5 });
	const tools: string[] = [];
	if (data.mcp) tools.push(`MCP ${data.mcp.up}/${data.mcp.total}`);
	if (data.skills !== undefined) tools.push(`skills ${data.skills}`);
	if (tools.length > 0) left.push({ text: style("muted", tools.join(" · ")), priority: 1 });

	const right: Segment[] = [
		{
			text: `${style("accent", "✱")} ${style("text", data.model)}${data.role ? ` ${style("muted", data.role)}` : ""}`,
			priority: 4,
		},
	];
	if (data.crew) {
		const { running, queued, done } = data.crew;
		right.push({
			text: `${style("muted", "crew")} ${style("accent", `${running}▶`)}${style("muted", `${queued}○`)}${style("success", `${done}✓`)}`,
			priority: 6,
		});
	}
	if (data.cost) right.push({ text: style("text", data.cost), priority: 7 });
	if (data.clock) right.push({ text: style("muted", data.clock), priority: 3 });

	// Right side gets first claim on the row, keeping at least the `[gk]` stub on the left.
	const leftMin = joinSegments(left, SEP, 0);
	const rightText = `${joinSegments(right, SEP, Math.max(0, width - 2 - visibleWidth(leftMin) - 2))} `;
	const leftText = ` ${joinSegments(left, SEP, Math.max(0, width - 1 - visibleWidth(rightText) - 1))}`;
	const status = spread(leftText, rightText, width);

	const hints = data.hints.map((h, i) => ({
		text: `${style(i === 0 ? "accent" : "text", h.key)} ${style("muted", h.label)}`,
		priority: -i,
	}));
	const version = `${style("dim", data.version)} `;
	const hintText = ` ${joinSegments(hints, SEP, Math.max(0, width - 1 - visibleWidth(version) - 1))}`;
	const hintRow = spread(hintText, version, width);
	return frame([status, hintRow], width, height);
}
