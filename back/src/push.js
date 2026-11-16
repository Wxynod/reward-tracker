// Reward Tracker — 周报推送（Web Push，iOS 16.4+ 主屏幕 App / 安卓 / 桌面浏览器）
// · VAPID 密钥对在第一次用到时由 Worker 自己生成，存 KV push:vapid（不需要另外设 secret）。
// · 订阅存 KV push:subs：[{ endpoint, keys:{p256dh, auth}, lang, excl:[卡 id], label, created, last_ok, last_week }]。
// · 每周日 21:07（香港时间）cron 先同步一次 Plaid，再按这台设备在周报里选的卡算本周消费，推给每台设备。
// · 消费口径和前端周报一致：信用卡购物净额，退款冲减；还款 / 转账 / 收入 / 银行费用、年费、权益返现、「不计入分析」的交易不算。
// · 加密：RFC 8291（aes128gcm）+ RFC 8292（VAPID，ES256），全部用 WebCrypto。

const SUBS = "push:subs";
const VAPID = "push:vapid";
const SUBJECT = "https://wxynod.github.io/reward-tracker/";
const APP_URL = "https://wxynod.github.io/reward-tracker/";
const MAX_SUBS = 20;

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => {
  const str = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(str, (c) => c.charCodeAt(0));
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

// ------------------------------------------------------------ VAPID
async function vapid(env, getJSON, putJSON) {
  let v = await getJSON(env, VAPID, null);
  if (v?.publicKey && v?.privateJwk) return v;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  v = {
    publicKey: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    created: new Date().toISOString(),
  };
  await putJSON(env, VAPID, v);
  return v;
}

async function vapidHeader(v, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const key = await crypto.subtle.importKey("jwk", v.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

// ------------------------------------------------------------ RFC 8291 加密
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

async function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes,
    concat(enc.encode(JSON.stringify(payload)), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, body);
}

async function sendOne(v, sub, payload) {
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(v, sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
      Topic: "weekly",
    },
    body: await encrypt(sub, payload),
  });
  return res.status;
}

// ------------------------------------------------------------ 周报摘要
const NO_SPEND = new Set(["LOAN_PAYMENTS", "TRANSFER_IN", "TRANSFER_OUT", "INCOME", "BANK_FEES"]);
const BENEFIT_CREDIT = /\b(dining|hotel|resort|property|airline|uber|digital entertainment|entertainment|saks|walmart\+?|clear|equinox|lululemon|oura|resy|streaming|travel|statement|platinum|brilliant|gold|offer)\b.*\bcredit\b|\bamex offer\b|\bcredit\b.*\b(amex|american express)\b/i;
const ANNUAL_FEE = /annual\s*(membership\s*)?fee|membership\s*fee|card\s*member\s*fee|annual\s*card\s*fee/i;
const FX_PER_USD = { CNY: 7.1, HKD: 7.8 };

const day = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => day(new Date(Date.parse(s) + n * 86400000));
// 香港时间的今天；周一为一周第一天。周日当天出具当周，其余日子是上一周
export function latestWeek(now = Date.now()) {
  const today = day(new Date(now + 8 * 3600000));
  const dow = (new Date(today).getUTCDay() + 6) % 7;
  return dow === 6 ? addDays(today, -6) : addDays(today, -dow - 7);
}

function ignored(t, ig) {
  if (ig?.ids?.[t.id]) return true;
  const k = String(t.merchant || t.name || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!k) return false;
  return (ig?.names || []).some((r) => r.name === k && ((!r.from && !r.to) || ((!r.from || t.date >= r.from) && (!r.to || t.date <= r.to))));
}

function usdOf(t, hkdDays, hkdRates) {
  if (!t.currency || t.currency === "USD") return t.amount;
  if (t.currency === "CNY" && Number.isFinite(t.usd_fx?.amount)) return t.usd_fx.amount;
  if (t.currency === "HKD" && hkdDays.length) {
    const d = t.authorized_date || t.date;
    let lo = 0, hi = hkdDays.length - 1, hit = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (hkdDays[m] <= d) { hit = hkdDays[m]; lo = m + 1; } else hi = m - 1; }
    if (hit && Date.parse(d) - Date.parse(hit) <= 7 * 86400000) return t.amount / hkdRates[hit];
  }
  return FX_PER_USD[t.currency] ? t.amount / FX_PER_USD[t.currency] : null;
}

export function weeklySummary(data, ws, excl = []) {
  const ex = new Set(excl);
  const credit = new Set(data.items.flatMap((it) => it.accounts).filter((a) => a.type === "credit" && !ex.has(a.id)).map((a) => a.id));
  const hkdRates = data.fx?.usd_hkd?.rates || {};
  const hkdDays = Object.keys(hkdRates).sort();
  const ig = data.rewards?.ignore;
  const prevWs = addDays(ws, -7), we = addDays(ws, 6);
  const sum = { cur: 0, prev: 0, n: 0, top: null };
  const merch = new Map();
  for (const t of data.transactions) {
    if (!credit.has(t.account_id) || t.date < prevWs || t.date > we) continue;
    if (NO_SPEND.has(t.category)) continue;
    if (t.amount < 0 && BENEFIT_CREDIT.test(`${t.name || ""} ${t.merchant || ""}`)) continue;
    if (ANNUAL_FEE.test(`${t.name || ""} ${t.merchant || ""} ${t.detail?.original_description || ""}`)) continue;
    if (ignored(t, ig)) continue;
    const usd = usdOf(t, hkdDays, hkdRates);
    if (usd == null) continue;
    if (t.date < ws) { sum.prev += usd; continue; }
    sum.cur += usd;
    if (usd > 0) sum.n++;
    const k = String(t.merchant || t.name || "").trim();
    merch.set(k, (merch.get(k) || 0) + usd);
  }
  for (const [k, v] of merch) if (v > 0 && (!sum.top || v > sum.top.v)) sum.top = { k, v };
  return { ws, cards: credit.size, ...sum };
}

const money = (v) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function weeklyMessage(s, lang) {
  const we = addDays(s.ws, 6);
  const en = lang === "en";
  const [m1, d1, m2, d2] = [+s.ws.slice(5, 7), +s.ws.slice(8), +we.slice(5, 7), +we.slice(8)];
  const range = en ? `${MON[m1 - 1]} ${d1} – ${m1 === m2 ? d2 : `${MON[m2 - 1]} ${d2}`}` : `${m1}月${d1}日 – ${m1 === m2 ? "" : `${m2}月`}${d2}日`;
  const title = en ? `Weekly report · ${range}` : `周报 · ${range}`;
  let body;
  if (!s.n && Math.abs(s.cur) < 0.005) body = en ? "No card spending this week." : "这一周没有刷卡消费。";
  else {
    const diff = s.cur - s.prev;
    const cmp = Math.abs(s.prev) < 0.005 ? "" : Math.abs(diff) < 0.005
      ? (en ? ", same as the week before" : "，和前一周持平")
      : en ? `, ${money(Math.abs(diff))} ${diff < 0 ? "less" : "more"} than the week before`
        : `，比前一周${diff < 0 ? "少" : "多"} ${money(Math.abs(diff))}`;
    const top = s.top ? (en ? ` Biggest: ${s.top.k} ${money(s.top.v)}.` : `花得最多的是 ${s.top.k}（${money(s.top.v)}）。`) : "";
    body = en ? `You spent ${money(s.cur)} across ${s.n} purchase${s.n === 1 ? "" : "s"}${cmp}.${top}`
      : `本周刷卡 ${s.n} 笔，共 ${money(s.cur)}${cmp}。${top}`;
  }
  return { title, body, url: `${APP_URL}?weekly=${s.ws}`, tag: `weekly-${s.ws}` };
}

// ------------------------------------------------------------ 订阅管理 & 发送
function cleanSub(b) {
  const s = b?.subscription;
  if (!s || typeof s.endpoint !== "string" || !/^https:\/\/[^/]+\//.test(s.endpoint) || s.endpoint.length > 1000) throw Object.assign(new Error("subscription 无效"), { status: 400 });
  const keys = s.keys || {};
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh || "") || !/^[A-Za-z0-9_-]{16,30}$/.test(keys.auth || "")) throw Object.assign(new Error("subscription keys 无效"), { status: 400 });
  return {
    endpoint: s.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    lang: b.lang === "en" ? "en" : "zh",
    excl: Array.isArray(b.excl) ? b.excl.filter((x) => typeof x === "string" && x.length <= 200).slice(0, 200) : [],
    label: String(b.label || "").slice(0, 80),
  };
}

export function pushRoutes({ getJSON, putJSON, loadAll }) {
  return {
    "GET /api/push/key": async (env) => ({ key: (await vapid(env, getJSON, putJSON)).publicKey }),
    "POST /api/push/subscribe": async (env, body) => {
      const sub = cleanSub(body);
      const all = await getJSON(env, SUBS, []);
      const prev = all.find((s) => s.endpoint === sub.endpoint);
      const subs = all.filter((s) => s.endpoint !== sub.endpoint);
      subs.push({ ...prev, ...sub, created: prev?.created || new Date().toISOString() });
      await putJSON(env, SUBS, subs.slice(-MAX_SUBS));
      return { ok: true, devices: subs.length };
    },
    "POST /api/push/unsubscribe": async (env, body) => {
      const ep = String(body.endpoint || "");
      const subs = await getJSON(env, SUBS, []);
      const next = subs.filter((s) => s.endpoint !== ep);
      if (next.length !== subs.length) await putJSON(env, SUBS, next);
      return { ok: true, devices: next.length };
    },
    // 立刻给这台设备推一条最新一期的周报（用来测试）
    "POST /api/push/test": async (env, body) => {
      const ep = String(body.endpoint || "");
      const sub = (await getJSON(env, SUBS, [])).find((s) => s.endpoint === ep);
      if (!sub) throw Object.assign(new Error("这台设备还没有开启通知"), { status: 404 });
      const v = await vapid(env, getJSON, putJSON);
      const msg = weeklyMessage(weeklySummary(await loadAll(env), latestWeek(), sub.excl), sub.lang);
      const status = await sendOne(v, sub, msg);
      if (status === 404 || status === 410) {
        await putJSON(env, SUBS, (await getJSON(env, SUBS, [])).filter((s) => s.endpoint !== ep));
        throw Object.assign(new Error("推送服务说这个订阅已失效，请关掉通知再重新打开"), { status: 410 });
      }
      if (status >= 300) throw Object.assign(new Error(`推送服务返回 ${status}`), { status: 502 });
      return { ok: true };
    },
  };
}

// cron：每周日给所有设备推当周周报；同一周只推一次（last_week 记录）
export async function sendWeekly(env, { getJSON, putJSON, loadAll }) {
  const subs = await getJSON(env, SUBS, []);
  if (!subs.length) return;
  const ws = latestWeek();
  const data = await loadAll(env);
  const v = await vapid(env, getJSON, putJSON);
  const keep = [];
  for (const sub of subs) {
    if (sub.last_week === ws) { keep.push(sub); continue; }
    try {
      const status = await sendOne(v, sub, weeklyMessage(weeklySummary(data, ws, sub.excl), sub.lang));
      if (status === 404 || status === 410) continue; // 设备已取消订阅
      keep.push(status < 300 ? { ...sub, last_week: ws, last_ok: new Date().toISOString() } : { ...sub, last_error: status });
    } catch (e) {
      keep.push({ ...sub, last_error: e.message });
    }
  }
  await putJSON(env, SUBS, keep);
}
