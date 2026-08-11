/**
 * User-path E2E coverage — every user journey through the real extension
 * entry point (src/index.ts) driven by the shared mock: start/parallel/
 * verifier/loop/fail-retry/checkpoint/abort/resume/spec-scopes/save/
 * commands/maxAgents/isError. The driver parses the SAME text the AI would
 * see from tool results (batch payloads), so what is asserted is exactly
 * what an agent consumes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootExtension, makePi, type MockPi } from "./helpers/mock-pi.js";

/* ------------------------------ helpers ------------------------------ */

async function tmpProject() {
	const dir = await mkdtemp(join(tmpdir(), "dag-paths-"));
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Parse the "- node: X\n  agent: Y\n  task: Z…" blocks (task runs to block end). */
function parseBatch(
	text: string,
): { node: string; agent: string; task: string }[] {
	const out: { node: string; agent: string; task: string }[] = [];
	for (const block of text.split("- node: ").slice(1)) {
		const lines = block.split("\n");
		const node = lines[0]!.trim();
		const taskIdx = lines.findIndex((l) => /^ {2}task: /.test(l));
		const agent = block.match(/agent: ([^\n]+)/)?.[1]?.trim();
		if (taskIdx < 0 || !agent) continue;
		const task = lines
			.slice(taskIdx)
			.map((l, i) => (i === 0 ? l.replace(/^ {2}task: /, "") : l))
			.join("\n")
			// stop at the batch trailer ("Protocol:" line) — depArtifacts stay
			.replace(/\n\n(?=Protocol:|- node: ).*$/s, "")
			.trim();
		out.push({ node, agent, task });
	}
	return out;
}

let callSeq = 0;
/** Assert there is a batch and return its first item (non-null). */
function firstBatch(text: string, expectName?: string) {
	const items = parseBatch(text);
	assert.ok(items.length > 0, `no batch in:\n${text}`);
	const item = items[0]!;
	if (expectName) assert.equal(item.node, expectName);
	return item;
}
/** Emit the subagent start/end events for one node execution (writes artifacts first). */
async function execNode(
	pi: MockPi,
	dir: string,
	item: { agent: string; task: string },
	opts: { artifacts?: Record<string, string>; isError?: boolean } = {},
) {
	const id = `tc-${++callSeq}`;
	await pi.emit("tool_execution_start", {
		toolCallId: id,
		toolName: "subagent",
		args: { agent: item.agent, task: item.task },
	});
	for (const [p, c] of Object.entries(opts.artifacts ?? {})) {
		await mkdir(join(dir, p).replace(/[^/\\]+$/, ""), { recursive: true });
		await writeFile(join(dir, p), c);
	}
	await pi.emit("tool_execution_end", {
		toolCallId: id,
		toolName: "subagent",
		isError: opts.isError ?? false,
	});
}

function tool(pi: MockPi, name: string) {
	const t = pi.tools.find((x) => x.name === name);
	assert.ok(t, `tool ${name} not registered`);
	return t;
}

async function start(pi: MockPi, dir: string, spec: string) {
	const res = (await tool(pi, "dag_start").execute(
		"c-start",
		{ spec },
		undefined,
		undefined,
		{ cwd: dir },
	)) as {
		content: { type: string; text: string }[];
	};
	const text = res.content[0]?.text ?? "";
	assert.match(text, /Workflow started: runId=/);
	const runId = text.match(/runId=([A-Za-z0-9_-]+)/)![1]!;
	return { runId, text };
}

async function complete(pi: MockPi, dir: string, runId: string, node: string) {
	const res = (await tool(pi, "dag_complete").execute(
		"c-comp",
		{ runId, node },
		undefined,
		undefined,
		{ cwd: dir },
	)) as {
		content: { type: string; text: string }[];
	};
	return res.content[0]?.text ?? "";
}

/* ------------------------------ specs -------------------------------- */

const ONE = JSON.stringify({
	name: "one",
	nodes: {
		a: {
			agent: "w",
			task: "do A",
			produces: [{ path: "a.md", check: "nonEmpty" }],
		},
	},
});

const PARALLEL = JSON.stringify({
	name: "par",
	nodes: {
		a: { agent: "w", task: "do A" },
		b: { agent: "w", task: "do B" },
		c: { agent: "w", task: "do C", needs: ["a", "b"] },
	},
});

const VERIFIER = JSON.stringify({
	name: "ver",
	nodes: {
		discover: {
			agent: "scout",
			task: "Explore and write ctx.md",
			produces: [{ path: "ctx.md", check: "nonEmpty" }],
		},
		review: {
			agent: "reviewer",
			role: "verifier",
			task: "Check {artifacts}",
			needs: ["discover"],
		},
	},
});

const LOOP = JSON.stringify({
	name: "loop",
	nodes: {
		body: {
			agent: "w",
			task: "Write report.md with FIXED",
			produces: [{ path: "report.md", check: "grep:FIXED" }],
		},
		loop: { loop: { body: "body", maxIterations: 3 } },
		done: { agent: "w", task: "wrap", needs: ["loop"] },
	},
});

const CHECKPOINT = JSON.stringify({
	name: "ckpt",
	nodes: {
		discover: { agent: "w", task: "do A" },
		approve: { checkpoint: true, needs: ["discover"] },
		done: { agent: "w", task: "wrap", needs: ["approve"] },
	},
});

/* ------------------------------- tests ------------------------------- */

test("path 6/7: fail → retry → pass → finish", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await start(pi, t.dir, ONE);
		const a = firstBatch(text, "a");

		// execute WITHOUT the artifact → gate fails → complete rejected
		await execNode(pi, t.dir, a);
		let res = await complete(pi, t.dir, runId, a.node);
		assert.match(res, /artifact evidence failed/);

		// retry re-issues the payload
		const retryRes = (await tool(pi, "dag_retry").execute(
			"c-r",
			{ runId, node: a.node },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		const retryText = retryRes.content[0]?.text ?? "";
		assert.match(retryText, /re-issued/);

		// execute WITH the artifact → passes → finish
		await execNode(pi, t.dir, a, { artifacts: { "a.md": "content" } });
		res = await complete(pi, t.dir, runId, a.node);
		assert.match(res, /a passed/);
		const fin = (await tool(pi, "dag_finish").execute(
			"c-f",
			{ runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(fin.content[0]?.text ?? "", /completed/);
	} finally {
		await t.cleanup();
	}
});

test("path 8: subagent isError → node failed → complete rejected", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await start(pi, t.dir, ONE);
		const a = firstBatch(text, "a");
		await execNode(pi, t.dir, a, { isError: true });
		const res = await complete(pi, t.dir, runId, a.node);
		assert.match(res, /failed/);
	} finally {
		await t.cleanup();
	}
});

test("path 3: parallel tasks[] batch executes both roots then the join", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await start(pi, t.dir, PARALLEL);
		const items = parseBatch(text);
		const a = items[0]!;
		const b = items[1]!;
		assert.equal(a.node, "a");
		assert.equal(b.node, "b");

		// ONE subagent call carrying both tasks (parallel form, shared toolCallId)
		const id = `tc-par-${++callSeq}`;
		await pi.emit("tool_execution_start", {
			toolCallId: id,
			toolName: "subagent",
			args: {
				tasks: [
					{ agent: a.agent, task: a.task },
					{ agent: b.agent, task: b.task },
				],
			},
		});
		await pi.emit("tool_execution_end", {
			toolCallId: id,
			toolName: "subagent",
			isError: false,
		});

		assert.match(await complete(pi, t.dir, runId, "a"), /a passed/);
		const afterB = await complete(pi, t.dir, runId, "b");
		assert.match(afterB, /b passed/);
		// join node issued
		const c = firstBatch(afterB, "c");
		await execNode(pi, t.dir, c);
		assert.match(await complete(pi, t.dir, runId, "c"), /c passed/);
	} finally {
		await t.cleanup();
	}
});

test("path 4: verifier fan-in injects dependency artifacts into the payload", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await start(pi, t.dir, VERIFIER);
		const discover = firstBatch(text, "discover");
		await execNode(pi, t.dir, discover, { artifacts: { "ctx.md": "context" } });
		const after = await complete(pi, t.dir, runId, "discover");
		assert.match(after, /discover passed/);
		const review = firstBatch(after, "review");
		// {artifacts} was replaced with the dep product path (visible in the
		// full payload text, not just the first task line)
		assert.match(after, /discover:ctx\.md/);
		assert.doesNotMatch(after, /\{artifacts\}/);
		await execNode(pi, t.dir, review);
		assert.match(await complete(pi, t.dir, runId, "review"), /review passed/);
	} finally {
		await t.cleanup();
	}
});

test("path 5: loop body fails twice then passes; exhaustion caps at maxIterations", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await start(pi, t.dir, LOOP);
		const body = firstBatch(text, "body");

		// iteration 1: no artifact → fail, body re-issued (proven by iteration 2
		// being attributable again rather than "no execution evidence")
		await execNode(pi, t.dir, body);
		let res = await complete(pi, t.dir, runId, "body");
		assert.match(res, /artifact evidence failed/);

		// iteration 2: no artifact → fail again (re-issue + attribution worked)
		await execNode(pi, t.dir, body);
		res = await complete(pi, t.dir, runId, "body");
		assert.match(res, /artifact evidence failed/);

		// iteration 3: artifact present → passes → done issued
		await execNode(pi, t.dir, body, { artifacts: { "report.md": "FIXED" } });
		res = await complete(pi, t.dir, runId, "body");
		assert.match(res, /body passed/);
		const done = firstBatch(res, "done");
		await execNode(pi, t.dir, done);
		assert.match(await complete(pi, t.dir, runId, "done"), /done passed/);
	} finally {
		await t.cleanup();
	}
});

test("path 9: checkpoint human gate — approve unlocks, reject blocks", async () => {
	const t = await tmpProject();
	try {
		// approve path
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await start(pi, t.dir, CHECKPOINT);
		const discover = firstBatch(text, "discover");
		await execNode(pi, t.dir, discover);
		await complete(pi, t.dir, runId, "discover");

		const status = await pi.runCommand(`status ${runId}`, t.dir);
		assert.match(
			status[0]?.text ?? "",
			/⏸ approve/,
			"checkpoint shown as awaiting",
		);

		// human approves via the slash command
		const approved = await pi.runCommand(`approve ${runId} approve`, t.dir);
		assert.match(approved[0]?.text ?? "", /approved/);

		// reject path (separate run)
		const pi2 = makePi();
		await bootExtension(pi2, t.dir);
		const r2 = await start(pi2, t.dir, CHECKPOINT);
		const d2 = firstBatch(r2.text, "discover");
		await execNode(pi2, t.dir, d2);
		await complete(pi2, t.dir, r2.runId, "discover");
		const rejected = await pi2.runCommand(
			`reject ${r2.runId} approve no-go`,
			t.dir,
		);
		assert.match(rejected[0]?.text ?? "", /rejected/);
		const fin = (await tool(pi2, "dag_finish").execute(
			"c-f",
			{ runId: r2.runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(fin.content[0]?.text ?? "", /incomplete/);
	} finally {
		await t.cleanup();
	}
});

test("path 10: abort stops the run; later transitions are refused", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await start(pi, t.dir, ONE);
		const a = firstBatch(text, "a");
		const ab = (await tool(pi, "dag_abort").execute(
			"c-ab",
			{ runId, reason: "changed my mind" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(ab.content[0]?.text ?? "", /aborted/);
		// a later complete on the aborted run is refused
		await execNode(pi, t.dir, a);
		const res = await complete(pi, t.dir, runId, "a");
		assert.match(res, /no transitions allowed/);
	} finally {
		await t.cleanup();
	}
});

test("path 11: resume re-issues an in-flight node in a NEW session", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await start(pi, t.dir, ONE);
		const a = firstBatch(text, "a");
		await execNode(pi, t.dir, a); // attributed → running, never completed

		// brand-new session (fresh extension instance)
		const pi2 = makePi();
		await bootExtension(pi2, t.dir);
		const resumeRes = (await tool(pi2, "dag_start").execute(
			"c-rs",
			{ resumeRunId: runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		const resumeText = resumeRes.content[0]?.text ?? "";
		assert.match(resumeText, /Ready batch/);
		firstBatch(resumeText, "a");
	} finally {
		await t.cleanup();
	}
});

test("path 12/13: /dag save promotes inline spec; dag_start(specName) loads it", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		await start(pi, t.dir, ONE); // sets lastInlineSpec

		const saved = await pi.runCommand("save myflow", t.dir);
		assert.match(saved[0]?.text ?? "", /saved definition "myflow"/);
		const defFile = join(t.dir, ".pi", "workflows", "myflow.json");
		const content = await (await import("node:fs/promises")).readFile(
			defFile,
			"utf8",
		);
		assert.ok(content.includes('"name": "one"'));

		// fresh session loads the project-scope definition by name
		const pi2 = makePi();
		await bootExtension(pi2, t.dir);
		const res = (await tool(pi2, "dag_start").execute(
			"c-n",
			{ specName: "myflow" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		const text = res.content[0]?.text ?? "";
		assert.match(text, /Workflow started/);
		assert.ok(parseBatch(text).length === 1);
	} finally {
		await t.cleanup();
	}
});

test("path 14: /dag list, graph, new, help commands smoke", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		await start(pi, t.dir, ONE);

		const list = await pi.runCommand("list", t.dir);
		assert.match(list[0]?.text ?? "", /runs:/);
		const graph = await pi.runCommand("graph", t.dir);
		assert.match(graph[0]?.text ?? "", /mermaid/);
		const fresh = await pi.runCommand("new", t.dir);
		assert.match(fresh[0]?.text ?? "", /my-workflow/);
		const help = await pi.runCommand("help", t.dir);
		assert.match(help[0]?.text ?? "", /Protocol/);
	} finally {
		await t.cleanup();
	}
});

test("path 17: maxAgents caps issued nodes", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const spec = JSON.stringify({
			name: "cap",
			policy: { maxAgents: 1 },
			nodes: { a: { agent: "w", task: "A" }, b: { agent: "w", task: "B" } },
		});
		const { text } = await start(pi, t.dir, spec);
		assert.equal(
			parseBatch(text).length,
			1,
			"only one node issued under maxAgents",
		);
	} finally {
		await t.cleanup();
	}
});

test("path 5b: loop exhaustion past maxIterations blocks the workflow", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const spec = JSON.stringify({
			name: "loop-exh",
			nodes: {
				body: {
					agent: "w",
					task: "Write report.md with FIXED",
					produces: [{ path: "report.md", check: "grep:FIXED" }],
				},
				loop: { loop: { body: "body", maxIterations: 2 } },
				done: { agent: "w", task: "wrap", needs: ["loop"] },
			},
		});
		const { runId, text } = await start(pi, t.dir, spec);
		const body = firstBatch(text, "body");

		// both iterations fail (no artifact)
		for (let i = 0; i < 2; i++) {
			await execNode(pi, t.dir, body);
			const res = await complete(pi, t.dir, runId, "body");
			assert.match(res, /artifact evidence failed/);
		}
		// loop exhausted → done never issued; finish incomplete
		const fin = (await tool(pi, "dag_finish").execute(
			"c-f",
			{ runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(fin.content[0]?.text ?? "", /incomplete/);
		assert.match(fin.content[0]?.text ?? "", /exhausted/);
	} finally {
		await t.cleanup();
	}
});

test("path 18: explicit finish defeats continueOnError; default inference does not", async () => {
	const t = await tmpProject();
	try {
		// explicit finish listing the soft node → cannot finish
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const spec = JSON.stringify({
			name: "finish-required",
			finish: ["opt"],
			nodes: { opt: { agent: "w", task: "do", continueOnError: true } },
		});
		const { runId, text } = await start(pi, t.dir, spec);
		const opt = firstBatch(text, "opt");
		await execNode(pi, t.dir, opt);
		await tool(pi, "dag_fail").execute(
			"c-f",
			{ runId, node: "opt", reason: "soft fail" },
			undefined,
			undefined,
			{ cwd: t.dir },
		);
		const fin1 = (await tool(pi, "dag_finish").execute(
			"c-f2",
			{ runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(
			fin1.content[0]?.text ?? "",
			/incomplete/,
			"explicit finish must not pass",
		);

		// default inference (no finish list): a failed soft leaf does NOT block
		const pi2 = makePi();
		await bootExtension(pi2, t.dir);
		const spec2 = JSON.stringify({
			name: "soft-default",
			nodes: { opt: { agent: "w", task: "do", continueOnError: true } },
		});
		const r2 = await start(pi2, t.dir, spec2);
		const o2 = firstBatch(r2.text, "opt");
		await execNode(pi2, t.dir, o2);
		await tool(pi2, "dag_fail").execute(
			"c-f",
			{ runId: r2.runId, node: "opt", reason: "soft fail" },
			undefined,
			undefined,
			{ cwd: t.dir },
		);
		const fin2 = (await tool(pi2, "dag_finish").execute(
			"c-f2",
			{ runId: r2.runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(
			fin2.content[0]?.text ?? "",
			/completed/,
			"soft leaf must not block finish",
		);
	} finally {
		await t.cleanup();
	}
});

test("path 6b: dag_fail tool marks a node failed; retry re-issues it", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await start(pi, t.dir, ONE);
		const a = firstBatch(text, "a");
		await execNode(pi, t.dir, a);
		// dag_fail while the node is running/ready
		const fl = (await tool(pi, "dag_fail").execute(
			"c-fl",
			{ runId, node: "a", reason: "blocked externally" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(fl.content[0]?.text ?? "", /marked failed/);
		// complete after fail → refused (must retry)
		const refused = await complete(pi, t.dir, runId, "a");
		assert.match(refused, /failed/);
		// retry → re-issued → pass
		const rt = (await tool(pi, "dag_retry").execute(
			"c-rt",
			{ runId, node: "a" },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(rt.content[0]?.text ?? "", /re-issued/);
		await execNode(pi, t.dir, a, { artifacts: { "a.md": "content" } });
		assert.match(await complete(pi, t.dir, runId, "a"), /a passed/);
	} finally {
		await t.cleanup();
	}
});

test("command edges: unknown run / non-checkpoint approve / bad node are refused", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId } = await start(pi, t.dir, CHECKPOINT);

		const noRun = await pi.runCommand("status run-does-not-exist", t.dir);
		assert.match(noRun[0]?.text ?? "", /not found/);
		const noRunApprove = await pi.runCommand(
			"approve run-does-not-exist approve",
			t.dir,
		);
		assert.match(noRunApprove[0]?.text ?? "", /not found/);

		// approve a non-checkpoint node (discover, not awaiting) → refused
		const badNode = await pi.runCommand(`approve ${runId} discover`, t.dir);
		assert.match(badNode[0]?.text ?? "", /not a checkpoint|not awaiting/);
	} finally {
		await t.cleanup();
	}
});

test("edge: resuming a completed run is refused", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const { runId, text } = await start(pi, t.dir, ONE);
		const a = firstBatch(text, "a");
		await execNode(pi, t.dir, a, { artifacts: { "a.md": "content" } });
		await complete(pi, t.dir, runId, "a");
		await tool(pi, "dag_finish").execute(
			"c-f",
			{ runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		);

		const pi2 = makePi();
		await bootExtension(pi2, t.dir);
		const resumeRes = (await tool(pi2, "dag_start").execute(
			"c-rs",
			{ resumeRunId: runId },
			undefined,
			undefined,
			{ cwd: t.dir },
		)) as {
			content: { type: string; text: string }[];
		};
		assert.match(resumeRes.content[0]?.text ?? "", /not resumable/);
	} finally {
		await t.cleanup();
	}
});

test("trigger: resources_discover registers the dag-workflow skill", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		await bootExtension(pi, t.dir);
		const res = (await pi.emit("resources_discover", { reason: "startup" })) as {
			skillPaths?: string[];
		};
		const dirs = res?.skillPaths ?? [];
		assert.ok(dirs.length === 1, `expected one skill dir, got ${dirs.length}`);
		// the skill file must exist under the advertised path
		const skill = join(dirs[0]!, "dag-workflow", "SKILL.md");
		const stat = await import("node:fs/promises").then((m) => m.stat(skill));
		assert.ok(stat.isFile(), `SKILL.md not found at ${skill}`);
	} finally {
		await t.cleanup();
	}
});
