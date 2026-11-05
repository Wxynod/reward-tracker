// Reward Tracker — Cloudflare Worker 后端
// 作用：代理 Plaid API（secret 只存在这里），把 access_token / 交易 / 权益规则存进 KV。
// 登录：POST /api/login 校验 APP_USERNAME / APP_PASSWORD，返回签名会话令牌；
// 其余请求都要带 Authorization: Bearer <会话令牌>。

const PLAID_HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

const SESSION_DAYS = 14;   // 登录有效期
const MAX_FAILS = 5;       // 同一 IP 连续失败次数上限
const LOCK_SECONDS = 900;  // 超限后锁定时长

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/api/login") return await login(request, env, cors);
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

  "PUT /api/benefits": async (env, body) => {
    if (!Array.isArray(body.benefits)) throw httpError(400, "benefits must be an array");
    await putJSON(env, "benefits", body.benefits);
    return { ok: true };
  },
};

// ---------------------------------------------------------------- sync

async function syncItem(env, itemId) {
  const item = await getItem(env, itemId);
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

  const store = await getJSON(env, `txns:${itemId}`, {});
  for (const t of [...result.added, ...result.modified]) store[t.transaction_id] = slimTxn(t);
  for (const r of result.removed) delete store[r.transaction_id];

  let accounts = result.accounts;
  if (!accounts?.length) {
    accounts = (await plaid(env, "/accounts/get", { access_token: item.access_token })).accounts;
  }

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
    const req = { access_token: item.access_token, count: 500 };
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
  transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const benefits = await getJSON(env, "benefits", []);
  return { env: env.PLAID_ENV || "sandbox", items, transactions, benefits };
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
  pending: !!t.pending,
  logo: t.logo_url || null,
});

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
