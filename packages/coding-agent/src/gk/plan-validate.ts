import type { WorkItem } from "./router";

export type CrewPlanError = {
	code: "duplicate-id" | "unknown-dep" | "cycle" | "empty-brief" | "empty-scope" | "scope-overlap";
	itemIds: string[];
	message: string;
};

/** Strip `./`, collapse `//`, drop trailing `/`; "" means the repo root. */
function normalizeScope(scope: string): string {
	let normalized = scope.trim().replace(/\/{2,}/g, "/");
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	if (normalized === ".") return "";
	return normalized.replace(/\/+$/, "");
}

/** True iff the two write scopes are equal or one is a path-segment prefix of the other. */
export function scopesOverlap(a: string, b: string): boolean {
	const x = normalizeScope(a);
	const y = normalizeScope(b);
	if (x === "" || y === "" || x === y) return true;
	return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** All ids reachable from `id` via `dependsOn` (excluding `id` itself unless it is on a cycle). */
function transitiveDeps(byId: Map<string, WorkItem>, id: string): Set<string> {
	const seen = new Set<string>();
	const stack = [...(byId.get(id)?.dependsOn ?? [])];
	while (stack.length > 0) {
		const next = stack.pop()!;
		if (seen.has(next)) continue;
		seen.add(next);
		stack.push(...(byId.get(next)?.dependsOn ?? []));
	}
	return seen;
}

/** True iff neither item depends, directly or transitively, on the other. */
export function canRunConcurrently(items: WorkItem[], a: string, b: string): boolean {
	const byId = new Map(items.map(item => [item.id, item]));
	return !transitiveDeps(byId, a).has(b) && !transitiveDeps(byId, b).has(a);
}

/** Finds each dependency cycle once, as the list of ids along it. */
function findCycles(items: WorkItem[], byId: Map<string, WorkItem>): string[][] {
	const cycles: string[][] = [];
	const state = new Map<string, "visiting" | "done">();
	const path: string[] = [];
	const visit = (id: string): void => {
		state.set(id, "visiting");
		path.push(id);
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			if (!byId.has(dep)) continue;
			const depState = state.get(dep);
			if (depState === "visiting") cycles.push(path.slice(path.indexOf(dep)));
			else if (depState === undefined) visit(dep);
		}
		path.pop();
		state.set(id, "done");
	};
	for (const item of items) if (!state.has(item.id)) visit(item.id);
	return cycles;
}

/** Every problem in a crew plan; `[]` means the plan can be cast and run. */
export function validateCrewPlan(items: WorkItem[]): CrewPlanError[] {
	const errors: CrewPlanError[] = [];
	const byId = new Map<string, WorkItem>();
	const duplicates = new Set<string>();
	for (const item of items) {
		if (byId.has(item.id)) duplicates.add(item.id);
		else byId.set(item.id, item);
	}
	for (const id of duplicates) {
		errors.push({ code: "duplicate-id", itemIds: [id], message: `Item id "${id}" is used more than once.` });
	}

	for (const item of items) {
		for (const dep of item.dependsOn) {
			if (!byId.has(dep)) {
				errors.push({
					code: "unknown-dep",
					itemIds: [item.id, dep],
					message: `Item "${item.id}" depends on unknown item "${dep}".`,
				});
			}
		}
		if (item.brief.trim() === "") {
			errors.push({ code: "empty-brief", itemIds: [item.id], message: `Item "${item.id}" has an empty brief.` });
		}
		if (item.scope.some(scope => scope.trim() === "")) {
			errors.push({
				code: "empty-scope",
				itemIds: [item.id],
				message: `Item "${item.id}" has a blank scope entry; list real paths, or use scope: [] for a read-only item.`,
			});
		}
	}

	for (const cycle of findCycles(items, byId)) {
		errors.push({
			code: "cycle",
			itemIds: cycle,
			message: `Dependency cycle: ${[...cycle, cycle[0]].join(" → ")}.`,
		});
	}

	const unique = [...byId.values()];
	const deps = new Map(unique.map(item => [item.id, transitiveDeps(byId, item.id)]));
	for (let i = 0; i < unique.length; i++) {
		for (let j = i + 1; j < unique.length; j++) {
			const a = unique[i];
			const b = unique[j];
			if (deps.get(a.id)!.has(b.id) || deps.get(b.id)!.has(a.id)) continue;
			const clash = a.scope
				.filter(sa => sa.trim() !== "")
				.flatMap(sa => b.scope.filter(sb => sb.trim() !== "" && scopesOverlap(sa, sb)).map(sb => [sa, sb]));
			if (clash.length === 0) continue;
			const [sa, sb] = clash[0];
			errors.push({
				code: "scope-overlap",
				itemIds: [a.id, b.id],
				message: `Items "${a.id}" (${sa}) and "${b.id}" (${sb}) can run at the same time and write overlapping paths; add a dependsOn or split the scopes.`,
			});
		}
	}

	return errors;
}
