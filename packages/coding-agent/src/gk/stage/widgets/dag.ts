/**
 * `dag` panel. Each node with dependencies is drawn as a fan-in: its sources stacked on the left,
 * joined by a bracket whose middle row points at the target.
 *
 *   W-04 @wren  ✓ ──┐
 *   W-01 @ada   ● ──┼──▶ W-03 @grace ○
 *   W-02 @linus ● ──┘
 */
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { frame, glyph, padEnd, type StageStyle, type StageToken } from "./common";

export type DagState = "running" | "queued" | "done" | "failed";

export interface DagNode {
	id: string;
	/** Without `@`. */
	agent?: string;
	agentToken?: StageToken;
	state: DagState;
}

export interface DagData {
	nodes: readonly DagNode[];
	edges: readonly { from: string; to: string }[];
	/** Append the `● run  ○ wait  ✓ done  ✗ fail` legend when there is room. Default true. */
	legend?: boolean;
}

export function renderDag(data: DagData, width: number, height: number, style: StageStyle): string[] {
	const byId = new Map(data.nodes.map(n => [n.id, n]));
	const labelW = Math.max(0, ...data.nodes.map(n => visibleWidth(n.id) + (n.agent ? n.agent.length + 2 : 0)));
	const label = (n: DagNode, pad: boolean) => {
		const raw = n.agent ? `${n.id} @${n.agent}` : n.id;
		const text = pad ? padEnd(raw, labelW) : raw;
		if (!n.agent) return style("text", text);
		return style("text", n.id) + style(n.agentToken ?? "muted", text.slice(n.id.length));
	};
	const node = (n: DagNode, pad: boolean) => `${label(n, pad)} ${glyph(n.state, style)}`;
	const edge = (s: string) => style("dim", s);

	const rows: string[] = [];
	const linked = new Set<string>();
	for (const e of data.edges) linked.add(e.from).add(e.to);
	for (const n of data.nodes) if (!linked.has(n.id)) rows.push(node(n, true));

	for (const target of data.nodes) {
		const sources = data.edges
			.filter(e => e.to === target.id)
			.map(e => byId.get(e.from))
			.filter((n): n is DagNode => n !== undefined);
		if (sources.length === 0) continue;
		const mid = Math.floor(sources.length / 2);
		sources.forEach((src, i) => {
			let conn: string;
			if (sources.length === 1) conn = "─────▶ ";
			else if (i === mid) conn = i === sources.length - 1 ? "──┴──▶ " : "──┼──▶ ";
			else conn = i === 0 ? "──┐" : i === sources.length - 1 ? "──┘" : "──┤";
			const tail = i === mid ? node(target, false) : "";
			rows.push(`${node(src, true)} ${edge(conn)}${tail}`);
		});
	}

	if (data.legend !== false && rows.length < height) {
		rows.push(
			[
				`${glyph("running", style)} ${style("muted", "run")}`,
				`${glyph("queued", style)} ${style("muted", "wait")}`,
				`${glyph("done", style)} ${style("muted", "done")}`,
				`${glyph("failed", style)} ${style("muted", "fail")}`,
			].join("  "),
		);
	}
	return frame(rows, width, height);
}
