# 青龙 / 白虎面板：实测与取舍

## 仓库地址

| 面板 | GitHub | Star | 技术栈 |
|---|---|---|---|
| **青龙** QingLong | <https://github.com/whyour/qinglong> | 20.1k | Node.js + Python + TypeScript |
| **白虎** BaiHu | <https://github.com/engigu/baihu-panel> | — | Go（后端）+ Web |

镜像：

```
青龙  docker.io/whyour/qinglong:latest        (766 MB)
白虎  ghcr.io/engigu/baihu:latest             (注意：不是 Docker Hub)
```

## 实测结果（青龙，2026-11-27，机器 m_agq3igqp6ahsogpy6l4deimtka）

```bash
docker pull whyour/qinglong:latest        # 766 MB，成功
docker run -d --name ql --restart unless-stopped \
  -p 5700:5700 -v /data/qinglong/data:/ql/data \
  -e TZ=Asia/Shanghai whyour/qinglong:latest
```

| 项 | 结果 |
|---|---|
| 容器状态 | `Up (healthy)` |
| 本地 `127.0.0.1:5700` | `200` |
| 发布端口后公网访问 | `200` → `https://5700-<机器ID>.instabox.tech` |
| CPU 占用 | 3% |
| 内存占用 | 165 MB / 7.8 GiB（2.1%） |
| 磁盘 | +0.7 GB（根盘 4.6G → 5.3G） |
| 启动耗时 | 约 25 秒到 healthy |

**结论：技术上完全可行，装得下、跑得起来。**

## 但是：面板的调度器在这个平台上失效

这是核心问题，不是配置问题。

```bash
# 机器挂起时
curl https://5700-<机器ID>.instabox.tech  →  503 (Sandbox offline)
```

更关键的是：**VM 挂起时，容器里的 cron 和内核一起冻住，不会补跑。**

我用 guest 内 20ms 心跳验证过这一点（宿主机层面冻结，见上游 README 的证据链）：
suspend 期间 `/data/tmp/hb.log` 出现 2.3~16 秒的断档，说明整个 VM 停摆。

所以：

| 用法 | 结果 |
|---|---|
| 靠青龙面板的「定时任务」每天跑 | ❌ 机器睡着时永不触发 |
| 让机器一直醒着（保活） | ⚠️ 能跑，但白烧 8 小时上限，操作失误吃 5~135 分钟冷却 |
| **外部定时器唤醒 → 面板只当手动控制台** | ✅ 可行，但面板就是多余的 |
| **外部定时器唤醒 → 直接跑脚本** | ✅ 最简，本仓库的做法 |

## 什么时候值得装

装面板**唯一**合理的场景：

- 你有几十个签到脚本，需要一个 Web UI 管理环境变量、看执行历史、手动点一下重跑
- 你能接受「机器醒着的时候才能操作面板」

即便如此，调度仍然必须放在机器外面。做法是：外部定时器 `POST /exec` 调青龙的 API 触发任务，或者直接让外部定时器唤醒后跑 `ql` 的 CLI。

## 什么时候不值得装

| 你的情况 | 建议 |
|---|---|
| 3~10 个签到脚本 | ❌ 别装。`checkin.py` + `config.json` 就够，零依赖零内存 |
| 需要 Web UI 管理大量脚本 | ✅ 装，但调度放外面 |
| 想让它 24 小时挂着当服务 | ❌ 免费机做不到（8 小时上限 + 冷却阶梯） |

## 内存 vs 收益

| 方案 | 内存 | 磁盘 | 依赖 | 调度能力 |
|---|---|---|---|---|
| `checkin.py`（本仓库） | ~15 MB（跑的时候才占） | 30 KB | Python 3 标准库 | 靠外部定时器 |
| 青龙面板 | 165 MB 常驻 | 700 MB | Docker + 4 个进程 | **在挂起的机器上无效** |
| 白虎面板 | 未实测，Go 单二进制预计 <80 MB | ~100 MB | Docker | 同上 |

机器总共 7.8 GiB 可用，165 MB 不算什么。但**它换来的是 0 调度能力**，这才是问题。

## 如果你还是想装

```bash
# 青龙
docker run -d --name ql --restart unless-stopped \
  -p 5700:5700 \
  -v /data/qinglong/data:/ql/data \
  -e TZ=Asia/Shanghai \
  whyour/qinglong:latest

# 发布端口（注意：机器挂起时公网访问会 503）
curl -X POST "https://api.instabox.sh/v1/machines/$MID/ports" \
  -H "X-API-Key: $IBK_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(date +%s)" \
  -d '{"port":5700}'
# → https://5700-<机器ID>.instabox.tech
```

首次打开会要求初始化管理员账号，**一定要设强密码**——这个 URL 是公网可达的。
也可以发布时加 `"access":"private"` 生成需要 token 才能访问的链接。

关掉面板腾内存：

```bash
docker stop ql && docker rm ql
docker rmi whyour/qinglong:latest      # 顺便回收 766 MB
```