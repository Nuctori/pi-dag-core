/**
 * core.ts — RunManager: the orchestration facade the pi adapter drives.
 *
 * This is the only place where scheduler + evidence + state meet. It is
 * still pi-free (roots are injected) so the full protocol can be exercised
 * in unit tests: start → issue batch → execute (simulated subagent calls)
 * → complete → finish, including every adversarial scenario.
 */
import { randomUUID } from "node:crypto";
import type { Roots } from "./state.js";
import {
	appendEvent,
	freshRunFromSpec,
	loadDefinition,
	loadRunAny,
	persistRun,
	saveDefinition,
} from "./state.js";
import { formatIssues, parseSpec } from "./spec.js";
import {
	checkFinish,
	computeBatch,
	completeNode,
	failNode,
	isReady,
	loopOwner,
	markExecuted,
	resolveCheckpoint,
	retryNode,
} from "./scheduler.js";
import {
	attributeInvocations,
	checkArtifacts,
	formatEvidence,
	type PendingPayload,
} from "./evidence.js";
import type {
	ReadyBatch,
	RunState,
	Scope,
	SubagentInvocation,
	TransitionResult,
} from "./types.js";

export interface StartOptions {
	spec?: string;
	specName?: string;
	resumeRunId?: string;
	scope?: Scope;
}

export interface StartResult {
	ok: boolean;
	error?: string;
	runId?: string;
	scope?: Scope;
	status?: string;
	batch?: ReadyBatch;
	resume?: boolean;
}

export interface CompleteResult extends TransitionResult {
	evidenceReport?: string;
	passed?: boolean;
	failReason?: string;
}

export class RunManager {
	constructor(private readonly roots: Roots) {}

	/* ------------------------------- start ------------------------------- */

	async start(opts: StartOptions): Promise<StartResult> {
		// resume path: replay persisted snapshot, recompute the ready batch
		if (opts.resumeRunId) {
			const found = await loadRunAny(this.roots, opts.resumeRunId);
			if (!found)
				return { ok: false, error: `run ${opts.resumeRunId} not found` };
			const run = found.run;
			if (run.status !== "running")
				return { ok: false, error: `run is ${run.status}, not resumable` };
			// B3: execution evidence (observed subagent calls) is session-local —
			// both "running" (executed here, never completed) and "ready" (issued
			// here, never executed) nodes must be reset to "queued" so the new
			// session re-issues their payloads. Otherwise they are unreachable:
			// dag_complete requires "running", but no new session can ever
			// attribute evidence to them.
			for (const n of Object.values(run.nodes)) {
				if (n.state === "running" || n.state === "ready") {
					n.state = "queued";
					n.issueTs = undefined;
					n.toolCallId = undefined;
					n.executedTs = undefined;
					n.issuedTask = undefined;
				}
			}
			const batch = computeBatch(run);
			await persistRun(this.roots, run);
			return {
				ok: true,
				runId: run.runId,
				scope: run.scope,
				status: run.status,
				batch,
				resume: true,
			};
		}

		let specText: string | undefined;
		let scope: Scope = opts.scope ?? "session";
		if (opts.specName) {
			const def = await loadDefinition(this.roots, opts.specName);
			if (!def)
				return {
					ok: false,
					error: `definition "${opts.specName}" not found (checked project and user scopes)`,
				};
			specText = def.text;
			scope = def.scope;
		} else if (opts.spec) {
			specText = opts.spec;
		} else {
			return {
				ok: false,
				error:
					"provide spec (inline), specName (3-scope lookup), or resumeRunId",
			};
		}

		const parsed = parseSpec(specText);
		if (!parsed.ok) {
			return {
				ok: false,
				error: `spec invalid:\n${formatIssues(parsed.issues)}`,
			};
		}

		const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
		const run = freshRunFromSpec(parsed.spec, runId, scope);
		await persistRun(this.roots, run);
		await appendEvent(this.roots, run, "start", {
			scope,
			spec: parsed.spec.name,
		});

		const batch = computeBatch(run);
		// P1b: an empty batch without notes leaves the AI guessing. Distinguish
		// "run already in flight" (continue with dag_complete/dag_retry) from
		// "everything settled" (finish or abort).
		if (batch.items.length === 0 && batch.notes.length === 0) {
			const inFlight = Object.entries(run.nodes)
				.filter(
					([, n]) =>
						n.state === "ready" ||
						n.state === "running" ||
						n.state === "awaiting_approval",
				)
				.map(([name]) => name);
			if (inFlight.length > 0) {
				batch.notes.push(
					`run already active — nodes in flight: ${inFlight.join(", ")}. Continue with dag_complete(runId, node) / dag_retry / /dag approve; dag_start only starts NEW runs.`,
				);
			} else {
				batch.notes.push(
					"no issuable nodes — all nodes passed or failed. Call dag_finish (if all required passed) or dag_abort.",
				);
			}
		}
		await persistRun(this.roots, run);
		return { ok: true, runId, scope, status: run.status, batch };
	}

	/* ------------------------------ evidence ----------------------------- */

	/**
	 * Feed captured subagent tool calls into the run: attribute to pending
	 * payloads (launch attestation), mark nodes running, and record subagent
	 * errors (isError → node failed, loop-aware).
	 * Returns attributions so the adapter can log evidence.
	 *
	 * H1: only invocations whose execution has FINISHED (tool_execution_end
	 * observed) are attributable — a call still running when dag_complete fires
	 * yields "no execution evidence", forcing the executor to wait for the
	 * subagent result before completing (never batch the two in one message).
	 */
	async ingestCalls(
		run: RunState,
		calls: SubagentInvocation[],
	): Promise<{ node: string; toolCallId: string }[]> {
		const pending: PendingPayload[] = [];
		for (const [name, n] of Object.entries(run.nodes)) {
			if (n.state !== "ready" || !n.issueTs) continue;
			const specN = run.spec.nodes[name]!;
			const isBody = run.loopBodies.includes(name);
			const task = n.issuedTask ?? specN.task!;
			if (isBody) {
				pending.push({
					node: name,
					agent: specN.agent!,
					task,
					issuedAt: n.issueTs,
				});
			} else if (!specN.checkpoint && !specN.loop) {
				pending.push({
					node: name,
					agent: specN.agent!,
					task,
					issuedAt: n.issueTs,
				});
			}
			// loop owners and checkpoints are never executed directly
		}

		const consumed = new Set<string>();
		// H1 defense-in-depth: only FINISHED executions are attributable, no
		// matter who calls ingestCalls (adapter or tests).
		const attributable = calls.filter((c) => c.finished);
		const attributions = attributeInvocations(pending, attributable, consumed);
		const out: { node: string; toolCallId: string }[] = [];
		for (const a of attributions) {
			// executedTs = the call's OBSERVED launch time (tool_execution_start),
			// not the drain time — a node launched long ago but attributed late
			// must still count as stalled (stall nudge correctness).
			markExecuted(run, a.node, a.invocation.toolCallId, a.invocation.ts);
			await appendEvent(this.roots, run, "executed", {
				node: a.node,
				toolCallId: a.invocation.toolCallId,
				agent: a.invocation.agent,
			});
			out.push({ node: a.node, toolCallId: a.invocation.toolCallId });
			if (a.invocation.isError) {
				failNode(
					run,
					a.node,
					`subagent call errored (${a.invocation.runId ?? a.invocation.toolCallId})`,
				);
				await appendEvent(this.roots, run, "failed", {
					node: a.node,
					reason: "subagent error",
				});
			}
		}
		await persistRun(this.roots, run);
		return out;
	}

	/* ------------------------------ complete ----------------------------- */

	async complete(
		run: RunState,
		node: string,
		artifactRoot: string,
	): Promise<CompleteResult> {
		const n = run.nodes[node];
		if (!n) return this.transitionError(run, `unknown node "${node}"`);
		if (run.status !== "running")
			return this.transitionError(
				run,
				`run is ${run.status} — no transitions allowed`,
			);
		if (n.state === "passed")
			return this.transitionError(run, `node "${node}" already passed`);
		if (n.state === "failed") {
			return this.transitionError(
				run,
				`node "${node}" is failed — use dag_retry (${n.failReason ?? ""})`,
			);
		}
		if (n.state !== "running") {
			return this.transitionError(
				run,
				`node "${node}" has no execution evidence (state ${n.state}). Protocol: call subagent with the issued payload first and WAIT for its result, then dag_complete — do not batch dag_complete with subagent in the same message.`,
			);
		}

		// artifact gates (CI evidence)
		const specNode = run.spec.nodes[node]!;
		const art = await checkArtifacts(artifactRoot, specNode, n.issueTs ?? 0);
		const evidenceReport = art.evidence.length
			? formatEvidence(art.evidence)
			: "(no declared produces)";

		if (!art.ok) {
			failNode(
				run,
				node,
				`artifact gates failed:\n${formatEvidence(art.evidence)}`,
			);
			await appendEvent(this.roots, run, "failed", {
				node,
				reason: "artifact gates",
			});
			await persistRun(this.roots, run);
			// recompute: loop bodies get re-issued; dependents get blocked
			const batch = computeBatch(run);
			await persistRun(this.roots, run);
			return {
				ok: false,
				error: `artifact evidence failed for "${node}":\n${evidenceReport}`,
				evidenceReport,
				passed: false,
				failReason: n.failReason,
				batch,
				run,
			};
		}

		const res = completeNode(run, node, { artifactHashes: art.hashes });
		if (!res.ok) return this.transitionError(run, res.error!);

		// loop handling: a passing body passes its loop owner — but only if the
		// owner's dependencies are STILL satisfied (B1: a dep failing mid-loop
		// must not let the loop pass).
		const owner = loopOwner(run, node);
		if (owner) {
			const o = run.nodes[owner];
			if (o) {
				if (isReady(run, owner)) {
					o.state = "passed";
					o.passedAt = Date.now();
					o.iteration = run.nodes[node]!.attempts;
				} else {
					o.state = "failed";
					o.failReason = `loop "${owner}" dependencies no longer satisfied`;
				}
			}
		}

		await appendEvent(this.roots, run, "passed", {
			node,
			artifacts: art.hashes,
		});
		await persistRun(this.roots, run);
		const batch = computeBatch(run);
		await persistRun(this.roots, run);
		return { ok: true, evidenceReport, passed: true, batch, run };
	}

	/* ------------------------------- fail -------------------------------- */

	async fail(
		run: RunState,
		node: string,
		reason: string,
	): Promise<TransitionResult> {
		const n = run.nodes[node];
		if (!n) return this.transitionError(run, `unknown node "${node}"`);
		if (run.status !== "running")
			return this.transitionError(
				run,
				`run is ${run.status} — no transitions allowed`,
			);
		if (n.state !== "running" && n.state !== "ready") {
			return this.transitionError(
				run,
				`node "${node}" is ${n.state}; only running/ready nodes can be failed`,
			);
		}
		failNode(run, node, reason);
		await appendEvent(this.roots, run, "failed", { node, reason });
		await persistRun(this.roots, run);
		const batch = computeBatch(run);
		await persistRun(this.roots, run);
		return { ok: true, batch, run };
	}

	/* ------------------------------- retry ------------------------------- */

	async retry(run: RunState, node: string): Promise<TransitionResult> {
		if (run.status !== "running")
			return this.transitionError(
				run,
				`run is ${run.status} — no transitions allowed`,
			);
		const res = retryNode(run, node);
		if (!res.ok) return this.transitionError(run, res.error!);
		await appendEvent(this.roots, run, "retry", { node });
		await persistRun(this.roots, run);
		const batch = computeBatch(run);
		await persistRun(this.roots, run);
		return { ok: true, batch, run };
	}

	/* ----------------------------- checkpoint ---------------------------- */

	async resolveCheckpoint(
		run: RunState,
		node: string,
		approved: boolean,
		reason?: string,
	): Promise<TransitionResult> {
		if (run.status !== "running")
			return this.transitionError(
				run,
				`run is ${run.status} — no transitions allowed`,
			);
		const res = resolveCheckpoint(run, node, approved, reason);
		if (!res.ok) return this.transitionError(run, res.error!);
		await appendEvent(this.roots, run, approved ? "approved" : "rejected", {
			node,
			reason,
		});
		await persistRun(this.roots, run);
		const batch = computeBatch(run);
		await persistRun(this.roots, run);
		return { ok: true, batch, run };
	}

	/* ------------------------------- finish ------------------------------ */

	async finish(run: RunState): Promise<{
		ok: boolean;
		error?: string;
		report?: string[];
		run: RunState;
	}> {
		const { ok, report } = checkFinish(run);
		if (!ok) {
			return {
				ok: false,
				error: `workflow incomplete:\n${report.join("\n")}`,
				report,
				run,
			};
		}
		run.status = "completed";
		run.completedAt = Date.now();
		await appendEvent(this.roots, run, "finish", { report });
		await persistRun(this.roots, run);
		return { ok: true, report, run };
	}

	async abort(
		run: RunState,
		reason: string,
	): Promise<{ ok: boolean; error?: string; run: RunState }> {
		if (run.status !== "running") {
			return { ok: false, error: `run is ${run.status}, not aborted`, run };
		}
		run.status = "aborted";
		run.failReason = reason;
		await appendEvent(this.roots, run, "abort", { reason });
		await persistRun(this.roots, run);
		return { ok: true, run };
	}

	/* ------------------------------ helpers ------------------------------ */

	private transitionError(run: RunState, error: string): TransitionResult {
		return { ok: false, error, batch: { items: [], notes: [] }, run };
	}

	/* ------------------------------ definitions -------------------------- */

	async saveSpec(
		scope: "project" | "user",
		name: string,
		specText: string,
	): Promise<{ ok: boolean; error?: string; file?: string }> {
		try {
			const file = await saveDefinition(this.roots, scope, name, specText);
			return { ok: true, file };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	}

	/** Validate a spec string without starting a run (AI-friendly checker). */
	validate(specText: string): { ok: boolean; issues: string[] } {
		const parsed = parseSpec(specText);
		if (!parsed.ok)
			return {
				ok: false,
				issues: parsed.issues.map((i) => `${i.path}: ${i.message}`),
			};
		return { ok: true, issues: [] };
	}
}
