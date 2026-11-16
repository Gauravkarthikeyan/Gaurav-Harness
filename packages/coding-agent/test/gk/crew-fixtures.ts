import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CrewWorkerResult, CrewWorkerSpawner } from "../../src/gk/crew-runtime";
import {
	type CrewApproval,
	type CrewApprovalRequest,
	CrewController,
	type CrewHost,
	type CrewRunContext,
} from "../../src/gk/crew-tools";
import { CrewLedger } from "../../src/gk/ledger";
import type { WorkItem } from "../../src/gk/router";
import type { CrewPolicy, RosterEntry, Tier } from "../../src/gk/types";

export interface FakeWorker {
	name: string;
	prompt: string;
	model: string;
	workerId: string;
	finish(ok?: boolean, costUsd?: number): void;
}

/** Spawner whose workers settle only when the test calls `finish`. */
export class FakeSpawner implements CrewWorkerSpawner {
	readonly spawned: FakeWorker[] = [];
	readonly killed: string[] = [];
	readonly sent: Array<{ workerId: string; msg: string }> = [];

	async spawn(a: { name: string; prompt: string; model: string }) {
		const { promise, resolve } = Promise.withResolvers<CrewWorkerResult>();
		const workerId = `w${this.spawned.length + 1}`;
		this.spawned.push({
			...a,
			workerId,
			finish: (ok = true, costUsd = 0.1) => resolve({ ok, costUsd, tokens: 100, text: ok ? "all good" : "broke" }),
		});
		return { workerId, settled: promise };
	}

	async send(workerId: string, msg: string): Promise<void> {
		this.sent.push({ workerId, msg });
	}

	async kill(workerId: string): Promise<void> {
		this.killed.push(workerId);
		this.spawned.find(w => w.workerId === workerId)?.finish(false, 0.01);
	}
}

export function entry(selector: string, tier: Tier, output: number, extra: Partial<RosterEntry> = {}): RosterEntry {
	return {
		selector,
		provider: selector.split("/")[0]!,
		openWeight: false,
		tier,
		strengths: [],
		enabled: true,
		maxConcurrent: 2,
		planIncluded: false,
		cost: { input: output / 5, output },
		...extra,
	};
}

export const ROSTER: RosterEntry[] = [entry("cheap/one", 1, 1), entry("mid/two", 2, 8), entry("top/three", 3, 30)];
export const CONDUCTOR = entry("top/conductor", 3, 75);

export function item(id: string, extra: Partial<WorkItem> = {}): WorkItem {
	return {
		id,
		title: `title ${id}`,
		brief: `do ${id}`,
		skills: ["docs"],
		difficulty: 1,
		size: "S",
		dependsOn: [],
		scope: [`${id}/`],
		...extra,
	};
}

/** Drain microtasks (spawn → settle → pump chains). */
export async function tick(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

export interface Harness {
	crew: CrewController;
	spawner: FakeSpawner;
	requests: CrewApprovalRequest[];
	runs: CrewRunContext[];
	ledgerPath: string;
	autoApproveSet: boolean[];
	/** Session policy as the host stores it. */
	policy: CrewPolicy;
}

export function harness(
	opts: {
		approve?: (req: CrewApprovalRequest) => CrewApproval;
		autoApprove?: boolean;
		maxRunUsd?: number;
		noUi?: boolean;
		roster?: RosterEntry[];
	} = {},
): Harness {
	const spawner = new FakeSpawner();
	const requests: CrewApprovalRequest[] = [];
	const runs: CrewRunContext[] = [];
	const autoApproveSet: boolean[] = [];
	const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gk-crew-")), "ledger.jsonl");
	const h = { policy: {} as CrewPolicy };
	const host: CrewHost = {
		roster: async () => opts.roster ?? ROSTER,
		conductor: () => CONDUCTOR,
		maxRunUsd: () => opts.maxRunUsd,
		autoApprove: () => opts.autoApprove ?? false,
		setAutoApprove: on => autoApproveSet.push(on),
		policy: () => h.policy,
		setPolicy: policy => {
			h.policy = policy;
		},
		approve: opts.noUi
			? undefined
			: async req => {
					requests.push(req);
					return opts.approve ? opts.approve(req) : { approved: true, cast: req.cast };
				},
		spawner: () => spawner,
		ledger: () => new CrewLedger(ledgerPath),
		promptHead: () => "add hello",
		onRunStart: ctx => runs.push(ctx),
	};
	return Object.assign(h, { crew: new CrewController(host), spawner, requests, runs, ledgerPath, autoApproveSet });
}
