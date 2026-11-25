/**
 * External CLI panes (spec §5.11): `/open <command>` and `pane_open` run a command under `$SHELL -lc` in a real
 * PTY (omp's native `PtySession`) and draw its screen, kept by the headless VT in `@oh-my-pi/pi-utils/vterm`,
 * as the body of a `pty` tile. The PTY follows the tile's size; a focused pane gets every keystroke
 * (`Ctrl+]` gives focus back); the tile settles when the process exits and chips 10 s later.
 */
import type { PtyArgvStartOptions, PtyRunResult } from "@oh-my-pi/pi-natives";
import { normalizeInputForPty } from "@oh-my-pi/pi-tui/tools/bash-interactive";
import { readTerminalRows, styleTerminalRow } from "@oh-my-pi/pi-tui/tools/terminal-output";
import { logger } from "@oh-my-pi/pi-utils";
import type { Terminal } from "@oh-my-pi/pi-utils/vterm";
import type { TileStore } from "./tiles";
import { fit, padEnd } from "./widgets/common";

/** The slice of `PtySession` a pane drives; tests pass a fake. */
export interface PtyProcess {
	startArgv(
		options: PtyArgvStartOptions,
		onChunk?: (error: Error | null, chunk: string) => void,
	): Promise<PtyRunResult>;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}

export interface StagePtysOptions {
	store: TileStore;
	cwd: string;
	/** A new PTY per pane (production: `new PtySession()`). */
	spawn(): PtyProcess;
	/** Headless VT constructor (production: `@oh-my-pi/pi-utils/vterm`'s `Terminal`). */
	terminal(): Promise<typeof Terminal>;
	onChange(): void;
	/** Shell that runs the command; default `$SHELL`, else `sh`. */
	shell?: string;
}

/** Key that gives focus back from a pane to the composer. */
export const PTY_RELEASE_KEY = "ctrl+]";
/** Size the PTY starts at, before its tile has been drawn. */
const START_COLS = 80;
const START_ROWS = 24;
const SCROLLBACK = 2_000;

interface Pane {
	id: string;
	name: string;
	process: PtyProcess;
	terminal?: Terminal;
	/** Output that arrived before the VT loaded. */
	early: string[];
	cols: number;
	rows: number;
	/** Resolves once every queued write reached the VT. */
	written: Promise<void>;
	exited: boolean;
	/** Resolves once the VT is attached (or the terminal never will be: exit). */
	ready: PromiseWithResolvers<void>;
	/** Resolves with the exit code. */
	exit: PromiseWithResolvers<number>;
}

/** `zsh`, `claude`, `npm run dev` → `zsh`, `claude`, `npm`: the tab and title name of a command. */
export function ptyName(command: string): string {
	const head = command.trim().split(/\s+/)[0] ?? "";
	return head.split("/").at(-1) || "pty";
}

export class StagePtys {
	readonly #opts: StagePtysOptions;
	readonly #panes = new Map<string, Pane>();
	#seq = 0;

	constructor(options: StagePtysOptions) {
		this.#opts = options;
	}

	/** Open a pane running `command`; returns its tile id. */
	open(command: string, title?: string): string {
		const name = title?.trim() || ptyName(command);
		const id = `pty:${++this.#seq}`;
		const pane: Pane = {
			id,
			name,
			process: this.#opts.spawn(),
			early: [],
			cols: START_COLS,
			rows: START_ROWS,
			written: Promise.resolve(),
			exited: false,
			ready: Promise.withResolvers<void>(),
			exit: Promise.withResolvers<number>(),
		};
		this.#panes.set(id, pane);
		this.#opts.store.add({ id, kind: "pty", parentId: null, state: "running", title: name });
		void this.#opts.terminal().then(
			Ctor => this.#attachTerminal(pane, Ctor),
			error => logger.warn("gk pty: terminal emulator failed to load", { error: String(error) }),
		);
		const shell = this.#opts.shell ?? (process.env.SHELL || "sh");
		pane.process
			.startArgv(
				{
					application: shell,
					args: ["-lc", command],
					cwd: this.#opts.cwd,
					cols: pane.cols,
					rows: pane.rows,
					env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
				},
				(error, chunk) => {
					if (error || !chunk) return;
					this.#feed(pane, chunk);
				},
			)
			.then(
				result => this.#exit(pane, result.exitCode ?? (result.cancelled ? 130 : 1)),
				error => {
					this.#feed(pane, `\r\n[pty error: ${error instanceof Error ? error.message : String(error)}]\r\n`);
					this.#exit(pane, 1);
				},
			);
		this.#opts.onChange();
		return id;
	}

	has(id: string): boolean {
		return this.#panes.has(id);
	}

	/** Open panes in creation order, for the tab row. */
	list(): Array<{ id: string; name: string; exited: boolean }> {
		return [...this.#panes.values()].map(p => ({ id: p.id, name: p.name, exited: p.exited }));
	}

	#attachTerminal(pane: Pane, Ctor: typeof Terminal): void {
		const terminal = new Ctor({ cols: pane.cols, rows: pane.rows, scrollback: SCROLLBACK, allowProposedApi: true });
		// Replies the child asks the terminal for (cursor position, device attributes) go back to it.
		terminal.onData(data => {
			if (!pane.exited) this.#write(pane, data);
		});
		pane.terminal = terminal;
		pane.ready.resolve();
		for (const chunk of pane.early.splice(0)) this.#queue(pane, chunk);
		this.#opts.onChange();
	}

	#feed(pane: Pane, chunk: string): void {
		if (!pane.terminal) pane.early.push(chunk);
		else this.#queue(pane, chunk);
	}

	#queue(pane: Pane, chunk: string): void {
		const terminal = pane.terminal!;
		pane.written = pane.written.then(() => {
			const { promise, resolve } = Promise.withResolvers<void>();
			terminal.write(chunk, () => {
				resolve();
				this.#opts.onChange();
			});
			return promise;
		});
	}

	#write(pane: Pane, data: string): void {
		try {
			pane.process.write(data);
		} catch {
			// The child exited between the key and the write.
		}
	}

	#exit(pane: Pane, exitCode: number): void {
		if (pane.exited) return;
		pane.exited = true;
		pane.ready.resolve();
		pane.exit.resolve(exitCode);
		const store = this.#opts.store;
		if (store.get(pane.id)) {
			if (store.get(pane.id)?.focused) store.focus(null);
			store.update(pane.id, { state: "done", exitCode });
		}
		this.#opts.onChange();
	}

	/** Resolves when every chunk received so far is on the VT screen (tests, live checks). */
	async settled(id: string): Promise<void> {
		const pane = this.#panes.get(id);
		if (!pane) return;
		await pane.ready.promise;
		await pane.written;
	}

	/** Resolves with the pane's exit code once its process ends. */
	exited(id: string): Promise<number> | undefined {
		return this.#panes.get(id)?.exit.promise;
	}

	/** Send a key from the Stage to the pane's child. Returns false when the pane cannot take it. */
	key(id: string, data: string): boolean {
		const pane = this.#panes.get(id);
		if (!pane || pane.exited) return false;
		const bytes = normalizeInputForPty(data, pane.terminal?.modes.applicationCursorKeysMode ?? false);
		if (bytes) this.#write(pane, bytes);
		return true;
	}

	/**
	 * The pane's screen at `cols`×`rows` (exactly that many rows, each padded to `cols`). Resizes the VT and the
	 * PTY when the tile size changed. `cursor` is the VT cursor inside that grid while the child runs.
	 */
	rows(id: string, cols: number, rows: number): { rows: string[]; cursor: { row: number; col: number } | null } {
		const pane = this.#panes.get(id);
		const blank = Array.from({ length: Math.max(0, rows) }, () => padEnd("", cols));
		if (!pane || cols <= 0 || rows <= 0) return { rows: blank, cursor: null };
		if (cols !== pane.cols || rows !== pane.rows) {
			pane.cols = cols;
			pane.rows = rows;
			pane.terminal?.resize(cols, rows);
			if (!pane.exited) {
				try {
					pane.process.resize(cols, rows);
				} catch {
					// Not started yet: the start options carry the last size.
				}
			}
		}
		const terminal = pane.terminal;
		if (!terminal) {
			blank[0] = padEnd(fit("starting…", cols), cols);
			return { rows: blank, cursor: null };
		}
		const buffer = terminal.buffer.active;
		const screen = readTerminalRows(terminal, buffer.viewportY, rows).map(line =>
			padEnd(fit(styleTerminalRow(line, ""), cols), cols),
		);
		while (screen.length < rows) screen.push(padEnd("", cols));
		const cursor = pane.exited
			? null
			: { row: Math.min(rows - 1, buffer.cursorY), col: Math.min(cols - 1, buffer.cursorX) };
		return { rows: screen, cursor };
	}

	/** Kill one pane's child (tile stays until it chips). */
	kill(id: string): void {
		const pane = this.#panes.get(id);
		if (pane && !pane.exited) {
			try {
				pane.process.kill();
			} catch {
				// already gone
			}
		}
	}

	/** Kill every child and drop the panes (session end). */
	dispose(): void {
		for (const pane of this.#panes.values()) {
			this.kill(pane.id);
			pane.terminal?.dispose();
		}
		this.#panes.clear();
	}
}
