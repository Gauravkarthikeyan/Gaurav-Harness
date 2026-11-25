import { describe, expect, it } from "bun:test";
import type { PtyArgvStartOptions, PtyRunResult } from "@oh-my-pi/pi-natives";
import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { loadXtermTerminal } from "@oh-my-pi/pi-tui/tools/terminal-output";
import { StageHost } from "../../../src/gk/stage/host";
import { type PtyProcess, ptyName, StagePtys } from "../../../src/gk/stage/pty-pane";
import { plainStyle } from "../../../src/gk/stage/style";
import { CHIP_DELAY, TileStore } from "../../../src/gk/stage/tiles";

/** A PTY whose output and exit the test drives. */
class FakePty implements PtyProcess {
	started: PtyArgvStartOptions | undefined;
	readonly written: string[] = [];
	readonly resizes: Array<[number, number]> = [];
	killed = false;
	#emit: ((error: Error | null, chunk: string) => void) | undefined;
	readonly #done = Promise.withResolvers<PtyRunResult>();

	startArgv(options: PtyArgvStartOptions, onChunk?: (error: Error | null, chunk: string) => void) {
		this.started = options;
		this.#emit = onChunk;
		return this.#done.promise;
	}
	output(text: string): void {
		this.#emit?.(null, text);
	}
	exit(exitCode: number): void {
		this.#done.resolve({ exitCode, cancelled: false, timedOut: false });
	}
	write(data: string): void {
		this.written.push(data);
	}
	resize(cols: number, rows: number): void {
		this.resizes.push([cols, rows]);
	}
	kill(): void {
		this.killed = true;
		this.exit(137);
	}
}

function setup() {
	const clock = { t: 1000 };
	const store = new TileStore({ now: () => clock.t });
	store.add({ id: "main", kind: "transcript" });
	const fakes: FakePty[] = [];
	const ptys = new StagePtys({
		store,
		cwd: "/tmp/x",
		shell: "/bin/zsh",
		spawn: () => {
			const pty = new FakePty();
			fakes.push(pty);
			return pty;
		},
		terminal: loadXtermTerminal,
		onChange: () => {},
	});
	return { clock, store, ptys, fakes };
}

describe("StagePtys", () => {
	it("runs the command under $SHELL -lc in the session cwd and names the pane", () => {
		const { ptys, fakes, store } = setup();
		const id = ptys.open("claude --resume");
		expect(fakes[0]!.started).toMatchObject({
			application: "/bin/zsh",
			args: ["-lc", "claude --resume"],
			cwd: "/tmp/x",
		});
		expect(store.get(id)).toMatchObject({ kind: "pty", state: "running", title: "claude" });
		expect(ptyName("/usr/local/bin/codex exec")).toBe("codex");
	});

	it("renders the VT grid at the tile size, cursor included", async () => {
		const { ptys, fakes } = setup();
		const id = ptys.open("zsh");
		ptys.rows(id, 20, 5);
		fakes[0]!.output("% echo hi\r\nhi\r\n\x1b[31mred\x1b[0m % ");
		await ptys.settled(id);
		const { rows, cursor } = ptys.rows(id, 20, 5);
		expect(rows).toHaveLength(5);
		for (const row of rows) expect(visibleWidth(row)).toBe(20);
		const plain = rows.map(r => Bun.stripANSI(r).trimEnd());
		expect(plain.slice(0, 3)).toEqual(["% echo hi", "hi", "red %"]);
		expect(rows[2]).toContain("\x1b[");
		expect(cursor).toEqual({ row: 2, col: 6 });
	});

	it("resizes the VT and the PTY when the tile size changes, once per size", async () => {
		const { ptys, fakes } = setup();
		const id = ptys.open("zsh");
		await ptys.settled(id);
		ptys.rows(id, 30, 6);
		ptys.rows(id, 30, 6);
		ptys.rows(id, 50, 10);
		expect(fakes[0]!.resizes).toEqual([
			[30, 6],
			[50, 10],
		]);
		fakes[0]!.output("x".repeat(45));
		await ptys.settled(id);
		// 50 columns wide: the 45-char line is not wrapped.
		expect(Bun.stripANSI(ptys.rows(id, 50, 10).rows[0]!).trimEnd()).toBe("x".repeat(45));
	});

	it("forwards keys in terminal bytes and settles on exit; the tile chips 10 s later", async () => {
		const { ptys, fakes, store, clock } = setup();
		const id = ptys.open("zsh");
		await ptys.settled(id);
		store.focus(id);
		expect(ptys.key(id, "l")).toBe(true);
		expect(ptys.key(id, "\r")).toBe(true);
		expect(fakes[0]!.written).toEqual(["l", "\r"]);
		fakes[0]!.exit(0);
		expect(await ptys.exited(id)).toBe(0);
		expect(store.get(id)).toMatchObject({ state: "done", exitCode: 0, focused: false });
		expect(ptys.key(id, "x")).toBe(false);
		clock.t += CHIP_DELAY.pty - 1;
		store.tick();
		expect(store.isChip(id)).toBe(false);
		clock.t += 1;
		store.tick();
		expect(store.isChip(id)).toBe(true);
	});

	it("kills every child on dispose", () => {
		const { ptys, fakes } = setup();
		ptys.open("zsh");
		ptys.open("claude");
		ptys.dispose();
		expect(fakes.map(f => f.killed)).toEqual([true, true]);
	});
});

describe("StageHost PTY panes", () => {
	it("opens a focused pane with a pty tab, sends keys to it, and Ctrl+] releases focus", async () => {
		let input: ((data: string) => unknown) | undefined;
		const fakes: FakePty[] = [];
		const host = new StageHost({
			ui: {
				terminal: { columns: 212, rows: 58 },
				requestRender: () => {},
				showOverlay: () => ({ hide() {}, setHidden() {}, isHidden: () => false }) as never,
				addInputListener: listener => {
					input = listener as (data: string) => unknown;
					return () => {};
				},
				hasOverlay: () => false,
			},
			session: () => ({
				subscribe: () => () => {},
				isStreaming: false,
				model: { id: "claude-sonnet-5" },
				messages: [],
				getSessionStats: () => ({ cost: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } }),
			}),
			sessionId: () => "abc123",
			blocks: () => [] as Component[],
			chrome: () => [] as Component[],
			isAssistant: () => false,
			cwd: "/tmp/x",
			git: null,
			timers: false,
			motion: false,
			todaySpend: null,
			style: plainStyle,
			ptys: {
				spawn: () => {
					const pty = new FakePty();
					fakes.push(pty);
					return pty;
				},
				terminal: loadXtermTerminal,
				shell: "/bin/zsh",
			},
		});
		host.start();
		const id = host.openPty("zsh");
		await host.ptys.settled(id);
		fakes[0]!.output("% ");
		await host.ptys.settled(id);
		let text = Bun.stripANSI(host.render(212, 58).join("\n"));
		expect(text).toContain("1:pty:zsh*");
		expect(text).toContain("pty:zsh");
		expect(text).toContain("^] release to composer");
		// Esc and Enter go to the child while the pane is focused.
		expect(input!("e")).toEqual({ consume: true });
		expect(input!("\x1b")).toEqual({ consume: true });
		expect(input!("\r")).toEqual({ consume: true });
		expect(fakes[0]!.written).toEqual(["e", "\x1b", "\r"]);
		expect(fakes[0]!.resizes.length).toBeGreaterThan(0);
		expect(input!("\x1d")).toEqual({ consume: true });
		expect(host.store.focused()).toBeUndefined();
		text = Bun.stripANSI(host.render(212, 58).join("\n"));
		expect(text).toContain("0:session*");
		expect(text).not.toContain("^] release");
		// Released: keys go back to omp's composer.
		expect(input!("z")).toBeUndefined();
		host.dispose();
		expect(fakes[0]!.killed).toBe(true);
	});
});
