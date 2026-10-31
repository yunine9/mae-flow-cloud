#!/usr/bin/env bash
# 8787 常驻实例的规范重启:探活 -> 优雅停 -> 原参数拉起 -> 等监听 -> 报 pid 与日志。
# 参数可覆盖缺省:restart-8787.sh [--data <目录>] [--port <端口>] [-- 其余原样传给 serve]。
# 注意:别用 npm exec 传参——npm 会把 --flag 吃成自己的配置,serve 拒启(2026-10-31 实测)。
set -euo pipefail

REPO=/home/ning/code/mae-flow-cloud
PORT=8787
DATA_DIR=/home/ning/mae-flow-local
EXTRA_FLAGS=(--issue-only --debug-issue)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data) DATA_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) EXTRA_FLAGS+=("$1"); shift ;;
  esac
done
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/serve-$PORT.log"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
mkdir -p "$LOG_DIR"

listen_pid() { ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1; }

OLD_PID="$(listen_pid || true)"
if [[ -n "$OLD_PID" ]]; then
  echo "停旧实例 pid=$OLD_PID"
  kill "$OLD_PID" || true
  for _ in $(seq 1 30); do [[ -z "$(listen_pid || true)" ]] && break; sleep 0.5; done
fi

cd "$REPO"
setsid nohup "$NODE_BIN" \
  --require "$REPO/node_modules/tsx/dist/preflight.cjs" \
  --import "file://$REPO/node_modules/tsx/dist/loader.mjs" \
  src/serve.ts --data "$DATA_DIR" --port "$PORT" "${EXTRA_FLAGS[@]}" >> "$LOG" 2>&1 &

for _ in $(seq 1 60); do [[ -n "$(listen_pid || true)" ]] && break; sleep 0.5; done
NEW_PID="$(listen_pid || true)"
if [[ -z "$NEW_PID" ]]; then
  echo "启动失败,最近日志($LOG):" >&2
  tail -5 "$LOG" >&2
  exit 1
fi
echo "8787 已重启 pid=$NEW_PID 日志=$LOG"
