/**
 * index.ts — pi adapter for pi-dag-core.
 *
 * This is the ONLY file that touches the pi runtime. Everything else in src/
 * is pure and unit-tested. The adapter owns:
 *   - tool registration (dag_start/complete/fail/retry/finish/abort)
 *   - command registration (/dag …) — human gates live here on purpose:
 *     commands are not callable by the AI, so checkpoint approval is
 *     structurally human-only
 *   - read-only event subscriptions (tool_call / tool_result capture)
 *   - prompt footprint: one-line snippets + protocol guidelines only
 *
 * Contract (four quadrants):
 *   read  — session records, event stream, spec/artifact files
 *   write — workflow definitions + run state ONLY (via state.ts whitelist)
 *   inject— tool-usage guidelines only
 *   block — never (no interception, no mutation, no result rewriting)
 */
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RunManager } from "./core.js";
import { normalizeInvocations } from "./evidence.js";
import {
	defaultRoots,
	listDefinitions,
	listRuns,
	loadRunAny,
	type Roots,
} from "./state.js";
import { renderMermaid, renderText } from "./viz.js";
import type { ReadyBatch, RunState } from "./types.js";

const SUBAGENT_TOOL = "subagent";
const MAX_BUFFER = 200;

/** A captured subagent tool call, kept in memory until attributed. */
interface CapturedCall {
	toolCallId: string;
	ts: number;
	input: Record<string, unknown>;
	isError: boolean;
	/** false until tool_execution_end is observed (H1). */
	finished: boolean;
}

/** Batch → human-readable payload block the AI must execute verbatim. */
function renderBatch(batch: ReadyBatch): string {
	if (batch.items.length === 0) return "(no ready nodes)";
	// NOTE: `task` ALREADY carries the {artifacts} fan-in injection (done in
	// nodePayload at issue time) — do NOT append depArtifacts again, or the
	// rendered payload won't match the issuedTask and attribution fails.
	const lines = batch.items.map(
		(it) => `- node: ${it.node}\n  agent: ${it.agent}\n  task: ${it.task}`,
	);
	return lines.join("\n\n");
}

const PROTOCOL =
	"Protocol: execute the batch items above by calling subagent with the EXACT agent and task (no edits), then report each with dag_complete. Never mark a node passed by other means.";

export default function dagCoreExtension(pi: ExtensionAPI) {
	let roots: Roots;
	let manager: RunManager;
	/** In-memory captured subagent calls (read-only observation). */
	let buffer: CapturedCall[] = [];
	/** Inline spec from the most recent dag_start (for /dag save). */
	let lastInlineSpec: string | undefined;

	function requireRoots() {
		// roots are set at session_start; defensive fallback
		if (!manager) throw new Error("dag-core: session not initialized");
	}

	pi.on("session_start", async (_event, ctx) => {
		roots = defaultRoots(ctx.cwd, ctx.sessionManager.getSessionId());
		manager = new RunManager(roots);
		buffer = [];
		// H2: the subagent tool is NOT built into pi — it comes from the
		// pi-subagents extension (or an equivalent). Probe and warn loudly:
		// without it, no execution evidence is ever observed and every
		// dag_complete is rejected.
		try {
			const tools = pi.getAllTools();
			const hasSubagent = tools.some((t) => t.name === SUBAGENT_TOOL);
			if (!hasSubagent) {
				ctx.ui.notify(
					`dag-core: the "${SUBAGENT_TOOL}" tool is not registered — install pi-subagents (or an equivalent providing it) or workflows cannot execute.`,
					"error",
				);
			}
		} catch {
			// probe is best-effort
		}
		// warm run index so /dag status lists recoverable runs immediately
		await listRuns(roots);
	});

	pi.on("session_shutdown", async () => {
		buffer = [];
	});

	// Trigger mechanism: ship the dag-workflow SKILL with the extension so the
	// model has a WHEN-to-use reference it can self-activate from (the skill
	// description is the trigger surface; the 5 protocol guidelines cover HOW).
	pi.on("resources_discover", async () => {
		return {
			skillPaths: [fileURLToPath(new URL("../skills", import.meta.url))],
		};
	});

	/* ------------------------------------------------------------------ */
	/* Read-only event capture                                             */
	/* ------------------------------------------------------------------ */

	// Attribution source: tool_execution_start fires during the PREFLIGHT phase
	// in assistant source order, BEFORE any tool in the batch executes. This
	// closes the parallel-batching race (subagent + dag_complete in one message:
	// dag_complete would otherwise drain an empty buffer).
	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== SUBAGENT_TOOL) return;
		try {
			buffer.push({
				toolCallId: event.toolCallId,
				ts: Date.now(),
				input: structuredClone(event.args ?? {}),
				isError: false,
				finished: false,
			});
			if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
		} catch {
			// observation is best-effort; never affects the call
		}
	});

	// H1: the exit-code ring of the evidence chain. tool_execution_end fires
	// AFTER the tool completes (completion order) and carries isError. A call
	// without its execution_end is "not finished" and cannot be attributed —
	// dag_complete against it rejects with "no execution evidence".
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== SUBAGENT_TOOL) return;
		const c = buffer.find((b) => b.toolCallId === event.toolCallId);
		if (c) {
			c.isError = event.isError === true;
			c.finished = true;
		}
	});

	/* ------------------------------------------------------------------ */
	/* Shared helpers                                                      */
	/* ------------------------------------------------------------------ */

	async function loadRun(runId: string): Promise<RunState | { error: string }> {
		const found = await loadRunAny(roots, runId);
		if (!found) return { error: `run ${runId} not found` };
		return found.run;
	}

	async function ingestAndDrain(
		run: RunState,
	): Promise<{ node: string; toolCallId: string }[]> {
		if (buffer.length === 0) return [];
		// H1: only drain entries whose execution has ENDED; a still-running
		// subagent call stays buffered so the next dag_complete can attribute it.
		const finished = buffer.filter((b) => b.finished);
		buffer = buffer.filter((b) => !b.finished);
		const invocations = finished.flatMap((c) =>
			normalizeInvocations({
				toolCallId: c.toolCallId,
				ts: c.ts,
				input: c.input,
				isError: c.isError,
				finished: true,
			}),
		);
		return manager.ingestCalls(run, invocations);
	}

	function ok(text: string, details: Record<string, unknown> = {}) {
		return { content: [{ type: "text" as const, text }], details };
	}

	/* ------------------------------------------------------------------ */
	/* M7: serialize state-mutating tool executions. pi runs sibling tool   */
	/* calls concurrently; two dag_complete in one message would otherwise  */
	/* each load the snapshot, mutate, and persist — last write wins, one   */
	/* completion lost. The queue makes load→mutate→persist atomic.         */
	/* ------------------------------------------------------------------ */

	let mutex: Promise<unknown> = Promise.resolve();
	function serial<T>(work: () => Promise<T>): Promise<T> {
		const run = mutex.then(work, work);
		mutex = run.catch(() => {});
		return run;
	}

	/* ------------------------------------------------------------------ */
	/* Tools                                                               */
	/* ------------------------------------------------------------------ */
	pi.registerTool({
		name: "dag_start",
		label: "DAG Start",
		description:
			"Start an approved workflow from a spec (inline JSON, specName, or resumeRunId). Returns the ready batch: execute each item with subagent using the EXACT agent and task, then dag_complete.",
		promptSnippet:
			"Start a DAG workflow; returns the ready batch to execute via subagent",
		promptGuidelines: [
			// WHEN to use dag_start (the trigger), not just HOW
			"Use dag_start when the task decomposes into multiple dependent stages needing verification or gates — parallel research → synthesis → review/fix loop, or any flow where order, re-runs and auditability matter (see the dag-workflow skill for the decision rule).",
			"For a single focused task use subagent directly; for independent parallel tasks use subagent tasks[] without dag; for a simple 2-3 step chain use subagent chain — dag-core adds overhead that only pays off for enforced multi-stage flows.",
			// HOW (protocol)
			"Use dag_start to begin a workflow. It returns a ready batch: call subagent exactly as specified (same agent and task, no edits).",
			"After each node's subagent call, call dag_complete with the node name; a node becomes passed only through dag_complete.",
			"If dag_complete marks a node failed, re-run it with dag_retry; never treat a node as done by any other means.",
			"For situations not covered by the workflow spec (subagent error, missing artifacts, changed requirements), follow the node's failure policy or call dag_abort to return to the human — do not improvise.",
			"Call dag_finish only after all required nodes are passed.",
		],
		parameters: Type.Object({
			spec: Type.Optional(
				Type.String({ description: "Inline workflow spec as JSON" }),
			),
			specName: Type.Optional(
				Type.String({
					description: "Definition name; resolved project → user scope",
				}),
			),
			resumeRunId: Type.Optional(
				Type.String({ description: "Resume an existing running run" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				requireRoots();
				if (params.spec) lastInlineSpec = params.spec;
				const res = await manager.start({
					spec: params.spec,
					specName: params.specName,
					resumeRunId: params.resumeRunId,
				});
				if (!res.ok) return ok(`dag_start rejected:\n${res.error}`);
				const batchText = renderBatch(res.batch!);
				const text = [
					`Workflow started: runId=${res.runId} (scope=${res.scope})`,
					"",
					`Ready batch:\n${batchText}`,
					"",
					PROTOCOL,
				].join("\n");
				return ok(text, {
					runId: res.runId,
					scope: res.scope,
					status: res.status,
					batch: res.batch,
				});
			} catch (e) {
				return ok(`dag_start error: ${(e as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "dag_complete",
		label: "DAG Complete",
		description:
			"Report a node's subagent execution. Passes only when execution was observed (matching subagent call) AND declared artifacts pass checks.",
		promptSnippet:
			"Report a node's subagent result; evidence gates decide pass/fail",
		promptGuidelines: [
			"Use dag_complete only after calling subagent with the issued payload for that node; dag_complete verifies the call was observed and artifacts exist.",
		],
		parameters: Type.Object({
			runId: Type.String(),
			node: Type.String(),
			result: Type.Optional(
				Type.String({
					description: "Optional human-readable summary of the node result",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return serial(async () => {
				try {
					requireRoots();
					const run = await loadRun(params.runId);
					if ("error" in run) return ok(`dag_complete rejected: ${run.error}`);
					await ingestAndDrain(run);
					const res = await manager.complete(run, params.node, ctx.cwd);
					if (!res.ok)
						return ok(
							`dag_complete rejected for "${params.node}":\n${res.error}`,
						);
					const batchText = renderBatch(res.batch);
					const evidence = res.evidenceReport
						? `\nArtifact evidence:\n${res.evidenceReport}`
						: "";
					return ok(
						[
							`✓ ${params.node} passed.${evidence}`,
							"",
							`Ready batch:\n${batchText}`,
							"",
							PROTOCOL,
						].join("\n"),
						{ runId: params.runId, next: res.batch },
					);
				} catch (e) {
					return ok(`dag_complete error: ${(e as Error).message}`);
				}
			});
		},
	});

	pi.registerTool({
		name: "dag_fail",
		label: "DAG Fail",
		description:
			"Declare a node failed (e.g. the subagent call errored or the task is impossible). Dependents become blocked; workflow cannot finish until retried or aborted.",
		promptSnippet: "Declare a node failed",
		parameters: Type.Object({
			runId: Type.String(),
			node: Type.String(),
			reason: Type.String({ description: "Failure reason" }),
		}),
		async execute(_toolCallId, params) {
			return serial(async () => {
				try {
					requireRoots();
					const run = await loadRun(params.runId);
					if ("error" in run) return ok(`dag_fail rejected: ${run.error}`);
					await ingestAndDrain(run);
					const res = await manager.fail(run, params.node, params.reason);
					if (!res.ok) return ok(`dag_fail rejected: ${res.error}`);
					return ok(
						`✗ ${params.node} marked failed: ${params.reason}\n\nNext batch:\n${renderBatch(res.batch)}`,
					);
				} catch (e) {
					return ok(`dag_fail error: ${(e as Error).message}`);
				}
			});
		},
	});

	pi.registerTool({
		name: "dag_retry",
		label: "DAG Retry",
		description:
			"Re-run a failed node: clears its state and re-issues its payload. Only failed nodes can be retried.",
		promptSnippet: "Re-run a failed node",
		parameters: Type.Object({
			runId: Type.String(),
			node: Type.String(),
		}),
		async execute(_toolCallId, params) {
			return serial(async () => {
				try {
					requireRoots();
					const run = await loadRun(params.runId);
					if ("error" in run) return ok(`dag_retry rejected: ${run.error}`);
					const res = await manager.retry(run, params.node);
					if (!res.ok) return ok(`dag_retry rejected: ${res.error}`);
					return ok(
						`↻ ${params.node} re-issued. Execute with subagent, then dag_complete.\n\n${renderBatch(res.batch)}`,
					);
				} catch (e) {
					return ok(`dag_retry error: ${(e as Error).message}`);
				}
			});
		},
	});

	pi.registerTool({
		name: "dag_finish",
		label: "DAG Finish",
		description:
			"Validate and complete the workflow. Rejects while any required node is not passed.",
		promptSnippet: "Validate and finish the workflow",
		parameters: Type.Object({
			runId: Type.String(),
		}),
		async execute(_toolCallId, params) {
			try {
				requireRoots();
				const run = await loadRun(params.runId);
				if ("error" in run) return ok(`dag_finish rejected: ${run.error}`);
				const res = await manager.finish(run);
				if (!res.ok)
					return ok(
						`dag_finish rejected — workflow incomplete:\n${res.report!.join("\n")}`,
					);
				return ok(
					`Workflow ${params.runId} completed.\n\n${res.report!.join("\n")}`,
				);
			} catch (e) {
				return ok(`dag_finish error: ${(e as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "dag_abort",
		label: "DAG Abort",
		description:
			"Abort the workflow and return to the human. The only legitimate exit for uncovered situations.",
		promptSnippet: "Abort the workflow, returning to the human",
		parameters: Type.Object({
			runId: Type.String(),
			reason: Type.String(),
		}),
		async execute(_toolCallId, params) {
			try {
				requireRoots();
				const run = await loadRun(params.runId);
				if ("error" in run) return ok(`dag_abort rejected: ${run.error}`);
				const res = await manager.abort(run, params.reason);
				if (!res.ok) return ok(`dag_abort rejected: ${res.error}`);
				return ok(`Workflow ${params.runId} aborted: ${params.reason}`);
			} catch (e) {
				return ok(`dag_abort error: ${(e as Error).message}`);
			}
		},
	});

	/* ------------------------------------------------------------------ */
	/* Commands (human gates + inspection)                                 */
	/* ------------------------------------------------------------------ */

	pi.registerCommand("dag", {
		description:
			"DAG workflow controls. Subcommands: status, graph, list, save, approve, reject, new, help",
		handler: async (args, ctx) => {
			await cmdHandler(args, ctx);
		},
	});

	async function cmdHandler(args: string, ctx: ExtensionCommandContext) {
		try {
			requireRoots();
			const [sub, ...rest] = args.trim().split(/\s+/);
			switch (sub) {
				case "status": {
					const runs = await listRuns(roots);
					const target = rest[0];
					if (target) {
						const run = await loadRun(target);
						if ("error" in run) return ctx.ui.notify(run.error, "error");
						return ctx.ui.notify(renderText(run), "info");
					}
					if (runs.length === 0) return ctx.ui.notify("no runs yet", "info");
					const lines = runs.map(
						(r) => `  ${r.runId} [${r.scope}] ${r.status} — ${r.spec}`,
					);
					return ctx.ui.notify(`runs:\n${lines.join("\n")}`, "info");
				}
				case "graph": {
					const runId = rest[0];
					const runs = await listRuns(roots);
					const found = runId
						? await loadRun(runId)
						: await (async () => {
								const latest =
									runs.find((r) => r.status === "running") ?? runs[0];
								return latest ? loadRun(latest.runId) : { error: "no runs" };
							})();
					if (!found || "error" in found)
						return ctx.ui.notify("run not found", "error");
					return ctx.ui.notify(
						`${renderText(found)}\n\n${renderMermaid(found)}`,
						"info",
					);
				}
				case "list": {
					const defs = await listDefinitions(roots);
					const runs = await listRuns(roots);
					const d = defs.length
						? defs.map((x) => `  ${x.scope}: ${x.name}`).join("\n")
						: "  (none)";
					const r = runs.length
						? runs
								.map((x) => `  ${x.runId} [${x.scope}] ${x.status} — ${x.spec}`)
								.join("\n")
						: "  (none)";
					return ctx.ui.notify(`definitions:\n${d}\n\nruns:\n${r}`, "info");
				}
				case "save": {
					const name = rest[0];
					if (!name) return ctx.ui.notify("usage: /dag save <name>", "error");
					if (!lastInlineSpec)
						return ctx.ui.notify(
							"no inline spec from the last dag_start to save",
							"error",
						);
					const res = await manager.saveSpec("project", name, lastInlineSpec);
					if (!res.ok)
						return ctx.ui.notify(`save failed: ${res.error}`, "error");
					return ctx.ui.notify(
						`saved definition "${name}" → ${res.file}`,
						"info",
					);
				}
				case "approve":
				case "reject": {
					const runId = rest[0];
					const node = rest[1];
					if (!runId || !node)
						return ctx.ui.notify(`usage: /dag ${sub} <runId> <node>`, "error");
					const run = await loadRun(runId);
					if ("error" in run) return ctx.ui.notify(run.error, "error");
					const res = await manager.resolveCheckpoint(
						run,
						node,
						sub === "approve",
						rest.slice(2).join(" ") || undefined,
					);
					if (!res.ok)
						return ctx.ui.notify(`checkpoint: ${res.error}`, "error");
					return ctx.ui.notify(
						`${sub === "approve" ? "✓" : "✗"} ${node} ${sub === "approve" ? "approved" : "rejected"}\n\nNext batch:\n${renderBatch(res.batch)}`,
						"info",
					);
				}
				case "new": {
					return ctx.ui.notify(
						"dag spec template (JSON):\n\n" + TEMPLATE,
						"info",
					);
				}
				case "help":
				default:
					return ctx.ui.notify(HELP, "info");
			}
		} catch (e) {
			ctx.ui.notify(`dag error: ${(e as Error).message}`, "error");
		}
	}

	/* ------------------------------------------------------------------ */

	const TEMPLATE = JSON.stringify(
		{
			name: "my-workflow",
			policy: { failFast: true, maxAgents: 20 },
			nodes: {
				discover: {
					agent: "scout",
					task: "Explore the module and write context.md",
					produces: [{ path: "context.md", check: "nonEmpty" }],
				},
				review: {
					agent: "reviewer",
					role: "verifier",
					needs: ["discover"],
					task: "Verify the findings in {artifacts} and write review.md",
					produces: [{ path: "review.md", check: "grep:APPROVED" }],
				},
				approve: { checkpoint: true, needs: ["review"] },
				done: {
					agent: "worker",
					task: "Write the final summary to done.md",
					needs: ["approve"],
				},
			},
		},
		null,
		2,
	);

	const HELP = `dag-core — workflow state machine for pi

Tools (AI):  dag_start  dag_complete  dag_fail  dag_retry  dag_finish  dag_abort
Commands (human):  /dag status [runId] | /dag graph [runId] | /dag list
                   /dag save <name> | /dag approve|reject <runId> <node> | /dag new

Protocol:
  1. dag_start returns a ready batch — execute items with subagent verbatim.
  2. dag_complete verifies: observed subagent call + artifact gates.
  3. Failed nodes: dag_retry (or dag_abort to return to the human).
  4. dag_finish requires every required node passed.
  5. Checkpoints are resolved by a human via /dag approve|reject.

Boundaries: writes only to workflow definitions + run state (3 scopes);
subscriptions are read-only observation; never blocks or mutates calls.`;
}
