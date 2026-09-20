#!/usr/bin/env node
/**
 * JEV 审判庭 — 后端代理（访客体验版）
 *
 * 两种运行模式：
 *   A. 自托管 / 开发模式：设置 TYPESAFE_API_KEY（或 ~/.workbuddy/secrets/typesafe.key），
 *      所有请求无限调用（你自己本地玩用这个）。
 *   B. 公开演示模式：额外设置 TYPESAFE_DEMO_KEY 作为「访客演示 Key」。
 *      - 访客未填自己的 key 时，用 DEMO_KEY 调用，但服务端按 IP+模式 限制 GUEST_LIMIT_PER_MODE 次；
 *      - 访客在页面填入自己的 API Key 后，走其本人配额，无限畅玩。
 *
 * 安全：Key 仅服务端持有；访客自填的 key 只用于本次请求的 Authorization，不落盘。
 * 纯 Node 内置模块，无需 npm install。
 *
 * 访客计数说明（v2 修复跨实例/冷启动计数跳变）：
 *   - 每次请求实时从 data/guest_counts.json 读取当前计数（不再依赖启动时的内存快照）；
 *   - 计数写入通过串行锁（writeLock）排队，避免并发/重试导致的重复自增；
 *   - 取客户端真实 IP 用 X-Forwarded-For 的【首段】（原始客户端），比末段更稳定，避免代理 IP 抖动导致同一访客落到不同桶。
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 8777;
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const GUEST_LIMIT_PER_MODE = 3; // 访客每模式体验次数上限
const COUNTS_FILE = path.join(__dirname, "data", "guest_counts.json");

// ---- 可选：从项目根目录 .env 读取（仅用于 VPS 自托管；云平台直接注入 env，无需此文件） ----
(function loadEnvFile() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch (e) {
    /* 没有 .env 文件则跳过 */
  }
})();

// ---- 读取 Key（仅服务端） ----
function loadKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  const p =
    process.env.TYPESAFE_KEY_PATH ||
    path.join(os.homedir(), ".workbuddy", "secrets", "typesafe.key");
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch (e) {
    return null;
  }
}
const API_KEY = loadKey(); // 自托管 / 开发模式用
const DEMO_KEY = (process.env.TYPESAFE_DEMO_KEY || "").trim() || null; // 访客演示用

// ---- 访客计数（按 IP+模式），持久化到文件防止重启/跨实例绕过 ----
function readCounts() {
  try {
    return JSON.parse(fs.readFileSync(COUNTS_FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}
function writeCounts(obj) {
  try {
    fs.mkdirSync(path.dirname(COUNTS_FILE), { recursive: true });
    fs.writeFileSync(COUNTS_FILE, JSON.stringify(obj));
  } catch (e) {
    /* 不可写则本次计数不落盘（内存中仍正确） */
  }
}
// 串行锁：保证读-改-写不会并发交错，杜绝重复自增
let writeLock = Promise.resolve();
function withLock(fn) {
  const next = writeLock.then(fn, fn);
  // 防止某个 fn 抛错导致锁链断裂
  writeLock = next.catch(() => {});
  return next;
}

function getIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    // 取 X-Forwarded-For 的首段 = 原始客户端 IP（最稳定，不受代理追加影响）
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "unknown";
}

// 查询某 IP+模式已用次数
function checkGuest(ip, mode) {
  const counts = readCounts();
  return counts[ip + ":" + mode] || 0;
}
// 成功一次后 +1 并落盘（串行化）
function bumpGuest(ip, mode) {
  return withLock(() => {
    const counts = readCounts();
    const ck = ip + ":" + mode;
    counts[ck] = (counts[ck] || 0) + 1;
    writeCounts(counts);
    return counts[ck];
  });
}

// ---- 访客访问日志（输出到 stdout，Render 日志面板可查看） ----
function logAccess(info) {
  console.log("[ACCESS]", JSON.stringify(Object.assign({ time: new Date().toISOString() }, info)));
}
// 简易 GeoIP（ip-api.com 免费、无需 key；仅做尽力查询，失败不影响主流程）
function geoLookup(ip) {
  if (!ip || ip === "unknown") return;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1)/.test(ip)) return; // 跳过内网/本机
  const r = http.get("http://ip-api.com/json/" + encodeURIComponent(ip), (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => {
      try {
        const g = JSON.parse(d);
        if (g && g.status === "success") {
          console.log("[GEO]", JSON.stringify({ ip, country: g.country, region: g.regionName, city: g.city, lat: g.lat, lon: g.lon, org: g.org, isp: g.isp }));
        }
      } catch (e) {}
    });
  });
  r.on("error", () => {});
  r.setTimeout(3000, () => r.destroy());
}

// 防止意外异常把整个服务带崩
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---- 转发到 Jev（key 由调用方传入），带 429/529 退避重试 ----
function callJev(payload, key, attempt = 1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      TYPESAFE_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject({ status: 502, message: "Jev 返回了无法解析的结果" });
            }
          } else if (
            (res.statusCode === 429 || res.statusCode === 529) &&
            attempt < 3
          ) {
            setTimeout(
              () => callJev(payload, key, attempt + 1).then(resolve, reject),
              600 * attempt
            );
          } else {
            reject({
              status: res.statusCode,
              message: data || `Jev 请求失败 (${res.statusCode})`,
            });
          }
        });
      }
    );
    req.on("error", () => reject({ status: 502, message: "无法连接 Jev 服务" }));
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

// ---- 校验前端请求：只允许 state + questions + 可选 meta/userKey ----
function sanitize(body) {
  if (!body || typeof body !== "object") return null;
  if (typeof body.state === "undefined") return null;
  if (!body.questions || typeof body.questions !== "object") return null;
  const types = ["noul", "choice", "score"];
  for (const [id, q] of Object.entries(body.questions)) {
    if (!q || !types.includes(q.type)) return null;
    if (typeof q.instructions !== "string" && typeof q.instructions !== "object")
      return null;
  }
  if (Object.keys(body.questions).length > 8) return null; // 防滥用
  return { state: body.state, model: MODEL, questions: body.questions };
}

// ---- 路由 ----
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ demoEnabled: !!DEMO_KEY, guestLimit: GUEST_LIMIT_PER_MODE })
    );
    return;
  }

  if (req.method === "POST" && req.url === "/api/judge") {
    let raw = "";
    let aborted = false;
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 65536 && !aborted) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求体过大（上限 64KB）" }));
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (aborted) return;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求体不是合法 JSON" }));
        return;
      }
      const clean = sanitize(parsed);
      if (!clean) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求格式不合法" }));
        return;
      }

      const mode = (parsed.meta && parsed.meta.mode) || "unknown";
      const userKey =
        parsed.userKey && String(parsed.userKey).trim()
          ? String(parsed.userKey).trim()
          : null;

      // ---- 决定使用哪个 Key 与是否受限 ----
      let key, isGuest = false, guestUsed = 0;
      if (userKey) {
        // 访客自填 Key：本人配额，无限；做基本格式校验
        if (!/^[\w\-]{10,}$/.test(userKey)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "API Key 格式不正确" }));
          return;
        }
        key = userKey;
      } else if (DEMO_KEY) {
        // 访客演示模式：按 IP+模式 计数限制（实时读文件，避免内存快照漂移）
        const ip = getIp(req);
        const used = checkGuest(ip, mode);
        if (used >= GUEST_LIMIT_PER_MODE) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              code: "GUEST_LIMIT",
              error: `该模式体验次数已用完（每模式限 ${GUEST_LIMIT_PER_MODE} 次）。在右上角填入你自己的 TypeSafe API Key，即可无限畅玩。`,
            })
          );
          return;
        }
        key = DEMO_KEY;
        isGuest = true;
      } else if (API_KEY) {
        // 自托管 / 开发模式：无限
        key = API_KEY;
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "服务端未配置 Key（请设置 TYPESAFE_API_KEY 或 TYPESAFE_DEMO_KEY）",
          })
        );
        return;
      }

      try {
        const t0 = Date.now();
        const out = await callJev(clean, key);
        out.timing = { jev_ms: Date.now() - t0 };
        const rip = getIp(req);
        logAccess({ event: "judge", ip: rip, mode, keyType: userKey ? "own-key" : (DEMO_KEY ? "guest" : "dev"), ua: req.headers["user-agent"] || "" });
        if (isGuest) {
          // 仅在调用成功后计数一次（只算成功体验，不浪费失败额度）
          guestUsed = await bumpGuest(getIp(req), mode);
          out.guest = { mode, used: guestUsed, limit: GUEST_LIMIT_PER_MODE };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(e.status || 502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || "Jev 调用失败" }));
      }
    });
    return;
  }

  // 静态文件
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  if (urlPath === "/index.html") {
    const vip = getIp(req);
    logAccess({ event: "pageview", ip: vip, ua: req.headers["user-agent"] || "", referer: req.headers["referer"] || "" });
    geoLookup(vip); // 仅页面打开时查一次地理，省额度
  }
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  JEV 审判庭 已启动`);
  console.log(`  ➜  打开 http://localhost:${PORT}\n`);
  if (!DEMO_KEY && !API_KEY)
    console.log("  ⚠️  未配置任何 Key（TYPESAFE_API_KEY / TYPESAFE_DEMO_KEY）\n");
  else if (!DEMO_KEY)
    console.log("  ℹ️  自托管/开发模式：所有请求无限调用\n");
  else
    console.log(
      `  ℹ️  访客演示模式：未填 Key 的访客每模式限 ${GUEST_LIMIT_PER_MODE} 次\n`
    );
});
