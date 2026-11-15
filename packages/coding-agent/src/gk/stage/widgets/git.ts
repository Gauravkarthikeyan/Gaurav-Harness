/** `git` panel: commit graph lines, then changed files with status letter and diffstat bar. */
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { frame, padEnd, type StageStyle, type StageToken } from "./common";

export interface GitGraphLine {
	/** Graph prefix, e.g. `*`, `| *`, `|/`. */
	graph: string;
	/** Absent for graph-only rows. */
	sha?: string;
	/** e.g. `HEAD→main`; drawn in parentheses. */
	refs?: string;
	subject?: string;
}

export type GitFileStatus = "M" | "A" | "D" | "R";

export interface GitFile {
	status: GitFileStatus;
	path: string;
	add: number;
	del: number;
}

export interface GitData {
	graph: readonly GitGraphLine[];
	files: readonly GitFile[];
}

const STATUS_TOKEN: Record<GitFileStatus, StageToken> = { M: "warning", A: "success", D: "error", R: "info" };
const BAR_CELLS = 10;
const PATH_MIN = 8;

export function renderGit(data: GitData, width: number, height: number, style: StageStyle): string[] {
	const rows = data.graph.map(g => {
		let line = style("muted", g.graph);
		if (g.sha) line += ` ${style("accent", g.sha)}`;
		if (g.refs) line += ` ${style("info", `(${g.refs})`)}`;
		if (g.subject) line += ` ${style("text", g.subject)}`;
		return line;
	});

	const maxChange = Math.max(1, ...data.files.map(f => f.add + f.del));
	const stats = data.files.map(f => [f.add ? `+${f.add}` : "", f.del ? `−${f.del}` : ""].filter(Boolean).join(" "));
	const statW = Math.max(0, ...stats.map(s => visibleWidth(s)));
	const pathRoom = width - 2 - 2 - BAR_CELLS - 2 - statW;
	const showBar = pathRoom >= PATH_MIN;
	const pathW = Math.min(
		Math.max(0, ...data.files.map(f => visibleWidth(f.path))),
		Math.max(0, showBar ? pathRoom : width - 2 - 2 - statW),
	);
	for (const f of data.files) {
		const path = padEnd(truncateToWidth(f.path, pathW), pathW);
		let line = `${style(STATUS_TOKEN[f.status], f.status)} ${style("text", path)}  `;
		if (showBar) {
			// Scale by the largest change; any nonzero part gets at least one cell.
			const total = Math.max(f.add + f.del > 0 ? 1 : 0, Math.round(((f.add + f.del) / maxChange) * BAR_CELLS));
			const delCells = f.del > 0 ? Math.max(1, Math.round((f.del / (f.add + f.del)) * total)) : 0;
			const addCells = Math.max(0, total - delCells);
			line += `${style("success", "▇".repeat(addCells))}${style("error", "▒".repeat(delCells))}${" ".repeat(BAR_CELLS - addCells - delCells)}  `;
		}
		const [add, del] = [f.add ? `+${f.add}` : "", f.del ? `−${f.del}` : ""];
		line += [add && style("success", add), del && style("error", del)].filter(Boolean).join(" ");
		rows.push(line);
	}
	return frame(rows, width, height);
}
