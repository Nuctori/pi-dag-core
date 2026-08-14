/**
 * state.ts — the ONLY module with filesystem write access.
 *
 * Write boundary (from the design contract):
 *   - writes are limited to workflow definitions (3 scopes) and workflow
 *     run state (events.jsonl / snapshot.json / evidence buffering)
 *   - every path is derived from a whitelisted root; user-provided names are
 *     sanitized; ".." / absolute paths / backslash escapes are rejected
 *   - writes are atomic (temp file + rename) so a crash never corrupts state
 *   - the snapshot is the authoritative recoverable state; events.jsonl is
 *     the append-only audit trail
 */
import {
	mkdir,
	readFile,
	rename,
	writeFile,
	readdir,
	rm,
	open,
	stat,
	chmod,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { RunState, Scope, Spec } from "./types.js";
import { createRun } from "./scheduler.js";
import { validateSpec } from "./spec.js";

export interface Roots {
	/** Project root (ctx.cwd). */
	project: string;
	/** User home. */
	user: string;
	/** Session id (for session-scoped runs). */
	sessionId: string;
}

export function defaultRoots(cwd: string, sessionId: string): Roots {
	return { project: cwd, user: homedir(), sessionId };
}

/* ------------------------------------------------------------------ */
/* Path whitelist                                                      */
/* ------------------------------------------------------------------ */

const NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function safeName(name: string, kind: "spec" | "run"): string {
	const clean = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
	if (!NAME_RE.test(clean)) throw new Error(`unsafe ${kind} name: "${name}"`);
	return clean;
}

function underRoot(root: string, ...parts: string[]): string {
	const joined = resolve(root, ...parts);
	if (!joined.startsWith(resolve(root) + sep) && joined !== resolve(root)) {
		throw new Error(`path escapes root: ${parts.join("/")}`);
	}
	return joined;
}

export function defsDir(r: Roots, scope: "project" | "user"): string {
	return scope === "project"
		? underRoot(r.project, ".pi", "workflows")
		: underRoot(r.user, ".pi", "agent", "workflows");
}

export function runsDir(r: Roots, scope: Scope): string {
	switch (scope) {
		case "project":
			return underRoot(r.project, ".pi", "workflows", "runs");
		case "user":
			return underRoot(r.user, ".pi", "agent", "workflows", "runs");
		case "session":
			return underRoot(
				r.user,
				".pi",
				"agent",
				"workflows",
				"runs",
				`s-${safeName(r.sessionId, "run")}`,
			);
		default:
			throw new Error(`unknown scope: ${String(scope)}`);
	}
}

export function runDir(r: Roots, scope: Scope, runId: string): string {
	return underRoot(runsDir(r, scope), safeName(runId, "run"));
}

/* ------------------------------------------------------------------ */
/* Atomic primitives                                                   */
/* ------------------------------------------------------------------ */

async function atomicWrite(file: string, data: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	// L8: unique temp name (no shared ${pid}.tmp collisions) + fsync before
	// rename so a power loss cannot leave a truncated snapshot as the target.
	// 0o600: snapshots/definitions embed the full task text — never world-readable.
	const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	const fh = await open(tmp, "w", 0o600);
	try {
		await fh.writeFile(data, "utf8");
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(tmp, file);
	// P1: fsync the parent directory so the rename itself is durable —
	// without it a power loss can silently roll back the last transition.
	await syncDir(dirname(file));
}

/** Best-effort directory fsync (POSIX durability for rename; Windows lacks it). */
async function syncDir(dir: string): Promise<void> {
	try {
		const fh = await open(dir, "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
	} catch {
		// unsupported platform — file-level fsync still guards the bytes
	}
}

/* ------------------------------------------------------------------ */
/* Definitions (3 scopes)                                              */
/* ------------------------------------------------------------------ */

export async function saveDefinition(
	r: Roots,
	scope: "project" | "user",
	name: string,
	specText: string,
): Promise<string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(specText);
	} catch (e) {
		throw new Error(`spec is not valid JSON: ${(e as Error).message}`);
	}
	const v = validateSpec(parsed);
	if (!v.ok)
		throw new Error(
			`spec invalid: ${v.issues.map((i) => i.message).join("; ")}`,
		);
	const file = underRoot(defsDir(r, scope), `${safeName(name, "spec")}.json`);
	await atomicWrite(file, JSON.stringify(parsed, null, 2) + "\n");
	return file;
}

export async function listDefinitions(
	r: Roots,
): Promise<{ scope: "project" | "user"; name: string; file: string }[]> {
	const out: { scope: "project" | "user"; name: string; file: string }[] = [];
	for (const scope of ["project", "user"] as const) {
		try {
			const dir = defsDir(r, scope);
			for (const f of await readdir(dir)) {
				// v0 definitions are JSON-only (YAML spec is v1) — don't list
				// files the loader can never load.
				if (f.endsWith(".json")) {
					out.push({
						scope,
						name: f.replace(/\.json$/, ""),
						file: join(dir, f),
					});
				}
			}
		} catch {
			// dir missing → no definitions
		}
	}
	return out;
}

export async function loadDefinition(
	r: Roots,
	name: string,
): Promise<{ scope: "project" | "user"; text: string } | null> {
	for (const scope of ["project", "user"] as const) {
		try {
			const file = underRoot(
				defsDir(r, scope),
				`${safeName(name, "spec")}.json`,
			);
			const text = await readFile(file, "utf8");
			return { scope, text };
		} catch {
			// continue to user scope
		}
	}
	return null;
}

/* ------------------------------------------------------------------ */
/* Run state                                                           */
/* ------------------------------------------------------------------ */

export async function persistRun(r: Roots, run: RunState): Promise<void> {
	const dir = runDir(r, run.scope, run.runId);
	await atomicWrite(join(dir, "snapshot.json"), JSON.stringify(run, null, 2));
}

/** Audit-log rotation ceiling: past this size the ledger rolls to events.1.jsonl (latest two generations). */
const MAX_EVENT_LOG = 2 * 1024 * 1024;

/** Append an audit event (best-effort; never throws into the session). */
export async function appendEvent(
	r: Roots,
	run: RunState,
	type: string,
	data: unknown,
): Promise<void> {
	try {
		const dir = runDir(r, run.scope, run.runId);
		await mkdir(dir, { recursive: true });
		const file = join(dir, "events.jsonl");
		const st = await stat(file).catch(() => null);
		if (st && st.size > MAX_EVENT_LOG) {
			// L-R2: rotate instead of growing unboundedly; best-effort like the
			// append itself (snapshot remains authoritative either way).
			await rename(file, join(dir, "events.1.jsonl")).catch(() => {});
		}
		await writeFile(
			file,
			JSON.stringify({ ts: Date.now(), type, runId: run.runId, data }) + "\n",
			// 0o600: audit entries embed task text / reasons — never world-readable.
			{ flag: "a", mode: 0o600 },
		);
	} catch {
		// audit trail is best-effort; snapshot remains authoritative
	}
}

export async function loadRun(
	r: Roots,
	scope: Scope,
	runId: string,
): Promise<RunState | null> {
	try {
		const file = join(runDir(r, scope, runId), "snapshot.json");
		const raw = JSON.parse(await readFile(file, "utf8")) as RunState;
		// L-A1 migration: pre-0.1.7 files may still be 0644 — tighten best-effort
		// on every read so old runs heal without waiting for the next transition.
		await chmod(file, 0o600).catch(() => {});
		// P1: re-validate the embedded spec on load — a tampered snapshot can
		// otherwise smuggle an invalid spec (incl. a pathological grep pattern
		// that hangs dag_complete) past the startup gate. Corrupt → treated as
		// not found, which is also the honest answer for a bad snapshot.
		const v = validateSpec(raw.spec);
		if (!v.ok) return null;
		return raw;
	} catch {
		return null;
	}
}

/** Look up a run across all three scopes (project, user, session). */
export async function loadRunAny(
	r: Roots,
	runId: string,
): Promise<{ run: RunState; scope: Scope } | null> {
	for (const scope of ["project", "user", "session"] as const) {
		const run = await loadRun(r, scope, runId);
		if (run) return { run, scope };
	}
	return null;
}

export async function listRuns(r: Roots): Promise<
	{
		runId: string;
		scope: Scope;
		status: string;
		spec: string;
		createdAt: number;
	}[]
> {
	const out: {
		runId: string;
		scope: Scope;
		status: string;
		spec: string;
		createdAt: number;
	}[] = [];
	for (const scope of ["project", "user", "session"] as const) {
		try {
			const dir = runsDir(r, scope);
			for (const f of await readdir(dir)) {
				if (f.startsWith(".")) continue;
				try {
					const snap = JSON.parse(
						await readFile(join(dir, f, "snapshot.json"), "utf8"),
					) as RunState;
					out.push({
						runId: snap.runId,
						scope,
						status: snap.status,
						spec: snap.spec.name,
						createdAt: snap.createdAt,
					});
				} catch {
					// skip unreadable
				}
			}
		} catch {
			// dir missing
		}
	}
	return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function removeRunDir(
	r: Roots,
	scope: Scope,
	runId: string,
): Promise<void> {
	try {
		await rm(runDir(r, scope, runId), { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

export function freshRunFromSpec(
	spec: Spec,
	runId: string,
	scope: Scope,
	now = Date.now(),
): RunState {
	return createRun(spec, runId, scope, now);
}
