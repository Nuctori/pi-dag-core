/**
 * state.ts tests — write boundary, atomicity, recovery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runDir,
	safeName,
	saveDefinition,
	loadDefinition,
	listDefinitions,
	persistRun,
	loadRun,
	appendEvent,
} from "../src/state.js";
import { parseSpec } from "../src/spec.js";
import { freshRunFromSpec } from "../src/state.js";

const SPEC = JSON.stringify({
	name: "demo",
	nodes: { a: { agent: "w", task: "t" } },
});

async function tmpRoots() {
	const dir = await mkdtemp(join(tmpdir(), "dagstate-"));
	return { project: dir, user: dir, sessionId: "sess-1" };
}

test("path whitelist: path traversal is rejected, unsafe names are sanitized", () => {
	const r = { project: "/tmp/p", user: "/tmp/u", sessionId: "s" };
	// bare ".." survives sanitization (dots are legal) and must be caught by the escape check
	assert.throws(() => runDir(r, "project", ".."));
	// slashes/absolute prefixes are sanitized into safe single-segment filenames that stay under runs/
	assert.ok(runDir(r, "project", "../x").includes("runs"));
	assert.ok(runDir(r, "project", "/abs").includes("runs"));
	assert.ok(runDir(r, "project", "a/b").includes("runs"));
	assert.ok(runDir(r, "project", "run-abc123").includes("runs"));
});

test("safeName sanitizes", () => {
	assert.equal(safeName("a b/c", "spec"), "a_b_c");
	assert.equal(safeName("run-1", "run"), "run-1");
});

test("definition save/load round-trip (project scope)", async () => {
	const r = await tmpRoots();
	try {
		const file = await saveDefinition(r, "project", "demo", SPEC);
		assert.ok(file.endsWith("demo.json"));
		const def = await loadDefinition(r, "demo");
		assert.equal(def!.scope, "project");
		const parsed = parseSpec(def!.text);
		assert.ok(parsed.ok);
	} finally {
		await rm(r.project, { recursive: true, force: true });
	}
});

test("invalid definitions are refused at save time", async () => {
	const r = await tmpRoots();
	try {
		await assert.rejects(() =>
			saveDefinition(
				r,
				"project",
				"bad",
				JSON.stringify({ name: "bad", nodes: {} }),
			),
		);
	} finally {
		await rm(r.project, { recursive: true, force: true });
	}
});

test("run state persists and reloads (crash recovery path)", async () => {
	const r = await tmpRoots();
	try {
		const parsed = parseSpec(SPEC);
		assert.ok(parsed.ok);
		const run = freshRunFromSpec(parsed.spec, "run-test1", "project");
		await persistRun(r, run);
		await appendEvent(r, run, "start", { spec: "demo" });
		const loaded = await loadRun(r, "project", "run-test1");
		assert.ok(loaded);
		assert.equal(loaded!.spec.name, "demo");
		assert.equal(loaded!.status, "running");
		// audit trail exists
		const ev = await readFile(
			join(runDir(r, "project", "run-test1"), "events.jsonl"),
			"utf8",
		);
		assert.match(ev, /"start"/);
	} finally {
		await rm(r.project, { recursive: true, force: true });
	}
});

test("definition listing covers both scopes", async () => {
	const r = await tmpRoots();
	try {
		await saveDefinition(r, "project", "pdef", SPEC);
		await saveDefinition(r, "user", "udef", SPEC);
		const defs = await listDefinitions(r);
		const names = defs.map((d) => `${d.scope}:${d.name}`);
		assert.ok(names.includes("project:pdef"));
		assert.ok(names.includes("user:udef"));
	} finally {
		await rm(r.project, { recursive: true, force: true });
	}
});

test("definition listing ignores non-JSON files (yaml is v1)", async () => {
	const r = await tmpRoots();
	try {
		await saveDefinition(r, "project", "pdef", SPEC);
		await writeFile(
			join(r.project, ".pi", "workflows", "stray.yaml"),
			"name: stray\n",
		);
		const defs = await listDefinitions(r);
		const names = defs.map((d) => d.name);
		assert.ok(names.includes("pdef"));
		assert.ok(
			!names.includes("stray"),
			"yaml files must not be listed — the v0 loader reads JSON only",
		);
	} finally {
		await rm(r.project, { recursive: true, force: true });
	}
});
