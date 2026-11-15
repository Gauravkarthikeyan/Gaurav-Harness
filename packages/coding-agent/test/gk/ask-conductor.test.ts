import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type AskConductorDetails,
	AskConductorTool,
	answerCrewQuestion,
} from "@oh-my-pi/pi-coding-agent/gk/ask-conductor-tool";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resolveBuiltinToolPlan, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const CONDUCTOR = "Main";
const WORKER = "CalmPanda";

function setup() {
	const agents = new AgentRegistry();
	const inbox: IrcMessage[] = [];
	const sessionFor = (sink?: (msg: IrcMessage) => void) =>
		({
			deliverIrcMessage: async (msg: IrcMessage) => {
				sink?.(msg);
				return "injected";
			},
		}) as unknown as AgentSession;
	agents.register({
		id: CONDUCTOR,
		displayName: CONDUCTOR,
		kind: "main",
		session: sessionFor(msg => inbox.push(msg)),
		sessionFile: null,
		status: "running",
	});
	agents.register({
		id: WORKER,
		displayName: WORKER,
		kind: "sub",
		parentId: CONDUCTOR,
		session: sessionFor(),
		sessionFile: null,
		status: "running",
	});
	const bus = new IrcBus(agents);
	// Settles once the bus has recorded the question, not merely handed it to the conductor.
	const asked = Promise.withResolvers<IrcMessage | undefined>();
	const send = bus.send.bind(bus);
	vi.spyOn(bus, "send").mockImplementation(async msg => {
		const receipt = await send(msg);
		if (msg.to === CONDUCTOR) asked.resolve(inbox.at(-1));
		return receipt;
	});
	IrcBus.installGlobal(bus);
	const tool = new AskConductorTool({ crewConductorId: CONDUCTOR, getAgentId: () => WORKER } as ToolSession);
	return { tool, inbox, asked: asked.promise };
}

function text(result: AgentToolResult<AskConductorDetails>): string {
	const [first] = result.content;
	return first?.type === "text" ? first.text : "";
}

describe("ask_conductor", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		IrcBus.resetGlobalForTests();
	});

	it("blocks until the conductor answers through answerCrewQuestion", async () => {
		const { tool, asked } = setup();
		const pending = tool.execute("call-1", { question: "Add `retries` to Config, or read RETRIES from env?" });

		const question = await asked;
		expect(question?.from).toBe(WORKER);
		expect(question?.to).toBe(CONDUCTOR);
		expect(question?.body).toBe("[ask_conductor] Add `retries` to Config, or read RETRIES from env?");

		expect(await answerCrewQuestion(CONDUCTOR, WORKER, "Add it to Config.")).toBe(true);
		const result = await pending;
		expect(text(result)).toBe("Add it to Config.");
		expect(result.details?.answered).toBe(true);
		// Answered: the next conductor message takes the normal vibe path.
		expect(await answerCrewQuestion(CONDUCTOR, WORKER, "Also add a test.")).toBe(false);
	});

	it("times out with guidance and closes the question", async () => {
		vi.useFakeTimers();
		const { tool, asked } = setup();
		const pending = tool.execute("call-2", { question: "Which port?" });
		expect((await asked)?.body).toBe("[ask_conductor] Which port?");
		vi.advanceTimersByTime(300_000);
		const result = await pending;
		expect(text(result)).toContain("No answer from the conductor within 300s");
		expect(text(result)).toContain("state the assumption in your report");
		expect(result.details?.answered).toBe(false);
		expect(await answerCrewQuestion(CONDUCTOR, WORKER, "Late answer.")).toBe(false);
	});

	it("answerCrewQuestion returns false when nothing is pending", async () => {
		const { inbox } = setup();
		expect(await answerCrewQuestion(CONDUCTOR, WORKER, "Steer.")).toBe(false);
		expect(inbox).toHaveLength(0);
	});

	it("is planned only for sessions with a crew conductor", async () => {
		const base = { cwd: "/tmp", settings: Settings.isolated(), skipPythonPreflight: true } as ToolSession;
		const worker = await resolveBuiltinToolPlan({ ...base, crewConductorId: CONDUCTOR }, ["read"]);
		expect(worker.names).toContain("ask_conductor");
		const plain = await resolveBuiltinToolPlan(base, ["read"]);
		expect(plain.names).not.toContain("ask_conductor");
		const restricted = await resolveBuiltinToolPlan(
			{ ...base, crewConductorId: CONDUCTOR, restrictToolNames: true },
			["read"],
		);
		expect(restricted.names).not.toContain("ask_conductor");
	});
});
