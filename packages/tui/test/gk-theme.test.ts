import { describe, expect, it } from "bun:test";
import {
	DEFAULT_DARK_THEME,
	DEFAULT_LIGHT_THEME,
	GK_AGENT_HUES,
	GK_DAY,
	GK_NIGHT,
	type GkPalette,
	gkPaletteFor,
} from "../src/theme/gk-palette";
import { getBuiltinThemes, loadThemeJsonSync } from "../src/theme/loader";
import type { ThemeJson } from "../src/theme/schema";
import { validateThemeJson } from "../src/theme/schema-validation";

/** WCAG 2.x relative luminance of a `#rrggbb` color. */
function relativeLuminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map(i => {
		const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
	const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

/** A color token as a hex string, following one level of `vars` indirection like the theme loader. */
function hexOf(json: ThemeJson, token: keyof ThemeJson["colors"]): string {
	const value = json.colors[token];
	const resolved = typeof value === "string" && json.vars && value in json.vars ? json.vars[value] : value;
	if (typeof resolved !== "string" || !/^#[0-9a-fA-F]{6}$/.test(resolved)) {
		throw new Error(`${json.name}.${token} must resolve to a #rrggbb color, got ${JSON.stringify(resolved)}`);
	}
	return resolved;
}

type PaletteKey = Exclude<keyof GkPalette, "agent">;

/** [foreground, background, minimum ratio]: every pairing the v2 spec promises. */
const CONTRAST_TABLE: ReadonlyArray<readonly [PaletteKey, PaletteKey, number]> = [
	["text", "paneBg", 4.5],
	["muted", "paneBg", 4.5],
	["accent", "paneBg", 4.5],
	["accentStrong", "paneBg", 4.5],
	["success", "paneBg", 4.5],
	["error", "paneBg", 4.5],
	["warning", "paneBg", 4.5],
	["info", "paneBg", 4.5],
	["dim", "paneBg", 3],
	["text", "panel", 4.5],
	["muted", "panel", 4.5],
	["accent", "panel", 4.5],
	["dim", "panel", 3],
	["text", "surface", 4.5],
	["muted", "surface", 4.5],
	["text", "selectedBg", 4.5],
	["accent", "selectedBg", 4.5],
	["text", "badgeBg", 4.5],
	["accent", "badgeBg", 4.5],
	["text", "diffAddBg", 4.5],
	["success", "diffAddBg", 4.5],
	["text", "diffRemoveBg", 4.5],
	["error", "diffRemoveBg", 4.5],
];

const THEMES = [
	{ name: DEFAULT_DARK_THEME, palette: GK_NIGHT },
	{ name: DEFAULT_LIGHT_THEME, palette: GK_DAY },
] as const;

/** omp token → palette key it must carry, so the JSON themes cannot drift from the palette. */
const TOKEN_MAP: ReadonlyArray<readonly [keyof ThemeJson["colors"], PaletteKey]> = [
	["text", "text"],
	["muted", "muted"],
	["dim", "dim"],
	["accent", "accent"],
	["border", "border"],
	["borderAccent", "borderFocus"],
	["borderMuted", "borderMuted"],
	["success", "success"],
	["error", "error"],
	["warning", "warning"],
	["mdLink", "info"],
	["selectedBg", "selectedBg"],
	["statusLineBg", "panel"],
	["toolDiffAdded", "success"],
	["toolDiffRemoved", "error"],
];

describe("gk themes", () => {
	it("defaults dark terminals to gk-night and light terminals to gk-day", () => {
		expect(DEFAULT_DARK_THEME).toBe("gk-night");
		expect(DEFAULT_LIGHT_THEME).toBe("gk-day");
		expect(loadThemeJsonSync(DEFAULT_DARK_THEME).name).toBe("gk-night");
		expect(loadThemeJsonSync(DEFAULT_LIGHT_THEME).name).toBe("gk-day");
		expect(gkPaletteFor("gk-night")).toBe(GK_NIGHT);
		expect(gkPaletteFor("gk-day")).toBe(GK_DAY);
		expect(gkPaletteFor("titanium")).toBeUndefined();
	});

	it("gk-night paints panes on pure black", () => {
		expect(GK_NIGHT.paneBg).toBe("#000000");
	});

	for (const { name, palette } of THEMES) {
		describe(name, () => {
			const json = getBuiltinThemes()[name];

			it("is a built-in theme that passes schema validation", () => {
				expect(json).toBeDefined();
				expect(() => validateThemeJson(json)).not.toThrow();
			});

			it("declares the pane background as the terminal background", () => {
				expect(json.terminal?.background).toBe(palette.paneBg);
				expect(json.terminal?.foreground).toBe(palette.text);
				expect(json.terminal?.ansi).toHaveLength(16);
			});

			for (const [token, key] of TOKEN_MAP) {
				it(`${token} carries palette.${key}`, () => {
					expect(hexOf(json, token)).toBe(palette[key]);
				});
			}

			for (const [fg, bg, min] of CONTRAST_TABLE) {
				it(`${fg} on ${bg} reaches ${min}:1`, () => {
					expect(contrastRatio(palette[fg], palette[bg])).toBeGreaterThanOrEqual(min);
				});
			}

			for (const hue of GK_AGENT_HUES) {
				it(`agent ${hue} reaches 4.5:1 on paneBg and badgeBg`, () => {
					expect(contrastRatio(palette.agent[hue], palette.paneBg)).toBeGreaterThanOrEqual(4.5);
					expect(contrastRatio(palette.agent[hue], palette.badgeBg)).toBeGreaterThanOrEqual(4.5);
				});
			}

			it("keeps agent hues distinct from each other", () => {
				const hues = GK_AGENT_HUES.map(hue => palette.agent[hue]);
				expect(new Set(hues).size).toBe(hues.length);
			});
		});
	}
});
