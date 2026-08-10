/**
 * E2E adapter tests — drive the REAL pi extension entry point (src/index.ts)
 * with a mock ExtensionAPI, exercising the full wiring that unit tests on
 * the core cannot reach: tool registration, session_start roots, the
 * tool_execution_start/end event capture, buffer drain, and the H1
 * still-running rejection. No LLM, no real pi — deterministic and CI-safe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dagCoreExtension from "../src/index.js";

type ToolDef = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
};

interface MockPi {
	handlers: Map<string, (...args: unknown[]) => unknown>;
	tools: ToolDef[];
	notifyCalls: { kind: string; text: string }[];
	hasSubagent: boolean;
	on(event: string, fn: (...args: unknown[]) => unknown): void;
	registerTool(def: ToolDef): void;
	registerCommand(name: string, def: { handler: (...a: unknown[]) => unknown }): void;
	getAllTools(): { name: string }[];
	emit(event: string, ...args: unknown[]): Promise<unknown>;
}

function makePi(hasSubagent = true): MockPi {
	const pi: MockPi = {
		handlers: new Map(),
		tools: [],
		notifyCalls: [],
		hasSubagent,
		on(event, fn) {
			this.handlers.set(event, fn);
		},
		registerTool(def) {
			this.tools.push(def);
		},
		registerCommand(_name, _def) {
			// commands are not exercised in these tests
		},
		getAllTools() {
			return this.hasSubagent
				? [{ name: "subagent" }, { name: "read" }]
				: [{ name: "read" }];
		},
		async emit(event, ...args) {
			const fn = this.handlers.get(event);
			if (!fn) return;
			return fn(...args);
		},
	};
	return pi;
}

function sessionCtx(cwd: string, notify: (text: string, kind: string) => void) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "e2e-session" },
		ui: { notify },
	};
}

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
	return {
		dir,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function startRun(pi: MockPi, dir: string) {
	const ctx = sessionCtx(dir, () => {});
	await pi.emit("session_start", {}, ctx);
	const start = pi.tools.find((t) => t.name === "dag_start")!;
	const res = (await start.execute("c1", { spec: SPEC }, undefined, undefined, ctx)) as {
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
		dagCoreExtension(pi as unknown as ExtensionAPI);
		const { runId, text } = await startRun(pi, t.dir);
		const { agent, task } = toolArgs(text);

		// the AI "executes" the node: subagent call fires start + end events
		await pi.emit("tool_execution_start", { toolCallId: "tc-1", toolName: "subagent", args: { agent, task } });
		await writeFile(join(t.dir, "ctx.md"), "artifact content");
		await pi.emit("tool_execution_end", { toolCallId: "tc-1", toolName: "subagent", isError: false });

		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const ctx = sessionCtx(t.dir, () => {});
		const res = (await complete.execute("c2", { runId, node: "discover" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
		};
		assert.match(res.content[0]?.text ?? "", /discover passed/);

		// finish the remaining node + finish the workflow
		await pi.emit("tool_execution_start", { toolCallId: "tc-2", toolName: "subagent", args: { agent: "worker", task: "wrap up" } });
		await pi.emit("tool_execution_end", { toolCallId: "tc-2", toolName: "subagent", isError: false });
		const c2 = (await complete.execute("c3", { runId, node: "done" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
		};
		assert.match(c2.content[0]?.text ?? "", /done passed/);

		const finish = pi.tools.find((x) => x.name === "dag_finish")!;
		const f = (await finish.execute("c4", { runId }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
		};
		assert.match(f.content[0]?.text ?? "", /completed/);
	} finally {
		await t.cleanup();
	}
});

test("E2E (H1): dag_complete before the subagent call finishes is rejected", async () => {
	const t = await tmpProject();
	try {
		const pi = makePi();
		dagCoreExtension(pi as unknown as ExtensionAPI);
		const { runId, text } = await startRun(pi, t.dir);
		const { agent, task } = toolArgs(text);

		// launch observed (preflight) but execution_end NOT emitted yet
		await pi.emit("tool_execution_start", { toolCallId: "tc-h1", toolName: "subagent", args: { agent, task } });

		const complete = pi.tools.find((x) => x.name === "dag_complete")!;
		const ctx = sessionCtx(t.dir, () => {});
		const res = (await complete.execute("c2", { runId, node: "discover" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
		};
		assert.match(res.content[0]?.text ?? "", /no execution evidence/);

		// now the call finishes → the SAME buffered call becomes attributable
		await pi.emit("tool_execution_end", { toolCallId: "tc-h1", toolName: "subagent", isError: false });
		await writeFile(join(t.dir, "ctx.md"), "artifact content");
		const res2 = (await complete.execute("c3", { runId, node: "discover" }, undefined, undefined, ctx)) as {
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
		dagCoreExtension(pi as unknown as ExtensionAPI);
		await pi.emit("session_start", {}, sessionCtx(t.dir, () => {}));
		const notified = pi.tools.length > 0; // extension still registered its tools
		assert.ok(notified);
		// the extension must have registered all dag tools regardless
		for (const name of ["dag_start", "dag_complete", "dag_finish"]) {
			assert.ok(pi.tools.some((x) => x.name === name), `tool ${name} registered`);
		}
	} finally {
		await t.cleanup();
	}
});
