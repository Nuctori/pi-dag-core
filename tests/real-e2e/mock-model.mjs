/**
 * mock-model.mjs — scripted OpenAI-completions server for the REAL pi smoke.
 *
 * Drives a genuine pi agent session without any LLM/API key: every model
 * request is answered with a canned scripted response. The parent
 * conversation gets a tool-call sequence that exercises the dag protocol
 * end-to-end (dag_start → subagent → dag_complete → dag_finish); subagent
 * CHILD sessions (identified by their own first user message) get a plain
 * "done" reply so they complete with isError=false.
 *
 * The dag_start result is parsed from the conversation to inject the real
 * runId into later scripted turns (__RUNID__ placeholder).
 */
import http from "node:http";

const PORT = Number(process.env.SMOKE_PORT ?? 8787);
const PARENT_KEY = "run the smoke workflow"; // must match the pi prompt below

const SPEC = JSON.stringify({
  name: "smoke",
  nodes: {
    discover: {
      agent: "scout",
      task: "Explore the module and write ctx.md",
    },
  },
});

/* ------------------------------- turns ------------------------------- */

const t = (fn, args) => ({ fn, args });
const turns = [
  t("dag_start", { spec: SPEC }),
  t("subagent", { agent: "scout", task: "Explore the module and write ctx.md" }),
  t("dag_complete", { runId: "__RUNID__", node: "discover" }),
  t("dag_finish", { runId: "__RUNID__" }),
  null, // final text
];

/* ------------------------------ helpers ------------------------------ */

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function firstUserText(messages) {
  for (const m of messages) {
    if (m.role === "user") {
      const c = Array.isArray(m.content) ? m.content.map((x) => x.text ?? "").join("") : String(m.content ?? "");
      if (c.trim()) return c;
    }
  }
  return "";
}

function extractRunId(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" || m.role === "toolResult") {
      const txt = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      const hit = txt.match(/runId=([A-Za-z0-9_-]+)/);
      if (hit) return hit[1];
    }
  }
  return null;
}

function assistantMessage(messages) {
  const key = firstUserText(messages);
  const isParent = key.toLowerCase().includes(PARENT_KEY.toLowerCase());
  const bucket = isParent ? hash(PARENT_KEY) : hash(key || "child");
  const counters = countersByKey;
  const idx = counters.get(bucket) ?? 0;
  counters.set(bucket, idx + 1);

  if (!isParent) {
    return { role: "assistant", content: "done: task complete.", tool_calls: undefined };
  }
  const scripted = turns[Math.min(idx, turns.length - 1)];
  if (scripted === null) {
    return { role: "assistant", content: "SMOKE-OK: workflow completed.", tool_calls: undefined };
  }
  let args = JSON.stringify(scripted.args);
  if (scripted.fn !== "subagent") {
    args = args.replaceAll("__RUNID__", extractRunId(messages) ?? "run-missing");
  }
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: `call_${idx}`, type: "function", function: { name: scripted.fn, arguments: args } },
    ],
  };
}

const countersByKey = new Map();

/* ------------------------------- server ------------------------------ */

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function respond(res, messages) {
  const msg = assistantMessage(messages);
  if (msg.tool_calls) {
    sseChunk(res, {
      id: "smoke-1", object: "chat.completion.chunk", created: Date.now(), model: "scripted-model",
      choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
    });
    sseChunk(res, {
      id: "smoke-1", object: "chat.completion.chunk", created: Date.now(), model: "scripted-model",
      choices: [{ index: 0, delta: { tool_calls: msg.tool_calls }, finish_reason: null }],
    });
    sseChunk(res, {
      id: "smoke-1", object: "chat.completion.chunk", created: Date.now(), model: "scripted-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
  } else {
    sseChunk(res, {
      id: "smoke-1", object: "chat.completion.chunk", created: Date.now(), model: "scripted-model",
      choices: [{ index: 0, delta: { role: "assistant", content: msg.content }, finish_reason: null }],
    });
    sseChunk(res, {
      id: "smoke-1", object: "chat.completion.chunk", created: Date.now(), model: "scripted-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

http
  .createServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        if (parsed.stream === false) {
          const msg = assistantMessage(messages);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            id: "smoke-1", object: "chat.completion", created: Date.now(), model: "scripted-model",
            choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }],
          }));
          return;
        }
        respond(res, messages);
      } catch (e) {
        res.write(`data: ${JSON.stringify({ error: { message: String(e) } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock-model listening on 127.0.0.1:${PORT}`));
