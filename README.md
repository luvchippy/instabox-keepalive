# instabox-daily —— 免费机当「每日任务机」用

把 instabox 免费机（4 vCPU / 8 GiB / 20 GiB）当作**每天跑几分钟脚本**的服务器：
签到、领积分、拉数据、发日报。其余时间让它睡，一分钱不花、不碰 8 小时上限。

> 这个仓库 fork 自 [pingmike2/instabox-keepalive](https://github.com/pingmike2/instabox-keepalive)，
> 原版解决的是「让机器一直醒着」。本仓库改了个方向：**让机器一直睡着，定点醒一下**。
> 原版内容完整保留在 [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md) 和 `worker/worker.js`。

---

## 为什么不保活

instabox 免费机的三条硬规则（原文见 [`docs/POLICY.md`](docs/POLICY.md)）：

| 规则 | 免费机 | 保活的后果 |
|---|---|---|
| 空闲暂停 | 固定 30 分钟，**无冷却、不扣额度** | 保活会阻止它睡，白烧运行时长 |
| 单轮上限 | 120 分钟起步，最多 480 分钟（8 小时） | 撞线后被平台停，进冷却 |
| 撞线冷却 | 第 1 次 5~20 分钟，第 2 次 60~75，第 3 次起 **120~135 分钟** | 越撞越长，指数恶化 |

所以对「每天跑几分钟」的用途，**睡着才是最优状态**：不占额度、无冷却、随时能秒醒（唤醒 5~10 秒，内存和进程全保留）。

---

## 架构

```
cron-job.org（或任意外部定时器，每分钟/每天定点）
        │  POST /v1/machines/{id}/exec
        │  Header: X-API-Key: ibk_xxx
        ▼
api.instabox.sh ──唤醒──▶ 你的沙盒（5~10 秒）
        │                      │
        │                      └─ bash /data/checkin/run.sh
        │                              ├─ 日期戳检查（一天只跑一次）
        │                              ├─ checkin.py 跑各站点
        │                              └─ 日志 + 可选推送
        ▼
   30 分钟无活动 → 自动 idle-suspend（免费、无冷却）→ 等下一次敲门
```

**关键点：`POST /exec` 对「自己睡着的」机器自带唤醒**，不需要单独的 wake/resume 调用，
一条 HTTP 请求搞定「叫醒 + 跑脚本 + 拿结果」。官方原文：

> A machine that paused **itself** resumes when you use it again... A request that wakes the machine
> waits up to 45 seconds for the resume and then runs.

但有前提：**只对 idle-suspend 有效**（`autoSuspendedAt` 有值）。手动 `suspend` 过的机器
（`desiredState=suspended`）走 exec 会返回 `409 machine_not_running`，必须先 `resume`。

| 怎么睡的 | exec 自动唤醒 | 恢复方式 |
|---|---|---|
| 空闲 30 分钟自睡 | ✅ 5~10 秒 | 直接 exec |
| 手动 suspend | ❌ 409 | `resume` |
| stopped | ❌ 409 | `start` |

**所以别手动 suspend 它**，让它自然睡即可。真需要兜底就用 Worker 版。

> **⚠️ 冷唤醒实测 130 秒**，不是速记的 5~10 秒。长时间空闲后宿主机回收了内存气球，
> 恢复要把页重新 fault-in。这直接决定方案选型：
> - cron-job.org 单条 exec 会 30 秒超时（唤醒仍在服务端继续，但脚本没跑）→ 要拆成
>   `resume` + `exec` 两条 job，间隔 5 分钟
> - Worker 版没有这个限制（内部等满 240 秒 + 重试 retryable 409）→ 一条搞定
>
> 详见 [docs/cron-job.org.md](docs/cron-job.org.md#️-冷唤醒实测-130-秒超过-cron-joborg-的-30-秒超时)

---

## 三种调度器，选一个

| 方案 | 依赖 | 适合 | 见 |
|---|---|---|---|
| **cron-job.org**（推荐） | 无，纯网页配置 | 想零运维、不碰 Cloudflare | [docs/cron-job.org.md](docs/cron-job.org.md) |
| Cloudflare Worker | 一个 CF 账号 + 1 个 cron 名额 | 已经在用 CF、想要 /status 面板 | [docs/cloudflare-worker.md](docs/cloudflare-worker.md) |
| 自家 VPS / NAS crontab | 一台常开机器 | 已有服务器 | `curl` 一行即可 |

---

## 机器上要装什么

```bash
# 一次性安装（在沙盒里执行）
curl -fsSL https://raw.githubusercontent.com/luvchippy/instabox-keepalive/main/machine/install.sh | bash
```

装完后 `/data/checkin/` 下是：

| 文件 | 作用 |
|---|---|
| `checkin.py` | 签到引擎，**纯 Python 标准库**（这机器没装 requests），配置驱动 |
| `config.json` | 站点配置，cookie 用 `${ENV_VAR}` 引用，不落明文 |
| `run.sh` | 入口。自带「一天只跑一次」日期戳；`--force` 强制重跑 |
| `logs/` | 每天一个 `.stdout` + 结构化 `.log` |

### 配置一个站点

```json
{
  "name": "smzdm",
  "enable": true,
  "method": "POST",
  "url": "https://zhiyou.smzdm.com/user/checkin/jsonp_checkin",
  "headers": { "Cookie": "${SMZDM_COOKIE}", "Referer": "https://www.smzdm.com/" },
  "expect": { "status": [200], "json_path": "error_code", "json_equals": 0 },
  "retries": 2,
  "timeout": 25
}
```

`expect` 支持四种判定：

| 字段 | 含义 |
|---|---|
| `status` | 允许的 HTTP 状态码数组，默认 `[200]` |
| `contains` | 响应正文必须包含的字符串（可多个） |
| `not_contains` | 不能出现的字符串（比如「请先登录」） |
| `json_path` + `json_equals` | 按点号路径取 JSON 字段并比对 |

cookie 存环境变量：

```bash
cat >> /data/checkin/.env <<'EOF'
export SMZDM_COOKIE="your_cookie_here"
EOF
chmod 600 /data/checkin/.env
```

`run.sh` 会自动 `source` 它。

### 先干跑验证

```bash
cd /data/checkin
python3 checkin.py --dry-run     # 只打印要发的请求，不发
python3 checkin.py --list        # 看配置
bash run.sh --force              # 真跑一次
```

---

## 关于青龙 / 白虎面板

| 面板 | 仓库 | 语言 | 说明 |
|---|---|---|---|
| 青龙 | https://github.com/whyour/qinglong | JS + Python | 20.1k star，Docker 一键，生态最大 |
| 白虎 | https://github.com/engigu/baihu-panel | Go | 更轻，多语言运行时管理 |

**能装，但在这台机器上是错配。** 实测（青龙 `whyour/qinglong:latest`，766 MB 镜像）：

- ✅ 装得下、跑得起来（CPU 3% / 内存 165 MB）、端口发布后公网可访问
- ❌ **面板自己的定时任务在 VM 挂起时一起冻结**——容器跟内核一起停，cron 永远不触发
- ❌ 想让它按点跑，就得保活 → 回去撞 8 小时上限

结论：面板只能当「手动执行」的控制台用，调度必须放在机器外面。
只跑几个签到脚本的话，`checkin.py` + `config.json` 已经够，面板是多余的一层。

详情与实测数据见 [docs/panels.md](docs/panels.md)。

---

## 目录

```
machine/            机器侧脚本（签到引擎、配置、入口）
worker/tasks.js     Cloudflare Worker 版每日调度器
worker/worker.js    原版保活 worker（保留，不推荐）
docs/
  POLICY.md         instabox 免费机政策原文摘录
  cron-job.org.md   cron-job.org 配置步骤
  cloudflare-worker.md  Worker 部署步骤
  panels.md         青龙/白虎实测与取舍
  CLI.md            原版 CLI 手册
  UPSTREAM-README.md 上游 README 存档
```

## License

MIT，继承上游。