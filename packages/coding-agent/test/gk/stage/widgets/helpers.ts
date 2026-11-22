import { expect } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { HostStyle } from "../../../../src/gk/stage/style";
import type { StageStyle } from "../../../../src/gk/stage/widgets/common";

export const identity: StageStyle = (_token, text) => text;

/** Wraps every styled run in a distinct SGR so width math must ignore escapes (any host token, so the Stage host takes it too). */
export const sgr: HostStyle = (token, text) => `\x1b[38;5;${token.length + 16}m${text}\x1b[0m`;

export function expectExact(rows: string[], width: number, height: number): void {
	expect(rows).toHaveLength(height);
	for (const row of rows) expect(visibleWidth(row)).toBe(width);
}

/** Assert exact width/height under the SGR style across a range of sizes, including degenerate ones. */
export function expectExactAcrossSizes(render: (width: number, height: number) => string[]): void {
	for (const width of [0, 1, 5, 17, 40, 80, 212]) {
		for (const height of [0, 1, 3, 12]) expectExact(render(width, height), width, height);
	}
}

/** Trailing blanks trimmed, for readable goldens. */
export function trimmed(rows: string[]): string[] {
	return rows.map(r => r.trimEnd());
}
