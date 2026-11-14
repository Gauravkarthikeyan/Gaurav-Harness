import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GK_UPSTREAM_VERSION, GK_VERSION, formatGkVersion } from "../../src/gk/brand";
import { importOmpProfile } from "../../src/gk/import-omp";

describe("importOmpProfile", () => {
	let home: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "gk-import-omp-"));
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("copies ~/.omp/agent into ~/.gk/agent when .gk is absent", async () => {
		const ompAgent = path.join(home, ".omp", "agent");
		fs.mkdirSync(ompAgent, { recursive: true });
		fs.writeFileSync(path.join(ompAgent, "auth.json"), '{"token":"x"}');

		const result = await importOmpProfile({ home });

		expect(result).toEqual({ imported: true, reason: "imported" });
		expect(fs.readFileSync(path.join(home, ".gk", "agent", "auth.json"), "utf8")).toBe('{"token":"x"}');
		expect(fs.existsSync(path.join(ompAgent, "auth.json"))).toBe(true);
	});

	it("leaves an existing .gk untouched", async () => {
		fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
		fs.writeFileSync(path.join(home, ".omp", "agent", "auth.json"), "{}");
		fs.mkdirSync(path.join(home, ".gk"));
		const copies: Array<[string, string]> = [];

		const result = await importOmpProfile({
			home,
			copy: async (src, dst) => {
				copies.push([src, dst]);
			},
		});

		expect(result).toEqual({ imported: false, reason: "gk-exists" });
		expect(copies).toEqual([]);
		expect(fs.existsSync(path.join(home, ".gk", "agent"))).toBe(false);
	});

	it("reports no-omp when neither profile exists", async () => {
		const result = await importOmpProfile({ home });

		expect(result).toEqual({ imported: false, reason: "no-omp" });
		expect(fs.existsSync(path.join(home, ".gk"))).toBe(false);
	});

	it("routes the copy through the injected copier", async () => {
		fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
		const copies: Array<[string, string]> = [];

		const result = await importOmpProfile({
			home,
			copy: async (src, dst) => {
				copies.push([src, dst]);
			},
		});

		expect(result.reason).toBe("imported");
		expect(copies).toEqual([[path.join(home, ".omp", "agent"), path.join(home, ".gk", "agent")]]);
	});
});

describe("gk version string", () => {
	it("prints only gk-code and its own version", () => {
		expect(GK_VERSION).toBe("0.1.0");
		expect(formatGkVersion()).toBe("gk-code 0.1.0");
		expect(formatGkVersion("1.2.3")).toBe("gk-code 1.2.3");
		expect(formatGkVersion()).not.toContain(GK_UPSTREAM_VERSION);
	});
});
