import { describe, expect, it } from "bun:test";
import { canRunConcurrently, scopesOverlap, validateCrewPlan } from "../../src/gk/plan-validate";
import type { WorkItem } from "../../src/gk/router";

function item(id: string, extra: Partial<WorkItem> = {}): WorkItem {
	return {
		id,
		title: id,
		brief: `do ${id}`,
		skills: ["backend"],
		difficulty: 1,
		size: "S",
		dependsOn: [],
		scope: [`src/${id}/`],
		...extra,
	};
}

const codes = (items: WorkItem[]): string[] => validateCrewPlan(items).map(error => error.code);

describe("scopesOverlap", () => {
	it("treats a directory and a file inside it as overlapping", () => {
		expect(scopesOverlap("src/api/", "src/api/routes.ts")).toBe(true);
		expect(scopesOverlap("src/api/routes.ts", "src/api/")).toBe(true);
	});

	it("matches on whole path segments only", () => {
		expect(scopesOverlap("src/api", "src/api2")).toBe(false);
		expect(scopesOverlap("src/api/", "src/api2/")).toBe(false);
	});

	it("normalizes ./ prefixes, doubled slashes and trailing slashes", () => {
		expect(scopesOverlap("./src//api/", "src/api")).toBe(true);
		expect(scopesOverlap("package.json", "./package.json")).toBe(true);
		expect(scopesOverlap("src/a", "src/b")).toBe(false);
	});
});

describe("canRunConcurrently", () => {
	const items = [item("a"), item("c", { dependsOn: ["a"] }), item("b", { dependsOn: ["c"] }), item("d")];

	it("is false for direct and transitive dependencies in either order", () => {
		expect(canRunConcurrently(items, "c", "a")).toBe(false);
		expect(canRunConcurrently(items, "a", "b")).toBe(false);
		expect(canRunConcurrently(items, "b", "a")).toBe(false);
	});

	it("is true for independent items", () => {
		expect(canRunConcurrently(items, "a", "d")).toBe(true);
		expect(canRunConcurrently(items, "d", "b")).toBe(true);
	});
});

describe("validateCrewPlan", () => {
	it("accepts a valid 3-item plan", () => {
		const items = [
			item("api", { scope: ["src/api/"] }),
			item("ui", { skills: ["frontend"], scope: ["src/ui/"] }),
			item("tests", { skills: ["tests"], dependsOn: ["api", "ui"], scope: ["test/", "src/api/"] }),
		];
		expect(validateCrewPlan(items)).toEqual([]);
	});

	it("reports duplicate ids", () => {
		const errors = validateCrewPlan([item("a"), item("a", { scope: ["docs/"] })]);
		expect(errors.map(e => e.code)).toEqual(["duplicate-id"]);
		expect(errors[0].itemIds).toEqual(["a"]);
	});

	it("reports unknown dependencies", () => {
		const errors = validateCrewPlan([item("a", { dependsOn: ["ghost"] })]);
		expect(errors.map(e => e.code)).toEqual(["unknown-dep"]);
		expect(errors[0].itemIds).toEqual(["a", "ghost"]);
	});

	it("reports cycles", () => {
		const errors = validateCrewPlan([item("a", { dependsOn: ["b"] }), item("b", { dependsOn: ["a"] })]);
		expect(errors.map(e => e.code)).toEqual(["cycle"]);
		expect([...errors[0].itemIds].sort()).toEqual(["a", "b"]);
	});

	it("reports self-dependency as a cycle", () => {
		expect(codes([item("a", { dependsOn: ["a"] })])).toEqual(["cycle"]);
	});

	it("reports empty briefs", () => {
		expect(codes([item("a", { brief: "   " })])).toEqual(["empty-brief"]);
	});

	it("reports blank scope entries", () => {
		expect(codes([item("a", { scope: [" "] })])).toEqual(["empty-scope"]);
		expect(codes([item("a", { scope: ["src/a/", ""] })])).toEqual(["empty-scope"]);
	});

	it("accepts scope: [] as a read-only item that never overlaps", () => {
		const items = [item("research", { scope: [] }), item("a", { scope: ["src/"] }), item("root", { scope: ["."] })];
		expect(validateCrewPlan(items).map(e => e.itemIds)).toEqual([["a", "root"]]);
	});

	it("rejects overlapping scopes on items that can run at the same time", () => {
		const errors = validateCrewPlan([
			item("a", { scope: ["src/api/"] }),
			item("b", { scope: ["src/api/routes.ts"] }),
		]);
		expect(errors.map(e => e.code)).toEqual(["scope-overlap"]);
		expect(errors[0].itemIds).toEqual(["a", "b"]);
		expect(errors[0].message).toContain("src/api/routes.ts");
	});

	it("allows overlapping scopes when B depends on A", () => {
		const items = [item("a", { scope: ["src/api/"] }), item("b", { scope: ["src/api/"], dependsOn: ["a"] })];
		expect(validateCrewPlan(items)).toEqual([]);
	});

	it("allows overlapping scopes when B depends on A transitively via C", () => {
		const items = [
			item("a", { scope: ["src/api/"] }),
			item("c", { scope: ["docs/"], dependsOn: ["a"] }),
			item("b", { scope: ["src/api/routes.ts"], dependsOn: ["c"] }),
		];
		expect(validateCrewPlan(items)).toEqual([]);
	});

	it("does not treat sibling prefixes as overlap", () => {
		expect(validateCrewPlan([item("a", { scope: ["src/api"] }), item("b", { scope: ["src/api2"] })])).toEqual([]);
	});
});
