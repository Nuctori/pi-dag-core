/**
 * Adapter E2E — core protocol wiring through the real extension entry point:
 * tool registration, session_start roots, the tool_execution_start/end event
 * capture, buffer drain, and the H1 still-running rejection. (User-path
 * breadth lives in e2e-paths.test.ts; the shared mock is in helpers/.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { bootExtension, makePi, type MockPi } from "./helpers/mock-pi.js";

const SPEC = JSON.stringify({
	name: "e2e",
	nodes: {
		discover: {
			agent: "scout",
			task: "Explore and write ctx.md",
			produces: [{ path: "ctx.md", check: "nonEmpty" }],
		},
		done: { agent: "worker", task: "wrap up", needs: ["discover"] },
	},
});

async function tmpProject() {
	const dir = await mkdtemp(join(tmpdir(), "dag-e2e-"));
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function startRun(pi: MockPi, dir: string, spec = SPEC) {
	const start = pi.tools.find((t) => t.name === "dag_start")!;
	const res = (await start.execute("c1", { spec }, undefined, undefined, {
		cwd: dir,
	})) as {
		details: { runId?: string };
		content: { type: string; text: string }[];
	};
	const runId = res.details.runId;
	const text = res.content[0]?.text ?? "";
	assert.ok(runId, `dag_start failed: ${text}`);
	return { runId, text };
}

function toolArgs(text: string): { agent: string; task: string } {
	const m = text.match(/agent: ([^\n]+)\n {2}task: ([^\n]+)/);
	assert.ok(m, `no payload in batch:\n${text}`);
	return { agent: m[1]!, task: m[2]!.trim() };
}

test("E2E: full adapter flow — start, capture, complete, finish", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await startRun(pi, t.dir);
		const { agent, task } = toolArgs(text);

		// the AI "executes" the node: subagent call fires start + end events
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-1",
			toolName: "subagent",
			args: { agent, task },
		});
		await writeFile(join(t.dir, "ctx.md"), "artifact content");
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-1",
			toolName: "subagent",
			isError: false,
		});

		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res = (await complete.execute(
			"c2",
			{ runId, node: "discover" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(res.content[0]?.text ?? "", /discover passed/);

		// finish the remaining node + finish the workflow
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-2",
			toolName: "subagent",
			args: { agent: "worker", task: "wrap up" },
		});
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-2",
			toolName: "subagent",
			isError: false,
		});
		const c2 = (await complete.execute(
			"c3",
			{ runId, node: "done" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(c2.content[0]?.text ?? "", /done passed/);

		const finish = pi.tools.find((x) => x.name === "dag_finish")!;
		const f = (await finish.execute("c4", { runId }, undefined, undefined, {
			cwd: t.dir,
		})) as {
			content: { type: string; text: string }[];
		};
		assert.match(f.content[0]?.text ?? "", /completed/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (L-A2): subagent calls before the first dag_start are never captured", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		// a subagent call fires BEFORE any workflow exists — it can never
		// attribute (M4) and must not be retained (sensitive args retention)
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-pre",
			toolName: "subagent",
			args: { agent: "scout", task: "Explore and write ctx.md" },
		});
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-pre",
			toolName: "subagent",
			isError: false,
		});

		const { runId } = await startRun(pi, t.dir);

		// dag_complete without a post-start call → plain "no execution
		// evidence", NO near-miss diagnostics naming the pre-start call
		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res = (await complete.execute(
			"c2",
			{ runId, node: "discover" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		const out = res.content[0]?.text ?? "";
		assert.match(out, /no execution evidence/);
		assert.doesNotMatch(out, /tc-pre/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (L-A3): dag_complete declaration lands in the events ledger", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await startRun(pi, t.dir);
		const { agent, task } = toolArgs(text);

		await pi.emit("tool_execution_start", {
			toolCallId: "tc-1",
			toolName: "subagent",
			args: { agent, task },
		});
		await writeFile(join(t.dir, "ctx.md"), "artifact content");
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-1",
			toolName: "subagent",
			isError: false,
		});

		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res = (await complete.execute(
			"c2",
			{ runId, node: "discover", result: "all checks green" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(res.content[0]?.text ?? "", /discover passed/);

		// the AI's declaration (with result) is in the audit ledger — the run
		// is session-scoped (no scope passed to dag_start), so the ledger lives
		// under ~/.pi/agent/workflows/runs/s-<sessionId>/
		const ledger = await readFile(
			join(
				homedir(),
				".pi",
				"agent",
				"workflows",
				"runs",
				"s-e2e-session",
				runId,
				"events.jsonl",
			),
			"utf8",
		);
		assert.match(ledger, /"complete"/);
		assert.match(ledger, /all checks green/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (H1): dag_complete before the subagent call finishes is rejected", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await startRun(pi, t.dir);
		const { agent, task } = toolArgs(text);

		// launch observed (preflight) but execution_end NOT emitted yet
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-h1",
			toolName: "subagent",
			args: { agent, task },
		});

		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res = (await complete.execute(
			"c2",
			{ runId, node: "discover" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(res.content[0]?.text ?? "", /no execution evidence/);
		assert.match(
			res.content[0]?.text ?? "",
			/STILL RUNNING — wait for its result/,
			"rejection must name the in-flight cause instead of repeating the protocol",
		);

		// now the call finishes → the SAME buffered call becomes attributable
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-h1",
			toolName: "subagent",
			isError: false,
		});
		await writeFile(join(t.dir, "ctx.md"), "artifact content");
		const res2 = (await complete.execute(
			"c3",
			{ runId, node: "discover" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(res2.content[0]?.text ?? "", /discover passed/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (H2): missing subagent tool triggers a startup warning", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi(false);
		const notified: { kind: string; text: string }[] = [];
		await bootExtension(pi, t.dir, (text, kind) =>
			notified.push({ text, kind }),
		);
		const warning = notified.find((n) => n.kind === "error");
		assert.ok(warning, "expected an error-level startup warning");
		assert.match(warning!.text, /subagent/);
		for (const name of ["dag_start", "dag_complete", "dag_finish"]) {
			assert.ok(
				pi.tools.some((x) => x.name === name),
				`tool ${name} registered`,
			);
		}
	} finally {
		await t.cleanup();
	}
});

/* ------------------------------------------------------------------ */
/* Stall nudge (liveness) — adapter-level, tiny threshold + real sleep  */
/* ------------------------------------------------------------------ */

const STALL_SPEC = JSON.stringify({
	name: "e2e-stall",
	policy: { stallAfterSec: 1 },
	nodes: {
		discover: {
			agent: "scout",
			task: "Explore and write ctx.md",
			produces: [{ path: "ctx.md", check: "nonEmpty" }],
		},
		done: { agent: "worker", task: "wrap up" },
	},
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("E2E (stall): near-miss rejection advises re-running with the exact payload", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await startRun(pi, t.dir, STALL_SPEC);
		const { agent, task } = toolArgs(text);

		// AI launched with a MODIFIED payload (near-miss) — call finished
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-near",
			toolName: "subagent",
			args: { agent, task: task + " (my own version)" },
		});
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-near",
			toolName: "subagent",
			isError: false,
		});
		await sleep(1100); // age > stallAfterSec

		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res = (await complete.execute(
			"c2",
			{ runId, node: "discover" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		const out = res.content[0]?.text ?? "";
		assert.match(out, /Stalled/);
		// the call did NOT attribute (post-drain buffer empty) — re-run with
		// the EXACT payload is the correct advice, not dag_complete
		assert.match(out, /call subagent with the issued payload/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (stall): in-flight subagent call advises waiting, not re-launching", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await startRun(pi, t.dir, STALL_SPEC);
		const { agent, task } = toolArgs(text);

		// launch observed but execution STILL running (no end event)
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-inflight",
			toolName: "subagent",
			args: { agent, task },
		});
		await sleep(1100);

		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res = (await complete.execute(
			"c2",
			{ runId, node: "discover" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		const out = res.content[0]?.text ?? "";
		assert.match(out, /no execution evidence/); // H1 still enforced
		assert.match(out, /Stalled/);
		assert.match(out, /still running — wait for its result/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (stall): executed-but-uncompleted sibling advises dag_complete", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await startRun(pi, t.dir, STALL_SPEC);
		const { agent, task } = toolArgs(text); // discover payload
		// 'done' was issued in the SAME start batch (no deps) — take its
		// payload from the start text; post-complete batches never re-issue (B2).
		const doneMatch = text.match(
			/node: done\s*\n {2}agent: ([^\n]+)\n {2}task: ([^\n]+)/,
		);
		assert.ok(doneMatch, "done payload present in start batch");

		// complete discover properly
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-a",
			toolName: "subagent",
			args: { agent, task },
		});
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-a",
			toolName: "subagent",
			isError: false,
		});
		await writeFile(join(t.dir, "ctx.md"), "artifact content");
		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res1 = (await complete.execute(
			"c2",
			{ runId, node: "discover" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(res1.content[0]?.text ?? "", /discover passed/);

		// sibling 'done' executed (call finished) but never completed
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-b",
			toolName: "subagent",
			args: { agent: doneMatch[1]!, task: doneMatch[2]!.trim() },
		});
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-b",
			toolName: "subagent",
			isError: false,
		});
		await sleep(1100);

		// re-complete discover → rejected (already passed) but the drain
		// attributes done → stall note says dag_complete, not re-run
		const res2 = (await complete.execute(
			"c2",
			{ runId, node: "discover" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		const out = res2.content[0]?.text ?? "";
		assert.match(out, /already passed/);
		assert.match(out, /Stalled/);
		assert.match(out, /result is in hand — call dag_complete/);
	} finally {
		await t.cleanup();
	}
});

/* ------------------------------------------------------------------ */
/* Unattended checkpoint auto-approve (adapter level, real sleep)       */
/* ------------------------------------------------------------------ */

const AUTO_SPEC = JSON.stringify({
	name: "e2e-auto",
	nodes: {
		a: { agent: "w", task: "do a" },
		gate: { checkpoint: { autoAfterSec: 1 }, needs: ["a"] },
		b: { agent: "w", task: "do b", needs: ["gate"] },
	},
});

test("E2E (auto-approve): unattended checkpoint passes via resume poll", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await startRun(pi, t.dir, AUTO_SPEC);
		const { agent, task } = toolArgs(text);

		// complete a → gate awaits, note discloses the auto timeout
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-a",
			toolName: "subagent",
			args: { agent, task },
		});
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-a",
			toolName: "subagent",
			isError: false,
		});
		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res1 = (await complete.execute(
			"c2",
			{ runId, node: "a" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		const out1 = res1.content[0]?.text ?? "";
		assert.match(out1, /checkpoint "gate" reached/);
		assert.match(out1, /auto-approves after 1s/);
		assert.match(out1, /resumeRunId/);

		// wait past the timeout, then poll with dag_start({resumeRunId})
		await sleep(1100);
		const start = pi.tools.find((x) => x.name === "dag_start")!;
		const res2 = (await start.execute(
			"c3",
			{ resumeRunId: runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		const out2 = res2.content[0]?.text ?? "";
		assert.match(out2, /auto-approved after timeout/);
		assert.match(out2, /node: b/);

		// complete b and finish — the report discloses the auto approval
		const bArgs = out2.match(
			/node: b\s*\n {2}agent: ([^\n]+)\n {2}task: ([^\n]+)/,
		);
		assert.ok(bArgs, "b payload in resume batch");
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-b",
			toolName: "subagent",
			args: { agent: bArgs[1]!, task: bArgs[2]!.trim() },
		});
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-b",
			toolName: "subagent",
			isError: false,
		});
		const res3 = (await complete.execute(
			"c4",
			{ runId, node: "b" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(res3.content[0]?.text ?? "", /b passed/);
		const finish = pi.tools.find((x) => x.name === "dag_finish")!;
		const res4 = (await finish.execute("c5", { runId }, undefined, undefined, {
			cwd: t.dir,
		})) as { content: { type: string; text: string }[] };
		assert.match(res4.content[0]?.text ?? "", /auto-approved, unattended/);
	} finally {
		await t.cleanup();
	}
});

/* ------------------------------------------------------------------ */
/* Rejection diagnostics (real-session findings: evidence friction)    */
/* ------------------------------------------------------------------ */

test("E2E (diag): retry without re-execution names the cause (evidence clock)", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const spec = JSON.stringify({
			name: "e2e-diag-retry",
			nodes: {
				a: {
					agent: "w",
					task: "produce a.md",
					produces: [{ path: "a.md", check: "nonEmpty" }],
				},
			},
		});
		const { runId, text } = await startRun(pi, t.dir, spec);
		const { agent, task } = toolArgs(text);

		// execute, but the artifact is missing → gate fails → node failed (attempt 1)
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-1",
			toolName: "subagent",
			args: { agent, task },
		});
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-1",
			toolName: "subagent",
			isError: false,
		});
		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res1 = (await complete.execute(
			"c2",
			{ runId, node: "a" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(res1.content[0]?.text ?? "", /artifact evidence failed/);

		// retry, then complete WITHOUT re-executing (the msq5zurp pattern)
		const retry = pi.tools.find((x) => x.name === "dag_retry")!;
		await retry.execute("c3", { runId, node: "a" }, undefined, undefined, {
			cwd: t.dir,
		});
		const res2 = (await complete.execute(
			"c4",
			{ runId, node: "a" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		const out = res2.content[0]?.text ?? "";
		assert.match(out, /no execution evidence/);
		assert.match(out, /previously executed \(attempt 1\)/);
		assert.match(out, /resets the evidence clock/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (diag): all nodes passed but unfinished → nudge dag_finish", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await startRun(pi, t.dir, STALL_SPEC);
		const { agent, task } = toolArgs(text); // discover payload
		const doneMatch = text.match(
			/node: done\s*\n {2}agent: ([^\n]+)\n {2}task: ([^\n]+)/,
		);
		assert.ok(doneMatch, "done payload present in start batch");

		// complete both nodes but never call dag_finish
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-a",
			toolName: "subagent",
			args: { agent, task },
		});
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-a",
			toolName: "subagent",
			isError: false,
		});
		await writeFile(join(t.dir, "ctx.md"), "artifact content");
		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res1 = (await complete.execute(
			"c2",
			{ runId, node: "discover" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(res1.content[0]?.text ?? "", /discover passed/);

		await pi.emit("tool_execution_start", {
			toolCallId: "tc-b",
			toolName: "subagent",
			args: { agent: doneMatch[1]!, task: doneMatch[2]!.trim() },
		});
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-b",
			toolName: "subagent",
			isError: false,
		});
		const res2 = (await complete.execute(
			"c3",
			{ runId, node: "done" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(res2.content[0]?.text ?? "", /done passed/);

		// touch the run again without finishing → the nudge names dag_finish
		const res3 = (await complete.execute(
			"c4",
			{ runId, node: "discover" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		const out = res3.content[0]?.text ?? "";
		assert.match(out, /already passed/);
		assert.match(out, /Call dag_finish/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (P0-1): one run's dag_complete must not consume another run's evidence", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const specA = JSON.stringify({
			name: "e2e-run-a",
			nodes: {
				a: {
					agent: "scout",
					task: "task A",
					produces: [{ path: "a.md", check: "nonEmpty" }],
				},
			},
		});
		const specB = JSON.stringify({
			name: "e2e-run-b",
			nodes: {
				b: {
					agent: "worker",
					task: "task B",
					produces: [{ path: "b.md", check: "nonEmpty" }],
				},
			},
		});
		const { runId: runA } = await startRun(pi, t.dir, specA);
		const { runId: runB } = await startRun(pi, t.dir, specB);

		// run B's subagent call fires AND finishes while run A is still live
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-b",
			toolName: "subagent",
			args: { agent: "worker", task: "task B" },
		});
		await writeFile(join(t.dir, "b.md"), "b content");
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-b",
			toolName: "subagent",
			isError: false,
		});

		// run A's dag_complete drains the session buffer — must reject on its
		// own node without swallowing run B's finished call
		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const resA = (await complete.execute(
			"c2",
			{ runId: runA, node: "a" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(resA.content[0]?.text ?? "", /no execution evidence/);

		// run B's evidence must still be attributable afterwards
		const resB = (await complete.execute(
			"c3",
			{ runId: runB, node: "b" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(resB.content[0]?.text ?? "", /b passed/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (P0-2): duplicate dag_start(resumeRunId) must not orphan finished evidence", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const spec = JSON.stringify({
			name: "e2e-resume",
			nodes: {
				a: {
					agent: "w",
					task: "produce a.md",
					produces: [{ path: "a.md", check: "nonEmpty" }],
				},
			},
		});
		const { runId, text } = await startRun(pi, t.dir, spec);
		const { agent, task } = toolArgs(text);

		// the node executes AND finishes, artifact in place
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-1",
			toolName: "subagent",
			args: { agent, task },
		});
		await writeFile(join(t.dir, "a.md"), "artifact content");
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-1",
			toolName: "subagent",
			isError: false,
		});

		// mistaken/duplicate resume fires before dag_complete
		const start = pi.tools.find((x) => x.name === "dag_start")!;
		const resumed = (await start.execute(
			"c2",
			{ resumeRunId: runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(resumed.content[0]?.text ?? "", /\[resumed\]/);

		// the executed call must still be attributable — no re-execution needed
		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res = (await complete.execute(
			"c3",
			{ runId, node: "a" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(res.content[0]?.text ?? "", /a passed/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (M7b): resume of a dead run rejects WITHOUT draining/mutating it", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const spec = JSON.stringify({
			name: "e2e-dead",
			nodes: {
				a: {
					agent: "w",
					task: "produce a.md",
					produces: [{ path: "a.md", check: "nonEmpty" }],
				},
			},
		});
		const { runId, text } = await startRun(pi, t.dir, spec);
		const { agent, task } = toolArgs(text);

		// the node executes AND finishes while the run is still live
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-live",
			toolName: "subagent",
			args: { agent, task },
		});
		await writeFile(join(t.dir, "a.md"), "artifact content");
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-live",
			toolName: "subagent",
			isError: false,
		});

		// human aborts the run
		const abort = pi.tools.find((x) => x.name === "dag_abort")!;
		const ab = (await abort.execute(
			"c2",
			{ runId, reason: "closed by human" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(ab.content[0]?.text ?? "", /aborted/);

		// message-replay resume of the DEAD run — the buffered call must NOT
		// be attributed into it (that would mutate + persist a frozen snapshot)
		const start = pi.tools.find((x) => x.name === "dag_start")!;
		const resumed = (await start.execute(
			"c3",
			{ resumeRunId: runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(resumed.content[0]?.text ?? "", /not resumable/);

		const runDir2 = join(
			homedir(),
			".pi",
			"agent",
			"workflows",
			"runs",
			"s-e2e-session",
			runId,
		);
		const snap = JSON.parse(
			await readFile(join(runDir2, "snapshot.json"), "utf8"),
		);
		assert.equal(
			snap.nodes.a.state,
			"ready",
			"dead run snapshot must stay frozen at its pre-abort state (no attribution into it)",
		);
		assert.equal(
			snap.nodes.a.executedTs,
			undefined,
			"dead run must not gain execution evidence",
		);
		const ledger = await readFile(join(runDir2, "events.jsonl"), "utf8");
		assert.doesNotMatch(
			ledger,
			/tc-live/,
			"no executed event may land in a dead run's ledger",
		);
	} finally {
		await t.cleanup();
	}
});

test("E2E (P0-3): /dag approve resolves the human gate (load inside serial queue)", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const spec = JSON.stringify({
			name: "e2e-gate",
			nodes: {
				gate: { checkpoint: true },
				work: {
					agent: "w",
					task: "do the work",
					needs: ["gate"],
					produces: [{ path: "w.md", check: "nonEmpty" }],
				},
			},
		});
		const { runId } = await startRun(pi, t.dir, spec);

		// human approves the gate → work must be issued in the next batch
		const notified = await pi.runCommand(`approve ${runId} gate`, t.dir);
		const text = notified.map((n) => n.text).join("\n");
		assert.match(text, /gate approved/);
		assert.match(text, /node: work\s*\n {2}agent: w\s*\n {2}task: do the work/);

		// execute the now-issued node and complete it
		await pi.emit("tool_execution_start", {
			toolCallId: "tc-w",
			toolName: "subagent",
			args: { agent: "w", task: "do the work" },
		});
		await writeFile(join(t.dir, "w.md"), "work artifact");
		await pi.emit("tool_execution_end", {
			toolCallId: "tc-w",
			toolName: "subagent",
			isError: false,
		});
		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const res = (await complete.execute(
			"c2",
			{ runId, node: "work" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as { content: { type: string; text: string }[] };
		assert.match(res.content[0]?.text ?? "", /work passed/);
	} finally {
		await t.cleanup();
	}
});
