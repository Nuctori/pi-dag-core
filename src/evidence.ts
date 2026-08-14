/**
 * evidence.ts — CI-style evidence gates.
 *
 * The state machine is the source of truth for *what may happen next*;
 * this module is the source of truth for *whether it actually happened*.
 *
 * Evidence model (three links in a chain):
 *   1. launch attestation — the subagent call was OBSERVED by the core
 *      (captured from the tool_call event stream; not reported by the AI),
 *      and its arguments match the issued payload verbatim;
 *   2. exit status — the observed call did not error;
 *   3. artifacts — declared products exist, are non-empty, were written
 *      after the node was issued, and carry a recorded sha256 (plus optional
 *      grep/json checks).
 *
 * Attribution is done by payload matching against pending issued payloads:
 * the AI cannot fabricate evidence because the core watched the real call.
 */
import { createHash } from "node:crypto";
import { readFile, stat, realpath, readdir } from "node:fs/promises";
import { resolve, sep, join } from "node:path";
import type {
	ArtifactEvidence,
	NodeSpec,
	SubagentInvocation,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Invocation normalization (from the subagent tool_call args)          */
/* ------------------------------------------------------------------ */

export interface RawSubagentCall {
	toolCallId: string;
	ts: number;
	input: Record<string, unknown>;
	isError: boolean;
	/** false until tool_execution_end is observed (H1: execution must finish). */
	finished: boolean;
	runId?: string;
}

/**
 * Normalize a subagent tool call into 1..N invocations.
 * Supports the built-in subagent single form ({agent, task}) and the
 * parallel form ({tasks: [{agent, task, ...}]}). Chain form is out of
 * protocol for v0 (each node = exactly one subagent call) — it yields
 * no invocations.
 */
export function normalizeInvocations(
	call: RawSubagentCall,
): SubagentInvocation[] {
	const out: SubagentInvocation[] = [];
	const base = {
		toolCallId: call.toolCallId,
		ts: call.ts,
		isError: call.isError,
		finished: call.finished,
		runId: call.runId,
	};

	const single = call.input as { agent?: unknown; task?: unknown };
	if (typeof single.agent === "string" && typeof single.task === "string") {
		out.push({ ...base, agent: single.agent, task: single.task });
		return out;
	}

	const tasks = (call.input as { tasks?: unknown }).tasks;
	if (Array.isArray(tasks)) {
		for (const t of tasks) {
			const o = t as { agent?: unknown; task?: unknown };
			if (typeof o.agent === "string" && typeof o.task === "string") {
				out.push({ ...base, agent: o.agent, task: o.task });
			}
		}
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Payload matching (launch attestation)                               */
/* ------------------------------------------------------------------ */

export interface PendingPayload {
	node: string;
	agent: string;
	task: string;
	issuedAt: number;
}

export interface Attribution {
	node: string;
	invocation: SubagentInvocation;
}

/**
 * Normalize a task string for attribution comparison.
 *
 * The AI re-emits the issued task when calling subagent, and LLM tokenizers
 * routinely swap quote glyphs ('x' → "x", 'x' → 'x') and collapse whitespace
 * runs. Those edits are semantically invisible — treat them as equal. ANY
 * other difference (added/removed words, reordering, truncation) stays a
 * mismatch, so the cannot-fabricate property of payload matching is intact.
 */
export function normalizeTask(s: string): string {
	return s.replace(/[''""]/g, '"').replace(/\s+/g, " ");
}

/**
 * Locate the first meaningful difference between an issued task and the
 * observed subagent task, for diagnostics. Returns a compact line, or null
 * when the two match under normalizeTask.
 */
export function firstDiff(expected: string, actual: string): string | null {
	const a = normalizeTask(expected);
	const b = normalizeTask(actual);
	if (a === b) return null;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) {
			return (
				`task differs at char ${i}: expected ${JSON.stringify(a[i])}, observed ${JSON.stringify(b[i])}\n` +
				`  expected …${a.slice(Math.max(0, i - 24), i + 40)}…\n` +
				`  observed …${b.slice(Math.max(0, i - 24), i + 40)}…`
			);
		}
	}
	return `task length differs: expected ${a.length} chars, observed ${b.length}`;
}

/**
 * Match captured invocations against pending issued payloads.
 * Deterministic: an invocation is attributed to the earliest-issued pending
 * node whose agent+task match exactly AND whose timestamp is not before the
 * issue time (M4: stale/replayed events from an earlier attempt cannot
 * consume a fresh iteration). Non-matching invocations are ignored (the AI
 * may call subagent for unrelated work mid-run). Returns one attribution per
 * invocation, in call order.
 */
export function attributeInvocations(
	pending: PendingPayload[],
	invocations: SubagentInvocation[],
	consumed: Set<string>,
): Attribution[] {
	const attributions: Attribution[] = [];
	// clone pending so we can consume in order
	const pool = [...pending].sort((a, b) => a.issuedAt - b.issuedAt);
	for (const inv of invocations) {
		// Parallel tasks share one toolCallId; dedupe is by (toolCallId, agent, task).
		const key = `${inv.toolCallId}|${inv.agent}|${inv.task}`;
		if (consumed.has(key)) continue;
		const normTask = normalizeTask(inv.task);
		const match = pool.find(
			(p) =>
				!consumed.has(p.node) &&
				p.agent === inv.agent &&
				normalizeTask(p.task) === normTask &&
				inv.ts >= p.issuedAt, // M4: no stale attribution
		);
		if (!match) continue;
		consumed.add(key);
		consumed.add(match.node);
		attributions.push({ node: match.node, invocation: inv });
	}
	return attributions;
}

/* ------------------------------------------------------------------ */
/* Artifact gates                                                      */
/* ------------------------------------------------------------------ */

export function parseCheck(
	check: string | undefined,
): { type: "exists" | "nonEmpty" | "json" | "grep"; pattern?: string } | null {
	if (!check) return { type: "exists", pattern: undefined };
	if (check === "exists" || check === "nonEmpty" || check === "json")
		return { type: check };
	if (check.startsWith("grep:"))
		return { type: "grep", pattern: check.slice(5) };
	return null;
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

/** Freshness tolerance for coarse mtime granularity (FAT/SMB ~2s). */
const FRESH_TOLERANCE_MS = 2000;

/**
 * Verify a node's declared artifacts on disk.
 * `root` is the artifact base dir (project cwd for project runs).
 * `issuedAt` is used for the mtime ordering check (artifact must have been
 * written after the node was issued — blocks "reused an old file").
 */
export async function checkArtifacts(
	root: string,
	specNode: NodeSpec,
	issuedAt: number,
	freshnessAnchor?: number,
): Promise<{
	ok: boolean;
	hashes: Record<string, string>;
	evidence: ArtifactEvidence[];
}> {
	const evidence: ArtifactEvidence[] = [];
	const hashes: Record<string, string> = {};
	let ok = true;
	const HASH_CAP = 64 * 1024 * 1024; // 64 MB — never read huge artifacts whole for hashing
	// P1 (F8): freshness is judged against the ACTUAL execution start (the
	// observed subagent launch) when known — not the issue instant — with a
	// 2s tolerance for coarse filesystem mtime granularity (FAT/SMB) and
	// same-tick writes. A legitimately-fresh artifact must never be falsely
	// rejected as stale (that forces a re-run = double execution).
	const anchor = (freshnessAnchor ?? issuedAt) - FRESH_TOLERANCE_MS;

	for (const a of specNode.produces ?? []) {
		const parsed = parseCheck(a.check);
		const abs = resolve(root, a.path);
		const entry: ArtifactEvidence = {
			path: a.path,
			check: a.check,
			exists: false,
			nonEmpty: false,
			mtimeAfterIssue: false,
		};

		try {
			const st = await stat(abs);
			// M6: resolve symlinks — an artifact that points OUTSIDE the project
			// root is not acceptable evidence.
			let contained = true;
			try {
				const real = await realpath(abs);
				const realRoot = await realpath(root);
				contained = real === realRoot || real.startsWith(realRoot + sep);
			} catch {
				contained = false;
			}
			entry.exists = true;
			if (!contained) {
				entry.detail = "artifact resolves outside the project root (symlink?)";
				ok = false;
				evidence.push(entry);
				continue;
			}
			// P0: directories are legitimate artifacts. nonEmpty = the directory
			// has entries; freshness = at least one entry was written after the
			// node was issued (the dir's own mtime predates the run). Seed with
			// the dir's own mtime: an EMPTY dir has no entries to scan, and a
			// freshly created empty dir is legit `exists` evidence (regression:
			// seeding 0 made every new empty dir fail as "stale").
			if (st.isDirectory()) {
				const entries = await readdir(abs);
				entry.nonEmpty = entries.length > 0;
				let newest = st.mtimeMs;
				for (const name of entries) {
					try {
						const es = await stat(join(abs, name));
						if (es.mtimeMs > newest) newest = es.mtimeMs;
					} catch {
						// ignore unreadable entries
					}
				}
				entry.mtimeAfterIssue = newest >= anchor;
			} else {
				entry.nonEmpty = st.size > 0;
				entry.mtimeAfterIssue = st.mtimeMs >= anchor;
			}
			if (st.isFile() && st.size <= HASH_CAP) {
				const buf = await readFile(abs);
				const hash = sha256(buf);
				entry.sha256 = hash;
				hashes[a.path] = hash;

				if (parsed?.type === "grep" && parsed.pattern) {
					// P0-4: a tampered snapshot can smuggle an invalid pattern
					// past spec validation — fail the gate with the REAL reason
					// instead of a lying "not found". (ReDoS hang is not
					// catchable here; snapshot re-validation on load covers it.)
					try {
						entry.grepMatch = new RegExp(parsed.pattern).test(
							buf.toString("utf8"),
						);
					} catch {
						entry.detail = `invalid grep pattern "${parsed.pattern}"`;
					}
				}
				if (parsed?.type === "json") {
					try {
						JSON.parse(buf.toString("utf8"));
						entry.jsonOk = true;
					} catch {
						entry.jsonOk = false;
					}
				}
			} else if (st.isFile() && st.size > HASH_CAP) {
				entry.detail =
					"artifact larger than 64 MB — hash skipped, existence/freshness still verified";
			}
		} catch {
			// stat/read failed → file missing; entry defaults stand
		}

		if (parsed?.type === "nonEmpty" && (!entry.exists || !entry.nonEmpty)) {
			entry.detail = `missing or empty — expected at ${abs}; produces paths are RELATIVE to the session cwd — if the subagent wrote it under its own working dir, copy/move it here`;
			ok = false;
		} else if (parsed?.type === "grep" && (!entry.exists || !entry.grepMatch)) {
			// P0-4: entry.detail may already name an invalid pattern — don't
			// overwrite the real reason with a misleading "not found".
			entry.detail ??= `grep "${parsed.pattern}" not found`;
			ok = false;
		} else if (parsed?.type === "json" && (!entry.exists || !entry.jsonOk)) {
			entry.detail = "not valid JSON";
			ok = false;
		} else if (parsed?.type === "exists" && !entry.exists) {
			entry.detail = `missing — expected at ${abs}; produces paths are RELATIVE to the session cwd — if the subagent wrote it under its own working dir, copy/move it here`;
			ok = false;
		} else if (entry.exists && !entry.mtimeAfterIssue) {
			entry.detail = "written before the node was issued (stale artifact)";
			ok = false;
		}
		evidence.push(entry);
	}
	return { ok, hashes, evidence };
}

/** Human-readable evidence report. */
export function formatEvidence(evidence: ArtifactEvidence[]): string {
	return evidence
		.map((e) => {
			const checks = [
				e.exists ? "exists" : "MISSING",
				e.nonEmpty ? "non-empty" : "empty",
				e.mtimeAfterIssue ? "fresh" : "STALE",
				e.grepMatch !== undefined ? (e.grepMatch ? "grep✓" : "grep✗") : null,
				e.jsonOk !== undefined ? (e.jsonOk ? "json✓" : "json✗") : null,
				e.sha256 ? `sha256:${e.sha256.slice(0, 12)}` : null,
			].filter(Boolean);
			return `  - ${e.path} [${checks.join(", ")}]${e.detail ? ` — ${e.detail}` : ""}`;
		})
		.join("\n");
}
