/**
 * pi-dag-core — core type definitions.
 *
 * The core is deliberately pi-runtime-free: everything in src/ (except index.ts)
 * is pure TypeScript so the state machine, scheduler, evidence gates and state
 * persistence can be unit-tested without a running pi session.
 */

/** Scope of a workflow definition / run. */
export type Scope = "session" | "project" | "user";

/** Static node states (CI-style, not "done/not done"). */
export type NodeState =
	| "queued" // waiting on dependencies
	| "ready" // issued to the executor (payload handed to AI)
	| "running" // a matching subagent execution was observed
	| "passed" // all evidence gates passed
	| "failed" // a gate failed or execution errored
	| "blocked" // a non-continueOnError dependency failed
	| "awaiting_approval"; // checkpoint node, human gate

/** Run-level status. */
export type RunStatus = "running" | "completed" | "aborted" | "degraded";

/** Artifact checks: "exists" | "nonEmpty" | "json" | "grep:<re>" (sha256 is recorded, not checked). */
export type Check = "exists" | "nonEmpty" | "json" | `grep:${string}`;

export interface ArtifactSpec {
	/** Path relative to ctx.cwd (project scope) or the workflow root. */
	path: string;
	check?: Check;
}

export interface LoopSpec {
	/** Body node name. The body node is executed repeatedly until it passes. */
	body: string;
	/** v0 supports only "passed" (evidence-gated). Free-text LLM conditions are v1. */
	until?: "passed";
	/** Hard cap enforced by the state machine. Default 3. */
	maxIterations?: number;
}

export interface NodeSpec {
	/** Agent used for the subagent call. Required unless checkpoint: true. */
	agent?: string;
	/** Exact task text handed to subagent. Required unless checkpoint: true. */
	task?: string;
	/** Dependency node names. */
	needs?: string[];
	/** verifier nodes automatically receive dependency artifacts via {artifacts}. */
	role?: "worker" | "verifier";
	/** Declared products — CI evidence: exists / nonEmpty / grep / json. */
	produces?: ArtifactSpec[];
	/** v2: gate command executed by the subagent, verified via transcript scan. */
	gate?: { command: string; expectExit?: number };
	/**
	 * Human gate: no agent/task/produces; resolves via /dag approve|reject.
	 * `{ autoAfterSec }` opts the gate into unattended operation: it
	 * auto-passes mechanically once awaiting longer than the timeout
	 * (swept on any dag tool call / resume / /dag status). Default `true` =
	 * human-only forever.
	 */
	checkpoint?: boolean | { autoAfterSec: number };
	/** Loop wrapper: re-executes body until passed or maxIterations. */
	loop?: LoopSpec;
	/** A failed node with continueOnError does not block its dependents. */
	continueOnError?: boolean;
}

export interface Policy {
	/** Stop issuing new batches after the first failed node. Default true. */
	failFast?: boolean;
	/** Hard cap on subagent executions per run. Default 20. */
	maxAgents?: number;
	/**
	 * Stall nudge threshold (seconds): a node issued-but-not-launched (ready)
	 * or executed-but-not-completed (running) older than this triggers a
	 * read-only reminder in dag tool results and /dag status. Default 600.
	 * The nudge never fails or retries anything — stalled nodes stay
	 * recoverable indefinitely.
	 */
	stallAfterSec?: number;
}

export interface Spec {
	name: string;
	version?: number;
	policy?: Policy;
	nodes: Record<string, NodeSpec>;
	/** Explicit terminal gates; default = nodes with no dependents. */
	finish?: string[];
}

export interface ValidationIssue {
	path: string;
	message: string;
}

export interface ValidationResult {
	ok: boolean;
	issues: ValidationIssue[];
}

/** One subagent invocation extracted from a subagent tool call. */
export interface SubagentInvocation {
	toolCallId: string;
	ts: number;
	agent: string;
	task: string;
	isError: boolean;
	/** false until tool_execution_end is observed (H1). */
	finished: boolean;
	runId?: string;
}

export interface ArtifactEvidence {
	path: string;
	check: Check | undefined;
	exists: boolean;
	nonEmpty: boolean;
	mtimeAfterIssue: boolean;
	sha256?: string;
	grepMatch?: boolean;
	jsonOk?: boolean;
	detail?: string;
}

export interface NodeRun {
	node: string;
	state: NodeState;
	/** Set when the node was issued (payload handed to the executor). */
	issueTs?: number;
	/** The exact task text issued (after {artifacts} injection) — evidence matching base. */
	issuedTask?: string;
	/** Set when a matching subagent execution was captured. */
	executedTs?: number;
	/** toolCallId of the attributed subagent call. */
	toolCallId?: string;
	/** For loop nodes: current iteration (1-based), and whether body passed. */
	iteration?: number;
	/** Set when the node entered awaiting_approval (auto-approve clock). */
	waitingSince?: number;
	/** True when a checkpoint passed via unattended auto-approve timeout. */
	autoApproved?: boolean;
	/** Artifact hashes at pass time. */
	artifactHashes?: Record<string, string>;
	failReason?: string;
	attempts: number;
	passedAt?: number;
}

export interface RunState {
	runId: string;
	scope: Scope;
	status: RunStatus;
	spec: Spec;
	nodes: Record<string, NodeRun>;
	/** nodes referenced as loop bodies (internal, excluded from finish). */
	loopBodies: string[];
	createdAt: number;
	/** monotonic issue counter used to disambiguate identical payloads. */
	issuedCount: number;
	/** subagent executions attributed so far (maxAgents gate). */
	executedCount: number;
	failReason?: string;
	completedAt?: number;
}

export interface BatchItem {
	node: string;
	agent: string;
	task: string;
	role: "worker" | "verifier";
	/** Payload injected for verifier fan-in. */
	depArtifacts?: string;
	produces: ArtifactSpec[];
	loop?: { body: string; maxIterations: number };
}

export interface ReadyBatch {
	items: BatchItem[];
	/** Nodes that became blocked or failed as a side effect of this transition. */
	notes: string[];
}

export interface TransitionResult {
	ok: boolean;
	error?: string;
	batch: ReadyBatch;
	run: RunState;
}
