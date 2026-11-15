import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableUserSource } from "@oh-my-pi/pi-coding-agent/capability";
import "@oh-my-pi/pi-coding-agent/discovery";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { GK_BUNDLED_SKILLS_DIR, GK_BUNDLED_SKILLS_PROVIDER_ID } from "@oh-my-pi/pi-coding-agent/gk/bundled-skills";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { restoreEnvValue } from "../helpers/settings-test-state";

const BUNDLED_SOURCE = `${GK_BUNDLED_SKILLS_PROVIDER_ID}:user`;

describe("gk bundled skills", () => {
	let tempHome: string;
	let tempCwd: string;
	let originalAgentDir: string;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		delete Bun.env.CLAUDE_CONFIG_DIR;
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gk-bundled-skills-home-"));
		tempCwd = path.join(tempHome, "work");
		await fs.mkdir(tempCwd, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".gk", "agent"));
	});

	afterEach(async () => {
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		disableUserSource("claude");
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	it("discovers the bundled pack from src/gk/skills", async () => {
		const { skills } = await loadSkills({ cwd: tempCwd });
		for (const name of ["brainstorming", "impeccable", "antislop-ui"]) {
			const skill = skills.find(s => s.name === name);
			expect(skill?.source).toBe(BUNDLED_SOURCE);
			expect(skill?.filePath).toBe(path.join(GK_BUNDLED_SKILLS_DIR, name, "SKILL.md"));
			expect(skill?.description.length).toBeGreaterThan(0);
		}
	});

	it("lets a same-named user skill replace the bundled copy without a namespaced alias", async () => {
		const file = path.join(getAgentDir(), "skills", "brainstorming", "SKILL.md");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, ["---", "description: My own brainstorming.", "---", "", "# mine"].join("\n"));

		const { skills } = await loadSkills({ cwd: tempCwd });
		const matches = skills.filter(s => s.name === "brainstorming" || s.name.endsWith("/brainstorming"));
		expect(matches).toHaveLength(1);
		expect(matches[0]?.source).toBe("native:user");
		expect(matches[0]?.description).toBe("My own brainstorming.");
		expect(skills.some(s => s.source === BUNDLED_SOURCE && s.name === "impeccable")).toBe(true);
	});
});
