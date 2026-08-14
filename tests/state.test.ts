/**
 * state.ts tests — write boundary, atomicity, recovery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
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

test("P1: snapshot smuggling an invalid spec is rejected on load", async () => {
	const r = await tmpRoots();
	try {
		const parsed = parseSpec(SPEC);
		assert.ok(parsed.ok);
		const run = freshRunFromSpec(parsed.spec, "run-smuggle", "project");
		await persistRun(r, run);
		// tamper: replace the embedded spec with an invalid one
		const file = join(runDir(r, "project", "run-smuggle"), "snapshot.json");
		const snap = JSON.parse(await readFile(file, "utf8"));
		snap.spec.nodes.a.produces = [{ path: "a.md", check: "grep:(" }];
		await writeFile(file, JSON.stringify(snap));
		assert.equal(
			await loadRun(r, "project", "run-smuggle"),
			null,
			"tampered snapshot must not load",
		);
	} finally {
		await rm(r.project, { recursive: true, force: true });
	}
});

test("P1: snapshot with topologically ordered duplicate payloads still loads (backward compat)", async () => {
	const r = await tmpRoots();
	try {
		const spec = parseSpec(
			JSON.stringify({
				name: "ordered-dup",
				nodes: {
					a: { agent: "w", task: "same payload" },
					b: { agent: "w", task: "same payload", needs: ["a"] },
				},
			}),
		);
		assert.ok(
			spec.ok,
			"ordered duplicates must validate (no parallel collision)",
		);
		const run = freshRunFromSpec(spec.spec, "run-bc", "project");
		await persistRun(r, run);
		assert.ok(
			await loadRun(r, "project", "run-bc"),
			"pre-existing runs with ordered duplicate payloads must stay reachable after upgrade",
		);
	} finally {
		await rm(r.project, { recursive: true, force: true });
	}
});

test("L-A1: snapshot, audit ledger and definitions are 0o600 (never world-readable)", async () => {
	if (process.platform === "win32") return; // POSIX permission bits only
	const r = await tmpRoots();
	try {
		const parsed = parseSpec(SPEC);
		assert.ok(parsed.ok);
		const run = freshRunFromSpec(parsed.spec, "run-perm", "project");
		await persistRun(r, run);
		await appendEvent(r, run, "start", { spec: "demo" });
		await saveDefinition(r, "project", "permdef", SPEC);
		for (const f of [
			join(runDir(r, "project", "run-perm"), "snapshot.json"),
			join(runDir(r, "project", "run-perm"), "events.jsonl"),
			join(r.project, ".pi", "workflows", "permdef.json"),
		]) {
			const st = await stat(f);
			assert.equal(
				st.mode & 0o077,
				0,
				`${f} must not be group/world readable (task text is sensitive)`,
			);
		}
		// migration: a pre-0.1.7 0644 snapshot heals on load
		const old = freshRunFromSpec(parsed.spec, "run-old", "project");
		const oldFile = join(runDir(r, "project", "run-old"), "snapshot.json");
		await writeFile(oldFile, JSON.stringify(old));
		await loadRun(r, "project", "run-old");
		const healed = await stat(oldFile);
		assert.equal(
			healed.mode & 0o077,
			0,
			"old 0644 snapshot must be tightened on load",
		);
	} finally {
		await rm(r.project, { recursive: true, force: true });
	}
});

test("L-R2: events.jsonl rotates to events.1.jsonl past 2 MB", async () => {
	const r = await tmpRoots();
	try {
		const parsed = parseSpec(SPEC);
		assert.ok(parsed.ok);
		const run = freshRunFromSpec(parsed.spec, "run-rot", "project");
		await persistRun(r, run);
		const dir = runDir(r, "project", "run-rot");
		const file = join(dir, "events.jsonl");
		// oversized ledger (past the 2 MB ceiling)
		await writeFile(file, "x".repeat(2 * 1024 * 1024 + 1024));
		await appendEvent(r, run, "complete", { node: "a", result: "ok" });
		const rotated = await readFile(join(dir, "events.1.jsonl"), "utf8");
		assert.ok(
			rotated.length > 2 * 1024 * 1024,
			"oversized ledger must be rotated aside",
		);
		const current = await readFile(file, "utf8");
		assert.match(current, /"complete"/);
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
