# 用 cron-job.org 当调度器

零成本、零运维，一个网页就能配。**不需要 Cloudflare，不需要任何常开机器。**

## 为什么这条路最省事

instabox 的 `POST /v1/machines/{id}/exec` 对**自己睡着**（idle-suspend）的机器**自带唤醒**：

```
机器 idle-suspended（autoSuspendedAt 有值）
   ↓ POST /exec  {"cmd": "bash /data/checkin/run.sh"}
自动 resume（5~10 秒，内存和进程全保留）
   ↓
命令执行，返回 stdout
```

官方原文（`docs/machines/auto-pause.md` → What wakes a machine）：

> A machine that paused **itself** resumes when you use it again, and you can recognize one by the
> `autoSuspendedAt` field being set. A request that wakes the machine waits up to 45 seconds for the
> resume and then runs.

以及同一页的例外条款：

> A machine **you** paused or stopped does not wake on use, and `instabox wake` does not wake it
> either. Run `instabox resume` or `instabox start` to bring it back.

### 这条区别很重要

| 机器怎么睡的 | `POST /exec` 会自动唤醒吗 | 怎么恢复 |
|---|---|---|
| **空闲 30 分钟自睡**（`autoSuspendedAt` 有值，`desiredState=running`） | ✅ **会**，5~10 秒 | 直接 exec |
| 你手动 suspend（`desiredState=suspended`） | ❌ 返回 `409 machine_not_running` | 必须 `resume` |
| stopped | ❌ | 必须 `start` |

实测确认（2026-11-27）：

```
手动 suspend 后 → POST /exec → 409 machine_not_running
                → POST /wake → 409 machine_not_running
                → POST /resume → 202 → 才恢复
```

**所以前提是：不要手动 suspend 这台机器。** 让它自然空闲自睡，`exec` 就能一条请求搞定。

如果你担心某次手动操作后忘了 resume，用[带唤醒兜底的方案](#如果你担心机器被手动暂停过)。

`/wake` 和 `/exec` 都不需要 `Idempotency-Key` 头，正好对上 cron-job.org 只能发固定请求的限制。
（`resume` / `start` / `suspend` / `stop` 这些生命周期操作**需要**这个头，缺了返回 400。）

### ⚠️ 冷唤醒实测 130 秒，超过 cron-job.org 的 30 秒超时

这是本仓库最重要的一条实测数据（2026-11-27）：

```
自然 idle-suspend 后 → POST /exec
  → 立刻返回 409 operation_conflict（retryable:true）
  → state 变成 resuming
  → 130 秒后才 running
```

原因：长时间空闲后宿主机把内存气球（balloon）回收了，恢复时要把页重新 fault-in，
比刚挂起时（5~10 秒）慢一个数量级。

**这对 cron-job.org 意味着什么：**

| 现象 | 结果 |
|---|---|
| cron-job.org 30 秒超时 | ✅ 请求会在 30 秒断开，但**唤醒操作已经在服务端启动，会继续跑完** |
| 那 30 秒的响应 | 是 `409 operation_conflict`（`retryable:true`），cron-job.org 会记成失败 |
| 脚本跑了吗 | ❌ **没有**。exec 在 resume 期间被拒了，脚本没执行 |
| 连续 25 次「失败」 | cron-job.org 会自动停用这个任务 |

**所以单条 exec 在「长时间没跑」的场景下不可靠。** 三个解法：

#### 解法 A：两条 job，间隔 5 分钟（cron-job.org 原生支持）

```
job A  每天 08:00   POST /v1/machines/{id}/resume   →  只负责把机器拉起来
job B  每天 08:05   POST /v1/machines/{id}/exec     →  机器已经醒了，直接跑
```

`resume` 需要 `Idempotency-Key`。用固定的 `daily-resume` 是安全的：重复调用返回缓存的上次结果，
不会重复执行。唯一风险是「缓存了成功但机器其实还睡着」——概率很低，且 job B 会再失败一次。

> 5 分钟够不够？实测冷唤醒 130 秒，5 分钟有 2.3 倍余量。

#### 解法 B：脚本自己先返回（推荐给急性子）

让 exec 只做「确认机器醒着」，真正的活交给后台：

```
job 每天 08:00
POST /exec  {"cmd":"nohup bash /data/checkin/run.sh > /data/checkin/logs/last.log 2>&1 & echo STARTED"}
```

- 30 秒内就能拿到 `STARTED`（如果机器已经醒了）；机器没醒仍然会 409
- 脚本在后台跑，不受 30 秒限制
- 代价：看不到签到结果，需要脚本自己推送（`config.json` 的 `notify`）

#### 解法 C：用 Worker（最稳）

[`worker/tasks.js`](../worker/tasks.js) 里已经处理了这两种情况：

```js
// 唤醒预算 240 秒（覆盖 130 秒冷唤醒）
const wake = await ensureRunning(env, id, 240_000);
// exec 遇到 retryable 409 会退避重试，最多 180 秒
for (let attempt = 1; Date.now() < execDeadline; attempt++) {
  exec = await api(env, "POST", `/v1/machines/${id}/exec`, { cmd });
  if (exec.ok) break;
  if (exec.json?.error?.retryable !== true) break;
  await sleep(Math.min(5000 * attempt, 20000));
}
```

Worker 的 cron 本身没有 30 秒限制，能等满 4 分钟。见 [cloudflare-worker.md](cloudflare-worker.md)。

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

## 如果你担心机器被手动暂停过

单条 `exec` 治不了 `desiredState=suspended`。这种情况下用 **Worker 版**（它内部按
`wake → resume → start` 三级兜底，见 [cloudflare-worker.md](cloudflare-worker.md)），
或者干脆两条 cron-job.org 任务：

```
job A  每天 08:00   POST /v1/machines/{id}/resume     Header: X-API-Key + Idempotency-Key
job B  每天 08:02   POST /v1/machines/{id}/exec       Header: X-API-Key   body: {"cmd":"bash /data/checkin/run.sh"}
```

`resume` 用**固定**的 `Idempotency-Key`（比如 `daily-resume-1`）是安全的——实测同 key 重复调用
返回的是缓存的上一次成功结果，不会报错也不会重复执行。但注意：**如果上一次 resume 缓存了成功，
而这次机器确实处于 suspended，缓存会骗你**。稳妥做法是让 key 带上日期，但这需要动态值，
cron-job.org 做不到。

**所以最省心的还是：永远别手动 suspend 这台机器。** 让它自己空闲自睡，一切自动。

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