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
for _ in $(seq 1 30); do
	curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
	sleep 1
done
ollama pull "$LIVE_MODEL" >/dev/null 2>&1 || {
	echo "model pull failed"
	cat "$SMOKE_HOME/ollama.log"
	exit 1
}

echo "== provision extensions (dag-core + ollama provider) =="
mkdir -p "$SMOKE_HOME/.pi/agent/extensions"
cp -r "$ROOT/src" "$SMOKE_HOME/.pi/agent/extensions/pi-dag-core"
cp "$ROOT/tests/real-e2e/ollama-provider.ts" "$SMOKE_HOME/.pi/agent/extensions/ollama-provider.ts"

PROMPT='pi 会话里有一个名为 dag_start 的 TOOL（不是 Airflow，不是图论库）。任务：读取本目录 README.md 的内容，用 dag_start 工具启动一个单节点工作流（spec 里一个节点，agent 用 "scout"，task 写"读取 README.md 并写 summary.md"，produces 用相对路径 summary.md，check 用 nonEmpty）。然后：调用 subagent 工具（参数必须逐字使用 dag_start 返回的 agent 和 task）→ 调用 dag_complete（runId 和 node 用 dag_start 返回的）→ 最后调用 dag_finish。严格按 dag_start 返回的批执行，不要自行发挥。'

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
*)
	echo "=== LIVE-E2E-LOCAL FAILED: incomplete event chain: $EVENTS ==="
	exit 1
	;;
esac
