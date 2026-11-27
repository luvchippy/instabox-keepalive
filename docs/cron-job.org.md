# 用 cron-job.org 当调度器

零成本、零运维，一个网页就能配。**不需要 Cloudflare，不需要任何常开机器。**

## 为什么这条路最省事

instabox 的 `POST /v1/machines/{id}/exec` **自带唤醒**：

```
机器 suspended（自睡）
   ↓ POST /exec  {"cmd": "bash /data/checkin/run.sh"}
自动 resume（5~10 秒，内存和进程全保留）
   ↓
命令执行，返回 stdout
```

所以一条 HTTP 请求就能完成「叫醒 + 跑脚本」。不需要先 wake 再 exec。

实测确认（2026-11-27）：

```
suspend → state=suspended
POST /exec 无 Idempotency-Key → 200，stdout="CRONJOB_OK"
```

`/wake` 和 `/exec` 都不需要 `Idempotency-Key` 头，正好对上 cron-job.org 只能发固定请求的限制。

## cron-job.org 的免费额度（官方 FAQ）

| 项 | 值 |
|---|---|
| 价格 | 完全免费 |
| 最小间隔 | **1 分钟**（每小时最多 60 次） |
| 任务数量 | 不限（要求 fair use） |
| 执行超时 | **30 秒**（超时断开连接） |
| 输出上限 | 64 KB |
| 自定义 header | ✅ 支持（`User-Agent` 和 `Connection` 会被忽略） |
| POST / PUT body | ✅ 支持 |
| 保留执行记录 | 最近 50 次，响应头/体存 2 天 |
| 自动停用 | 连续失败 25 次后停用任务 |
| 出口 IP | `116.203.134.67` `116.203.129.16` `23.88.105.37` `128.140.8.200` `91.99.23.109` |

> **30 秒超时是唯一要当心的点。** 冷唤醒实测 5~10 秒，加脚本执行通常 10~20 秒，够用。
> 但如果你有站点响应特别慢，把脚本改成后台跑、立即返回（见文末「超时兜底」）。

## 配置步骤

### 1. 建 job

登录 <https://console.cron-job.org> → **CREATE CRONJOB**

### 2. Common

| 字段 | 填什么 |
|---|---|
| Title | `instabox 每日签到` |
| URL | `https://api.instabox.sh/v1/machines/m_你的机器ID/exec` |
| Enable job | ✅ |
| Execution schedule | **Every day** → 选 `08:05`（你想起床看到结果的时间往前留 20 分钟） |

> 机器 ID 在机器里跑 `cat /etc/instabox/identity`，或在 `GET /v1/machines` 里看 `id` 字段（形如 `m_agq3igqp6ahsogpy6l4deimtka`）。

### 3. Advanced（关键）

| 字段 | 值 |
|---|---|
| Request method | **POST** |
| Request body | `{"cmd":"bash /data/checkin/run.sh"}` |
| Headers | `X-API-Key` = `ibk_你的key`（一行一条） |
| | `Content-Type` = `application/json` |
| Treat redirects as success | ✅ |
| Notify on failure | ✅（连续失败 25 次会自动停任务，早发现早处理） |

### 4. 保存并测一次

点 **TEST RUN**，看响应：

```json
{"stdout":"=== run.sh 2026-11-27 19:48:54 ===\n...\n=== exit=0 ===\n",
 "stderr":"","exitCode":0,"timedOut":false,"truncated":false,"oomKilled":false}
```

- `exitCode: 0` → 跑成功了
- `exitCode` 非 0 → 脚本内部有站点失败，看 `stdout` 里哪一行是 `✘`
- HTTP 502 / `machine_cooldown` → 说明之前撞过 8 小时上限，在冷却里，等它结束

> **注意**：`run.sh` 自带「一天只跑一次」的日期戳。TEST RUN 如果当天已经跑过，会直接返回 `SKIP`。
> 想强制验证用 `{"cmd":"bash /data/checkin/run.sh --force"}`。

## 想跑多次？

免费机一天可以醒很多次，每次只花几分钟。多个时间点就建多个 job（cron-job.org 不限制任务数）：

```
job 1:  每天 08:05   bash /data/checkin/run.sh
job 2:  每天 20:05   bash /data/checkin/run.sh   ← run.sh 会 SKIP，除非加 --force
```

如果确实需要一天跑两轮，给第二个 job 的 body 加 `--force`，或者把 `run.sh` 的日期戳改成「按半天」：

```bash
# run.sh 里把 TODAY 改成
TODAY=$(TZ=Asia/Shanghai date +%F)-$([ $(TZ=Asia/Shanghai date +%H) -lt 12 ] && echo am || echo pm)
```

## 超时兜底（脚本可能超过 30 秒时）

改成后台执行 + 立即返回：

```json
{"cmd":"nohup bash /data/checkin/run.sh >/data/checkin/logs/last.log 2>&1 & echo STARTED"}
```

这样 cron-job.org 立刻拿到 `STARTED`，脚本在机器里继续跑。结果看 `/data/checkin/logs/last.log`。

代价：cron-job.org 那边永远是「成功」，站点失败不会告警。折中方案是让脚本自己推送到 Telegram / webhook（`config.json` 的 `notify` 字段支持）。

## 安全提醒

cron-job.org 会把 `X-API-Key` 存在它的服务器上。降低风险：

1. 建一把**专用 key**，scope 只给 `machines:write`（`exec` 需要这个），**不要给 `machines:delete`**
2. 泄露时去 <https://dashboard.instabox.sh/dashboard/api-keys> revoke 掉重建，只改 cron-job.org 里那一行

## 替代品

| 服务 | 免费额度 | 备注 |
|---|---|---|
| [cron-job.org](https://cron-job.org) | 1 分钟间隔，30s 超时 | 本文方案，最省事 |
| [GitHub Actions](https://github.com/features/actions) | 2000 分钟/月，cron 最小 5 分钟 | 仓库 Settings → Secrets 存 key，workflow 里 `curl` |
| 自家 VPS / NAS crontab | 你自己的 | 最可控，但要有一台常开机器 |
| Cloudflare Worker | 5 个 cron 名额 | 见 [cloudflare-worker.md](cloudflare-worker.md) |

### GitHub Actions 版（如果不想用 cron-job.org）

`.github/workflows/checkin.yml`：

```yaml
name: instabox checkin
on:
  schedule:
    - cron: '5 0 * * *'   # UTC 00:05 = 北京 08:05
  workflow_dispatch:

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - name: wake + run
        run: |
          curl -sS -m 60 -X POST \
            "https://api.instabox.sh/v1/machines/${{ secrets.INSTABOX_MACHINE_ID }}/exec" \
            -H "X-API-Key: ${{ secrets.INSTABOX_API_KEY }}" \
            -H "Content-Type: application/json" \
            -d '{"cmd":"bash /data/checkin/run.sh"}'
```

> GitHub 的 cron 在高峰期会延迟 10~30 分钟，不如 cron-job.org 准。但对签到来说无所谓。