// ============================================================================
// instabox-tasks —— 每日签到调度器（Cloudflare Worker）
//
// 与 instabox-keepalive 的分工：
//   keepalive  = 让机器一直醒着（8 小时一轮，适合当常驻服务）
//   tasks(本文件) = 每天定点叫醒机器跑一小会儿脚本，跑完不管它，让平台自己 idle-suspend 掉
//
// 你的这台免费机一天只需运行几分钟，所以正确的用法是「睡 → 定点醒 → 跑 → 睡」，
// 而不是保活。这样一整天的停机时间反而是零成本（idle pause 无冷却、不扣任何额度）。
//
// 部署：
//   wrangler.toml 的 crons 用默认的 ["* * * * *"]（每分钟，用来判断到点没有）
//   变量：
//     INSTABOX_API_KEY   Secret   必填
//     INSTABOX_MACHINE   Text     机器名或 m_xxx
//     TASKS_AT           Text     每天几点跑，本地时间，"08:05"；多个用逗号 "08:05,20:05"
//     TASKS_TZ           Text     默认 Asia/Shanghai
//     TASKS_CMD          Text     默认 "bash /data/checkin/run.sh"
//     TASKS_WINDOW_MIN   Text     到点后多少分钟内允许触发，默认 15（够 cron 抖动）
//     TASKS_TOKEN        Secret   可选，保护 HTTP 手动触发
//
//   HTTP：
//     GET /?token=xxx        立刻跑一次（手动补跑）
//     GET /status?token=xxx  看今天跑过没、上次结果
// ============================================================================

const API_DEFAULT = "https://api.instabox.sh";
const TZ_DEFAULT = "Asia/Shanghai";
const CMD_DEFAULT = "bash /data/checkin/run.sh";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIn(tz) {
  // 返回 {y,m,d,hh,mm,minuteOfDay,dayKey}
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hh = Number(p.hour === "24" ? "0" : p.hour);
  const mm = Number(p.minute);
  return {
    y: p.year, m: p.month, d: p.day,
    hh, mm,
    minuteOfDay: hh * 60 + mm,
    dayKey: `${p.year}-${p.month}-${p.day}`,
  };
}

function parseTimes(value) {
  const out = [];
  for (const piece of String(value || "").split(/[,\s]+/)) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(piece.trim());
    if (!m) continue;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) continue;
    out.push(h * 60 + mi);
  }
  return out.sort((a, b) => a - b);
}

async function api(env, method, path, body, idem) {
  const res = await fetch((env.INSTABOX_API_URL || API_DEFAULT).replace(/\/+$/, "") + path, {
    method,
    headers: {
      "X-API-Key": env.INSTABOX_API_KEY,
      // 生命周期操作（resume/start/suspend/stop）缺这个头会 400
      ...(idem ? { "Idempotency-Key": idem } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function resolveMachine(env) {
  const want = (env.INSTABOX_MACHINE || "").trim();
  if (want.startsWith("m_")) return want;
  const r = await api(env, "GET", "/v1/machines");
  if (!r.ok) throw new Error(`列机器失败：HTTP ${r.status} ${r.text.slice(0, 120)}`);
  const list = r.json?.machines || [];
  if (!want) {
    if (!list.length) throw new Error("这把 key 名下没有机器");
    return list[0].id;
  }
  const hit = list.find((m) => m.name === want || m.id === want);
  if (!hit) throw new Error(`找不到机器 ${want}`);
  return hit.id;
}

// 机器被挂起时先唤醒：resume 优先，stopped 用 start 兜底
async function ensureRunning(env, id, budgetMs = 90_000) {
  const dead = Date.now() + budgetMs;
  let woke = [];
  while (Date.now() < dead) {
    const r = await api(env, "GET", `/v1/machines/${id}`);
    const state = r.json?.state;
    if (state === "running" && r.json?.runtime?.ready) return { ok: true, state, woke };
    if (state === "running") { await sleep(1500); continue; }
    if (!woke.length) {
      // wake 专治「自己睡着的」（idle-suspend），resume 治手动暂停，start 兜底 stopped
      for (const type of ["wake", "resume", "start"]) {
        const a = await api(env, "POST", `/v1/machines/${id}/${type}`, {},
          `tasks-${type}-${id}-${Date.now()}`);
        woke.push(`${type}:${a.status}`);
        if (a.ok) break;
      }
    }
    await sleep(3000);
  }
  return { ok: false, state: "timeout", woke };
}

async function runOnce(env, opts = {}) {
  const t0 = Date.now();
  const id = await resolveMachine(env);
  const cmd = (env.TASKS_CMD || CMD_DEFAULT).trim();

  const wake = await ensureRunning(env, id);
  if (!wake.ok) {
    return { ok: false, at: new Date().toISOString(), machine: id, phase: "wake", wake, error: `唤醒失败（${wake.state}）` };
  }

  const exec = await api(env, "POST", `/v1/machines/${id}/exec`, { cmd });

  // 可选：跑完立刻自己睡，状态确定、不多占 30 分钟
  let slept = null;
  if ((env.TASKS_SUSPEND_AFTER || "0").trim() === "1") {
    const s = await api(env, "POST", `/v1/machines/${id}/suspend`, {},
      `tasks-suspend-${id}-${Date.now()}`);
    slept = s.status;
  }

  // 没开 TASKS_SUSPEND_AFTER 就让它自己 idle-suspend（无冷却，同样不扣额度）
  const out = {
    ok: exec.ok,
    at: new Date().toISOString(),
    machine: id,
    cmd,
    ms: Date.now() - t0,
    wake: wake.woke,
    suspendedAfter: slept,
    exitCode: exec.json?.exitCode ?? null,
    stdout: (exec.json?.stdout || "").slice(-2000),
    stderr: (exec.json?.stderr || "").slice(-800),
    status: exec.status,
  };
  if (!exec.ok) out.error = exec.text.slice(0, 300);
  return out;
}

function requireToken(env, url) {
  // 兼容 keepalive 时代留下的 TOKEN secret，免得重配
  const want = env.TASKS_TOKEN || env.TOKEN;
  if (!want) return null;
  if (url.searchParams.get("token") === want) return null;
  return new Response(JSON.stringify({ ok: false, error: "token 不对" }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });
}

export default {
  async scheduled(event, env) {
    const tz = env.TASKS_TZ || TZ_DEFAULT;
    const times = parseTimes(env.TASKS_AT || "08:05");
    const windowMin = Number(env.TASKS_WINDOW_MIN || 15);
    if (!times.length) {
      console.log("instabox-tasks: TASKS_AT 没配有效时间，跳过");
      return;
    }

    const t = nowIn(tz);
    const due = times.some((slot) => {
      const diff = t.minuteOfDay - slot;
      return diff >= 0 && diff <= windowMin;
    });
    if (!due) return;

    console.log(`instabox-tasks: 到点触发 ${t.dayKey} ${t.hh}:${t.mm} (${tz})`);
    const out = await runOnce(env);
    console.log("instabox-tasks:", JSON.stringify(out));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const denied = requireToken(env, url);
    if (denied) return denied;
    const route = url.pathname.replace(/\/+$/, "") || "/";

    if (route === "/") {
      const out = await runOnce(env);
      return new Response(JSON.stringify(out, null, 1), {
        status: out.ok ? 200 : 502, headers: { "Content-Type": "application/json" },
      });
    }

    if (route === "/status") {
      const tz = env.TASKS_TZ || TZ_DEFAULT;
      const t = nowIn(tz);
      const cfgOut = {
        at: env.TASKS_AT || "08:05",
        tz,
        cmd: env.TASKS_CMD || CMD_DEFAULT,
        windowMin: Number(env.TASKS_WINDOW_MIN || 15),
        now: `${t.dayKey} ${String(t.hh).padStart(2, "0")}:${String(t.mm).padStart(2, "0")}`,
      };
      try {
        const id = await resolveMachine(env);
        const r = await api(env, "GET", `/v1/machines/${id}`);
        const m = r.json || {};
        return new Response(JSON.stringify({
          ok: true, config: cfgOut,
          machine: {
            id, name: m.name, state: m.state, desiredState: m.desiredState,
            maxRunMinutes: m.maxRunMinutes, runStartedAt: m.runStartedAt,
            cooldownUntil: m.cooldownUntil, autoSuspendedAt: m.autoSuspendedAt,
          },
        }, null, 1), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, config: cfgOut, error: e.message }, null, 1), {
          status: 502, headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ ok: false, error: "route not found" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  },
};