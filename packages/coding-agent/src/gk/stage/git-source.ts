/**
 * Git facts for the Stage header, status bar and `git` widget: branch with ahead/dirty counts, a short
 * commit graph and a per-file diffstat. One snapshot is three cheap git calls; callers throttle.
 */
import type { GitFile, GitFileStatus, GitGraphLine } from "./widgets/git";

export interface GitSnapshot {
	branch: string;
	ahead: number;
	/** Files with staged or unstaged changes. */
	changed: number;
	untracked: number;
	graph: GitGraphLine[];
	files: GitFile[];
}

export type GitLoader = (cwd: string) => Promise<GitSnapshot | null>;

async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? out : null;
	} catch {
		return null;
	}
}

const STATUS_LETTERS: Record<string, GitFileStatus> = { M: "M", A: "A", D: "D", R: "R", "?": "A", T: "M", C: "A", U: "M" };

/** Parse `git status --porcelain=v1 --branch` plus `git diff HEAD --numstat` and `git log --graph`. */
export function parseGitSnapshot(status: string, numstat: string, log: string): GitSnapshot {
	const lines = status.split("\n").filter(Boolean);
	const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
	const branch = head.split("...")[0]!.replace(/^No commits yet on /, "").trim() || "HEAD";
	const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
	const stats = new Map<string, { add: number; del: number }>();
	for (const row of numstat.split("\n")) {
		const [add, del, ...rest] = row.split("\t");
		if (rest.length === 0) continue;
		const file = rest.join("\t").replace(/^.*=> /, "").replace(/[{}]/g, "");
		stats.set(file, { add: Number(add) || 0, del: Number(del) || 0 });
	}
	let changed = 0;
	let untracked = 0;
	const files: GitFile[] = [];
	for (const row of lines) {
		const code = row.slice(0, 2);
		const file = row.slice(3).replace(/^.* -> /, "");
		if (code === "??") untracked++;
		else changed++;
		const letter = code === "??" ? "?" : code.trim()[0] ?? "M";
		const stat = stats.get(file) ?? { add: 0, del: 0 };
		files.push({ status: STATUS_LETTERS[letter] ?? "M", path: file, add: stat.add, del: stat.del });
	}
	files.sort((a, b) => b.add + b.del - (a.add + a.del));
	const graph: GitGraphLine[] = [];
	for (const row of log.split("\n")) {
		if (!row.trim()) continue;
		const m = /^([*|/\\ _.-]*?)\s*([0-9a-f]{7,})\s+(?:\(([^)]*)\)\s+)?(.*)$/.exec(row);
		if (m) graph.push({ graph: m[1]!.trimEnd() || "*", sha: m[2], refs: m[3]?.replace("HEAD -> ", "HEAD→"), subject: m[4] });
		else graph.push({ graph: row.trimEnd() });
	}
	return { branch, ahead, changed, untracked, graph, files };
}

/** Default loader: the working tree at `cwd`; `null` outside a repository. */
export const loadGitSnapshot: GitLoader = async cwd => {
	const [status, numstat, log] = await Promise.all([
		git(cwd, ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"]),
		git(cwd, ["diff", "HEAD", "--numstat", "--no-renames"]),
		git(cwd, ["log", "--graph", "--oneline", "--decorate", "-n", "3", "--color=never"]),
	]);
	if (status === null) return null;
	return parseGitSnapshot(status, numstat ?? "", log ?? "");
};

/** `main ↑2 ✱4 ?1`. */
export function branchLabel(snap: GitSnapshot): string {
	const parts = [snap.branch];
	if (snap.ahead > 0) parts.push(`↑${snap.ahead}`);
	if (snap.changed > 0) parts.push(`✱${snap.changed}`);
	if (snap.untracked > 0) parts.push(`?${snap.untracked}`);
	return parts.join(" ");
}
