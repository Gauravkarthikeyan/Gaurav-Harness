/** Tab row: tmux-style windows on the left, run summary on the right. */
import { bold, frame, glyph, type StageStyle, type StageToken, type StateGlyph, spread } from "./common";

export interface Tab {
	index: number;
	name: string;
	active?: boolean;
}

export interface TabSummaryItem {
	glyph?: StateGlyph;
	text: string;
	token?: StageToken;
}

export interface TabsData {
	tabs: readonly Tab[];
	/** Groups joined by ` │ `; items inside a group joined by two spaces. */
	summary?: readonly (readonly TabSummaryItem[])[];
}

export function renderTabs(data: TabsData, width: number, height: number, style: StageStyle): string[] {
	const left = ` ${data.tabs
		.map(t => {
			const label = `${t.index}:${t.name}${t.active ? "*" : ""}`;
			return t.active ? style("accent", bold(label)) : style("muted", label);
		})
		.join("  ")}`;
	const right = (data.summary ?? [])
		.filter(group => group.length > 0)
		.map(group =>
			group
				.map(item => {
					const text = style(item.token ?? "muted", item.text);
					return item.glyph ? `${glyph(item.glyph, style)} ${text}` : text;
				})
				.join("  "),
		)
		.join(style("dim", " │ "));
	return frame([spread(left, right ? `${right} ` : "", width)], width, height);
}
