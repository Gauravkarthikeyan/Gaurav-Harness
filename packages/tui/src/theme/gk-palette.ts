/**
 * GK visual language v2 (docs/superpowers/specs/2026-11-15-gk-visual-v2.md): theme names and the full palette,
 * including tokens omp's theme schema has no slot for (pane/panel bands, diff backgrounds, agent hues, pixel-logo
 * shadow). The `gk-night` / `gk-day` theme JSONs map omp's tokens onto these values; a test keeps them in sync.
 *
 * A leaf module: `theme.ts` reads the names while `loader.ts` is still mid-evaluation in the
 * loader → theme-class → theme import cycle.
 */

export const DEFAULT_DARK_THEME = "gk-night";
export const DEFAULT_LIGHT_THEME = "gk-day";

/** Agent handle colors, assigned in roster order; the conductor (`@main`) always uses `accent`. */
export const GK_AGENT_HUES = ["blue", "green", "magenta", "cyan", "orange", "lime"] as const;
export type GkAgentHue = (typeof GK_AGENT_HUES)[number];

export interface GkPalette {
	/** Pane interior. Stage/solo screens paint every pane cell with it, whatever the terminal background. */
	paneBg: string;
	/** Header bar, status bar, key-hint bar bands. */
	panel: string;
	/** Overlays, cards, composer, plan tables. */
	surface: string;
	/** Selected row / cursor line. */
	selectedBg: string;
	/** `@agent` badge and key-cap background. */
	badgeBg: string;
	/** Unfocused pane frame. */
	border: string;
	/** Inner separators, table rules, sparkline baselines. */
	borderMuted: string;
	/** Focused pane frame. */
	borderFocus: string;
	text: string;
	muted: string;
	/** Non-essential hints only; never the sole carrier of information. */
	dim: string;
	/** Gold: logo, focused frame, primary key hint, running dot. */
	accent: string;
	/** Gold peak: splash shimmer, finale headline. */
	accentStrong: string;
	/** Pixel-logo drop shadow. Decorative, no contrast requirement. */
	pixelShadow: string;
	success: string;
	error: string;
	warning: string;
	info: string;
	diffAddBg: string;
	diffRemoveBg: string;
	agent: Record<GkAgentHue, string>;
}

export const GK_NIGHT: GkPalette = {
	paneBg: "#000000",
	panel: "#0A0A0B",
	surface: "#0E0E10",
	selectedBg: "#1A1A1E",
	badgeBg: "#16161A",
	border: "#303036",
	borderMuted: "#1E1E22",
	borderFocus: "#D6A93A",
	text: "#E4E4E7",
	muted: "#9C9CA3",
	dim: "#6A6A72",
	accent: "#D6A93A",
	accentStrong: "#EBC35A",
	pixelShadow: "#5A4718",
	success: "#73C08A",
	error: "#E5716B",
	warning: "#E8955A",
	info: "#8AB4CC",
	diffAddBg: "#0E2416",
	diffRemoveBg: "#2B1113",
	agent: {
		blue: "#6C9EE0",
		green: "#7DBF8E",
		magenta: "#C987C2",
		cyan: "#5FBEC6",
		orange: "#D3956A",
		lime: "#B4BE6A",
	},
};

export const GK_DAY: GkPalette = {
	paneBg: "#FAFAFA",
	panel: "#F4F4F5",
	surface: "#F2F2F3",
	selectedBg: "#E6E6EA",
	badgeBg: "#EBEBEE",
	border: "#D4D4D8",
	borderMuted: "#E4E4E7",
	borderFocus: "#7A5A06",
	text: "#18181B",
	muted: "#55555C",
	dim: "#86868E",
	accent: "#7A5A06",
	accentStrong: "#5E4505",
	pixelShadow: "#D9C590",
	success: "#2A7340",
	error: "#B3322B",
	warning: "#A6521C",
	info: "#2F6688",
	diffAddBg: "#E3F3E6",
	diffRemoveBg: "#FBE5E3",
	agent: {
		blue: "#2F62B0",
		green: "#286B3C",
		magenta: "#9A3E8F",
		cyan: "#1A6A72",
		orange: "#984A1A",
		lime: "#5A6516",
	},
};

/** Palette for a theme name; `undefined` for non-GK themes. */
export function gkPaletteFor(themeName: string): GkPalette | undefined {
	if (themeName === DEFAULT_DARK_THEME) return GK_NIGHT;
	if (themeName === DEFAULT_LIGHT_THEME) return GK_DAY;
	return undefined;
}
