# instabox 免费机政策原文

来源：
- <https://instabox.sh/docs/machines/auto-pause.md> — Auto-pause and max-run
- <https://instabox.sh/docs/account/limits.md> — Limits
- <https://instabox.sh/docs/pricing.md> — Pricing

以下英文是官方原文逐字摘录，中文是翻译。

---

## 1. 单轮运行时长（Runtime on the free plan）

> On the free plan the service sets the maximum runtime, and you cannot change it. Each run starts with 120 minutes. While the machine is in use, the service extends the run before it ends, up to 480 minutes in one run. A machine that is no longer in use pauses when its time is up, and the cooldown starts.
>
> `instabox get` shows the current limit as **Max runtime**, and `instabox get --json` as `maxRunMinutes`, counted from `runStartedAt`. A paused or stopped machine has no run, so it shows 480, the most a run can last. When the machine starts or resumes, the limit goes back to 120 minutes and grows again with use.

免费计划的上限由平台设定，改不了。每一轮从 120 分钟开始；机器在被使用时，平台会在到期前延长，单轮最多 480 分钟。机器不再被使用时，到点就暂停，然后开始冷却。

暂停/停止的机器没有「轮」，所以显示 480（最长的可能值）。机器启动或恢复时，上限回到 120 分钟，重新开始增长。

## 2. 怎么延长（How the free plan extends a run）

> With 5 minutes left before the limit, the service counts in how many of the last 30 minutes the machine was in use. The count decides the new limit:
>
> | Minutes in use | The limit |
> | - | - |
> | 5 or more | grows by 120 minutes |
> | 1 to 4 | grows by 30 minutes |
> | None | stays, so the machine pauses when it is reached |
>
> Commands, file access, requests to the machine's ports, desktop use, terminal and SSH traffic, and CPU load of a quarter vCPU or more count as use. **Activity leases and wake calls keep a machine from an idle pause, but they do not count as use here.** When the service cannot read the machine's activity, the run gets the full 480 minutes. The limit is per run, not per day.

剩 5 分钟时，统计最近 30 分钟里有多少分钟「在用」，决定新上限：

| 在用分钟数 | 上限变化 |
|---|---|
| ≥ 5 分钟 | +120 分钟 |
| 1~4 分钟 | +30 分钟 |
| 0 分钟 | 不变，到点暂停 |

**算「在用」的**：命令执行、文件读写、访问机器端口、桌面操作、终端与 SSH 流量、≥0.25 vCPU 的 CPU 负载。
**不算的**：activity lease 和 wake 调用——它们只能阻止「空闲暂停」，在这个判定里无效。
读不到活动数据时，直接给满 480 分钟。**这是按轮算的，不是按天。**

## 3. 空闲暂停

> By default a machine pauses once it has been idle for 30 minutes.

默认空闲 30 分钟就暂停。免费计划这个值固定，PATCH 其他值返回：

```
400 spec_not_allowed
"Free users are not able to change idle time: a free sandbox pauses after 30 idle
minutes (autoSuspendAfterSeconds 1800; send 1800 or leave it out)."
```

## 4. 冷却阶梯（Cooldown after a maximum runtime）

> On the free plan, a cooldown starts when a machine is paused because it reached its maximum runtime, and the machine cannot wake until the cooldown ends. The cooldown is 5 minutes plus a random 0 to 15 minutes... **An idle pause has no cooldown on any plan.**
>
> Until the cooldown ends, every way of waking or starting the machine (exec, SSH, file reads, public URLs, wake, resume, and start) is refused with `409 machine_cooldown`. Stopping, pausing, or changing settings does not shorten a cooldown that has already started. Upgrading to Pro or a higher plan ends a max-run cooldown at once.

> On the free plan, back-to-back max-run pauses rest longer. By default:
>
> | Max-run pause in a row | Cooldown |
> | - | - |
> | 1st | 5 to 20 minutes |
> | 2nd | 60 to 75 minutes |
> | 3rd and later | 120 to 135 minutes |
>
> Each step is a base (5, 60, or 120 minutes) plus the same random 0 to 15. The count starts over when a run ends with no cooldown owed (an idle pause, or you pause or stop the machine). It also starts over when a run starts 2 hours or more after the last cooldown ended.

撞满上限被暂停 → 免费机进冷却，**期间所有唤醒路径都被拒（`409 machine_cooldown`），改设置也不能缩短**。

| 连续第几次撞满 | 冷却时长 |
|---|---|
| 第 1 次 | 5 ~ 20 分钟 |
| 第 2 次 | 60 ~ 75 分钟 |
| 第 3 次及以后 | **120 ~ 135 分钟** |

**重置条件**：某轮结束时没有欠冷却（空闲暂停、或者你自己暂停/停止机器），计数归零；或者新的一轮在上次冷却结束后 ≥2 小时才开始，也归零。

**空闲暂停没有冷却** —— 这是把机器当「每日任务机」用的核心依据。

## 5. 免费计划的其他硬限制

| 项 | 限制 |
|---|---|
| 机器数 | 1 |
| 同时运行 | 1 |
| 最大规格 | 4 vCPU / 8 GiB |
| 磁盘 | 20 GiB 固定，不可 resize |
| 存储总量 | 200 GiB |
| 快照 | 5 |
| 出网 | 100 GiB / 月 |
| 启动 | 3 次 / 分钟 |
| 成员 | 3 |
| API key | 20 个活跃 |
| 公开端口 | 16 个 / 机器 |
| exec | 全局 32 并发，单条最多 10 分钟（默认 60 秒超时） |
| 最大运行 | 120 起步 → 480 封顶，**只有 admin 能改** |
| 空闲暂停 | 30 分钟固定 |

## 6. 用这个仓库的理由

从上面第 3、4 条可以推出：**空闲暂停是免费的、无惩罚的**，而撞满 8 小时是**有惩罚且惩罚会累积**的。

所以对「每天只跑几分钟」的用途：

```
✅ 让它睡（idle pause）→ 零成本、无冷却、唤醒 5~10 秒
❌ 保活（8 小时轮转）→ 白烧时长，操作失误就吃 5~135 分钟冷却
```

`POST /exec` 自带唤醒，一条请求就能「叫醒 + 执行」，所以根本不需要单独的 wake/resume。