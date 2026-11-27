#!/bin/bash
# install.sh —— 在 instabox 沙盒里一次性装好每日签到环境
#
#   curl -fsSL https://raw.githubusercontent.com/luvchippy/instabox-keepalive/main/machine/install.sh | bash
#
# 做的事：
#   1. 建 /data/checkin/ 目录结构
#   2. 放好 checkin.py / config.json / run.sh
#   3. 建一个 .env 模板（cookie 放这里，不进 git）
#   4. 干跑自检，打印下一步
#
# 不装 systemd timer —— 调度交给机器外面的定时器（cron-job.org / Worker / 自家 crontab）。
# 原因见 docs/POLICY.md：VM 挂起时容器和内核一起冻住，机器内部的 timer 不补跑。

set -euo pipefail

DEST="${DEST:-/data/checkin}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/luvchippy/instabox-keepalive/main/machine}"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

say "安装到 $DEST"
mkdir -p "$DEST/logs"

# ---- 取文件：本地有就用本地，否则从 GitHub 拉 ----
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
fetch() {
  local name="$1"
  if [ -n "$HERE" ] && [ -f "$HERE/$name" ]; then
    cp "$HERE/$name" "$DEST/$name"
    echo "  本地: $name"
  else
    curl -fsSL "$REPO_RAW/$name" -o "$DEST/$name"
    echo "  下载: $name"
  fi
}

for f in checkin.py config.json run.sh; do fetch "$f"; done
chmod +x "$DEST/checkin.py" "$DEST/run.sh"

# ---- .env 模板 ----
if [ ! -f "$DEST/.env" ]; then
  cat > "$DEST/.env" <<'ENVEOF'
# 站点 cookie / token 放这里，run.sh 会自动 source。
# 权限已设 600，不会进 git（.gitignore 已排除）。
#
# export SMZDM_COOKIE=""
# export V2EX_COOKIE=""
# export HOSTLOC_COOKIE=""
ENVEOF
  chmod 600 "$DEST/.env"
  say "已生成 $DEST/.env（填入 cookie 后生效）"
else
  warn "$DEST/.env 已存在，跳过"
fi

# ---- 自检 ----
say "环境检查"
python3 -V
echo "  磁盘: $(df -h /data | tail -1 | awk '{print $4" 可用"}')"
echo "  时区: $(date +%Z)  （脚本内部统一用 Asia/Shanghai）"

say "配置自检（--list）"
cd "$DEST" && python3 checkin.py --list || true

cat <<TIP

\033[1m下一步：\033[0m
  1) 编辑 $DEST/config.json，把要签到的站点改成 "enable": true 并填 url/headers
  2) cookie 写进 $DEST/.env
  3) 干跑验证：   cd $DEST && python3 checkin.py --dry-run
  4) 真跑一次：   bash $DEST/run.sh --force
  5) 配外部定时器：见 docs/cron-job.org.md（一条 POST /exec 搞定唤醒+执行）

\033[1m重要：\033[0m
  · 机器会在空闲 30 分钟后自动睡（免费、无冷却），这是期望行为，别去保活
  · 不要装机器内部的 cron/systemd timer —— VM 挂起时不会补跑（systemd Persistent 除外，
    但那样还得外部唤醒，反而更绕）
TIP