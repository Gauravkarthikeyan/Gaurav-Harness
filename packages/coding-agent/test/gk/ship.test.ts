import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectVerifyCommand, finaleFor, outputTail, runVerifyCommand } from "../../src/gk/ship";

function project(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gk-ship-"));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	return dir;
}

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });

describe("detectVerifyCommand", () => {
	it.each([
		[
			{ "package.json": pkg({ test: "bun test", check: "tsc" }), "bun.lock": "" },
			"bun run check",
			'package.json "check"',
		],
		[{ "package.json": pkg({ test: "vitest run" }), "pnpm-lock.yaml": "" }, "pnpm run test", 'package.json "test"'],
		[{ "package.json": pkg({ lint: "eslint ." }), "yarn.lock": "" }, "yarn lint", 'package.json "lint"'],
		[{ "package.json": pkg({ test: "jest" }) }, "npm run test", 'package.json "test"'],
		[{ Makefile: "build:\n\tcc x.c\ntest: build\n\t./x\n" }, "make test", "Makefile test"],
		[{ "Cargo.toml": "[package]\nname='x'\n" }, "cargo test", "Cargo.toml"],
		[{ "go.mod": "module x\n" }, "go test ./...", "go.mod"],
		[{ "pyproject.toml": "[tool.pytest.ini_options]\n" }, "pytest", "pyproject.toml"],
		[{ "pytest.ini": "[pytest]\n" }, "pytest", "pytest.ini"],
	])("%o → %s", async (files, command, source) => {
		expect(await detectVerifyCommand(project(files))).toEqual({ command, source });
	});

	it("skips npm's placeholder test script and Makefiles without a test target; finds nothing in an empty dir", async () => {
		expect(
			await detectVerifyCommand(
				project({ "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }) }),
			),
		).toBeUndefined();
		expect(await detectVerifyCommand(project({ Makefile: "build:\n\tcc x.c\n" }))).toBeUndefined();
		expect(await detectVerifyCommand(project({}))).toBeUndefined();
	});

	it("prefers gk.verifyCommand", async () => {
		const dir = project({ "package.json": pkg({ test: "jest" }) });
		expect(await detectVerifyCommand(dir, "  make ci ")).toEqual({ command: "make ci", source: "gk.verifyCommand" });
		expect(await detectVerifyCommand(dir, "")).toEqual({ command: "npm run test", source: 'package.json "test"' });
	});
});

describe("runVerifyCommand", () => {
	it("streams output and reports the exit code", async () => {
		const chunks: string[] = [];
		const ok = await runVerifyCommand("echo one; echo two >&2", os.tmpdir(), t => chunks.push(t));
		expect(ok.exitCode).toBe(0);
		expect(ok.output).toContain("one");
		expect(ok.output).toContain("two");
		expect(chunks.join("")).toBe(ok.output);
		const bad = await runVerifyCommand("echo nope; exit 3", os.tmpdir(), () => {});
		expect(bad.exitCode).toBe(3);
	});
});

describe("finaleFor", () => {
	const verify = { command: "bun test", source: 'package.json "test"' };
	it("is BUILD SUCCESSFUL only on exit 0", () => {
		const result = finaleFor(verify, { exitCode: 0, durationMs: 4200, output: "" }, [
			{ label: "cost", value: "$0.42" },
		]);
		expect(result).toEqual({
			kind: "success",
			caption: "bun test passed in 4.2s",
			rows: [
				{ label: "cost", value: "$0.42" },
				{ label: "verify", value: "bun test · 4.2s" },
			],
		});
	});

	it("is an honest BUILD FAILED with the failing command and its last 10 lines", () => {
		const output = `${Array.from({ length: 14 }, (_, i) => `\x1b[31mline ${i}\x1b[0m`).join("\n")}\n\n`;
		const result = finaleFor(verify, { exitCode: 1, durationMs: 2100, output }, []);
		expect(result).toMatchObject({
			kind: "failure",
			caption: "bun test exited 1 after 2.1s",
			failures: [{ label: "bun test", detail: "exit 1 · 2.1s" }],
			outputTitle: "bun test",
		});
		expect(result.kind === "failure" && result.output).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i + 4}`));
	});

	it("keeps the last redraw of carriage-return progress lines", () => {
		expect(outputTail("a\rb\rc\nd")).toEqual(["c", "d"]);
	});
});
