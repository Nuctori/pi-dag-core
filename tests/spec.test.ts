/**
 * spec validation tests — the first gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec } from "../src/spec.js";

const GOOD = JSON.stringify({
	name: "good",
	nodes: {
		a: {
			agent: "scout",
			task: "do a",
			produces: [{ path: "a.md", check: "nonEmpty" }],
		},
		b: { agent: "worker", task: "do b", needs: ["a"] },
		v: {
			agent: "reviewer",
			role: "verifier",
			task: "check {artifacts}",
			needs: ["a", "b"],
		},
		approve: { checkpoint: true, needs: ["v"] },
		done: { agent: "worker", task: "wrap up", needs: ["approve"] },
	},
});

function issuesOf(json: string): string[] {
	const r = parseSpec(json);
	return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
}

test("valid spec passes", () => {
	const r = parseSpec(GOOD);
	assert.ok(r.ok);
});

test("cycle is rejected", () => {
	const bad = JSON.stringify({
		name: "cycle",
		nodes: {
			a: { agent: "w", task: "t", needs: ["b"] },
			b: { agent: "w", task: "t", needs: ["a"] },
		},
	});
	assert.match(issuesOf(bad).join(" "), /cycle/);
});

test("missing dependency is rejected", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: { a: { agent: "w", task: "t", needs: ["ghost"] } },
	});
	assert.match(issuesOf(bad).join(" "), /unknown node/);
});

test("verifier without needs is rejected", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: { a: { agent: "w", role: "verifier", task: "t" } },
	});
	assert.match(issuesOf(bad).join(" "), /verifier node must declare needs/);
});

test("checkpoint with agent is rejected", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: { c: { checkpoint: true, agent: "w" } },
	});
	assert.match(issuesOf(bad).join(" "), /checkpoint node must not define/);
});

test("loop body referenced elsewhere is rejected", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: {
			loop: { agent: "w", task: "t", loop: { body: "body", maxIterations: 2 } },
			body: { agent: "w", task: "t" },
			other: { agent: "w", task: "t", needs: ["body"] },
		},
	});
	assert.match(issuesOf(bad).join(" "), /internal to the loop/);
});

test("overlapping produces paths are rejected", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: {
			a: { agent: "w", task: "t", produces: [{ path: "same.md" }] },
			b: { agent: "w", task: "t", produces: [{ path: "same.md" }] },
		},
	});
	assert.match(issuesOf(bad).join(" "), /overlapping produces/);
});

test("unsafe artifact path is rejected", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: { a: { agent: "w", task: "t", produces: [{ path: "../evil" }] } },
	});
	assert.match(issuesOf(bad).join(" "), /unsafe artifact path/);
});

test("M5: Windows drive-letter artifact paths are rejected", () => {
	for (const p of [
		"C:/Windows/win.ini",
		"C:\\Windows\\win.ini",
		"D:relative.txt",
	]) {
		const bad = JSON.stringify({
			name: "x",
			nodes: { a: { agent: "w", task: "t", produces: [{ path: p }] } },
		});
		assert.match(
			issuesOf(bad).join(" "),
			/unsafe artifact path/,
			`path ${p} must be rejected`,
		);
	}
});

test("P1a: unsafe path message teaches the fix (relative path)", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: {
			a: {
				agent: "w",
				task: "t",
				produces: [{ path: "D:/node/follow_me/critiques/ai.md" }],
			},
		},
	});
	const msg = issuesOf(bad).join(" ");
	assert.match(msg, /relative to the project root/);
	assert.match(msg, /critiques\/ai\.md/);
});

test("P2: duplicate produces path within one node is rejected", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: {
			a: {
				agent: "w",
				task: "t",
				produces: [
					{ path: "IMPLEMENTATION.md", check: "nonEmpty" },
					{ path: "IMPLEMENTATION.md", check: "nonEmpty" },
				],
			},
		},
	});
	assert.match(issuesOf(bad).join(" "), /duplicate produces path/);
});

test("M9: gate field is rejected in v0 (not enforced)", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: { a: { agent: "w", task: "t", gate: { command: "npm test" } } },
	});
	assert.match(issuesOf(bad).join(" "), /gate is not enforced/);
});

test("L4: over-long grep patterns are rejected", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: {
			a: {
				agent: "w",
				task: "t",
				produces: [{ path: "a.md", check: `grep:${"a".repeat(300)}` }],
			},
		},
	});
	assert.match(issuesOf(bad).join(" "), /grep pattern too long/);
});

test("unknown node fields are rejected (strict schema)", () => {
	const bad = JSON.stringify({
		name: "x",
		nodes: { a: { agent: "w", task: "t", sneaky: true } },
	});
	assert.ok(issuesOf(bad).length > 0);
});

test("invalid JSON reports cleanly", () => {
	const r = parseSpec("{ not json");
	assert.ok(!r.ok);
});

test("stallAfterSec policy is accepted", () => {
	const good = JSON.stringify({
		name: "x",
		policy: { stallAfterSec: 120 },
		nodes: { a: { agent: "w", task: "t" } },
	});
	assert.equal(issuesOf(good).length, 0);
});

test("stallAfterSec must be a positive number", () => {
	for (const v of [0, -5, "60"]) {
		const bad = JSON.stringify({
			name: "x",
			policy: { stallAfterSec: v },
			nodes: { a: { agent: "w", task: "t" } },
		});
		assert.ok(issuesOf(bad).length > 0, `stallAfterSec=${v} must be rejected`);
	}
});

test("checkpoint autoAfterSec form is accepted", () => {
	const good = JSON.stringify({
		name: "x",
		nodes: { g: { checkpoint: { autoAfterSec: 60 } } },
	});
	assert.equal(issuesOf(good).length, 0);
});

test("checkpoint autoAfterSec must be positive and alone", () => {
	const bad1 = JSON.stringify({
		name: "x",
		nodes: { g: { checkpoint: { autoAfterSec: 0 } } },
	});
	assert.ok(issuesOf(bad1).length > 0, "autoAfterSec=0 must be rejected");
	const bad2 = JSON.stringify({
		name: "x",
		nodes: { g: { checkpoint: { autoAfterSec: 60, sneaky: true } } },
	});
	assert.ok(issuesOf(bad2).length > 0, "extra fields must be rejected");
});
