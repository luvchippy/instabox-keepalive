#!/bin/bash
# /data/checkin/run.sh —— 每日签到的入口，被外部定时器（Cloudflare Worker）唤醒后执行
#
# 自带「一天只跑一次」保护：Worker 的 cron 窗口可能触发多次，这里用日期戳挡住。
# 强制重跑：bash run.sh --force
set -uo pipefail
cd "$(dirname "$0")" || exit 1

MARK=".last-run"
TODAY=$(TZ=Asia/Shanghai date +%F)
FORCE=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--force" ]; then FORCE=1; else ARGS+=("$a"); fi
done

if [ "$FORCE" -eq 0 ] && [ -f "$MARK" ] && [ "$(cat "$MARK")" = "$TODAY" ]; then
  echo "SKIP: 今天 ($TODAY) 已经跑过了（--force 可强制重跑）"
  exit 0
fi

mkdir -p logs
LOG="logs/$(TZ=Asia/Shanghai date +%F).stdout"
{
  echo "=== run.sh $(TZ=Asia/Shanghai date '+%F %T') ==="
  if [ ${#ARGS[@]} -gt 0 ]; then
    python3 checkin.py "${ARGS[@]}"
  else
    python3 checkin.py
  fi
} 2>&1 | tee -a "$LOG"

rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] && echo "$TODAY" > "$MARK"
echo "=== exit=$rc ==="
exit "$rc"