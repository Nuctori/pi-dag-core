/**
 * zen-provider.ts — registers OpenCode Zen (free-tier models) as a pi provider.
 *
 * Zen exposes an OpenAI-compatible endpoint at https://opencode.ai/zen/v1 with
 * genuinely free models (e.g. deepseek-v4-flash-free). Auth is a plain API key
 * from https://opencode.ai/auth — set ZEN_API_KEY (in CI: the
 * ZEN_API_KEY GitHub secret). No local inference; the model runs on Zen's
 * cloud. Copied into ~/.pi/agent/extensions/ so CHILD pi processes load it too.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const model = process.env.LIVE_MODEL ?? "deepseek-v4-flash-free";
	pi.registerProvider("zen", {
		name: "OpenCode Zen",
		baseUrl: "https://opencode.ai/zen/v1",
		apiKey: "$ZEN_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: model,
				name: `Zen ${model}`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 8192,
			},
		],
	});
}
