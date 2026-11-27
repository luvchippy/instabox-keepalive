#!/usr/bin/env python3
"""instabox 每日签到执行器 —— 只用标准库，不依赖 requests。

设计前提（这台免费机的实际限制）：
  · 机器 30 分钟无活动会自动 idle-suspend（无冷却、免费）
  · 单轮连续运行上限 8 小时，撞线才有 5~135 分钟惩罚冷却
  · 因此签到任务不应该常驻，而应该「被外部唤醒 → 跑几分钟 → 自己睡回去」

调用方式（Cloudflare Worker 或任何外部定时器）：
  POST /v1/machines/{id}/resume         # 幂等，running 时也返回 200
  POST /v1/machines/{id}/exec  {"cmd": "bash /data/checkin/run.sh"}

用法：
  python3 checkin.py                 # 跑全部启用的站点
  python3 checkin.py --site NAME     # 只跑一个
  python3 checkin.py --dry-run       # 只打印要发的请求，不发
  python3 checkin.py --list          # 列出配置
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(BASE, "config.json")
LOGDIR = os.path.join(BASE, "logs")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

CST = timezone(timedelta(hours=8))


def now():
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")


def load_config():
    if not os.path.exists(CONFIG):
        sys.exit(f"缺少配置文件：{CONFIG}")
    with open(CONFIG, encoding="utf-8") as f:
        return json.load(f)


def expand(value, env):
    """把配置里的 ${VAR} 替换成环境变量，避免把 cookie 明文写进仓库。"""
    if not isinstance(value, str):
        return value
    def sub(m):
        name = m.group(1)
        if name not in env:
            raise KeyError(f"环境变量 {name} 未设置（站点配置里引用了它）")
        return env[name]
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", sub, value)


def http(method, url, headers=None, body=None, timeout=25):
    """返回 (status, text, elapsed_ms)。网络层错误返回 status=-1。"""
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    data = None
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body, ensure_ascii=False).encode()
            h.setdefault("Content-Type", "application/json")
        elif isinstance(body, str):
            data = body.encode()
    req = urllib.request.Request(url, data=data, method=method.upper(), headers=h)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), int((time.time() - t0) * 1000)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), int((time.time() - t0) * 1000)
    except Exception as e:
        return -1, f"{type(e).__name__}: {e}", int((time.time() - t0) * 1000)


def judge(site, status, text):
    """判定成功与否。expect 支持 status / contains / not_contains / json_path。"""
    exp = site.get("expect") or {}
    codes = exp.get("status", [200])
    if status not in codes:
        return False, f"HTTP {status}（期望 {'/'.join(map(str, codes))}）"
    for needle in exp.get("contains", []):
        if needle not in text:
            return False, f"响应里没有「{needle}」"
    for needle in exp.get("not_contains", []):
        if needle in text:
            return False, f"响应里出现了「{needle}」"
    jp = exp.get("json_path")
    if jp:
        try:
            node = json.loads(text)
            for part in jp.split("."):
                node = node[int(part)] if part.isdigit() else node[part]
            if exp.get("json_equals") is not None and node != exp["json_equals"]:
                return False, f"{jp}={node!r}，期望 {exp['json_equals']!r}"
        except Exception as e:
            return False, f"JSON 解析失败：{e}"
    return True, "ok"


def run_site(site, env, dry=False):
    name = site.get("name") or site.get("url", "?")
    if not site.get("enable", True):
        return {"site": name, "skipped": True, "reason": "enable=false"}

    try:
        url = expand(site["url"], env)
        headers = {k: expand(v, env) for k, v in (site.get("headers") or {}).items()}
        body = site.get("body")
        if isinstance(body, dict):
            body = {k: expand(v, env) for k, v in body.items()}
        elif isinstance(body, str):
            body = expand(body, env)
    except KeyError as e:
        return {"site": name, "ok": False, "error": str(e)}

    method = site.get("method", "GET")
    if dry:
        return {"site": name, "dry_run": True, "method": method, "url": url,
                "headers": list(headers), "body": body}

    retries = int(site.get("retries", 2))
    last = None
    for attempt in range(1, retries + 2):
        status, text, ms = http(method, url, headers, body,
                                timeout=int(site.get("timeout", 25)))
        ok, why = judge(site, status, text) if status > 0 else (False, text)
        last = {"site": name, "ok": ok, "http": status, "ms": ms,
                "why": why, "attempt": attempt,
                "body": text[:300].replace("\n", " ")}
        if ok:
            break
        if status in (401, 403, 404):
            break  # 认证/路径错误，重试无意义
        if attempt <= retries:
            time.sleep(min(2 * attempt, 6))
    return last


def write_log(records):
    os.makedirs(LOGDIR, exist_ok=True)
    day = datetime.now(CST).strftime("%Y-%m-%d")
    path = os.path.join(LOGDIR, f"{day}.log")
    with open(path, "a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps({"at": now(), **r}, ensure_ascii=False) + "\n")
    return path


def notify(cfg, summary):
    """可选推送。type: none | webhook | telegram"""
    n = cfg.get("notify") or {}
    kind = (n.get("type") or "none").lower()
    if kind == "none":
        return
    text = summary
    try:
        if kind == "webhook":
            http("POST", expand(n["url"], os.environ), {"Content-Type": "application/json"},
                 {"text": text})
        elif kind == "telegram":
            token = os.environ.get("TG_TOKEN") or n.get("token", "")
            chat = os.environ.get("TG_CHAT") or n.get("chat_id", "")
            if token and chat:
                http("POST", f"https://api.telegram.org/bot{token}/sendMessage",
                     {"Content-Type": "application/json"},
                     {"chat_id": chat, "text": text, "disable_web_page_preview": True})
    except Exception as e:
        print(f"[notify] 推送失败：{e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", help="只跑指定站点名")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    cfg = load_config()
    sites = cfg.get("sites") or []
    if args.list:
        for s in sites:
            print(f"{'✔' if s.get('enable', True) else '✘'} {s.get('name','?'):24} "
                  f"{s.get('method','GET'):5} {s.get('url','')[:70]}")
        return
    if args.site:
        sites = [s for s in sites if s.get("name") == args.site]
        if not sites:
            sys.exit(f"没有名为 {args.site} 的站点")

    print(f"=== instabox 签到 {now()} | 站点 {len(sites)} 个 ===")
    env = dict(os.environ)
    records = []
    for s in sites:
        r = run_site(s, env, dry=args.dry_run)
        records.append(r)
        if r.get("skipped"):
            print(f"  -  {r['site']}: 跳过（{r['reason']}）")
        elif r.get("dry_run"):
            print(f"  ·  {r['site']}: {r['method']} {r['url']}")
        else:
            mark = "✔" if r.get("ok") else "✘"
            print(f"  {mark}  {r['site']}: {r.get('why','')} "
                  f"[{r.get('http')} {r.get('ms')}ms 第{r.get('attempt')}次]")

    real = [r for r in records if not r.get("skipped") and not r.get("dry_run")]
    if real:
        okn = sum(1 for r in real if r.get("ok"))
        summary = f"[instabox 签到] {okn}/{len(real)} 成功\n" + "\n".join(
            f"{'✔' if r['ok'] else '✘'} {r['site']}: {r.get('why','')}" for r in real)
        print(f"=== 结果 {okn}/{len(real)} 成功 ===")
        if not args.dry_run:
            p = write_log(records)
            print(f"日志：{p}")
            notify(cfg, summary)
        if okn < len(real):
            sys.exit(1)


if __name__ == "__main__":
    main()