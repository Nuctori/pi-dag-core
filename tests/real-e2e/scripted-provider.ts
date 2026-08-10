/**
 * scripted-provider.ts — registers the local mock model as a pi provider.
 *
 * This extension must be visible to EVERY pi process in the smoke run —
 * including the subagent CHILD sessions spawned by pi-subagents — so it is
 * copied into ~/.pi/agent/extensions/ by the run script (children inherit
 * the user extension dir, not the repo's -e flags).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const port = process.env.SMOKE_PORT ?? "8787";
	pi.registerProvider("scripted", {
		name: "Scripted",
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: "x",
		api: "openai-completions",
		models: [
			{
				id: "scripted-model",
				name: "Scripted Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64000,
				maxTokens: 4096,
			},
		],
	});
}
