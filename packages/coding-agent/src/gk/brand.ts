/** omp release this fork is based on; bump on every upstream merge. */
export const GK_UPSTREAM_VERSION = "18.20.1";

/** `--version` output: `gk-code <version> (omp <upstream>)`. */
export function formatGkVersion(version: string): string {
	return `gk-code ${version} (omp ${GK_UPSTREAM_VERSION})`;
}
