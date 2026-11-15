/**
 * Launch-mode resolution (spec §5.2): `--solo` / `--orchestra` win, then `gk.launchMode`; `ask` shows the mode
 * picker when the launch can ask (interactive TTY, fresh session), preselecting the last choice.
 */

export const LAUNCH_MODES = ["solo", "orchestra"] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

export const LAUNCH_MODE_SETTINGS = ["ask", ...LAUNCH_MODES] as const;
export type LaunchModeSetting = (typeof LAUNCH_MODE_SETTINGS)[number];

export interface LaunchModeInput {
	readonly soloFlag?: boolean;
	readonly orchestraFlag?: boolean;
	readonly setting: LaunchModeSetting;
	readonly last: LaunchMode;
	/** Interactive TTY launch of a fresh session (not resume/continue/fork, not print or RPC). */
	readonly canAsk: boolean;
}

export type LaunchModeResolution =
	| { readonly kind: "mode"; readonly mode: LaunchMode }
	| { readonly kind: "ask"; readonly initial: LaunchMode };

export function resolveLaunchMode(input: LaunchModeInput): LaunchModeResolution {
	if (input.soloFlag) return { kind: "mode", mode: "solo" };
	if (input.orchestraFlag) return { kind: "mode", mode: "orchestra" };
	if (input.setting !== "ask") return { kind: "mode", mode: input.setting };
	return input.canAsk ? { kind: "ask", initial: input.last } : { kind: "mode", mode: "solo" };
}
