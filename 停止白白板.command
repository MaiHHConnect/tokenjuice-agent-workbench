#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/.run"
PID_FILE="$LOG_DIR/baibaiban-cloud-server.pid"
PORT=8085

echo "== 停止白白板 =="

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && ps -p "$PID" >/dev/null 2>&1; then
    kill "$PID" || true
    sleep 1
    echo "已停止进程: $PID"
    rm -f "$PID_FILE"
    exit 0
  fi
fi

PORT_PID="$(lsof -tiTCP:$PORT -sTCP:LISTEN -n -P 2>/dev/null || true)"
if [ -n "${PORT_PID:-}" ]; then
  kill $PORT_PID || true
  sleep 1
  echo "已停止端口 $PORT 上的进程: $PORT_PID"
  rm -f "$PID_FILE"
  exit 0
fi

echo "未检测到正在运行的白白板服务。"
