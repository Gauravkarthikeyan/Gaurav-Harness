/** `todo` panel: `✓` struck-through done items, `●` the current item, `○` pending. */
import { frame, glyph, type StageStyle, strike } from "./common";

export interface TodoItem {
	text: string;
	state: "done" | "current" | "pending";
}

export interface TodoData {
	items: readonly TodoItem[];
}

export function renderTodo(data: TodoData, width: number, height: number, style: StageStyle): string[] {
	const rows = data.items.map(item => {
		if (item.state === "done") return `${glyph("done", style)} ${style("dim", strike(item.text))}`;
		if (item.state === "current") return `${glyph("running", style)} ${style("text", item.text)}`;
		return `${glyph("queued", style)} ${style("muted", item.text)}`;
	});
	// Keep the current item in view, centered when the list overflows.
	const current = data.items.findIndex(i => i.state === "current");
	const maxStart = Math.max(0, rows.length - height);
	const start = Math.min(maxStart, Math.max(0, current - Math.floor((height - 1) / 2)));
	return frame(rows.slice(start), width, height);
}
