import { APP_NAME } from "@oh-my-pi/pi-utils";
import { col, compact, keyed, node, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";
import { detectColorMode } from "../../theme/color";
import { GK_NIGHT } from "../../theme/gk-palette";
import { Canvas } from "../../gk/canvas";
import { drawLogo, logoLayout } from "../../gk/logo";
import { paintPage } from "./gk-frame";

export const SETUP_OUTRO_MS = 1200;

const outroMemo = new Memo();

/**
 * Native outro, centered: "You're all set", the default model now in effect
 * (`model`, its display name, when there is one), and an indeterminate
 * progress bar standing in for the timed sweep. A click sends the `continue`
 * action. gk: no builtin image mark (the host's builtin mark is omp's logo).
 */
export function describeSetupOutro(model: string | undefined): NativeNode {
	return outroMemo.get([model], () =>
		col(
			compact([
				node("spacer", { grow: 1 }, undefined, "top"),
				keyed(text([span("You're all set", "strong")], { wrap: "none", role: "omp.setup.outro.title" }), "title"),
				model !== undefined &&
					keyed(
						text([span("Default model", "muted"), span(" · ", "dim"), span(model, "muted")], {
							wrap: "none",
							truncate: "end",
							role: "omp.setup.outro.model",
						}),
						"model",
					),
				keyed(
					text([span(`Starting ${APP_NAME}…`, "muted")], { wrap: "none", role: "omp.setup.outro.status" }),
					"status",
				),
				node("progress", { value: null, role: "omp.setup.outro.progress" }, undefined, "progress"),
				node("spacer", { grow: 1 }, undefined, "bottom"),
			]),
			{ align: "center", grow: 1, role: "omp.setup.outro", actions: { click: "continue" } },
		),
	);
}

/** gk-night outro: the lockup, `✓ setup saved`, and a one-pass progress bar (accent share, border rest). */
export function renderSetupOutro(width: number, height: number, elapsedMs: number): string[] {
	const canvas = new Canvas(width, height, GK_NIGHT.paneBg, detectColorMode());
	const layout = logoLayout(width);
	const top = Math.max(0, Math.floor((height - layout.rows - 5) / 2));
	drawLogo(canvas, top, layout, GK_NIGHT);
	const y = top + layout.rows + 1;
	canvas.center(y, "✓ setup saved", GK_NIGHT.success);
	canvas.center(y + 1, `starting ${APP_NAME}…`, GK_NIGHT.muted);
	const barWidth = Math.max(1, Math.min(72, width - 8));
	const filled = Math.round(barWidth * Math.max(0, Math.min(1, elapsedMs / SETUP_OUTRO_MS)));
	const left = Math.floor((width - barWidth) / 2);
	canvas.put(left, y + 3, "━".repeat(filled), GK_NIGHT.accent);
	canvas.put(left + filled, y + 3, "─".repeat(barWidth - filled), GK_NIGHT.border);
	return paintPage(canvas.lines(), width, height);
}
