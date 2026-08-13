/**
 * scheduler.ts — the workflow state machine.
 *
 * Pure logic, no I/O. The scheduler owns:
 *   - node lifecycle transitions (queued→ready→running→passed|failed|blocked)
 *   - ready-set computation (dependencies satisfied ⇒ issued to executor)
 *   - verifier fan-in ({artifacts} injection from dependency products)
 *   - loop nodes (re-execute body until passed, hard maxIterations cap)
 *   - checkpoint nodes (awaiting_approval, resolved by the human)
 *   - policy gates (failFast, maxAgents)
 *
 * Evidence is NOT computed here; the caller runs evidence gates and then
 * calls completeNode()/failNode(). The scheduler is the source of truth for
 * *what may happen next* — the "卡死机制": a node that never got execution
 * evidence can never transition to passed, so the workflow cannot advance.
 */
import { defaultPolicy, isVerifier } from "./spec.js";
import type {
	RunState,
	NodeRun,
	ReadyBatch,
	BatchItem,
	Spec,
	NodeSpec,
	Scope,
} from "./types.js";

const DEFAULT_MAX_ITERATIONS = 3;

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

export function createRun(
	spec: Spec,
	runId: string,
	scope: Scope,
	now = Date.now(),
): RunState {
	const loopBodies: string[] = [];
	const nodes: Record<string, NodeRun> = {};
	for (const name of Object.keys(spec.nodes)) {
		const n = spec.nodes[name]!;
		nodes[name] = {
			node: name,
			state: "queued",
			attempts: 0,
		};
		if (n.loop) loopBodies.push(n.loop.body);
	}
	return {
		runId,
		scope,
		status: "running",
		spec,
		nodes,
		loopBodies,
		createdAt: now,
		issuedCount: 0,
		executedCount: 0,
	};
}

/* ------------------------------------------------------------------ */
/* Dependency / readiness helpers                                      */
/* ------------------------------------------------------------------ */

function depsOf(spec: Spec, node: string): string[] {
	return spec.nodes[node]?.needs ?? [];
}

function isDepSatisfied(run: RunState, dep: string): boolean {
	const d = run.nodes[dep];
	if (!d) return false;
	if (d.state === "passed") return true;
	// continueOnError failures are "satisfied enough" (dependent becomes ready)
	if (d.state === "failed" && run.spec.nodes[dep]?.continueOnError) return true;
	return false;
}

export function isReady(run: RunState, node: string): boolean {
	return depsOf(run.spec, node).every((d) => isDepSatisfied(run, d));
}

/** Nodes that still must pass for the workflow to complete (finish set). */
export function requiredNodes(run: RunState): string[] {
	const spec = run.spec;
	const names = Object.keys(spec.nodes);
	const bodies = new Set(run.loopBodies);
	// I1: the DEFAULT finish set must exclude continueOnError leaves — otherwise
	// a soft node that legitimately failed becomes implicitly required and the
	// workflow can never complete. An EXPLICIT `finish` list still overrides
	// (M2: listed continueOnError nodes are then required by contract).
	const finish = spec.finish?.length
		? spec.finish
		: names.filter((n) => {
				if (bodies.has(n)) return false;
				if (spec.nodes[n]?.continueOnError) return false;
				return !Object.values(spec.nodes).some((on) => on.needs?.includes(n));
			});
	return finish;
}

/* ------------------------------------------------------------------ */
/* Batch computation (the "唤起" step: payloads are issued verbatim)    */
/* ------------------------------------------------------------------ */

function nodePayload(
	run: RunState,
	name: string,
	isLoopBody: boolean,
): BatchItem | null {
	const spec = run.spec;
	const n = spec.nodes[name]!;

	// loop body: executed under the loop node's semantics
	if (isLoopBody) {
		const owner = Object.entries(spec.nodes).find(
			([, on]) => on.loop?.body === name,
		)?.[0];
		if (!owner) return null;
		const ownerNode = spec.nodes[owner]!;
		const body = n as NodeSpec;
		return {
			node: name,
			agent: body.agent!,
			task: body.task!,
			role: body.role === "verifier" ? "verifier" : "worker",
			produces: body.produces ?? [],
			loop: {
				body: name,
				maxIterations: ownerNode.loop!.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			},
		};
	}

	// checkpoint: nothing to execute
	if (n.checkpoint) return null;

	let task = n.task!;
	let depArtifacts: string | undefined;
	if (isVerifier(n)) {
		const refs: string[] = [];
		for (const dep of depsOf(spec, name)) {
			const depRun = run.nodes[dep];
			const hashes = depRun?.artifactHashes ?? {};
			for (const a of spec.nodes[dep]?.produces ?? []) {
				refs.push(
					`${dep}:${a.path}${hashes[a.path] ? ` (sha256:${hashes[a.path]})` : ""}`,
				);
			}
		}
		if (refs.length > 0) {
			depArtifacts = `\n\nDependency artifacts (paths + hashes, verified):\n${refs.map((r) => `  - ${r}`).join("\n")}`;
		}
		task = task.replace(/\{artifacts\}/g, depArtifacts ?? "");
	} else {
		task = task.replace(/\{artifacts\}/g, "");
	}

	return {
		node: name,
		agent: n.agent!,
		task,
		role: isVerifier(n) ? "verifier" : "worker",
		depArtifacts,
		produces: n.produces ?? [],
	};
}

/**
 * Compute the next ready batch among nodes currently queued.
 * Respects failFast (no new work after a failed node) and maxAgents.
 */
export function computeBatch(run: RunState): ReadyBatch {
	const policy = defaultPolicy(run.spec);
	const notes: string[] = [];

	if (run.status !== "running") return { items: [], notes };

	// failFast: if any required node failed (not continueOnError), freeze.
	if (policy.failFast) {
		const failed = Object.entries(run.nodes).find(
			([name, n]) =>
				n.state === "failed" && !run.spec.nodes[name]?.continueOnError,
		);
		if (failed) {
			notes.push(
				`failFast: node "${failed[0]}" failed — no new nodes issued. dag_retry or dag_abort.`,
			);
			return { items: [], notes };
		}
	}

	const items: BatchItem[] = [];
	const bodies = new Set(run.loopBodies);
	for (const name of Object.keys(run.spec.nodes)) {
		const specN = run.spec.nodes[name]!;
		const n = run.nodes[name]!;
		if (n.state !== "queued" && n.state !== "ready") continue;
		// B2: a node already issued stays issued — never re-issue (loop bodies included)
		if (n.state === "ready") continue;
		// loop OWNERS are never issued for execution; the body executes on their behalf
		if (specN.loop && !bodies.has(name)) continue;
		// B1: a loop body's readiness is governed by its OWNER's dependencies —
		// the body's own needs are empty by validation (they belong to the owner).
		const ready = bodies.has(name)
			? isReady(run, loopOwner(run, name)!)
			: isReady(run, name);
		if (!ready) continue;

		// maxAgents gate: each issued node will consume one subagent execution.
		if (run.issuedCount >= policy.maxAgents) {
			notes.push(
				`maxAgents(${policy.maxAgents}) reached — further nodes blocked. dag_abort or raise policy in a new run.`,
			);
			continue;
		}

		const isBody = bodies.has(name);
		const payload = nodePayload(run, name, isBody);
		if (payload) {
			n.state = "ready";
			n.issueTs = Date.now();
			n.issuedTask = payload.task;
			run.issuedCount += 1;
			items.push(payload);
		} else if (run.spec.nodes[name]?.checkpoint) {
			// checkpoint with satisfied deps → human gate (or unattended
			// auto-approve if the spec opted in with autoAfterSec)
			const cp = run.spec.nodes[name]!.checkpoint;
			const autoAfterSec = typeof cp === "object" ? cp.autoAfterSec : undefined;
			n.state = "awaiting_approval";
			n.waitingSince = Date.now();
			notes.push(
				`checkpoint "${name}" reached — run /dag approve ${run.runId} ${name}${autoAfterSec ? ` (auto-approves after ${autoAfterSec}s unattended — poll with dag_start({resumeRunId:"${run.runId}"}) or /dag status)` : ""}`,
			);
		}
	}
	return { items, notes };
}

/** Record that the executor has launched a node (call this on captured execution). */
export function markExecuted(
	run: RunState,
	node: string,
	toolCallId: string,
	now = Date.now(),
): void {
	const n = run.nodes[node];
	if (!n) return;
	n.state = "running";
	n.toolCallId = toolCallId;
	n.executedTs = now;
	n.attempts += 1;
	run.executedCount += 1;
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

export function completeNode(
	run: RunState,
	node: string,
	opts: { artifactHashes?: Record<string, string>; now?: number },
): { ok: boolean; error?: string } {
	const n = run.nodes[node];
	if (!n) return { ok: false, error: `unknown node "${node}"` };
	if (n.state === "passed")
		return { ok: false, error: `node "${node}" already passed` };
	if (n.state === "failed") {
		return {
			ok: false,
			error: `node "${node}" is failed — use dag_retry before completing`,
		};
	}
	if (n.state !== "running") {
		return {
			ok: false,
			error: `node "${node}" has no execution evidence (state ${n.state}). Call subagent with the issued payload first, then dag_complete.`,
		};
	}

	n.state = "passed";
	n.passedAt = opts.now ?? Date.now();
	n.artifactHashes = opts.artifactHashes ?? {};
	n.failReason = undefined;
	return { ok: true };
}

/** Fail a node (evidence gate failure or subagent error). Handles loop iteration. */
export function failNode(run: RunState, node: string, reason: string): void {
	const n = run.nodes[node];
	if (!n) return;
	const owner = loopOwner(run, node);
	if (owner) {
		const ownerRun = run.nodes[owner];
		if (!ownerRun) return;
		const max =
			run.spec.nodes[owner]!.loop!.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		// iteration = attempts consumed so far; the max-th failed attempt exhausts the loop
		const iter = (ownerRun.iteration ?? 0) + 1;
		ownerRun.iteration = iter;
		n.failReason = reason;
		n.artifactHashes = undefined;
		if (iter >= max) {
			n.state = "failed";
			ownerRun.state = "failed";
			ownerRun.failReason = `loop "${owner}" exhausted ${max} iterations: ${reason}`;
		} else {
			// re-issue body for the next iteration
			n.state = "queued";
			n.issueTs = undefined;
			n.toolCallId = undefined;
			n.executedTs = undefined;
			ownerRun.state = "ready";
			run.nodes[owner]!.failReason = undefined;
		}
		return;
	}

	n.state = "failed";
	n.failReason = reason;

	// mark dependents blocked (unless their dep is continueOnError — scheduler
	// treats it as satisfied, so only hard failures block)
	for (const [name, on] of Object.entries(run.spec.nodes)) {
		if (on.needs?.includes(node) && run.nodes[name]!.state === "queued") {
			const depFailed = on.needs.some(
				(d) =>
					run.nodes[d]?.state === "failed" &&
					!run.spec.nodes[d]?.continueOnError,
			);
			if (depFailed) run.nodes[name]!.state = "blocked";
		}
	}
}

/** Re-run a failed (or loop-exhausted) node. */
export function retryNode(
	run: RunState,
	node: string,
): { ok: boolean; error?: string } {
	const n = run.nodes[node];
	if (!n) return { ok: false, error: `unknown node "${node}"` };
	if (n.state !== "failed") {
		return {
			ok: false,
			error: `node "${node}" is not failed (state ${n.state}); only failed nodes can be retried`,
		};
	}
	n.state = "queued";
	n.failReason = undefined;
	n.toolCallId = undefined;
	n.executedTs = undefined;
	n.artifactHashes = undefined;
	if (run.spec.nodes[node]?.loop) {
		n.iteration = 0;
		// re-arm the loop body: it was failed too and must be re-issued
		const body = run.spec.nodes[node]!.loop!.body;
		const bodyRun = run.nodes[body];
		if (bodyRun) {
			bodyRun.state = "queued";
			bodyRun.failReason = undefined;
			bodyRun.toolCallId = undefined;
			bodyRun.executedTs = undefined;
			bodyRun.artifactHashes = undefined;
		}
	}
	// unblock dependents
	for (const [name, on] of Object.entries(run.spec.nodes)) {
		if (on.needs?.includes(node) && run.nodes[name]!.state === "blocked") {
			run.nodes[name]!.state = "queued";
		}
	}
	return { ok: true };
}

/** Resolve a checkpoint node (human-only path). */
export function resolveCheckpoint(
	run: RunState,
	node: string,
	approved: boolean,
	reason?: string,
): { ok: boolean; error?: string } {
	const n = run.nodes[node];
	if (!n) return { ok: false, error: `unknown node "${node}"` };
	if (!run.spec.nodes[node]?.checkpoint) {
		return { ok: false, error: `node "${node}" is not a checkpoint` };
	}
	if (n.state !== "awaiting_approval") {
		return {
			ok: false,
			error: `checkpoint "${node}" is not awaiting approval (state ${n.state})`,
		};
	}
	if (approved) {
		n.state = "passed";
		n.passedAt = Date.now();
		n.waitingSince = undefined;
	} else {
		n.state = "failed";
		n.failReason = reason ?? "rejected by human";
		n.waitingSince = undefined;
		n.state = "failed";
		n.failReason = reason ?? "rejected by human";
		// M1: a rejected continueOnError checkpoint is "satisfied enough" —
		// dependents stay queued, mirroring failNode semantics.
		if (!run.spec.nodes[node]?.continueOnError) {
			for (const [name, on] of Object.entries(run.spec.nodes)) {
				if (on.needs?.includes(node) && run.nodes[name]!.state === "queued")
					run.nodes[name]!.state = "blocked";
			}
		}
	}
	return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Unattended checkpoint auto-approve (lazy sweep)                      */
/* ------------------------------------------------------------------ */

/**
 * Mechanically pass awaiting_approval checkpoints whose spec opted into
 * `checkpoint: { autoAfterSec }` and whose wait exceeds the timeout.
 * PURE and read-only on state except the approvals themselves — no I/O,
 * no timers; the adapter sweeps on any dag tool call / resume / /dag status.
 * The AI cannot accelerate this: only wall-clock time can.
 */
export function expireCheckpoints(run: RunState, now = Date.now()): string[] {
	const expired: string[] = [];
	if (run.status !== "running") return expired;
	for (const [name, n] of Object.entries(run.nodes)) {
		if (n.state !== "awaiting_approval") continue;
		const cp = run.spec.nodes[name]?.checkpoint;
		if (typeof cp !== "object") continue; // human-only gate
		const since = n.waitingSince;
		if (since === undefined) continue;
		if (now - since >= cp.autoAfterSec * 1000) {
			n.state = "passed";
			n.passedAt = now;
			n.autoApproved = true;
			n.waitingSince = undefined;
			expired.push(name);
		}
	}
	return expired;
}

/* ------------------------------------------------------------------ */
/* Finish / abort                                                      */
/* ------------------------------------------------------------------ */

export function checkFinish(run: RunState): { ok: boolean; report: string[] } {
	const report: string[] = [];
	const required = requiredNodes(run);
	const requiredSet = new Set(required);
	let ok = true;
	for (const name of Object.keys(run.spec.nodes)) {
		const n = run.nodes[name]!;
		const specN = run.spec.nodes[name]!;
		// M2: an explicitly-listed finish node is required even with continueOnError
		const isRequired = requiredSet.has(name) || !specN.continueOnError;
		if (n.state === "passed") {
			report.push(
				`  ✓ ${name}${n.autoApproved ? " (auto-approved, unattended)" : ""}`,
			);
			continue;
		}
		if (
			n.state === "failed" &&
			specN.continueOnError &&
			!requiredSet.has(name)
		) {
			// "never executed" = dag_fail declared on a ready node without any
			// observed subagent call (the only way finish can succeed with an
			// un-run node) — surface it so the human sees the skip.
			report.push(
				`  ⚠ ${name} (failed, continueOnError${n.toolCallId ? "" : " — never executed"})`,
			);
			continue;
		}
		if (!isRequired && (n.state === "failed" || n.state === "blocked")) {
			report.push(`  ⚠ ${name} (${n.state}, not required)`);
			continue;
		}
		ok = false;
		report.push(
			`  ✗ ${name} (${n.state}${n.failReason ? ` — ${n.failReason}` : ""})`,
		);
	}
	return { ok, report };
}

export function loopOwner(run: RunState, body: string): string | undefined {
	for (const [name, n] of Object.entries(run.spec.nodes)) {
		if (n.loop?.body === body) return name;
	}
	return undefined;
}

/* ------------------------------------------------------------------ */
/* Liveness observation (stall nudge)                                  */
/* ------------------------------------------------------------------ */

export interface StalledNode {
	node: string;
	state: "ready" | "running";
	/** seconds since issue (ready) or observed execution (running). */
	seconds: number;
}

/**
 * Read-only liveness check: nodes that have been issued but never launched
 * (ready) or executed but never completed (running) for longer than
 * `stallAfterMs`. This is a NUDGE, not enforcement — stalled nodes never
 * expire or auto-fail; they stay recoverable indefinitely (the issued
 * payload remains valid, and a running node only needs dag_complete).
 * awaiting_approval is a human gate and is never "stalled"; loop owners
 * carry no issueTs and are skipped (their body is the actionable node).
 */
export function stalledNodes(
	run: RunState,
	now = Date.now(),
	stallAfterMs: number,
): StalledNode[] {
	const out: StalledNode[] = [];
	if (run.status !== "running") return out;
	for (const [name, n] of Object.entries(run.nodes)) {
		if (n.state !== "ready" && n.state !== "running") continue;
		const since = n.state === "ready" ? n.issueTs : n.executedTs;
		if (since === undefined) continue;
		const age = now - since;
		if (age >= stallAfterMs) {
			out.push({
				node: name,
				state: n.state,
				seconds: Math.round(age / 1000),
			});
		}
	}
	return out;
}
