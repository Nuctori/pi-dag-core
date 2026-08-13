/**
 * Direct evidence-chain tests (G2): normalizeInvocations / attributeInvocations
 * / parseCheck / checkArtifacts — exercised head-on, not only through the
 * manager facade.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	normalizeInvocations,
	attributeInvocations,
	parseCheck,
	checkArtifacts,
	firstDiff,
} from "../src/evidence.js";
import type { NodeSpec } from "../src/types.js";

test("normalizeInvocations: single form", () => {
	const calls = normalizeInvocations({
		toolCallId: "t1",
		ts: 10,
		input: { agent: "scout", task: "do x" },
		isError: false,
		finished: true,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.agent, "scout");
	assert.equal(calls[0]!.finished, true);
});

test("normalizeInvocations: parallel tasks[] form shares toolCallId", () => {
	const calls = normalizeInvocations({
		toolCallId: "t1",
		ts: 10,
		input: {
			tasks: [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
			],
		},
		isError: false,
		finished: true,
	});
	assert.equal(calls.length, 2);
	assert.ok(calls.every((c) => c.toolCallId === "t1"));
});

test("normalizeInvocations: chain form yields nothing (out of v0 protocol)", () => {
	const calls = normalizeInvocations({
		toolCallId: "t1",
		ts: 10,
		input: { chain: [{ agent: "a", task: "1" }] },
		isError: false,
		finished: true,
	});
	assert.equal(calls.length, 0);
});

test("attributeInvocations: matches by agent+task, respects issue order and staleness", () => {
	const pending = [
		{ node: "a", agent: "scout", task: "T", issuedAt: 100 },
		{ node: "b", agent: "scout", task: "T", issuedAt: 200 },
	];
	const consumed = new Set<string>();
	// stale (ts < issuedAt) → ignored
	const stale = {
		toolCallId: "s",
		ts: 50,
		agent: "scout",
		task: "T",
		isError: false,
		finished: true,
	};
	assert.deepEqual(attributeInvocations(pending, [stale], consumed), []);
	// in-order attribution: first matching pending node wins
	const one = {
		toolCallId: "1",
		ts: 150,
		agent: "scout",
		task: "T",
		isError: false,
		finished: true,
	};
	const attrs = attributeInvocations(pending, [one], consumed);
	assert.equal(attrs.length, 1);
	assert.equal(attrs[0]!.node, "a");
});

test("attributeInvocations: quote/whitespace drift is tolerated (LLM re-emission)", () => {
	// Real failure from D:\node\follow_me sessions (iter33): the issued task
	// used 'single quotes', the subagent call re-emitted them as "double
	// quotes" — verbatim matching rejected it 6 times until dag_abort.
	const issued =
		"只读审计（cwd=D:/node/codeaudit）。fix-audit 曾记'A1 站数抬到 600+'，实测 970。任务：枚举调用点。";
	const reemitted = issued.replaceAll("'", '"').replaceAll("  ", " ");
	const pending = [
		{ node: "audit", agent: "scout", task: issued, issuedAt: 100 },
	];
	const consumed = new Set<string>();
	const attrs = attributeInvocations(
		pending,
		[
			{
				toolCallId: "t1",
				ts: 200,
				agent: "scout",
				task: reemitted,
				isError: false,
				finished: true,
			},
		],
		consumed,
	);
	assert.equal(attrs.length, 1);
	assert.equal(attrs[0]!.node, "audit");
});

test("attributeInvocations: substantive edit (added words) still not attributed", () => {
	const pending = [
		{ node: "audit", agent: "scout", task: "T do the thing", issuedAt: 100 },
	];
	const consumed = new Set<string>();
	const attrs = attributeInvocations(
		pending,
		[
			{
				toolCallId: "t1",
				ts: 200,
				agent: "scout",
				task: 'T do "the" thing and more',
				isError: false,
				finished: true,
			},
		],
		consumed,
	);
	assert.equal(attrs.length, 0);
});

test("firstDiff: locates the first meaningful divergence with context", () => {
	assert.equal(firstDiff("abc 'def' ghi", 'abc "def" ghi'), null); // quote-only drift
	const d = firstDiff("abc def ghi", "abc xyz ghi");
	assert.ok(d && d.includes("char 4"), d ?? "");
	assert.ok(d && d.includes("expected"), d ?? "");
	assert.equal(firstDiff("same text", "same text"), null);
});

test("parseCheck: valid and invalid forms", () => {
	assert.deepEqual(parseCheck(undefined), {
		type: "exists",
		pattern: undefined,
	});
	assert.deepEqual(parseCheck("nonEmpty"), { type: "nonEmpty" });
	assert.deepEqual(parseCheck("grep:APPROVED"), {
		type: "grep",
		pattern: "APPROVED",
	});
	assert.equal(parseCheck("bogus"), null);
});

test("checkArtifacts: exists/nonEmpty/grep/mtime/symlink-escape", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dag-evidence-"));
	try {
		const issuedAt = Date.now();
		const specNode: NodeSpec = {
			agent: "w",
			task: "t",
			produces: [
				{ path: "ok.md", check: "nonEmpty" },
				{ path: "approved.md", check: "grep:APPROVED" },
				{ path: "missing.md", check: "exists" },
			],
		};
		await new Promise((r) => setTimeout(r, 5)); // ensure mtime strictly after issuedAt
		await writeFile(join(dir, "ok.md"), "content");
		await writeFile(join(dir, "approved.md"), "APPROVED here");

		const res = await checkArtifacts(dir, specNode, issuedAt);
		assert.equal(res.ok, false); // missing.md fails
		const byPath = new Map(res.evidence.map((e) => [e.path, e]));
		assert.equal(byPath.get("ok.md")!.nonEmpty, true);
		assert.equal(byPath.get("approved.md")!.grepMatch, true);
		assert.equal(byPath.get("missing.md")!.exists, false);
		assert.ok(res.hashes["ok.md"], "sha256 recorded");
		// P0-regression: no duplicate evidence entries (the real bug that made
		// IMPLEMENTATION.md appear twice in follow_me sessions)
		assert.equal(res.evidence.length, 3);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("P0: directories are valid artifacts — nonEmpty = has entries, fresh = new entry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dag-evidence-dir-"));
	try {
		const specNode: NodeSpec = {
			agent: "w",
			task: "t",
			produces: [{ path: "src/", check: "nonEmpty" }],
		};
		const issuedAt = Date.now();
		// stale dir (created before issue, no new entries) → fails freshness
		await mkdir(join(dir, "src"));
		let res = await checkArtifacts(dir, specNode, issuedAt);
		assert.equal(res.ok, false, "empty dir must fail nonEmpty");
		// write an entry AFTER issue → passes
		await new Promise((r) => setTimeout(r, 5));
		await writeFile(join(dir, "src", "index.js"), "x");
		res = await checkArtifacts(dir, specNode, issuedAt);
		assert.equal(res.ok, true, "dir with a fresh entry must pass");
		const e = res.evidence[0]!;
		assert.equal(e.nonEmpty, true);
		assert.equal(e.mtimeAfterIssue, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("P0-regression: a freshly created EMPTY directory passes the default exists check", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dag-evidence-emptydir-"));
	try {
		const specNode: NodeSpec = {
			agent: "w",
			task: "t",
			produces: [{ path: "out/" }], // default exists check
		};
		const issuedAt = Date.now();
		await new Promise((r) => setTimeout(r, 5));
		await mkdir(join(dir, "out")); // created AFTER issue, empty
		const res = await checkArtifacts(dir, specNode, issuedAt);
		assert.equal(
			res.ok,
			true,
			"fresh empty dir must pass exists: " + JSON.stringify(res.evidence),
		);
		const e = res.evidence[0]!;
		assert.equal(e.exists, true);
		assert.equal(e.mtimeAfterIssue, true);
		// an empty dir whose mtime predates the issue must still fail freshness
		const staleDir = join(dir, "stale");
		await mkdir(staleDir);
		await new Promise((r) => setTimeout(r, 5));
		const res2 = await checkArtifacts(
			dir,
			{ ...specNode, produces: [{ path: "stale/" }] },
			Date.now(),
		);
		assert.equal(res2.ok, false, "stale empty dir must fail freshness");
		assert.match(res2.evidence[0]!.detail ?? "", /stale artifact/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
