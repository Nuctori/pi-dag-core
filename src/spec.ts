/**
 * spec.ts — workflow spec validation.
 *
 * Pure functions: typebox structural checks + graph checks (cycles, missing
 * deps, duplicate names, role rules, overlapping producers, loop rules).
 * The validator is the first gate: an invalid spec never reaches the
 * scheduler and never persists.
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type {
	Spec,
	ValidationResult,
	ValidationIssue,
	NodeSpec,
	Policy,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Typebox schema — the same schema used at runtime.                    */
/* ------------------------------------------------------------------ */

const ArtifactSpec = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		check: Type.Optional(
			Type.Union([
				Type.Literal("exists"),
				Type.Literal("nonEmpty"),
				Type.Literal("json"),
				Type.String({ pattern: "^grep:" }),
			]),
		),
	},
	{ additionalProperties: false },
);

const LoopSpec = Type.Object(
	{
		body: Type.String({ minLength: 1 }),
		until: Type.Optional(Type.Literal("passed")),
		maxIterations: Type.Optional(Type.Number({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const NodeSpecSchema = Type.Object(
	{
		agent: Type.Optional(Type.String({ minLength: 1 })),
		task: Type.Optional(Type.String({ minLength: 1 })),
		needs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		role: Type.Optional(
			Type.Union([Type.Literal("worker"), Type.Literal("verifier")]),
		),
		produces: Type.Optional(Type.Array(ArtifactSpec)),
		gate: Type.Optional(
			Type.Object(
				{
					command: Type.String({ minLength: 1 }),
					expectExit: Type.Optional(Type.Number()),
				},
				{ additionalProperties: false },
			),
		),
		checkpoint: Type.Optional(Type.Boolean()),
		loop: Type.Optional(LoopSpec),
		continueOnError: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const PolicySchema = Type.Object(
	{
		failFast: Type.Optional(Type.Boolean()),
		maxAgents: Type.Optional(Type.Number({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

export const SpecSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, pattern: "^[a-zA-Z0-9._-]+$" }),
		version: Type.Optional(Type.Number({ minimum: 1 })),
		policy: Type.Optional(PolicySchema),
		nodes: Type.Record(
			Type.String({ pattern: "^[a-zA-Z0-9._-]+$" }),
			NodeSpecSchema,
		),
		finish: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	},
	{ additionalProperties: false },
);

export type SpecStatic = Static<typeof SpecSchema>;

/* ------------------------------------------------------------------ */
/* Structural validation                                               */
/* ------------------------------------------------------------------ */

function issue(issues: ValidationIssue[], path: string, message: string): void {
	issues.push({ path, message });
}

function validateStructural(spec: unknown): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (!Value.Check(SpecSchema, spec)) {
		for (const e of Value.Errors(SpecSchema, spec)) {
			const raw = e as unknown as { path?: unknown };
			const path = typeof raw.path === "string" ? raw.path : "<root>";
			issue(issues, path, e.message);
		}
		return issues;
	}
	return issues;
}

/* ------------------------------------------------------------------ */
/* Graph validation (assumes structural validation passed)             */
/* ------------------------------------------------------------------ */

function validateGraph(s: Spec): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const names = new Set(Object.keys(s.nodes));

	if (names.size === 0) {
		issue(issues, "nodes", "spec must define at least one node");
		return issues;
	}

	for (const [name, n] of Object.entries(s.nodes)) {
		const p = `nodes.${name}`;

		// checkpoint nodes carry no execution payload
		if (n.checkpoint) {
			if (n.agent || n.task || n.produces || n.loop || n.gate) {
				issue(
					issues,
					p,
					"checkpoint node must not define agent/task/produces/loop/gate",
				);
			}
			if (n.role === "verifier") {
				issue(issues, p, "checkpoint node cannot be a verifier");
			}
		} else {
			if (!n.agent)
				issue(issues, p, "missing agent (required unless checkpoint)");
			if (!n.task)
				issue(issues, p, "missing task (required unless checkpoint)");
			// M9: gate is declared-but-not-enforced in v0 — reject it loudly
			// instead of silently accepting a promise the runtime keeps.
			if (n.gate) {
				issue(
					issues,
					`${p}.gate`,
					"gate is not enforced in v0 (transcript cross-check lands in v1) — remove the field",
				);
			}
			if (n.loop && (n.role === "verifier" || n.continueOnError)) {
				issue(issues, p, "loop node cannot be verifier or continueOnError");
			}
			if (n.loop && (n.produces?.length ?? 0) > 0) {
				issue(
					issues,
					p,
					"loop node declares produces; the body node owns artifacts",
				);
			}
		}

		// needs
		for (const d of n.needs ?? []) {
			if (d === name) {
				issue(issues, p, `self-dependency on ${d}`);
			} else if (!names.has(d)) {
				issue(issues, p, `needs unknown node "${d}"`);
			}
		}

		// verifier must have dependencies (fan-in makes no sense otherwise)
		if (n.role === "verifier" && (n.needs?.length ?? 0) === 0) {
			issue(issues, p, "verifier node must declare needs (fan-in)");
		}

		// produces path safety (prevent artifact checks escaping the project):
		// reject absolute paths (POSIX + Windows drive letters), traversal,
		// backslashes, and drive-relative forms (M5).
		for (const a of n.produces ?? []) {
			if (
				a.path.startsWith("/") ||
				a.path.includes("..") ||
				a.path.includes("\\") ||
				/^[a-zA-Z]:[\\/]/.test(a.path) ||
				/^[a-zA-Z]:/.test(a.path)
			) {
				issue(issues, `${p}.produces`, `unsafe artifact path "${a.path}"`);
			}
			// L4: keep grep patterns bounded (ReDoS / accidental megabyte regexes)
			if (a.check?.startsWith("grep:") && a.check.length > 220) {
				issue(
					issues,
					`${p}.produces`,
					`grep pattern too long (${a.check.length} chars, max 220)`,
				);
			}
		}
	}

	// loop body rules
	for (const [name, n] of Object.entries(s.nodes)) {
		if (!n.loop) continue;
		const body = n.loop.body;
		const p = `nodes.${name}.loop`;
		if (!names.has(body)) {
			issue(issues, p, `loop body "${body}" is not a node`);
			continue;
		}
		const bodyNode = s.nodes[body]!;
		if (bodyNode.loop || bodyNode.checkpoint) {
			issue(issues, p, "loop body must be a plain worker node");
		}
		if ((bodyNode.needs?.length ?? 0) > 0) {
			issue(
				issues,
				p,
				`loop body "${body}" must not declare its own needs (they belong to the loop node)`,
			);
		}
		// body must not be referenced by anyone else
		for (const [other, on] of Object.entries(s.nodes)) {
			if (other === name) continue;
			if (on.needs?.includes(body)) {
				issue(
					issues,
					p,
					`loop body "${body}" is referenced by "${other}" — body is internal to the loop`,
				);
			}
			if (on.loop?.body === body && other !== name) {
				issue(issues, p, `loop body "${body}" is shared by two loops`);
			}
		}
	}

	// cycle detection (Kahn's algorithm)
	const indeg = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const name of names) {
		indeg.set(name, 0);
		adj.set(name, []);
	}
	for (const [name, n] of Object.entries(s.nodes)) {
		for (const d of n.needs ?? []) {
			if (!names.has(d)) continue; // already reported as unknown dependency
			adj.get(d)!.push(name);
			indeg.set(name, (indeg.get(name) ?? 0) + 1);
		}
	}
	const queue = [...names].filter((n) => (indeg.get(n) ?? 0) === 0);
	const order: string[] = [];
	while (queue.length) {
		const cur = queue.shift()!;
		order.push(cur);
		for (const next of adj.get(cur)!) {
			indeg.set(next, (indeg.get(next) ?? 0) - 1);
			if ((indeg.get(next) ?? 0) === 0) queue.push(next);
		}
	}
	if (order.length !== names.size) {
		const cyclic = [...names].filter((n) => (indeg.get(n) ?? 0) > 0);
		issue(issues, "nodes", `cycle detected involving: ${cyclic.join(", ")}`);
	}

	// overlapping producers: two nodes that could ever be READY SIMULTANEOUSLY
	// must not write the same artifact path. Strictly ordered re-writers are
	// legitimate (e.g. a verifier writes final-review.md, a fix loop body then
	// rewrites it to APPROVED) — allow overlap when one node transitively
	// precedes the other. Order edges: needs → node, and loop owner → body.
	const reach = new Map<string, Set<string>>();
	for (const name of names) reach.set(name, new Set());
	const orderEdges: [string, string][] = [];
	for (const [name, n] of Object.entries(s.nodes)) {
		for (const d of n.needs ?? []) {
			if (!names.has(d)) continue;
			orderEdges.push([d, name]);
		}
		if (n.loop && names.has(n.loop.body)) {
			orderEdges.push([name, n.loop.body]); // owner gates the body
		}
	}
	for (const [from, to] of orderEdges) {
		reach.get(from)!.add(to);
	}
	// transitive closure (Floyd–Warshall over the small node set)
	const all = [...names];
	for (const k of all) {
		for (const i of all) {
			if (!reach.get(i)!.has(k)) continue;
			for (const j of all) {
				if (reach.get(k)!.has(j)) reach.get(i)!.add(j);
			}
		}
	}
	const producers = new Map<string, string[]>();
	for (const [name, n] of Object.entries(s.nodes)) {
		for (const a of n.produces ?? []) {
			const list = producers.get(a.path) ?? [];
			list.push(name);
			producers.set(a.path, list);
		}
	}
	for (const [path, list] of producers) {
		if (list.length > 1) {
			const unordered = list.filter(
				(a, i) => !list.some((b, j) => i !== j && reach.get(b)!.has(a)),
			);
			if (unordered.length > 1) {
				issue(
					issues,
					`nodes.${list.join(", ")}`,
					`overlapping produces path "${path}" (unordered writers)`,
				);
			}
		}
	}

	// finish must reference existing nodes
	for (const f of s.finish ?? []) {
		if (!names.has(f))
			issue(issues, `finish`, `finish node "${f}" does not exist`);
	}

	return issues;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Parse a JSON spec string into a Spec (structural + graph checks). */
export function parseSpec(
	input: string,
): { ok: true; spec: Spec } | { ok: false; issues: ValidationIssue[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(input);
	} catch (e) {
		return {
			ok: false,
			issues: [
				{ path: "<json>", message: `invalid JSON: ${(e as Error).message}` },
			],
		};
	}
	const structural = validateStructural(raw);
	if (structural.length > 0) return { ok: false, issues: structural };
	const spec = raw as Spec;
	const graph = validateGraph(spec);
	if (graph.length > 0) return { ok: false, issues: graph };
	return { ok: true, spec };
}

/** Full validation for a Spec object (used on load from disk). */
export function validateSpec(spec: unknown): ValidationResult {
	const structural = validateStructural(spec);
	if (structural.length > 0) return { ok: false, issues: structural };
	const graph = validateGraph(spec as Spec);
	if (graph.length > 0) return { ok: false, issues: graph };
	return { ok: true, issues: [] };
}

export function formatIssues(issues: ValidationIssue[]): string {
	return issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
}

export function defaultPolicy(spec: Spec): Required<Policy> {
	return {
		failFast: spec.policy?.failFast ?? true,
		maxAgents: spec.policy?.maxAgents ?? 20,
	};
}

export function isVerifier(n: NodeSpec): boolean {
	return n.role === "verifier";
}
