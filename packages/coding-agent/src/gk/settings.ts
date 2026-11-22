import { register } from "../config/registry";
import { LAUNCH_MODE_SETTINGS, LAUNCH_MODES } from "./launch-mode";

/** Which mode an interactive launch starts in; `ask` shows the mode picker (spec §5.2). */
export const cfgGkLaunchMode = register({
	id: "gk.launchMode",
	type: "enum",
	values: LAUNCH_MODE_SETTINGS,
	default: "ask",
	ui: {
		tab: "interaction",
		group: "Startup & Updates",
		label: "Launch Mode",
		description: "Start in Solo or Orchestra, or ask with the mode picker. --solo / --orchestra override it",
		options: [
			{ value: "ask", label: "Ask", description: "Show the mode picker, preselecting the last choice (default)" },
			{ value: "solo", label: "Solo", description: "One agent with the full toolset" },
			{ value: "orchestra", label: "Orchestra", description: "A conductor plans, roster models build" },
		],
	},
});

/** The mode picker's last choice; it preselects that card next launch. */
export const cfgGkLastLaunchMode = register({
	id: "gk.lastLaunchMode",
	type: "enum",
	values: LAUNCH_MODES,
	default: "solo",
});

/** Skip the Casting Board for plans within budget (spec §5.4); the board's `a` key turns it on. */
export const cfgGkOrchestraAutoApprove = register({
	id: "gk.orchestra.autoApprove",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Orchestra",
		label: "Auto-approve crew plans",
		description: "Start crew plans without the Casting Board when they fit the run budget",
	},
});

/** Run budget in USD; a plan estimated above it needs an explicit `!` on the Casting Board. 0 = no budget. */
export const cfgGkOrchestraMaxRunUsd = register({
	id: "gk.orchestra.maxRunUsd",
	type: "number",
	default: 2,
	ui: {
		tab: "interaction",
		group: "Orchestra",
		label: "Run budget (USD)",
		description: "Crew plans estimated above this need an explicit confirm on the Casting Board (0 = no budget)",
	},
});

/** Daily spend budget in USD across all sessions; the Stage's TODAY field warns once it is reached. Unset = none. */
export const cfgGkBudgetDailyUsd = register({
	id: "gk.budget.dailyUsd",
	type: "number",
	default: undefined,
	validate: raw => {
		if (raw === undefined || raw === null || (typeof raw === "number" && Number.isFinite(raw) && raw > 0)) return;
		throw new Error(`Invalid gk.budget.dailyUsd: expected a positive USD amount, got ${Bun.inspect(raw)}.`);
	},
});

/** `/ship`'s verify command (spec §5.9); empty = detect from the project (package.json, Makefile, Cargo, Go, pytest). */
export const cfgGkVerifyCommand = register({
	id: "gk.verifyCommand",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Orchestra",
		label: "Verify command",
		description: "Command /ship runs before the BUILD SUCCESSFUL finale; empty detects it from the project",
	},
});
