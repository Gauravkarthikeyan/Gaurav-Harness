import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { type LaunchModeInput, resolveLaunchMode } from "@oh-my-pi/pi-coding-agent/gk/launch-mode";

const base: LaunchModeInput = { setting: "ask", last: "solo", canAsk: true };

describe("resolveLaunchMode", () => {
	it("asks by default, preselecting the last choice", () => {
		expect(resolveLaunchMode(base)).toEqual({ kind: "ask", initial: "solo" });
		expect(resolveLaunchMode({ ...base, last: "orchestra" })).toEqual({ kind: "ask", initial: "orchestra" });
	});

	it("starts Solo without asking when the launch cannot ask", () => {
		expect(resolveLaunchMode({ ...base, canAsk: false, last: "orchestra" })).toEqual({ kind: "mode", mode: "solo" });
	});

	it("follows a fixed gk.launchMode", () => {
		expect(resolveLaunchMode({ ...base, setting: "solo" })).toEqual({ kind: "mode", mode: "solo" });
		expect(resolveLaunchMode({ ...base, setting: "orchestra" })).toEqual({ kind: "mode", mode: "orchestra" });
		expect(resolveLaunchMode({ ...base, setting: "orchestra", canAsk: false })).toEqual({
			kind: "mode",
			mode: "orchestra",
		});
	});

	it("lets --solo / --orchestra override the setting and skip the picker", () => {
		expect(resolveLaunchMode({ ...base, soloFlag: true })).toEqual({ kind: "mode", mode: "solo" });
		expect(resolveLaunchMode({ ...base, orchestraFlag: true })).toEqual({ kind: "mode", mode: "orchestra" });
		expect(resolveLaunchMode({ ...base, setting: "orchestra", soloFlag: true })).toEqual({
			kind: "mode",
			mode: "solo",
		});
		expect(resolveLaunchMode({ ...base, setting: "solo", orchestraFlag: true })).toEqual({
			kind: "mode",
			mode: "orchestra",
		});
	});
});

describe("launch mode flags", () => {
	it("parses --solo and --orchestra", () => {
		expect(parseArgs(["--solo"]).solo).toBe(true);
		expect(parseArgs(["--orchestra"]).orchestra).toBe(true);
		expect(parseArgs([]).solo).toBeUndefined();
	});

	it("rejects both at once", () => {
		expect(() => parseArgs(["--solo", "--orchestra"])).toThrow("--solo and --orchestra cannot be combined");
	});
});
