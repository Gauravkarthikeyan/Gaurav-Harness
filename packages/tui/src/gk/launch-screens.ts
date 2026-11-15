/**
 * Thin runner for the GK launch screens: the splash (checks run in parallel with the animation) followed by the
 * mode picker, in one full-screen overlay so there is no flash of the session between them. Rendering lives in
 * the pure `renderSplashFrame` / `renderModePicker`.
 */
import type { SetupUiHost } from "../setup/scenes/types";
import type { Component, OverlayFocusOwner } from "../tui";
import { type LaunchChoice, type PickerFact, pickerKey, renderModePicker } from "./mode-picker";
import { renderSplashFrame, type SplashCheck, type SplashCheckState } from "./splash-frame";

/** Animated splash: the motion runs at least this long. */
export const SPLASH_MIN_MS = 3500;
/** Animated splash: check rows settle on screen one by one, evenly between these times (or later, when the check does). */
export const SPLASH_REVEAL_FIRST_MS = 500;
export const SPLASH_REVEAL_LAST_MS = 2500;
/** Animated splash: the finished checklist and full bar hold this long before the picker. */
export const SPLASH_HOLD_MS = 1000;
/** Hard cap; checks still pending then stay pending on the last frame. */
export const SPLASH_MAX_MS = 6000;
/** Motionless splash: shown at least this long so it is not a flicker. */
export const SPLASH_STATIC_MIN_MS = 500;
const TICK_MS = 33;

export interface SplashCheckResult {
	readonly state: Exclude<SplashCheckState, "pending">;
	readonly value?: string;
	readonly detail?: string;
}

export interface SplashCheckTask {
	readonly id: string;
	readonly label: string;
	/** Runs once when the splash opens; `signal` aborts when the splash closes first. */
	run(signal: AbortSignal): Promise<SplashCheckResult>;
}

export interface LaunchScreensOptions {
	readonly version: string;
	/** False shows the motionless splash frame. */
	readonly motion: boolean;
	readonly splash?: {
		readonly checks: readonly SplashCheckTask[];
		readonly host?: string;
	};
	readonly picker?: {
		readonly initial: LaunchChoice;
		readonly last?: LaunchChoice;
		/** Read when the picker opens, after the splash checks settled or timed out. */
		readonly facts: () => { solo: readonly PickerFact[]; orchestra: readonly PickerFact[] };
	};
	readonly now?: () => number;
}

export type LaunchScreensResult =
	| { readonly kind: "chosen"; readonly choice: LaunchChoice }
	| { readonly kind: "quit" }
	/** No picker was requested; only the splash ran. */
	| { readonly kind: "none" };

/** Terminal reports that are not keypresses and must not skip the splash (SGR mouse, focus in/out). */
function isTerminalReport(data: string): boolean {
	return data.startsWith("\x1b[<") || data === "\x1b[I" || data === "\x1b[O";
}

class LaunchScreensComponent implements Component, OverlayFocusOwner {
	#phase: "splash" | "picker" | "done";
	#checks: SplashCheck[];
	/** When each check's result arrived (ms since start); `undefined` while pending. */
	#settledAt: (number | undefined)[];
	#focused: LaunchChoice;
	#facts: { solo: readonly PickerFact[]; orchestra: readonly PickerFact[] } = { solo: [], orchestra: [] };
	#startedAt = 0;
	#timer: NodeJS.Timeout | undefined;
	#abort = new AbortController();
	#done = Promise.withResolvers<LaunchScreensResult>();
	readonly #now: () => number;

	constructor(
		readonly ctx: SetupUiHost,
		readonly options: LaunchScreensOptions,
	) {
		this.#now = options.now ?? (() => performance.now());
		this.#phase = options.splash ? "splash" : "picker";
		this.#checks = (options.splash?.checks ?? []).map(task => ({ id: task.id, label: task.label, state: "pending" }));
		this.#settledAt = this.#checks.map(() => undefined);
		this.#focused = options.picker?.initial ?? "solo";
	}

	run(): Promise<LaunchScreensResult> {
		this.#startedAt = this.#now();
		if (this.#phase === "splash") this.#startSplash();
		else this.#openPicker();
		this.ctx.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#stopTimer();
		this.#abort.abort();
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this;
	}

	handleInput(data: string): void {
		if (this.#phase === "done" || isTerminalReport(data)) return;
		if (this.#phase === "splash") {
			if (data === "\x03") this.#finish({ kind: "quit" });
			else this.#endSplash();
			return;
		}
		const action = pickerKey(this.#focused, data);
		if (!action) return;
		if (action.type === "quit") this.#finish({ kind: "quit" });
		else if (action.type === "start") this.#finish({ kind: "chosen", choice: action.choice });
		else if (action.choice !== this.#focused) {
			this.#focused = action.choice;
			this.ctx.ui.requestRender();
		}
	}

	render(width: number): readonly string[] {
		const height = Math.max(1, this.ctx.ui.terminal.rows);
		if (this.#phase === "picker" || (this.#phase === "done" && this.options.picker)) {
			return renderModePicker(
				{
					focused: this.#focused,
					last: this.options.picker?.last,
					solo: this.#facts.solo,
					orchestra: this.#facts.orchestra,
					version: this.options.version,
				},
				width,
				height,
			);
		}
		const elapsed = this.#now() - this.#startedAt;
		return renderSplashFrame(
			{
				checks: this.#shownChecks(elapsed),
				version: this.options.version,
				host: this.options.splash?.host,
				motion: this.options.motion,
			},
			width,
			height,
			elapsed,
		);
	}

	/** When check `index` may show its result: staggered with motion, at once without. */
	#revealAt(index: number): number {
		if (!this.options.motion) return 0;
		const n = this.#checks.length;
		if (n <= 1) return SPLASH_REVEAL_LAST_MS;
		return SPLASH_REVEAL_FIRST_MS + ((SPLASH_REVEAL_LAST_MS - SPLASH_REVEAL_FIRST_MS) * index) / (n - 1);
	}

	/** The checklist as drawn at `elapsed`: a settled check still reads pending until its reveal time. */
	#shownChecks(elapsed: number): SplashCheck[] {
		return this.#checks.map((check, index) =>
			check.state === "pending" || elapsed >= this.#revealAt(index)
				? check
				: { id: check.id, label: check.label, state: "pending" },
		);
	}

	/** Time the whole checklist reads settled on screen, or `undefined` while any check is pending. */
	#allShownAt(): number | undefined {
		let at = 0;
		for (let i = 0; i < this.#checks.length; i++) {
			const settled = this.#settledAt[i];
			if (settled === undefined) return undefined;
			at = Math.max(at, settled, this.#revealAt(i));
		}
		return at;
	}

	#startSplash(): void {
		const signal = this.#abort.signal;
		(this.options.splash?.checks ?? []).forEach((task, index) => {
			task
				.run(signal)
				.catch((error: unknown): SplashCheckResult => ({
					state: "fail",
					value: "failed",
					detail: error instanceof Error ? error.message : String(error),
				}))
				.then(result => {
					if (this.#phase !== "splash") return;
					this.#checks[index] = { id: task.id, label: task.label, ...result };
					this.#checks = [...this.#checks];
					this.#settledAt[index] = this.#now() - this.#startedAt;
					this.#tick();
				});
		});
		// Motion repaints every tick; the static frame repaints only when a check settles (and at the deadline).
		this.#timer = setInterval(() => this.#tick(), this.options.motion ? TICK_MS : 100);
	}

	#tick(): void {
		if (this.#phase !== "splash") return;
		const elapsed = this.#now() - this.#startedAt;
		const shownAt = this.#allShownAt();
		const done = this.options.motion
			? shownAt !== undefined && elapsed >= Math.max(SPLASH_MIN_MS, shownAt + SPLASH_HOLD_MS)
			: shownAt !== undefined && elapsed >= SPLASH_STATIC_MIN_MS;
		if (elapsed >= SPLASH_MAX_MS || done) {
			this.#endSplash();
			return;
		}
		if (this.options.motion || shownAt !== undefined) this.ctx.ui.requestRender();
	}

	#endSplash(): void {
		this.#stopTimer();
		this.#abort.abort();
		if (this.options.picker) this.#openPicker();
		else this.#finish({ kind: "none" });
	}

	#openPicker(): void {
		this.#phase = "picker";
		this.#facts = this.options.picker?.facts() ?? { solo: [], orchestra: [] };
		this.ctx.ui.requestRender();
	}

	#stopTimer(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#finish(result: LaunchScreensResult): void {
		if (this.#phase === "done") return;
		this.#phase = "done";
		this.dispose();
		this.#done.resolve(result);
	}
}

/** Show the splash and/or the mode picker full-screen; restores focus and hides the overlay afterward. */
export async function runLaunchScreens(ctx: SetupUiHost, options: LaunchScreensOptions): Promise<LaunchScreensResult> {
	if (!options.splash && !options.picker) return { kind: "none" };
	const component = new LaunchScreensComponent(ctx, options);
	const overlay = ctx.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		ctx.ui.setFocus(component);
		return await component.run();
	} finally {
		ctx.ui.setFocus(component);
		component.dispose();
		overlay.hide();
	}
}
