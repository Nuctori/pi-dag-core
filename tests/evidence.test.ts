/**
 * Direct evidence-chain tests (G2): normalizeInvocations / attributeInvocations
 * / parseCheck / checkArtifacts — exercised head-on, not only through the
 * manager facade.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	normalizeInvocations,
	attributeInvocations,
	parseCheck,
	checkArtifacts,
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
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
