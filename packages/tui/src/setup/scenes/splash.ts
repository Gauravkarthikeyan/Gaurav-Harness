import { VERSION } from "@oh-my-pi/pi-utils";
import { lockupNode } from "../../prompt/welcome";
import { formatKeyHint } from "../../app-keybindings";
import { col, kbd, keyed, node, row, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { detectColorMode } from "../../theme/color";
import { GK_NIGHT } from "../../theme/gk-palette";
import { Canvas } from "../../gk/canvas";
import { drawLogo, logoLayout } from "../../gk/logo";
import { hintBar, paintPage } from "./gk-frame";

export const SETUP_SPLASH_MS = 1500;
export const SETUP_TICK_MS = 33;

/**
 * Setup intro (gk-night): the `</>` lockup centered on the black page, `setup` under it, and the key-hint bar.
 * Static: gk surfaces never loop an animation, so `elapsedMs` only exists for the wizard's timed phase.
 */
export function renderSetupSplash(width: number, height: number, _elapsedMs: number): string[] {
	const canvas = new Canvas(width, height, GK_NIGHT.paneBg, detectColorMode());
	const layout = logoLayout(width);
	const top = Math.max(0, Math.floor((height - layout.rows - 2) / 2));
	drawLogo(canvas, top, layout, GK_NIGHT);
	canvas.center(top + layout.rows + 1, "setup", GK_NIGHT.muted);
	const lines = canvas.lines();
	lines[height - 1] = hintBar(
		[
			[formatKeyHint("enter"), "start"],
			[formatKeyHint("ctrl+c"), "exit setup"],
		],
		width,
	);
	return paintPage(lines, width, height, new Set([height - 1]));
}

let splashNode: NativeNode | undefined;

/**
 * Native splash: the lockup centered and a quiet Enter hint pinned to the bottom. A click anywhere sends `skip`.
 */
export function describeSetupSplash(): NativeNode {
	splashNode ??= col(
		[
			node("spacer", { grow: 1 }, undefined, "top"),
			lockupNode(VERSION),
			node("spacer", { grow: 1 }, undefined, "bottom"),
			keyed(
				row([text([span("Press", "muted")]), kbd("enter"), text([span("to begin", "muted")])], {
					align: "center",
					gap: "xs",
					role: "omp.setup.hint",
				}),
				"hint",
			),
		],
		{ align: "center", grow: 1, role: "omp.setup.splash", actions: { click: "skip" } },
	);
	return splashNode;
}
