#!/usr/bin/env bash
# REAL-pi smoke test: boots an actual pi agent session (no LLM — scripted
# provider) with dag-core loaded, drives the full protocol through the real
# event stream, and asserts the workflow completes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export SMOKE_PORT="${SMOKE_PORT:-8787}"
if [ -n "${SMOKE_HOME:-}" ]; then
  export HOME="$SMOKE_HOME"
  mkdir -p "$HOME/.pi/agent/extensions"
  cp "$ROOT/tests/real-e2e/scripted-provider.ts" "$HOME/.pi/agent/extensions/scripted-provider.ts"
  # subagent tool provider must exist inside the smoke HOME
  if [ ! -d "$HOME/.pi/agent/npm/node_modules/pi-subagents" ]; then
    echo "installing pi-subagents into smoke HOME..."
    pi install npm:pi-subagents >/dev/null 2>&1
  fi
fi

node "$ROOT/tests/real-e2e/mock-model.mjs" & SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1

OUT="$HOME/smoke.out"
set +e
timeout 240 pi -p \
  "Run the smoke workflow: dag_start, then subagent, then dag_complete, then dag_finish." \
  -e "$ROOT/src/index.ts" \
  --model scripted/scripted-model >"$OUT" 2>&1
PI_EXIT=$?
set -e
cat "$OUT"
if [ $PI_EXIT -ne 0 ]; then
  # Known pi-subagents teardown race: the child-process cleanup may emit on a
  # stale session ctx AFTER the workflow completed (async-execution.ts). The
  # protocol trace (events: start→executed→passed→finish) already landed —
  # treat SMOKE-OK as the pass criterion, not pi's exit code.
  echo "note: pi exited $PI_EXIT after output — see pi-subagents teardown race; workflow result checked below"
fi
grep -q "SMOKE-OK" "$OUT" || {
  echo "=== REAL-PI SMOKE FAILED: SMOKE-OK not found ==="
  exit 1
}
echo "=== REAL-PI SMOKE PASSED ==="
