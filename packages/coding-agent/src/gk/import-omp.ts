import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";

export type OmpImportReason = "imported" | "gk-exists" | "no-omp";

export interface OmpImportResult {
	imported: boolean;
	reason: OmpImportReason;
}

export interface ImportOmpProfileOptions {
	home: string;
	/** Copies the omp agent dir to the gk agent dir; defaults to a recursive filesystem copy. */
	copy?: (src: string, dst: string) => Promise<void>;
}

function ompAgentDir(home: string): string {
	return path.join(home, ".omp", "agent");
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** True when `<home>/.gk` is absent and `<home>/.omp/agent` exists, i.e. the one-time import applies. */
export function shouldOfferOmpImport(home: string): boolean {
	return !fs.existsSync(path.join(home, CONFIG_DIR_NAME)) && isDirectory(ompAgentDir(home));
}

/** Copy `<home>/.omp/agent` to `<home>/.gk/agent`, only when `<home>/.gk` does not exist yet. */
export async function importOmpProfile({
	home,
	copy = copyAgentDir,
}: ImportOmpProfileOptions): Promise<OmpImportResult> {
	const gkRoot = path.join(home, CONFIG_DIR_NAME);
	if (fs.existsSync(gkRoot)) return { imported: false, reason: "gk-exists" };
	const src = ompAgentDir(home);
	if (!isDirectory(src)) return { imported: false, reason: "no-omp" };
	try {
		await copy(src, path.join(gkRoot, "agent"));
	} catch (error) {
		// A partial copy would turn every later offer into `gk-exists`; leave no `.gk` behind.
		await fs.promises.rm(gkRoot, { recursive: true, force: true });
		throw error;
	}
	return { imported: true, reason: "imported" };
}

/** Lock files belong to the omp processes that wrote them; sockets and FIFOs cannot be copied. */
async function shouldCopyEntry(source: string): Promise<boolean> {
	if (source.endsWith(".lock")) return false;
	const stat = await fs.promises.lstat(source);
	return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
}

async function copyAgentDir(src: string, dst: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(dst), { recursive: true });
	await fs.promises.cp(src, dst, {
		recursive: true,
		errorOnExist: true,
		force: false,
		verbatimSymlinks: true,
		filter: shouldCopyEntry,
	});
}

/** A plain interactive launch: the `launch` command without `-p`/`--print` or `--mode`. */
async function isInteractiveLaunch(argv: string[]): Promise<boolean> {
	// Latency boundary: cli.ts imports this module on every TTY launch; the command table loads only on a first run.
	const [{ resolveCliArgv }, { parseArgs }] = await Promise.all([import("../cli-commands"), import("../cli/args")]);
	const resolved = resolveCliArgv(argv);
	if ("error" in resolved || resolved.argv[0] !== "launch") return false;
	try {
		const parsed = parseArgs(resolved.argv.slice(1));
		return !parsed.print && parsed.mode === undefined;
	} catch {
		return false;
	}
}

export interface OmpImportNotice {
	kind: "info" | "warn";
	message: string;
}

/** Result line for the interactive session; the prepaint composer clears anything written to the terminal. */
let pendingNotice: OmpImportNotice | undefined;

/** Take (and clear) the notice left by {@link offerOmpProfileImport}, for the session's startup notices. */
export function takeOmpImportNotice(): OmpImportNotice | undefined {
	const notice = pendingNotice;
	pendingNotice = undefined;
	return notice;
}

/**
 * Startup hook for TTY launches: when `~/.gk` is missing and `~/.omp/agent` exists, ask once
 * whether to copy omp's agent dir so logins, models and config carry over. Must run before
 * anything creates `~/.gk` (the prepaint composer cache, settings).
 */
export async function offerOmpProfileImport(argv: string[], home: string = os.homedir()): Promise<void> {
	if (!shouldOfferOmpImport(home)) return;
	if (!(await isInteractiveLaunch(argv))) return;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let accepted: boolean;
	try {
		const answer = await rl.question(
			"Found an omp profile in ~/.omp/agent. Copy it to ~/.gk/agent so your logins and settings carry over? [Y/n] ",
		);
		const normalized = answer.trim().toLowerCase();
		accepted = normalized === "" || normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
	if (!accepted) return;
	try {
		const result = await importOmpProfile({ home });
		if (result.imported) {
			pendingNotice = { kind: "info", message: "Imported your omp profile into ~/.gk/agent (~/.omp is unchanged)." };
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pendingNotice = { kind: "warn", message: `Could not import the omp profile (${message}); ~/.gk starts empty.` };
	}
}
