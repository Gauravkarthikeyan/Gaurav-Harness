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
