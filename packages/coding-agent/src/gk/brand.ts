/** GK Code's own release version, shown by `--version` and in user-facing text. */
export const GK_VERSION = "0.1.0";

/** omp release this fork is based on; bump on every upstream merge. Internal only — never shown to users. */
export const GK_UPSTREAM_VERSION = "18.20.1";

/** `--version` output: `gk-code <version>`. */
export function formatGkVersion(version: string = GK_VERSION): string {
	return `gk-code ${version}`;
}

/**
 * Self-update is off: upstream's update channels ship omp builds, which would replace GK Code.
 * GK Code runs from its git checkout and updates with `git pull`.
 */
export const GK_SELF_UPDATE = false;

/** Shown wherever upstream would update itself or announce a new release. */
export const GK_UPDATE_HINT = "GK Code does not self-update. Update it from its git checkout with `git pull`.";
