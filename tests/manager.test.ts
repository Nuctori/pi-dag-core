/**
 * RunManager end-to-end tests — happy path + every adversarial scenario.
 *
 * The core is pi-free: subagent executions are simulated by feeding
 * SubagentInvocation objects to manager.ingestCalls (the same shape the
 * pi adapter derives from the tool_call event stream).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunManager } from "../src/core.js";
import { computeBatch } from "../src/scheduler.js";
import { loadRunAny } from "../src/state.js";
import type { SubagentInvocation } from "../src/types.js";

const SIMPLE = JSON.stringify({
	name: "simple",
	policy: { failFast: true, maxAgents: 10 },
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
			task: "Verify findings in {artifacts} and write review.md",
			produces: [{ path: "review.md", check: "grep:APPROVED" }],
		},
		approve: { checkpoint: true, needs: ["review"] },
		done: {
			agent: "worker",
			task: "Final wrap-up and summary",
			needs: ["approve"],
		},
	},
});

async function tmpRoots() {
	const dir = await mkdtemp(join(tmpdir(), "dagcore-"));
	return {
		project: dir,
		user: dir,
		sessionId: "test-session",
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

function call(
	_node: string,
	agent: string,
	task: string,
	toolCallId: string,
	isError = false,
	finished = true,
): SubagentInvocation {
	return { toolCallId, ts: Date.now(), agent, task, isError, finished };
}

async function writeArtifact(project: string, path: string, content: string) {
	const abs = join(project, path);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

test("happy path: start → execute → complete → approve → finish", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});

		const s = await m.start({ spec: SIMPLE });
		assert.ok(s.ok);
		assert.equal(s.batch!.items.length, 1);
		assert.equal(s.batch!.items[0]!.node, "discover");

		// execute discover with the EXACT issued payload
		const d = s.batch!.items[0]!;
		await writeArtifact(t.project, "context.md", "context content");
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run, [call(d.node, d.agent, d.task, "tc-1")]);
		const c1 = await m.complete(run, d.node, t.project);
		assert.ok(c1.ok, c1.error);

		// next batch: review (verifier) — check {artifacts} got injected
		assert.equal(c1.batch.items.length, 1);
		const v = c1.batch.items[0]!;
		assert.equal(v.node, "review");
		assert.match(v.task, /context\.md/);

		await writeArtifact(t.project, "review.md", "APPROVED");
		const run2 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run2, [call(v.node, v.agent, v.task, "tc-2")]);
		const c2 = await m.complete(run2, "review", t.project);
		assert.ok(c2.ok, c2.error);

		// checkpoint reached; human approves
		const run3 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		assert.equal(run3.nodes["approve"]!.state, "awaiting_approval");
		const ap = await m.resolveCheckpoint(run3, "approve", true);
		assert.ok(ap.ok);
		assert.equal(ap.batch.items.length, 1);
		assert.equal(ap.batch.items[0]!.node, "done");

		const run4 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run4, [
			call("done", "worker", run4.spec.nodes["done"]!.task!, "tc-3"),
		]);
		const c4 = await m.complete(run4, "done", t.project);
		assert.ok(c4.ok);

		const run5 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		const f = await m.finish(run5);
		assert.ok(f.ok, f.error);
	} finally {
		await t.cleanup();
	}
});

test("ADVERSARIAL: dag_complete without any subagent execution is rejected", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec: SIMPLE });
		assert.ok(s.ok);
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		// no ingestCalls — the AI tries to skip straight to complete
		const c = await m.complete(run, "discover", t.project);
		assert.ok(!c.ok);
		assert.match(c.error!, /no execution evidence/);
	} finally {
		await t.cleanup();
	}
});

test("ADVERSARIAL: wrong payload (AI edits the task) is not attributed → complete rejected", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec: SIMPLE });
		const d = s.batch!.items[0]!;
		await writeArtifact(t.project, "context.md", "content");
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		// AI runs subagent but with a DIFFERENT task (edited payload)
		await m.ingestCalls(run, [
			call(d.node, d.agent, d.task + " (my own version)", "tc-x"),
		]);
		const c = await m.complete(run, d.node, t.project);
		assert.ok(!c.ok);
		assert.match(c.error!, /no execution evidence/);
		assert.equal(run.nodes[d.node]!.state, "ready");
	} finally {
		await t.cleanup();
	}
});

test("ADVERSARIAL: artifact missing → failed; retry with artifact → passes", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec: SIMPLE });
		const d = s.batch!.items[0]!;
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run, [call(d.node, d.agent, d.task, "tc-1")]);
		// no artifact written
		const c = await m.complete(run, d.node, t.project);
		assert.ok(!c.ok);
		assert.match(c.error!, /artifact evidence failed/);
		assert.equal(run.nodes[d.node]!.state, "failed");

		const r = await m.retry(run, d.node);
		assert.ok(r.ok);
		await writeArtifact(t.project, "context.md", "now it exists");
		const run2 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run2, [call(d.node, d.agent, d.task, "tc-2")]);
		const c2 = await m.complete(run2, d.node, t.project);
		assert.ok(c2.ok, c2.error);
	} finally {
		await t.cleanup();
	}
});

test("ADVERSARIAL: stale artifact (written before issue) is rejected", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		// artifact written BEFORE the workflow starts (i.e. before any node is issued)
		await writeArtifact(t.project, "context.md", "pre-existing file");
		const s = await m.start({ spec: SIMPLE });
		const d = s.batch!.items[0]!;
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run, [call(d.node, d.agent, d.task, "tc-1")]);
		const c = await m.complete(run, d.node, t.project);
		assert.ok(!c.ok);
		assert.match(c.error!, /stale artifact/);
	} finally {
		await t.cleanup();
	}
});

test("ADVERSARIAL: premature finish is rejected while a node is queued", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec: SIMPLE });
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		const f = await m.finish(run);
		assert.ok(!f.ok);
		assert.match(f.error!, /incomplete/);
	} finally {
		await t.cleanup();
	}
});

test("parallel attribution: one subagent call with tasks[] covers a batch", async () => {
	const t = await tmpRoots();
	try {
		const spec = JSON.stringify({
			name: "parallel",
			nodes: {
				a: { agent: "scout", task: "do A" },
				b: { agent: "scout", task: "do B" },
				c: { agent: "worker", task: "do C", needs: ["a", "b"] },
			},
		});
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec });
		assert.equal(s.batch!.items.length, 2);
		const [a, b] = s.batch!.items;
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		// one tool call carrying tasks[] for both nodes
		const attrs = await m.ingestCalls(run, [
			call(a!.node, a!.agent, a!.task, "tc-par-1"),
			call(b!.node, b!.agent, b!.task, "tc-par-1"),
		]);
		assert.equal(attrs.length, 2);
		assert.equal(run.nodes[a!.node]!.state, "running");
		assert.equal(run.nodes[b!.node]!.state, "running");
		const c1 = await m.complete(run, a!.node, t.project);
		assert.ok(c1.ok);
		const c2 = await m.complete(run, b!.node, t.project);
		assert.ok(c2.ok);
	} finally {
		await t.cleanup();
	}
});

test("loop: body fails twice then passes → loop passes", async () => {
	const t = await tmpRoots();
	try {
		const spec = JSON.stringify({
			name: "loop",
			nodes: {
				body: {
					agent: "worker",
					task: "Write report.md with the fix",
					produces: [{ path: "report.md", check: "grep:FIXED" }],
				},
				loop: {
					agent: "ignored",
					task: "ignored",
					loop: { body: "body", maxIterations: 3 },
					needs: [],
				},
				done: { agent: "worker", task: "wrap up", needs: ["loop"] },
			},
		});
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec });
		assert.ok(s.ok);
		assert.equal(s.batch!.items.length, 1);
		assert.equal(s.batch!.items[0]!.node, "body"); // loop body issued, not the owner

		// iteration 1: artifact missing → fail
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		const body = s.batch!.items[0]!;
		await m.ingestCalls(run, [call(body.node, body.agent, body.task, "tc-1")]);
		const c1 = await m.complete(run, "body", t.project);
		assert.ok(!c1.ok);
		assert.equal(run.nodes["loop"]!.iteration, 1);

		// iteration 2: artifact missing → fail
		const run2 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run2, [call(body.node, body.agent, body.task, "tc-2")]);
		const c2 = await m.complete(run2, "body", t.project);
		assert.ok(!c2.ok);
		assert.equal(run2.nodes["loop"]!.iteration, 2);

		// iteration 3: artifact present → body passes → loop passes
		const run3 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await writeArtifact(t.project, "report.md", "FIXED");
		await m.ingestCalls(run3, [call(body.node, body.agent, body.task, "tc-3")]);
		const c3 = await m.complete(run3, "body", t.project);
		assert.ok(c3.ok, c3.error);
		assert.equal(run3.nodes["loop"]!.state, "passed");

		const run4 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		// execute the remaining 'done' node before finishing
		const doneItem = c3.batch.items.find((i) => i.node === "done");
		assert.ok(doneItem, "done should be issued after loop passes");
		await m.ingestCalls(run4, [
			call(doneItem.node, doneItem.agent, doneItem.task, "tc-done"),
		]);
		const c4 = await m.complete(run4, "done", t.project);
		assert.ok(c4.ok, c4.error);
		const run5 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		const f = await m.finish(run5);
		assert.ok(f.ok, f.error);
	} finally {
		await t.cleanup();
	}
});

test("A1 regression: exhausted loop can be retried — body re-armed and passes", async () => {
	const t = await tmpRoots();
	try {
		const spec = JSON.stringify({
			name: "loop-retry",
			nodes: {
				body: {
					agent: "worker",
					task: "t",
					produces: [{ path: "x.md", check: "nonEmpty" }],
				},
				loop: {
					agent: "ignored",
					task: "ignored",
					loop: { body: "body", maxIterations: 2 },
				},
				done: { agent: "worker", task: "wrap up", needs: ["loop"] },
			},
		});
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec });
		assert.ok(s.ok);
		// exhaust both iterations without artifacts
		for (let i = 1; i <= 2; i++) {
			const run = (await loadRunAny(
				{ project: t.project, user: t.user, sessionId: t.sessionId },
				s.runId!,
			))!.run;
			await m.ingestCalls(run, [call("body", "worker", "t", `tc-${i}`)]);
			const c = await m.complete(run, "body", t.project);
			assert.ok(!c.ok, "iteration should fail (no artifact)");
		}
		let run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		assert.equal(run.nodes["loop"]!.state, "failed");

		// retry the OWNER — body must be re-armed, not left dead
		const r = await m.retry(run, "loop");
		assert.ok(r.ok, r.error);
		assert.equal(r.batch.items.length, 1);
		assert.equal(r.batch.items[0]!.node, "body");

		// now the body passes → loop passes → finish succeeds
		run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await writeArtifact(t.project, "x.md", "content");
		await m.ingestCalls(run, [call("body", "worker", "t", "tc-retry")]);
		const c = await m.complete(run, "body", t.project);
		assert.ok(c.ok, c.error);
		assert.equal(run.nodes["loop"]!.state, "passed");
		const f = await m.finish(run);
		assert.ok(!f.ok, "done still queued — finish must wait");
		// finish the 'done' node to complete the workflow
		const doneItem = c.batch.items.find((i) => i.node === "done");
		assert.ok(doneItem);
		const run2 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run2, [
			call(doneItem.node, doneItem.agent, doneItem.task, "tc-done2"),
		]);
		const c2 = await m.complete(run2, "done", t.project);
		assert.ok(c2.ok, c2.error);
		const run3 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		const f2 = await m.finish(run3);
		assert.ok(f2.ok, f2.error);
	} finally {
		await t.cleanup();
	}
});

test("A2 regression: resume resets a running node to ready (evidence is session-local)", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec: SIMPLE });
		assert.ok(s.ok);
		const d = s.batch!.items[0]!;
		// simulate: node executed (attributed) but never completed — snapshot has it "running"
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run, [call(d.node, d.agent, d.task, "tc-inflight")]);
		assert.equal(run.nodes[d.node]!.state, "running");

		// new session (fresh manager), resume: running must reset to ready and re-issue
		const m2 = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const res = await m2.start({ resumeRunId: s.runId! });
		assert.ok(res.ok, res.error);
		assert.ok(
			res.batch!.items.some((i) => i.node === d.node),
			"discover re-issued on resume",
		);
	} finally {
		await t.cleanup();
	}
});

test("loop: exhaustion beyond maxIterations fails the loop", async () => {
	const t = await tmpRoots();
	try {
		const spec = JSON.stringify({
			name: "loop-exhaust",
			nodes: {
				body: {
					agent: "worker",
					task: "t",
					produces: [{ path: "x.md", check: "nonEmpty" }],
				},
				loop: {
					agent: "ignored",
					task: "ignored",
					loop: { body: "body", maxIterations: 2 },
				},
				done: { agent: "worker", task: "wrap up", needs: ["loop"] },
			},
		});
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec });
		assert.ok(s.ok);
		for (let i = 1; i <= 2; i++) {
			const run = (await loadRunAny(
				{ project: t.project, user: t.user, sessionId: t.sessionId },
				s.runId!,
			))!.run;
			await m.ingestCalls(run, [call("body", "worker", "t", `tc-${i}`)]);
			const c = await m.complete(run, "body", t.project);
			assert.ok(!c.ok, "iteration should fail (no artifact)");
		}
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		assert.equal(run.nodes["loop"]!.state, "failed");
		const f = await m.finish(run);
		assert.ok(!f.ok);
	} finally {
		await t.cleanup();
	}
});

test("maxAgents policy blocks further issuing", async () => {
	const t = await tmpRoots();
	try {
		const spec = JSON.stringify({
			name: "agents",
			policy: { maxAgents: 1 },
			nodes: {
				a: { agent: "w", task: "t1" },
				b: { agent: "w", task: "t2" },
				c: { agent: "w", task: "t3", needs: ["a", "b"] },
			},
		});
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec });
		assert.equal(s.batch!.items.length, 1); // only a (b never issued: cap is 1)
		assert.ok(s.batch!.notes.some((n) => /maxAgents/.test(n)));
	} finally {
		await t.cleanup();
	}
});

test("continueOnError: failed dep does not block dependent; finish can still pass", async () => {
	const t = await tmpRoots();
	try {
		const spec = JSON.stringify({
			name: "soft",
			nodes: {
				optional: { agent: "w", task: "t", continueOnError: true },
				main: { agent: "w", task: "t2" },
				done: { agent: "w", task: "t3", needs: ["optional", "main"] },
			},
		});
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec });
		assert.equal(s.batch!.items.length, 2);
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run, [call("optional", "w", "t", "tc-o")]);
		const f1 = await m.fail(run, "optional", "skipped intentionally");
		assert.ok(f1.ok);
		assert.equal(run.nodes["optional"]!.state, "failed");
		const run2 = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run2, [call("main", "w", "t2", "tc-m")]);
		const c = await m.complete(run2, "main", t.project);
		assert.ok(c.ok);
		// done should now be ready even though optional failed (continueOnError)
		assert.ok(
			c.batch.items.some((i) => i.node === "done"),
			"done should be issued",
		);
	} finally {
		await t.cleanup();
	}
});

test("subagent isError → node failed automatically", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec: SIMPLE });
		const d = s.batch!.items[0]!;
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run, [call(d.node, d.agent, d.task, "tc-err", true)]);
		assert.equal(run.nodes[d.node]!.state, "failed");
		const c = await m.complete(run, d.node, t.project);
		assert.ok(!c.ok);
		assert.match(c.error!, /failed/);
	} finally {
		await t.cleanup();
	}
});

test("B1 regression: loop body is not issued until the owner's needs pass", async () => {
	const t = await tmpRoots();
	try {
		const spec = JSON.stringify({
			name: "loop-deps",
			nodes: {
				gate: { agent: "worker", task: "t-gate" },
				body: { agent: "worker", task: "t-body" },
				loop: {
					agent: "ignored",
					task: "ignored",
					needs: ["gate"],
					loop: { body: "body", maxIterations: 2 },
				},
			},
		});
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec });
		assert.ok(s.ok);
		assert.deepEqual(
			s.batch!.items.map((i) => i.node).sort(),
			["gate"],
			"body must wait for the owner's dependency (gate)",
		);

		// complete the gate → body is now issuable
		const gate = s.batch!.items.find((i) => i.node === "gate")!;
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run, [call(gate.node, gate.agent, gate.task, "tc-g")]);
		const c = await m.complete(run, "gate", t.project);
		assert.ok(c.ok, c.error);
		assert.ok(c.batch.items.some((i) => i.node === "body"), "body issued after gate");
	} finally {
		await t.cleanup();
	}
});

test("B2 regression: a ready node (incl. loop body) is never re-issued", async () => {
	const t = await tmpRoots();
	try {
		const spec = JSON.stringify({
			name: "no-phantom",
			nodes: {
				body: { agent: "worker", task: "t" },
				loop: { agent: "ignored", task: "ignored", loop: { body: "body", maxIterations: 2 } },
			},
		});
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec });
		assert.ok(s.ok);
		assert.equal(s.batch!.items.length, 1);
		const issuedAtFirst = s.batch!.items[0]!.node;
		assert.equal(issuedAtFirst, "body");
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		const issuedCountBefore = run.issuedCount;
		// re-compute the batch — nothing may be re-issued (B2 phantom)
		const batch2 = computeBatch(run);
		assert.equal(batch2.items.length, 0, "ready body must not be re-issued");
		assert.equal(run.issuedCount, issuedCountBefore, "issuedCount must not inflate");
	} finally {
		await t.cleanup();
	}
});

test("B3 regression: resume re-issues READY (issued, never executed) nodes too", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec: SIMPLE });
		assert.ok(s.ok);
		// node issued but NEVER executed → state "ready" in the snapshot
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		assert.equal(run.nodes["discover"]!.state, "ready");

		const m2 = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const res = await m2.start({ resumeRunId: s.runId! });
		assert.ok(res.ok, res.error);
		assert.ok(
			res.batch!.items.some((i) => i.node === "discover"),
			"ready node must be re-issued on resume",
		);
	} finally {
		await t.cleanup();
	}
});

test("H1 regression: an unfinished subagent call (no execution_end) is not attributable", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec: SIMPLE });
		assert.ok(s.ok);
		const d = s.batch!.items[0]!;
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		// call observed but execution NOT finished → no attribution
		await m.ingestCalls(run, [call(d.node, d.agent, d.task, "tc-h1", false, false)]);
		assert.equal(run.nodes[d.node]!.state, "ready", "unfinished call must not mark running");
		const c = await m.complete(run, d.node, t.project);
		assert.ok(!c.ok);
		assert.match(c.error!, /no execution evidence/);
	} finally {
		await t.cleanup();
	}
});

test("M1 regression: rejected continueOnError checkpoint does not block dependents", async () => {
	const t = await tmpRoots();
	try {
		const spec = JSON.stringify({
			name: "ckpt-soft",
			nodes: {
				ckpt: { checkpoint: true, continueOnError: true },
				work: { agent: "worker", task: "t" },
				done: { agent: "worker", task: "t2", needs: ["ckpt", "work"] },
			},
		});
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec });
		assert.ok(s.ok);
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		// reject the soft checkpoint → dependent must NOT be blocked
		const rj = await m.resolveCheckpoint(run, "ckpt", false, "skip it");
		assert.ok(rj.ok);
		assert.equal(run.nodes["done"]!.state, "queued", "done must stay queued, not blocked");
	} finally {
		await t.cleanup();
	}
});

test("M2 regression: explicit finish list defeats continueOnError", async () => {
	const t = await tmpRoots();
	try {
		const spec = JSON.stringify({
			name: "finish-required",
			finish: ["opt"],
			nodes: {
				opt: { agent: "worker", task: "t", continueOnError: true },
			},
		});
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec });
		assert.ok(s.ok);
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		await m.ingestCalls(run, [call("opt", "worker", "t", "tc-opt")]);
		const f = await m.fail(run, "opt", "intentional");
		assert.ok(f.ok);
		const fin = await m.finish(run);
		assert.ok(!fin.ok, "explicit finish node must fail the workflow even with continueOnError");
	} finally {
		await t.cleanup();
	}
});

test("M4 regression: stale invocation (ts < issue time) is not attributed", async () => {
	const t = await tmpRoots();
	try {
		const m = new RunManager({
			project: t.project,
			user: t.user,
			sessionId: t.sessionId,
		});
		const s = await m.start({ spec: SIMPLE });
		assert.ok(s.ok);
		const d = s.batch!.items[0]!;
		const run = (await loadRunAny(
			{ project: t.project, user: t.user, sessionId: t.sessionId },
			s.runId!,
		))!.run;
		// invocation timestamp BEFORE the node was issued
		const stale = { toolCallId: "tc-stale", ts: 1, agent: d.agent, task: d.task, isError: false, finished: true };
		await m.ingestCalls(run, [stale]);
		assert.equal(run.nodes[d.node]!.state, "ready", "stale call must not be attributed");
	} finally {
		await t.cleanup();
	}
});
