#!/usr/bin/env bash
# Zero-key REAL-model E2E on CI — no mock, no login, no API key: a local
# Ollama model (free, open) runs ON the runner CPU and drives a genuine pi
# session through the dag protocol. Proves a REAL LLM generates a spec,
# executes nodes via REAL subagent children, and the state machine completes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export SMOKE_HOME="${SMOKE_HOME:-$(mktemp -d)}"
export HOME="$SMOKE_HOME"
export LIVE_MODEL="${LIVE_MODEL:-phi4-mini:3.8b}"
OUT="$SMOKE_HOME/live-e2e-local.out"

echo "== install pi + pi-subagents into smoke HOME =="
npm install -g @earendil-works/pi-coding-agent >/dev/null 2>&1
pi install npm:pi-subagents >/dev/null 2>&1

echo "== start ollama + pull $LIVE_MODEL =="
ollama serve >"$SMOKE_HOME/ollama.log" 2>&1 &
OLLAMA_PID=$!
trap 'kill $OLLAMA_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done
ollama pull "$LIVE_MODEL" >/dev/null 2>&1 || { echo "model pull failed"; cat "$SMOKE_HOME/ollama.log"; exit 1; }

echo "== provision extensions (dag-core + ollama provider) =="
mkdir -p "$SMOKE_HOME/.pi/agent/extensions"
cp -r "$ROOT/src" "$SMOKE_HOME/.pi/agent/extensions/pi-dag-core"
cp "$ROOT/tests/real-e2e/ollama-provider.ts" "$SMOKE_HOME/.pi/agent/extensions/ollama-provider.ts"

PROMPT='多阶段任务，适合用 dag 编排：1) 并行读取本目录的 README.md 和 src/cli.js 两个文件（各一个节点，产物各自写 summary-a.md / summary-b.md），2) 汇总节点交叉验证并写 NOTES.md（内容包含 VERIFIED），3) 完成工作流。请用 dag_start 生成 spec（produces 必须用相对路径），逐字执行返回的批，dag_complete，最后 dag_finish。'

echo "== run REAL pi with $LIVE_MODEL (local CPU, no mock, no key) =="
set +e
timeout 1500 pi -p "$PROMPT" --model "ollama/$LIVE_MODEL" >"$OUT" 2>&1
set -e
tail -25 "$OUT"

echo "== assert workflow completed =="
RUN_DIR="$(find "$SMOKE_HOME/.pi/agent/workflows/runs" -name events.jsonl 2>/dev/null | head -1)"
if [ -z "$RUN_DIR" ]; then
  echo "=== LIVE-E2E-LOCAL FAILED: no run state produced ==="
  echo "--- assistant tool sequence (what the model actually did) ---"
  grep -o '"toolName":"[a-z_]*"' "$OUT" | sort | uniq -c || true
  exit 1
fi
EVENTS=$(grep -o '"type":"[a-z]*"' "$RUN_DIR" | sed 's/"type":"//;s/"//' | tr '\n' ' ')
echo "events: $EVENTS"
case "$EVENTS" in
  *start*executed*passed*finish*) echo "=== LIVE-E2E-LOCAL PASSED ===" ;;
  *) echo "=== LIVE-E2E-LOCAL FAILED: incomplete event chain: $EVENTS ==="; exit 1 ;;
esac
