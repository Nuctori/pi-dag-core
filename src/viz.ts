/**
 * viz.ts — rendering from the run snapshot (single source of truth).
 *
 * The renderer never reconstructs state from the transcript — it renders
 * the persisted snapshot, so what you see is exactly what the state machine
 * believes. Text tree (v0) + mermaid export (v1).
 */
import type { RunState } from "./types.js";

const ICON: Record<string, string> = {
	queued: "·",
	ready: "▶",
	running: "▶",
	passed: "✓",
	failed: "✗",
	blocked: "⊘",
	awaiting_approval: "⏸",
};

export function renderText(run: RunState): string {
	const lines: string[] = [];
	lines.push(
		`run ${run.runId} [${run.scope}] — ${run.status} — spec "${run.spec.name}"`,
	);
	lines.push("");
	for (const name of Object.keys(run.spec.nodes)) {
		const n = run.nodes[name]!;
		const specN = run.spec.nodes[name]!;
		const kind = specN.checkpoint
			? " (checkpoint)"
			: specN.loop
				? ` (loop→${specN.loop.body})`
				: specN.role === "verifier"
					? " (verifier)"
					: "";
		const deps = (specN.needs ?? []).length
			? ` ← ${specN.needs!.join(", ")}`
			: "";
		const info = n.iteration ? ` iter:${n.iteration}` : "";
		const why = n.failReason ? ` — ${n.failReason}` : "";
		lines.push(`  ${ICON[n.state] ?? "?"} ${name}${kind}${deps}${info}${why}`);
	}
	return lines.join("\n");
}

export function renderMermaid(run: RunState): string {
	const lines: string[] = ["```mermaid", "flowchart TD"];
	for (const name of Object.keys(run.spec.nodes)) {
		const specN = run.spec.nodes[name]!;
		// mermaid: first token = node id, bracket content = label — never repeat the name
		const body = specN.checkpoint
			? `[⏸ ${name} — checkpoint]`
			: specN.loop
				? `((${name} — loop))`
				: `[${name}]`;
		lines.push(`    ${name}${body}`);
		for (const d of specN.needs ?? []) lines.push(`    ${d} --> ${name}`);
		if (specN.loop) lines.push(`    ${name} -. body .-> ${specN.loop.body}`);
	}
	const cls: Record<string, string[]> = {};
	for (const [name, n] of Object.entries(run.nodes)) {
		const c =
			n.state === "passed"
				? "pass"
				: n.state === "failed"
					? "fail"
					: n.state === "awaiting_approval"
						? "wait"
						: n.state === "running" || n.state === "ready"
							? "run"
							: "idle";
		(cls[c] ??= []).push(name);
	}
	for (const [c, names] of Object.entries(cls)) {
		lines.push(
			`    classDef ${c} ${c === "pass" ? "fill:#d1fae5" : c === "fail" ? "fill:#fee2e2" : c === "wait" ? "fill:#fef3c7" : c === "run" ? "fill:#dbeafe" : "fill:#f3f4f6"};`,
		);
		lines.push(`    class ${names.join(",")} ${c};`);
	}
	lines.push("```");
	return lines.join("\n");
}
