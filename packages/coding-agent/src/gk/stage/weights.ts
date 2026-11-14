import type { TileKind, TileState } from "./tiles";

/**
 * Per-kind base attention (spec §5.5). `diff`, `proc`, `telemetry`, `events` and `todo` are not in the
 * spec table; they take the value of their closest spec sibling (`git` for diff, `timeline` for the
 * passive widgets, `dag` for proc).
 */
export const KIND_BASE: Record<TileKind, number> = {
	transcript: 4,
	error: 2.5,
	agent: 2,
	pty: 2,
	computer: 2,
	dag: 1.5,
	proc: 1.5,
	git: 1,
	diff: 1,
	command: 1,
	timeline: 0.8,
	events: 0.8,
	telemetry: 0.8,
	todo: 0.8,
	web: 0.6,
};

export const STATE_MUL: Record<TileState, number> = {
	error: 2,
	running: 1.6,
	idle: 0.6,
	done: 0.35,
};

/** Recency decay time constant in ms. */
export const RECENCY_TAU_MS = 8_000;
export const FOCUS_MUL = 2.5;

export interface WeightInput {
	kind: TileKind;
	state: TileState;
	lastActivityAt: number;
	focused: boolean;
}

/** `KIND_BASE × STATE_MUL × (1 + e^(−(now − lastActivityAt)/8000)) × (focused ? 2.5 : 1)`. */
export function attentionWeight(tile: WeightInput, now: number): number {
	const age = Math.max(0, now - tile.lastActivityAt);
	return (
		KIND_BASE[tile.kind] *
		STATE_MUL[tile.state] *
		(1 + Math.exp(-age / RECENCY_TAU_MS)) *
		(tile.focused ? FOCUS_MUL : 1)
	);
}

export interface WeightedNode {
	id: string;
	parentId: string | null;
	weight: number;
}

/**
 * Subtree weight = own weight + Σ children's subtree weights. Nodes whose parent is not in the list
 * are roots. Cycles are broken by visiting each node once.
 */
export function subtreeWeights(nodes: readonly WeightedNode[]): Map<string, number> {
	const byId = new Map<string, WeightedNode>();
	for (const node of nodes) byId.set(node.id, node);
	const children = new Map<string, WeightedNode[]>();
	for (const node of nodes) {
		if (node.parentId === null || !byId.has(node.parentId)) continue;
		const list = children.get(node.parentId);
		if (list) list.push(node);
		else children.set(node.parentId, [node]);
	}
	const out = new Map<string, number>();
	const visiting = new Set<string>();
	const visit = (node: WeightedNode): number => {
		const cached = out.get(node.id);
		if (cached !== undefined) return cached;
		if (visiting.has(node.id)) return 0;
		visiting.add(node.id);
		let sum = node.weight;
		for (const child of children.get(node.id) ?? []) sum += visit(child);
		visiting.delete(node.id);
		out.set(node.id, sum);
		return sum;
	};
	for (const node of nodes) visit(node);
	return out;
}
