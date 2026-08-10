/**
 * Shared mock ExtensionAPI for adapter E2E tests.
 *
 * Exercises the REAL extension entry point (src/index.ts) without a pi
 * runtime or LLM: tools are registered for direct invocation, the
 * tool_execution_start/end event stream can be driven, and slash commands
 * are recorded so /dag … human paths are testable too.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dagCoreExtension from "../../src/index.js";

export type ToolDef = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{
		content: { type: string; text: string }[];
		details: Record<string, unknown>;
	}>;
};

export type NotifyEntry = { kind: string; text: string };

export interface MockPi {
	handlers: Map<string, (...args: unknown[]) => unknown>;
	tools: ToolDef[];
	commands: { name: string; handler: (args: string, ctx: unknown) => Promise<unknown> }[];
	notifyCalls: NotifyEntry[];
	hasSubagent: boolean;
	on(event: string, fn: (...args: unknown[]) => unknown): void;
	registerTool(def: ToolDef): void;
	registerCommand(name: string, def: { handler: (...a: unknown[]) => unknown }): void;
	getAllTools(): { name: string }[];
	emit(event: string, ...args: unknown[]): Promise<unknown>;
	/** Invoke a registered /dag command, capturing ui.notify output. */
	runCommand(args: string, cwd: string): Promise<NotifyEntry[]>;
}

export function makePi(hasSubagent = true): MockPi {
	const pi: MockPi = {
		handlers: new Map(),
		tools: [],
		commands: [],
		notifyCalls: [],
		hasSubagent,
		on(event, fn) {
			this.handlers.set(event, fn);
		},
		registerTool(def) {
			this.tools.push(def);
		},
		registerCommand(name, def) {
			this.commands.push({ name, handler: def.handler as MockPi["commands"][number]["handler"] });
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
		async runCommand(args, cwd) {
			const cmd = this.commands.find((c) => c.name === "dag");
			if (!cmd) throw new Error("dag command not registered");
			const out: NotifyEntry[] = [];
			await cmd.handler(args, sessionCtx(cwd, (text, kind) => out.push({ text, kind })));
			return out;
		},
	};
	return pi;
}

export function sessionCtx(cwd: string, notify: (text: string, kind: string) => void) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "e2e-session" },
		ui: { notify },
	};
}

/** Boot the extension in a fresh session and return the harness surface. */
export async function bootExtension(pi: MockPi, cwd: string, notify?: (text: string, kind: string) => void) {
	dagCoreExtension(pi as unknown as ExtensionAPI);
	await pi.emit("session_start", {}, sessionCtx(cwd, notify ?? (() => {})));
	return pi;
}
