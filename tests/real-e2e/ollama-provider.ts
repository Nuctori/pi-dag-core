/**
 * ollama-provider.ts — registers a local Ollama model as a pi provider.
 * Zero keys: points at the Ollama OpenAI-compatible endpoint on the runner.
 * Copied into ~/.pi/agent/extensions/ by the runner so CHILD pi processes
 * (subagent sessions) load it too.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const model = process.env.LIVE_MODEL ?? "qwen3:4b";
  pi.registerProvider("ollama", {
    name: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    api: "openai-completions",
    models: [
      {
        id: model,
        name: `Ollama ${model}`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 8192,
      },
    ],
  });
}
