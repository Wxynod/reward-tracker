// Reward Tracker — Cloudflare Worker 后端
// 作用：代理 Plaid API（secret 只存在这里），把 access_token / 交易 / 权益规则存进 KV。
// 登录：POST /api/login 校验 APP_USERNAME / APP_PASSWORD，返回签名会话令牌；
// 其余请求都要带 Authorization: Bearer <会话令牌>。
// Apple Card：Plaid 连不上，改由 iOS 快捷指令在每次 Apple Pay 付款后 POST /api/ingest/apple-card，
// 用单独的 APPLE_INGEST_TOKEN 验证（不用登录令牌，因为快捷指令里要长期保存）。

const PLAID_HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

const SESSION_DAYS = 14;   // 登录有效期
const MAX_FAILS = 5;       // 同一 IP 连续失败次数上限
const LOCK_SECONDS = 900;  // 超限后锁定时长

// Apple Card（快捷指令推送）在数据里伪装成一个 item + 一个信用卡账户，前端和积分计算不用区分来源
const APPLE_ITEM = "apple";
const APPLE_ACCOUNT = "apple-card";

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/api/login") return await login(request, env, cors);
      if (request.method === "POST" && url.pathname === "/api/ingest/apple-card") return await ingestApple(request, env, cors);
      if (!(await verifySession(request, env))) return json({ error: "请先登录" }, 401, cors);
      const handler = ROUTES[`${request.method} ${url.pathname}`];
      if (!handler) return json({ error: "not found" }, 404, cors);
      const body = ["POST", "PUT"].includes(request.method)
        ? await request.json().catch(() => ({}))
        : {};
      return json(await handler(env, body, url), 200, cors);
    } catch (err) {
      return json({ error: err.message, plaid: err.plaid || null }, err.status || 500, cors);
    }
  },
};

// ---------------------------------------------------------------- routes

const ROUTES = {
  // 创建 Link token；传 item_id 时进入 update mode（重新登录过期的连接）
  "POST /api/link-token": async (env, body) => {
    const req = {
      user: { client_user_id: "owner" },
      client_name: "Reward Tracker",
      country_codes: ["US"],
      language: "en",
    };
    if (env.PLAID_REDIRECT_URI) req.redirect_uri = env.PLAID_REDIRECT_URI;
    if (body.item_id) {
      req.access_token = (await getItem(env, body.item_id)).access_token;
    } else {
      req.products = ["transactions"];
      req.transactions = { days_requested: 730 };
    }
    const data = await plaid(env, "/link/token/create", req);
    return { link_token: data.link_token };
  },

  // Link 成功后用 public_token 换 access_token，存进 KV
  "POST /api/exchange": async (env, body) => {
    if (!body.public_token) throw httpError(400, "missing public_token");
    const ex = await plaid(env, "/item/public_token/exchange", { public_token: body.public_token });
    const inst = body.institution || {};
    await putJSON(env, `item:${ex.item_id}`, {
      access_token: ex.access_token,
      cursor: null,
      institution: inst.name || "Unknown",
      institution_id: inst.institution_id || null,
      added_at: new Date().toISOString(),
      last_synced: null,
      error: null,
    });
    const ids = await getJSON(env, "items", []);
    if (!ids.includes(ex.item_id)) ids.push(ex.item_id);
    await putJSON(env, "items", ids);
    await syncItem(env, ex.item_id).catch(() => {}); // 首次同步失败不影响连接
    return { item_id: ex.item_id };
  },

  // 拉取所有 Item 的增量交易，然后返回全量数据
  "POST /api/sync": async (env) => {
    const ids = await getJSON(env, "items", []);
    for (const id of ids) {
      try {
        await syncItem(env, id);
      } catch (e) {
        const item = await getItem(env, id);
        item.error = { code: e.plaid?.code || "UNKNOWN", message: e.message };
        await putJSON(env, `item:${id}`, item);
      }
    }
    return loadAll(env);
  },

  "GET /api/data": (env) => loadAll(env),

  "POST /api/items/remove": async (env, body) => {
    const id = body.item_id;
    if (id === APPLE_ITEM) {
      await Promise.all([env.DB.delete(`manual:${APPLE_ITEM}`), env.DB.delete(`txns:${APPLE_ITEM}`)]);
      return { ok: true };
    }
    const item = await getItem(env, id);
    await plaid(env, "/item/remove", { access_token: item.access_token }).catch(() => {});
    await Promise.all([
      env.DB.delete(`item:${id}`),
      env.DB.delete(`txns:${id}`),
      env.DB.delete(`accounts:${id}`),
    ]);
    const ids = (await getJSON(env, "items", [])).filter((x) => x !== id);
    await putJSON(env, "items", ids);
    return { ok: true };
  },

  // 让 Plaid 立刻去银行抓最新交易（含 Pending）。异步完成，几十秒后再 /api/sync 就能拿到。
  // Trial 计划含 Refresh；按量付费计划下 /transactions/refresh 按次计费
  "POST /api/refresh": async (env) => {
    const ids = await getJSON(env, "items", []);
    const results = [];
    for (const id of ids) {
      const item = await getItem(env, id);
      try {
        await plaid(env, "/transactions/refresh", { access_token: item.access_token });
        results.push({ institution: item.institution, ok: true });
      } catch (e) {
        results.push({ institution: item.institution, ok: false, error: e.plaid?.code || e.message });
      }
    }
    return { results };
  },

  // 全量重新拉取：cursor 清零，重建交易缓存（用来补齐旧交易缺的 MCC 等字段；/transactions/sync 不按次计费）
  "POST /api/resync": async (env) => {
    const ids = await getJSON(env, "items", []);
    for (const id of ids) {
      try { await syncItem(env, id, { full: true }); }
      catch (e) {
        const item = await getItem(env, id);
        item.error = { code: e.plaid?.code || "UNKNOWN", message: e.message };
        await putJSON(env, `item:${id}`, item);
      }
    }
    return loadAll(env);
  },

  // 积分设置：卡片对应、学习到的倍数规则、各积分计划余额
  "PUT /api/rewards": async (env, body) => {
    const r = body.rewards;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw httpError(400, "rewards must be an object");
    const clean = {
      cards: r.cards && typeof r.cards === "object" ? r.cards : {},
      rules: r.rules && typeof r.rules === "object" ? r.rules : {},
      balances: r.balances && typeof r.balances === "object" ? r.balances : {},
      closing: r.closing && typeof r.closing === "object" ? r.closing : {}, // 每张卡的账单日（1–31）
    };
    if (JSON.stringify(clean).length > 200_000) throw httpError(413, "rewards too large");
    await putJSON(env, "rewards", clean);
    return { ok: true };
  },

  // 银行 logo（来自 Plaid 机构信息，按机构缓存在 KV 里，30 天刷新一次）
  "GET /api/logos": async (env) => {
    const ids = await getJSON(env, "items", []);
    const out = {};
    for (const id of ids) {
      const item = await getJSON(env, `item:${id}`, null);
      if (!item?.institution_id) continue;
      const key = `inst:${item.institution_id}`;
      let inst = await getJSON(env, key, null);
      if (!inst || Date.now() - (inst.fetched || 0) > 30 * 864e5) {
        try {
          const d = await plaid(env, "/institutions/get_by_id", {
            institution_id: item.institution_id,
            country_codes: ["US"],
            options: { include_optional_metadata: true },
          });
          inst = {
            logo: d.institution.logo || null,
            color: d.institution.primary_color || null,
            url: d.institution.url || null,
            fetched: Date.now(),
          };
          await putJSON(env, key, inst);
        } catch { inst = inst || { logo: null, color: null, url: null }; }
      }
      out[item.institution] = { logo: inst.logo, color: inst.color, url: inst.url };
    }
    return { logos: out };
  },

  // 删除一笔快捷指令推送的交易（推错了、或者后来退款了）
  "POST /api/manual/delete": async (env, body) => {
    const store = await getJSON(env, `txns:${APPLE_ITEM}`, {});
    if (!store[body.id]) throw httpError(404, "交易不存在");
    delete store[body.id];
    await putJSON(env, `txns:${APPLE_ITEM}`, store);
    return loadAll(env);
  },

  "PUT /api/benefits": async (env, body) => {
    if (!Array.isArray(body.benefits)) throw httpError(400, "benefits must be an array");
    await putJSON(env, "benefits", body.benefits);
    return { ok: true };
  },
};

// ---------------------------------------------------------------- sync

async function syncItem(env, itemId, { full = false } = {}) {
  const item = await getItem(env, itemId);
  if (full) item.cursor = null;
  let result;
  // 分页期间数据变动时，Plaid 要求从本轮起始 cursor 重来
  for (let attempt = 0; ; attempt++) {
    try {
      result = await pullAll(env, item);
      break;
    } catch (e) {
      if (e.plaid?.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt < 2) continue;
      throw e;
    }
  }

  const store = full ? {} : await getJSON(env, `txns:${itemId}`, {});
  for (const t of [...result.added, ...result.modified]) store[t.transaction_id] = slimTxn(t);
  for (const r of result.removed) delete store[r.transaction_id];

  // 账户列表每次都用 /accounts/get（免费）取全量，避免交易对应的账户缺失
  let accounts;
  try { accounts = (await plaid(env, "/accounts/get", { access_token: item.access_token })).accounts; }
  catch { accounts = result.accounts || []; }

  item.cursor = result.cursor;
  item.last_synced = new Date().toISOString();
  item.error = null;
  await Promise.all([
    putJSON(env, `txns:${itemId}`, store),
    putJSON(env, `accounts:${itemId}`, accounts.map(slimAccount)),
    putJSON(env, `item:${itemId}`, item),
  ]);
}

async function pullAll(env, item) {
  const out = { added: [], modified: [], removed: [], accounts: null, cursor: item.cursor };
  let hasMore = true;
  while (hasMore) {
    const req = { access_token: item.access_token, count: 500, options: { include_original_description: true } };
    if (out.cursor) req.cursor = out.cursor;
    const d = await plaid(env, "/transactions/sync", req);
    out.added.push(...d.added);
    out.modified.push(...d.modified);
    out.removed.push(...d.removed);
    if (d.accounts?.length) out.accounts = d.accounts;
    out.cursor = d.next_cursor;
    hasMore = d.has_more;
  }
  return out;
}

async function loadAll(env) {
  const ids = await getJSON(env, "items", []);
  const items = [];
  let transactions = [];
  for (const id of ids) {
    const [item, accounts, txns] = await Promise.all([
      getJSON(env, `item:${id}`, null),
      getJSON(env, `accounts:${id}`, []),
      getJSON(env, `txns:${id}`, {}),
    ]);
    if (!item) continue;
    items.push({
      item_id: id,
      institution: item.institution,
      last_synced: item.last_synced,
      error: item.error,
      accounts,
    });
    transactions = transactions.concat(Object.values(txns));
  }
  const apple = await getJSON(env, `manual:${APPLE_ITEM}`, null);
  if (apple) {
    items.push({
      item_id: APPLE_ITEM,
      institution: "Apple Card",
      manual: true,
      last_synced: apple.last_synced,
      error: null,
      accounts: [{
        id: APPLE_ACCOUNT, name: "Apple Card", official_name: "Apple Card · Goldman Sachs", mask: null,
        type: "credit", subtype: "credit card", balance_current: null, balance_available: null, limit: null, currency: "USD",
      }],
    });
    transactions = transactions.concat(Object.values(await getJSON(env, `txns:${APPLE_ITEM}`, {})));
  }
  transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const [benefits, rewards] = await Promise.all([
    getJSON(env, "benefits", []),
    getJSON(env, "rewards", { cards: {}, rules: {}, balances: {}, closing: {} }),
  ]);
  return { env: env.PLAID_ENV || "sandbox", items, transactions, benefits, rewards };
}

const slimTxn = (t) => ({
  id: t.transaction_id,
  account_id: t.account_id,
  date: t.date,
  authorized_date: t.authorized_date || null,
  name: t.name,
  merchant: t.merchant_name || null,
  amount: t.amount, // Plaid：正数 = 支出，负数 = 退款 / 还款
  currency: t.iso_currency_code || t.unofficial_currency_code || "USD",
  category: t.personal_finance_category?.primary || null,
  category_detail: t.personal_finance_category?.detailed || null,
  mcc: t.merchant_category_code || null, // 4 位 MCC（Plaid beta 字段，部分交易为空）
  channel: t.payment_channel || null,
  website: t.website || t.counterparties?.find((c) => c.website)?.website || null, // 用来找品牌 logo
  detail: txnDetail(t), // 交易明细弹窗用：Plaid 返回的其余字段（空值省略）
  pending: !!t.pending,
  logo: t.logo_url || null,
});

// 去掉 null / 空字符串 / 空数组 / 空对象，减小 KV 体积
function compact(v) {
  if (Array.isArray(v)) { const a = v.map(compact).filter((x) => x !== undefined); return a.length ? a : undefined; }
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) { const c = compact(x); if (c !== undefined) o[k] = c; }
    return Object.keys(o).length ? o : undefined;
  }
  return v === null || v === "" ? undefined : v;
}

const txnDetail = (t) => compact({
  original_description: t.original_description,
  authorized_datetime: t.authorized_datetime,
  datetime: t.datetime,
  pending_transaction_id: t.pending_transaction_id,
  transaction_type: t.transaction_type,
  transaction_code: t.transaction_code,
  check_number: t.check_number,
  account_owner: t.account_owner,
  merchant_entity_id: t.merchant_entity_id,
  unofficial_currency_code: t.unofficial_currency_code,
  location: t.location,
  payment_meta: t.payment_meta,
  personal_finance_category: t.personal_finance_category,
  category_icon: t.personal_finance_category_icon_url,
  counterparties: t.counterparties?.map((c) => ({
    name: c.name, type: c.type, entity_id: c.entity_id, website: c.website, logo_url: c.logo_url,
    confidence_level: c.confidence_level, phone_number: c.phone_number,
  })),
}) || {};

const slimAccount = (a) => ({
  id: a.account_id,
  name: a.name,
  official_name: a.official_name || null,
  mask: a.mask || null,
  type: a.type,
  subtype: a.subtype,
  balance_current: a.balances?.current ?? null,
  balance_available: a.balances?.available ?? null,
  limit: a.balances?.limit ?? null,
  currency: a.balances?.iso_currency_code || "USD",
});

// ---------------------------------------------------------------- helpers

async function plaid(env, path, body) {
  const host = PLAID_HOSTS[env.PLAID_ENV || "sandbox"];
  if (!host) throw httpError(500, `unknown PLAID_ENV: ${env.PLAID_ENV}`);
  const res = await fetch(host + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = httpError(502, data.display_message || data.error_message || "Plaid error");
    err.plaid = { code: data.error_code, type: data.error_type, request_id: data.request_id };
    throw err;
  }
  return data;
}

async function getItem(env, id) {
  const item = await getJSON(env, `item:${id}`, null);
  if (!item) throw httpError(404, "item not found");
  return item;
}

async function getJSON(env, key, fallback) {
  const v = await env.DB.get(key, "json");
  return v ?? fallback;
}

const putJSON = (env, key, value) => env.DB.put(key, JSON.stringify(value));

// ---------------------------------------------------------------- Apple Card（iOS 快捷指令）

// 快捷指令请求体（JSON）：
//   { "merchant": 商户, "amount": 金额, "card": 卡名, "date": ISO 8601 时间 }
// amount 可以是 "$12.34" / "US$1,234.50" / 12.34 这类格式；date 不传就用收到请求的时间
async function ingestApple(request, env, cors) {
  if (!env.APPLE_INGEST_TOKEN) return json({ error: "Worker 未配置 APPLE_INGEST_TOKEN" }, 500, cors);
  const h = request.headers.get("Authorization") || "";
  const given = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!(await safeEqual(given, env.APPLE_INGEST_TOKEN))) return json({ error: "token 错误" }, 401, cors);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "请求体要是 JSON" }, 400, cors);

  const amount = parseAmount(body.amount);
  if (amount == null) return json({ error: `看不懂金额：${String(body.amount).slice(0, 40)}` }, 400, cors);
  const merchant = String(body.merchant || "").trim().slice(0, 120) || "Apple Card 消费";
  const card = String(body.card || "").trim().slice(0, 60) || null;

  // 用手机发来的本地时间取日期（避免跨时区把晚上的消费算到第二天）
  const rawDate = String(body.date || "").trim();
  const iso = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate : new Date().toISOString();
  const date = iso.slice(0, 10);

  // 同一分钟、同金额、同商户视为重复推送（快捷指令偶尔会触发两次）
  const id = "apl_" + (await sha256Hex(`${iso.slice(0, 16)}|${amount}|${merchant.toLowerCase()}`)).slice(0, 20);

  const store = await getJSON(env, `txns:${APPLE_ITEM}`, {});
  const dup = !!store[id];
  store[id] = {
    id,
    account_id: APPLE_ACCOUNT,
    date,
    authorized_date: date,
    name: merchant,
    merchant,
    amount, // 与 Plaid 一致：正数 = 支出
    currency: "USD",
    category: null,
    category_detail: null,
    mcc: null,
    channel: null,
    website: null,
    detail: compact({ source: "shortcut", authorized_datetime: iso, card, raw_amount: String(body.amount) }) || {},
    pending: false,
    logo: null,
  };
  const meta = (await getJSON(env, `manual:${APPLE_ITEM}`, null)) || { added_at: new Date().toISOString() };
  meta.last_synced = new Date().toISOString();
  await Promise.all([putJSON(env, `txns:${APPLE_ITEM}`, store), putJSON(env, `manual:${APPLE_ITEM}`, meta)]);
  return json({ ok: true, duplicate: dup, id, date, merchant, amount }, 200, cors);
}

function parseAmount(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  let s = String(v ?? "").replace(/[^\d.,\-−]/g, "").replace("−", "-");
  if (!/\d/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");          // 1,234.50
  else if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", "."); // 12,34（欧式小数点）
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- auth

async function login(request, env, cors) {
  if (!env.APP_USERNAME || !env.APP_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: "Worker 未配置登录信息" }, 500, cors);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const failKey = `fail:${ip}`;
  const fails = Number(await env.DB.get(failKey)) || 0;
  if (fails >= MAX_FAILS) return json({ error: "尝试次数过多，请 15 分钟后再试" }, 429, cors);

  const body = await request.json().catch(() => ({}));
  const userOk = await safeEqual(String(body.username || ""), env.APP_USERNAME);
  const passOk = await safeEqual(String(body.password || ""), env.APP_PASSWORD);
  if (!(userOk && passOk)) {
    await env.DB.put(failKey, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    return json({ error: "账号或密码错误" }, 401, cors);
  }

  await env.DB.delete(failKey);
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const token = await signSession(env, { sub: env.APP_USERNAME, exp });
  return json({ token, exp }, 200, cors);
}

// 令牌格式：base64url(payload).base64url(HMAC-SHA256(payload))
// 更换 SESSION_SECRET 即可让所有已登录设备失效
async function signSession(env, payload) {
  const data = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

async function verifySession(request, env) {
  if (!env.SESSION_SECRET) return false;
  const h = request.headers.get("Authorization") || "";
  const [data, sig] = (h.startsWith("Bearer ") ? h.slice(7) : "").split(".");
  if (!data || !sig) return false;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC", await hmacKey(env), unb64url(sig), new TextEncoder().encode(data)
    );
    if (!ok) return false;
    const p = JSON.parse(new TextDecoder().decode(unb64url(data)));
    return p.exp > Date.now() && p.sub === env.APP_USERNAME;
  } catch {
    return false;
  }
}

const hmacKey = (env) =>
  crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
