/**
 * Orchestra advisor channel: a crew worker asks its conductor one question over the IRC bus and
 * blocks until the conductor answers (through `crew_send`, routed by {@link answerCrewQuestion})
 * or the timeout passes. Built only for sessions spawned with `crewConductorId`.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import askConductorDescription from "../prompts/tools/ask-conductor.md" with { type: "text" };
import type { ToolSession } from "../tools";

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 900;
const QUESTION_PREFIX = "[ask_conductor] ";

const askConductorSchema = type({
	question: type("string > 0").describe("one specific question, with the options you see"),
	"timeout?": type("number > 0").describe(
		`max seconds to wait (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS})`,
	),
});

export interface AskConductorDetails {
	conductorId: string;
	answered: boolean;
	timeoutSeconds: number;
}

export class AskConductorTool implements AgentTool<typeof askConductorSchema, AskConductorDetails> {
	readonly name = "ask_conductor";
	readonly approval = "read" as const;
	readonly label = "Ask Conductor";
	readonly summary = "Ask the conductor a blocking question";
	readonly description = prompt.render(askConductorDescription);
	readonly parameters = askConductorSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: typeof askConductorSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<AskConductorDetails>> {
		const conductorId = this.session.crewConductorId;
		const selfId = this.session.getAgentId?.();
		if (!conductorId || !selfId) throw new ToolError("ask_conductor is only available to Orchestra crew workers.");
		const timeoutSeconds = Math.min(params.timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
		const bus = IrcBus.global();
		// Park the wait before asking: an answer that lands before a later wait would miss it.
		const cancel = new AbortController();
		const reply = bus.wait(
			selfId,
			{ from: conductorId, directOnly: true },
			timeoutSeconds * 1000,
			signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal,
			{ drainPending: false },
		);
		// An abort during the send rejects `reply` before it is awaited below.
		reply.catch(() => {});
		let answer: string | undefined;
		try {
			const receipt = await bus.send({
				from: selfId,
				to: conductorId,
				body: `${QUESTION_PREFIX}${params.question}`,
			});
			if (receipt.outcome === "failed") {
				cancel.abort();
				throw new ToolError(
					`Could not reach the conductor: ${receipt.error ?? "delivery failed"}. Proceed with your best judgment and state the assumption in your report.`,
				);
			}
			answer = (await reply)?.body;
		} finally {
			// Close an unanswered question so a late crew_send takes the normal vibe path
			// instead of landing on a bus wait that is no longer there.
			if (answer === undefined) bus.recordReply(conductorId, selfId);
		}
		const details: AskConductorDetails = { conductorId, answered: answer !== undefined, timeoutSeconds };
		const text =
			answer ??
			`No answer from the conductor within ${timeoutSeconds}s. Proceed with your best judgment and state the assumption in your report.`;
		return { content: [{ type: "text", text }], details };
	}
}

/**
 * Route a conductor message to `workerId` as the answer to its pending `ask_conductor`
 * question. Returns false when the worker has no question open to `conductorId`, so the
 * caller delivers the message through the vibe session instead.
 */
export async function answerCrewQuestion(conductorId: string, workerId: string, message: string): Promise<boolean> {
	const bus = IrcBus.global();
	if (!bus.unansweredSends(workerId, 0).some(pending => pending.to === conductorId)) return false;
	const receipt = await bus.send({ from: conductorId, to: workerId, body: message });
	return receipt.outcome !== "failed";
}
