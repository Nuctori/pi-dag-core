#!/usr/bin/env bash
# REAL-model E2E on CI — no mock: a free OpenCode Zen model (cloud inference)
# drives a genuine pi session through the dag protocol. Proves a REAL LLM
# generates a spec, executes nodes via REAL subagent children, and the state
# machine completes with evidence. Requires ZEN_API_KEY (free tier key from
# https://opencode.ai/auth) — in CI that is the ZEN_API_KEY GitHub secret.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export SMOKE_HOME="${SMOKE_HOME:-$(mktemp -d)}"
export HOME="$SMOKE_HOME"
export LIVE_MODEL="${LIVE_MODEL:-deepseek-v4-flash-free}"
OUT="$SMOKE_HOME/live-e2e.out"

if [ -z "${ZEN_API_KEY:-}" ]; then
	echo "=== LIVE-E2E SKIPPED: ZEN_API_KEY not set — add the OpenCode Zen free-tier key as a GitHub secret ==="
	exit 0 # not a failure; the job documents itself without the secret
fi

echo "== install pi + pi-subagents into smoke HOME =="
npm install -g @earendil-works/pi-coding-agent >/dev/null 2>&1
pi install npm:pi-subagents >/dev/null 2>&1

echo "== provision extensions (dag-core + zen provider) =="
mkdir -p "$SMOKE_HOME/.pi/agent/extensions"
cp -r "$ROOT/src" "$SMOKE_HOME/.pi/agent/extensions/pi-dag-core"
cp "$ROOT/tests/real-e2e/zen-provider.ts" "$SMOKE_HOME/.pi/agent/extensions/zen-provider.ts"

PROMPT='多阶段任务，适合用 dag 编排：1) 并行读取本目录的 README.md 和 src/cli.js 两个文件（各一个节点，产物各自写 summary-a.md / summary-b.md），2) 汇总节点交叉验证并写 NOTES.md（内容包含 VERIFIED），3) 完成工作流。请用 dag_start 生成 spec（produces 必须用相对路径），逐字执行返回的批，dag_complete，最后 dag_finish。'

echo "== run REAL pi with $LIVE_MODEL on OpenCode Zen (no mock, no local inference) =="
set +e
timeout 900 pi -p "$PROMPT" --model "zen/$LIVE_MODEL" >"$OUT" 2>&1
set -e
tail -30 "$OUT"

echo "== assert workflow completed =="
RUN_DIR="$(find "$SMOKE_HOME/.pi/agent/workflows/runs" -name events.jsonl 2>/dev/null | head -1)"
if [ -z "$RUN_DIR" ]; then
	echo "=== LIVE-E2E FAILED: no run state produced ==="
	echo "--- assistant tool sequence (what the model actually did) ---"
	grep -o '"toolName":"[a-z_]*"' "$OUT" | sort | uniq -c || true
	exit 1
fi
EVENTS=$(grep -o '"type":"[a-z]*"' "$RUN_DIR" | sed 's/"type":"//;s/"//' | tr '\n' ' ')
echo "events: $EVENTS"
case "$EVENTS" in
*start*executed*passed*finish*) echo "=== LIVE-E2E PASSED ===" ;;
*)
	echo "=== LIVE-E2E FAILED: incomplete event chain: $EVENTS ==="
	exit 1
	;;
esac
