# Cloudflare Worker 版调度器（备用方案）

如果不想用 cron-job.org、想留一个 `/status` 面板看机器状态，用这个。

**注意 cron 名额**：Workers 免费版每个账号只有 **5 个 cron 触发器**。这个项目占 1 个。

## 为什么需要它

相比 cron-job.org 直连 API，Worker 多做了这些：

| 能力 | cron-job.org 直连 | Worker |
|---|---|---|
| 唤醒 + 执行 | ✅ 一条 `/exec` | ✅ |
| 执行失败重试 | ❌ | ✅ |
| 状态面板 `/status` | ❌ | ✅ |
| 隐藏 API key | ❌（存在 cron-job.org 服务器） | ✅（存在 CF Secret） |
| 到点判定抗抖动 | ❌（固定时间点） | ✅（窗口 + 日期戳） |

## 部署

### 方式 A：面板粘贴（不用装工具）

1. Cloudflare 面板 → `Workers & Pages` → `Create` → `Worker` → 名字 `instabox-tasks` → `Deploy`
2. `Edit code` → 全选删掉 → 粘贴 [`worker/tasks.js`](../worker/tasks.js) 全文 → `Deploy`
3. `Settings` → `Variables and Secrets`：

| 变量 | 类型 | 值 |
|---|---|---|
| `INSTABOX_API_KEY` | **Secret** | `ibk_...` |
| `TASKS_TOKEN` | **Secret** | 自己起一串随机值（保护 HTTP 接口） |
| `INSTABOX_MACHINE` | Text | `ka-test` 或 `m_xxx` |
| `TASKS_AT` | Text | `08:05`（本地时间，逗号分隔多个） |
| `TASKS_TZ` | Text | `Asia/Shanghai` |
| `TASKS_CMD` | Text | `bash /data/checkin/run.sh` |
| `TASKS_WINDOW_MIN` | Text | `15` |
| `TASKS_SUSPEND_AFTER` | Text | `0`（跑完让它自己 idle-suspend） |

4. `Settings` → `Triggers` → `Cron Triggers` → 添加 `* * * * *`
   （每分钟跑一次，靠 `TASKS_AT` 判断到点没有）

### 方式 B：wrangler

```bash
cd worker
cp wrangler-tasks.toml wrangler.toml
npx wrangler login
npx wrangler secret put INSTABOX_API_KEY
npx wrangler secret put TASKS_TOKEN
npx wrangler deploy
```

`wrangler-tasks.toml` 里的 `[triggers] crons = ["* * * * *"]` 已经配好。

## 接口

| 路由 | 作用 |
|---|---|
| `GET /?token=xxx` | 立刻跑一次（手动补跑） |
| `GET /status?token=xxx` | 看配置 + 机器状态（含 `maxRunMinutes` / `cooldownUntil`） |

示例响应：

```json
{
 "ok": true, "at": "2026-11-27T11:39:53.581Z",
 "machine": "m_agq3igqp6ahsogpy6l4deimtka",
 "cmd": "bash /data/checkin/run.sh",
 "ms": 5377,
 "wake": ["wake:409", "resume:202"],
 "suspendedAfter": null,
 "exitCode": 0,
 "stdout": "=== instabox 签到 ... ===",
 "status": 200
}
```

## 实现要点

### 唤醒顺序 wake → resume → start

`wake` 只对「自己睡着的」（idle-suspend）有效；手动暂停过的机器要用 `resume`；
`stopped` 的只能 `start`。三个依次试，哪个成功就停。

```js
for (const type of ["wake", "resume", "start"]) {
  const a = await api(env, "POST", `/v1/machines/${id}/${type}`, {}, `tasks-${type}-${Date.now()}`);
  woke.push(`${type}:${a.status}`);
  if (a.ok) break;
}
```

### Idempotency-Key 是必须的

`resume` / `start` / `suspend` / `stop` 这些生命周期操作**缺 `Idempotency-Key` 头会返回 400**。
`exec` 不需要。所以:

```js
const res = await fetch(url, {
  method,
  headers: {
    "X-API-Key": env.INSTABOX_API_KEY,
    ...(idem ? { "Idempotency-Key": idem } : {}),   // 只有生命周期调用传
    ...(body ? { "Content-Type": "application/json" } : {}),
  },
  ...
});
```

### 冻结在 5~10 秒

实测从 `suspend` 到 `running`：

```
wake:409 → resume:202 → 5.4 秒后 exec 成功
```

超时预算给 90 秒，够用。

## 与 cron-job.org 二选一

**不要两个都开**。两边都配的话，同一时间会触发两次 `run.sh`——虽然日期戳会挡住第二次，
但没必要多一层。选 cron-job.org 就把 Worker 的 cron 删掉（腾出名额给别的项目）。