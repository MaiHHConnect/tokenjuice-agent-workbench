#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLOUD_DIR="$ROOT_DIR/cloud-server"
LOG_DIR="$ROOT_DIR/.run"
LOG_FILE="$LOG_DIR/baibaiban-cloud-server.log"
PID_FILE="$LOG_DIR/baibaiban-cloud-server.pid"
PORT=8085
APP_URL="http://localhost:${PORT}"

mkdir -p "$LOG_DIR"

echo "== 白白板一键启动 =="
echo "项目目录: $ROOT_DIR"
echo "服务目录: $CLOUD_DIR"
echo "日志文件: $LOG_FILE"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 Node.js 后再启动。"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "未检测到 npm，请先安装 npm 后再启动。"
  exit 1
fi

if [ ! -d "$CLOUD_DIR/node_modules" ]; then
  echo "未检测到 cloud-server 依赖，开始自动安装..."
  (cd "$CLOUD_DIR" && npm install)
  echo "依赖安装完成。"
  echo
fi

if lsof -iTCP:$PORT -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "白白板已在后台运行，端口: $PORT"
  echo "直接打开: $APP_URL"
  open "$APP_URL"
  exit 0
fi

echo "正在启动白白板服务..."
SERVER_PID="$(
  CLOUD_DIR="$CLOUD_DIR" LOG_FILE="$LOG_FILE" python3 - <<'PY'
import os
import subprocess

cloud_dir = os.environ["CLOUD_DIR"]
log_file = os.environ["LOG_FILE"]

with open(log_file, "ab", buffering=0) as log:
    proc = subprocess.Popen(
        ["node", "src/index.js"],
        cwd=cloud_dir,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
        close_fds=True,
    )

print(proc.pid)
PY
)"
echo "$SERVER_PID" > "$PID_FILE"

for _ in {1..30}; do
  if curl -fsS "$APP_URL/health" >/dev/null 2>&1; then
    echo "启动成功，PID: $SERVER_PID"
    echo "访问地址: $APP_URL"
    open "$APP_URL"
    exit 0
  fi
  sleep 1
done

echo "服务启动超时，请查看日志:"
echo "$LOG_FILE"
exit 1
