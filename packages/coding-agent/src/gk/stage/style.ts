/**
 * The one place Stage style tokens meet the theme. Widgets and the host speak `HostToken`s; this module
 * turns them into SGR using the active GK palette (gk-night / gk-day), or the active omp theme's
 * nearest slots for non-GK themes. Foreground tokens close with `39`, background tokens with `49`, so
 * nested styles (a colored sign inside a diff-background row) compose.
 */
import { theme } from "@oh-my-pi/pi-tui";
import { bgAnsi, detectColorMode, fgAnsi } from "@oh-my-pi/pi-tui/theme/color";
import { type GkPalette, gkPaletteFor } from "@oh-my-pi/pi-tui/theme/gk-palette";
import type { ColorMode, ThemeBg, ThemeColor } from "@oh-my-pi/pi-tui/theme/schema";
import { getCurrentThemeName } from "@oh-my-pi/pi-tui/theme/theme";
import type { StageStyle, StageToken } from "./widgets/common";

/** Widget tokens plus the host's own band backgrounds. */
export type HostToken = StageToken | "panelBg" | "paneBg";

export type HostStyle = (token: HostToken, text: string) => string;

type BgToken = "diffAddBg" | "diffDelBg" | "panelBg" | "paneBg" | "surfaceBg" | "badgeBg" | "selectedBg";

/** Palette slot for every token on GK themes. */
function paletteColor(p: GkPalette, token: HostToken): string {
	switch (token) {
		case "accent":
			return p.accent;
		case "text":
			return p.text;
		case "muted":
			return p.muted;
		case "dim":
			return p.dim;
		case "border":
			return p.border;
		case "borderAccent":
			return p.borderFocus;
		case "success":
			return p.success;
		case "error":
			return p.error;
		case "warning":
			return p.warning;
		case "info":
			return p.info;
		case "agent1":
			return p.agent.blue;
		case "agent2":
			return p.agent.green;
		case "agent3":
			return p.agent.magenta;
		case "agent4":
			return p.agent.cyan;
		case "agent5":
			return p.agent.orange;
		case "agent6":
			return p.agent.lime;
		case "diffAddBg":
			return p.diffAddBg;
		case "diffDelBg":
			return p.diffRemoveBg;
		case "panelBg":
			return p.panel;
		case "paneBg":
			return p.paneBg;
		case "surfaceBg":
			return p.surface;
		case "badgeBg":
			return p.badgeBg;
		case "selectedBg":
			return p.selectedBg;
	}
}

/** Nearest omp theme slot for non-GK themes. */
const THEME_FG: Record<Exclude<HostToken, BgToken>, ThemeColor> = {
	accent: "accent",
	text: "text",
	muted: "muted",
	dim: "dim",
	border: "border",
	borderAccent: "borderAccent",
	success: "success",
	error: "error",
	warning: "warning",
	info: "accent",
	agent1: "accent",
	agent2: "success",
	agent3: "warning",
	agent4: "accent",
	agent5: "warning",
	agent6: "success",
};

/** Background tokens and their nearest omp slot for non-GK themes. */
const THEME_BG: Record<BgToken, ThemeBg | null> = {
	diffAddBg: "toolSuccessBg",
	diffDelBg: "toolErrorBg",
	panelBg: "statusLineBg",
	// Non-GK themes keep the terminal's own background under panes.
	paneBg: null,
	surfaceBg: "statusLineBg",
	badgeBg: "selectedBg",
	selectedBg: "selectedBg",
};

function isBg(token: HostToken): token is BgToken {
	return token in THEME_BG;
}

/** SGR opener per token for the active theme; rebuilt when the theme name or color depth changes. */
let cache: { key: string; open: Map<HostToken, string> } | undefined;

function opener(token: HostToken): string {
	const name = getCurrentThemeName() ?? "";
	const mode: ColorMode = typeof theme === "undefined" ? detectColorMode() : theme.getColorMode();
	const key = `${name}|${mode}`;
	if (cache?.key !== key) cache = { key, open: new Map() };
	let open = cache.open.get(token);
	if (open !== undefined) return open;
	const palette = gkPaletteFor(name);
	if (palette) {
		const hex = paletteColor(palette, token);
		open = isBg(token) ? bgAnsi(hex, mode) : fgAnsi(hex, mode);
	} else if (typeof theme === "undefined") {
		open = "";
	} else if (isBg(token)) {
		const slot = THEME_BG[token];
		open = slot ? theme.getBgAnsi(slot) : "";
	} else {
		open = theme.getFgAnsi(THEME_FG[token]);
	}
	cache.open.set(token, open);
	return open;
}

/** Theme-backed style for the Stage host and its widgets. */
export const themeStyle: HostStyle = (token, text) => {
	if (text === "") return text;
	const open = opener(token);
	if (!open) return text;
	return `${open}${text}${isBg(token) ? "\x1b[49m" : "\x1b[39m"}`;
};

/** The widget-facing view of {@link themeStyle}. */
export const widgetStyle: StageStyle = themeStyle;

/** Identity style for tests and plain captures. */
export const plainStyle: HostStyle = (_token, text) => text;
