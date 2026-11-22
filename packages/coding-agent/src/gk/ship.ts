/**
 * `/ship` and the crew-run finale (spec §5.9): find the project's verify command, run it as a Stage command
 * pane, and play BUILD SUCCESSFUL only on a pass (BUILD FAILED, honestly, on a failure). No verify command
 * means no finale and a notice saying how to set one: no green without a pass.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FinaleResult, type FinaleRow, playFinale } from "@oh-my-pi/pi-tui/gk/finale";
import type { SetupUiHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { CrewRunSummary } from "./crew-runtime";
import { formatDuration } from "./stage/tool-lines";
import { formatUsd } from "./ui/casting-board";

export interface VerifyCommand {
	command: string;
	/** Where it came from, e.g. `package.json "test"`, `gk.verifyCommand`. */
	source: string;
}

async function readText(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

/** `bun run` / `pnpm run` / `yarn` / `npm run`, from the lockfile next to package.json. */
async function packageRunner(cwd: string): Promise<string> {
	if ((await exists(path.join(cwd, "bun.lock"))) || (await exists(path.join(cwd, "bun.lockb")))) return "bun run";
	if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm run";
	if (await exists(path.join(cwd, "yarn.lock"))) return "yarn";
	return "npm run";
}

const PACKAGE_SCRIPTS = ["check", "test", "lint"] as const;

/**
 * The verify command for `cwd`: `override` (`gk.verifyCommand`) when set, else the first of package.json
 * `check`/`test`/`lint` (with the lockfile's runner), `make test`, `cargo test`, `go test ./...`, `pytest`.
 */
export async function detectVerifyCommand(cwd: string, override?: string): Promise<VerifyCommand | undefined> {
	if (override?.trim()) return { command: override.trim(), source: "gk.verifyCommand" };
	const pkgText = await readText(path.join(cwd, "package.json"));
	if (pkgText) {
		try {
			const pkg = JSON.parse(pkgText) as { scripts?: Record<string, unknown> };
			const scripts = pkg.scripts ?? {};
			for (const name of PACKAGE_SCRIPTS) {
				const script = scripts[name];
				// npm's placeholder `test` script always fails; it is not a verify command.
				if (typeof script !== "string" || !script.trim() || /no test specified/.test(script)) continue;
				return { command: `${await packageRunner(cwd)} ${name}`, source: `package.json "${name}"` };
			}
		} catch (error) {
			logger.warn("ship: unreadable package.json", { cwd, error: String(error) });
		}
	}
	for (const makefile of ["Makefile", "makefile", "GNUmakefile"]) {
		const text = await readText(path.join(cwd, makefile));
		if (text && /^test\s*:/m.test(text)) return { command: "make test", source: `${makefile} test` };
	}
	if (await exists(path.join(cwd, "Cargo.toml"))) return { command: "cargo test", source: "Cargo.toml" };
	if (await exists(path.join(cwd, "go.mod"))) return { command: "go test ./...", source: "go.mod" };
	for (const marker of ["pytest.ini", "conftest.py", "tox.ini"]) {
		if (await exists(path.join(cwd, marker))) return { command: "pytest", source: marker };
	}
	const pyproject = await readText(path.join(cwd, "pyproject.toml"));
	if (pyproject && /\[tool\.pytest|pytest/.test(pyproject)) return { command: "pytest", source: "pyproject.toml" };
	return undefined;
}

export interface VerifyRun {
	exitCode: number;
	durationMs: number;
	output: string;
}

/** Run `command` through the shell in `cwd`, streaming stdout+stderr to `onOutput`. CI=1 keeps watchers off. */
export async function runVerifyCommand(
	command: string,
	cwd: string,
	onOutput: (text: string) => void,
	now: () => number = Date.now,
): Promise<VerifyRun> {
	const started = now();
	let output = "";
	try {
		const proc = Bun.spawn(["sh", "-c", command], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...Bun.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
		});
		const pump = async (stream: ReadableStream<Uint8Array>) => {
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				const text = decoder.decode(chunk, { stream: true });
				output += text;
				onOutput(text);
			}
		};
		await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
		const exitCode = await proc.exited;
		return { exitCode, durationMs: now() - started, output };
	} catch (error) {
		const text = `failed to start: ${error instanceof Error ? error.message : String(error)}\n`;
		onOutput(text);
		return { exitCode: 127, durationMs: now() - started, output: output + text };
	}
}

async function gitFilesChanged(cwd: string): Promise<string | undefined> {
	try {
		const run = async (args: string[]) => {
			const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
			const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			return code === 0 ? out : undefined;
		};
		const numstat = await run(["diff", "--numstat", "HEAD"]);
		const untracked = await run(["ls-files", "--others", "--exclude-standard"]);
		if (numstat === undefined) return undefined;
		let files = 0;
		let add = 0;
		let del = 0;
		for (const row of numstat.split("\n")) {
			const [a, d] = row.split("\t");
			if (d === undefined) continue;
			files++;
			add += Number(a) || 0;
			del += Number(d) || 0;
		}
		files += (untracked ?? "").split("\n").filter(Boolean).length;
		return `${files} file${files === 1 ? "" : "s"} (+${add} −${del})`;
	} catch {
		return undefined;
	}
}

/** Last lines of a command's output, escapes and carriage-return redraws stripped. */
export function outputTail(output: string, max = 10): string[] {
	return output
		.replace(/\n+$/, "")
		.split("\n")
		.map(line => line.slice(line.lastIndexOf("\r") + 1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
		.filter(line => line.trim() !== "")
		.slice(-max);
}

/** What the finale shows for a verify run (pure: the run plus the context rows). */
export function finaleFor(verify: VerifyCommand, run: VerifyRun, rows: readonly FinaleRow[]): FinaleResult {
	const took = formatDuration(run.durationMs);
	if (run.exitCode === 0) {
		return {
			kind: "success",
			caption: `${verify.command} passed in ${took}`,
			rows: [...rows, { label: "verify", value: `${verify.command} · ${took}` }],
		};
	}
	return {
		kind: "failure",
		caption: `${verify.command} exited ${run.exitCode} after ${took}`,
		failures: [{ label: verify.command, detail: `exit ${run.exitCode} · ${took}` }],
		output: outputTail(run.output),
		outputTitle: verify.command,
	};
}

export interface ShipHost {
	readonly cwd: string;
	readonly ui: SetupUiHost["ui"];
	readonly motion: boolean;
	/** `gk.verifyCommand`. */
	verifyOverride(): string | undefined;
	/** Stage command pane for the run; `undefined` when the Stage is not mounted. */
	commandPane(command: string): { append(text: string): void; end(exitCode: number): void } | undefined;
	showStatus(message: string): void;
	showWarning(message: string): void;
}

export const NO_VERIFY_NOTICE =
	"No verify command found, so no finale. Add a package.json check/test script, a Makefile test target, or set gk.verifyCommand.";

/** Detect, run as a command pane, and play the finale on the result. Returns the run, or `undefined` with none. */
async function verifyAndPlay(host: ShipHost, rows: () => Promise<FinaleRow[]>): Promise<VerifyRun | undefined> {
	const verify = await detectVerifyCommand(host.cwd, host.verifyOverride());
	if (!verify) {
		host.showWarning(NO_VERIFY_NOTICE);
		return undefined;
	}
	host.showStatus(`Verifying: ${verify.command} (${verify.source})`);
	const pane = host.commandPane(verify.command);
	const run = await runVerifyCommand(verify.command, host.cwd, text => pane?.append(text));
	pane?.end(run.exitCode);
	await playFinale({ ui: host.ui }, finaleFor(verify, run, await rows()), { motion: host.motion });
	return run;
}

/** `/ship`: verify the project, then BUILD SUCCESSFUL or BUILD FAILED with a session summary. */
export function ship(
	host: ShipHost,
	session: { costUsd(): number; startedAt: number },
	now: () => number = Date.now,
): Promise<VerifyRun | undefined> {
	return verifyAndPlay(host, async () => {
		const files = await gitFilesChanged(host.cwd);
		return [
			{ label: "session", value: formatDuration(now() - session.startedAt) },
			{ label: "cost", value: formatUsd(session.costUsd()) },
			...(files ? [{ label: "files changed", value: files }] : []),
		];
	});
}

/**
 * Crew-run finale: only a `completed` run whose every item is `done`, and only behind a passing verify.
 * Returns whether a finale played.
 */
export async function crewFinale(host: ShipHost, summary: CrewRunSummary): Promise<boolean> {
	if (summary.status !== "completed" || summary.items.length === 0) return false;
	if (summary.items.some(item => item.state !== "done")) return false;
	const run = await verifyAndPlay(host, async () => {
		const files = await gitFilesChanged(host.cwd);
		const workers = new Set(summary.items.map(item => item.name)).size;
		const longest = Math.max(0, ...summary.items.map(item => item.durationMs));
		return [
			{
				label: "crew",
				value: `${summary.items.length} item${summary.items.length === 1 ? "" : "s"} · ${workers} worker${workers === 1 ? "" : "s"}`,
			},
			{ label: "longest item", value: formatDuration(longest) },
			{
				label: "cost",
				value: `${formatUsd(summary.actualUsd)}${summary.crewEstUsd !== undefined ? ` (est ${formatUsd(summary.crewEstUsd)})` : ""}`,
			},
			...(files ? [{ label: "files changed", value: files }] : []),
		];
	});
	return run !== undefined;
}
