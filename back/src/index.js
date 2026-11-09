// Reward Tracker — Cloudflare Worker 后端
// 作用：代理 Plaid API（secret 只存在这里），把 access_token / 交易 / 权益规则存进 KV。
// 登录：POST /api/login 校验 APP_USERNAME / APP_PASSWORD，返回签名会话令牌；
// 其余请求都要带 Authorization: Bearer <会话令牌>。
// 不走 Plaid 的账户（例如香港 Amex）：POST /api/manual/import 写入，item 记为 source: "manual"，同步时跳过 Plaid。
// 可选：Worker secret INGEST_TOKEN 设置后，脚本可以只凭这个令牌调用写入接口（不能读数据）。

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
      const route = `${request.method} ${url.pathname}`;
      if (!(await verifySession(request, env)) && !(INGEST_ROUTES.has(route) && (await verifyIngest(request, env)))) {
        return json({ error: "请先登录" }, 401, cors);
      }
      const handler = ROUTES[route];
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
      // 更新模式：重新登录；add_liabilities 时顺便请求 Liabilities 授权（不占新连接名额）
      req.access_token = (await getItem(env, body.item_id)).access_token;
      if (body.add_liabilities) req.additional_consented_products = ["liabilities"];
    } else {
      req.products = ["transactions"];
      req.optional_products = ["liabilities"]; // 银行支持就一起授权，不支持也不影响连接
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
    if (!isManual(item)) await plaid(env, "/item/remove", { access_token: item.access_token }).catch(() => {});
    await Promise.all([
      env.DB.delete(`item:${id}`),
      env.DB.delete(`txns:${id}`),
      env.DB.delete(`accounts:${id}`),
      env.DB.delete(`liab:${id}`),
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
      if (isManual(item)) continue; // 手动导入的账户没有 Plaid 连接
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
      cardface: r.cardface && typeof r.cardface === "object" ? r.cardface : {}, // 每张卡选的卡面样式
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

  // 卡面图库：用 wrangler kv bulk put 从本机导入（cardlib = 名字列表，cardlib:<名字> = 图片），只在登录后返回
  "GET /api/cardlib": async (env) => {
    const names = await getJSON(env, "cardlib", []);
    const vals = await Promise.all(names.map((n) => env.DB.get(`cardlib:${n}`)));
    const out = {};
    names.forEach((n, i) => { if (vals[i]) out[n] = vals[i]; });
    return { images: out };
  },

  // 用户上传的卡面照片（已在浏览器里裁成横版 JPEG），每张卡一个 KV 键
  "GET /api/cardimgs": async (env) => {
    const ids = await getJSON(env, "cardimgs", []);
    const out = {};
    for (const id of ids) { const v = await env.DB.get(`cardimg:${id}`); if (v) out[id] = v; }
    return { images: out };
  },
  "PUT /api/cardimg": async (env, body) => {
    const id = String(body.account_id || "");
    if (!id) throw httpError(400, "missing account_id");
    let ids = await getJSON(env, "cardimgs", []);
    if (!body.data) {
      await env.DB.delete(`cardimg:${id}`);
      ids = ids.filter((x) => x !== id);
    } else {
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(body.data)) throw httpError(400, "bad image");
      if (body.data.length > 600_000) throw httpError(413, "image too large");
      await env.DB.put(`cardimg:${id}`, body.data);
      if (!ids.includes(id)) ids.push(id);
    }
    await putJSON(env, "cardimgs", ids);
    return { ok: true };
  },

  // 不走 Plaid 的账户：脚本把账户 / 账单信息 / 交易推上来。交易按 id 去重：已存在的默认跳过（overwrite: true 才覆盖）。
  // body: { item_id: "manual:<名字>", item?: { institution, region, notice }, accounts?: [...], liabilities?: { <account_id>: {...} },
  //         transactions?: [...], remove?: [<txn id>], overwrite?: false, replace_pending?: [<account_id>] }
  // replace_pending：这次带来的是这些账户「完整的」待入账列表，存着但不在列表里的待入账交易（已入账或被撤销）删掉
  "POST /api/manual/import": async (env, body) => manualImport(env, body),

  "PUT /api/benefits": async (env, body) => {
    if (!Array.isArray(body.benefits)) throw httpError(400, "benefits must be an array");
    await putJSON(env, "benefits", body.benefits);
    return { ok: true };
  },
};

// ---------------------------------------------------------------- sync

async function syncItem(env, itemId, { full = false } = {}) {
  const item = await getItem(env, itemId);
  if (isManual(item)) return; // 手动导入的账户只能由 /api/manual/import 更新
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

  // 全量重拉也不清空旧数据：只用 Plaid 返回的新增 / 修改覆盖、按 removed 删除。
  // （Apple Card 这类经 FinanceKit 的连接，Plaid 不一定能重新返回全部历史，清空会把交易弄丢）
  const store = await getJSON(env, `txns:${itemId}`, {});
  for (const t of [...result.added, ...result.modified]) store[t.transaction_id] = slimTxn(t);
  for (const r of result.removed) delete store[r.transaction_id];

  // 账户列表每次都用 /accounts/get（免费）取全量，避免交易对应的账户缺失
  let accounts;
  try { accounts = (await plaid(env, "/accounts/get", { access_token: item.access_token })).accounts; }
  catch { accounts = result.accounts || []; }
  // 这次没拿到账户时保留上次的账户列表，避免账户「消失」
  if (!accounts?.length) {
    const prev = await getJSON(env, `accounts:${itemId}`, []);
    if (prev.length) accounts = null;
  }

  // 信用卡负债：账单金额 / 出账日 / 最低还款 / 还款日 / APR。拿不到不影响交易同步
  const liab = await pullLiabilities(env, item);

  item.cursor = result.cursor;
  item.last_synced = new Date().toISOString();
  item.error = null;
  await Promise.all([
    liab ? putJSON(env, `liab:${itemId}`, liab) : null,
    putJSON(env, `txns:${itemId}`, store),
    accounts ? putJSON(env, `accounts:${itemId}`, accounts.map(slimAccount)) : null,
    putJSON(env, `item:${itemId}`, item),
  ]);
}

async function pullLiabilities(env, item) {
  try {
    const d = await plaid(env, "/liabilities/get", { access_token: item.access_token });
    item.liab_status = "ok";
    const out = {};
    for (const c of d.liabilities?.credit || []) {
      out[c.account_id] = {
        last_statement_balance: c.last_statement_balance ?? null,
        last_statement_issue_date: c.last_statement_issue_date || null,
        minimum_payment_amount: c.minimum_payment_amount ?? null,
        next_payment_due_date: c.next_payment_due_date || null,
        last_payment_amount: c.last_payment_amount ?? null,
        last_payment_date: c.last_payment_date || null,
        is_overdue: c.is_overdue ?? null,
        aprs: (c.aprs || []).map((a) => ({
          type: a.apr_type, pct: a.apr_percentage, balance: a.balance_subject_to_apr ?? null, interest: a.interest_charge_amount ?? null,
        })),
      };
    }
    return out;
  } catch (e) {
    const code = e.plaid?.code || "";
    // 需要用户在更新模式里补授权 / 银行不支持 / 其他错误
    item.liab_status = /CONSENT|NOT_AUTHORIZED|INVALID_PRODUCT/.test(code) ? "consent_required"
      : /NOT_SUPPORTED|NO_LIABILITY_ACCOUNTS|PRODUCTS_NOT_SUPPORTED/.test(code) ? "unsupported" : `error:${code || e.message}`;
    return null;
  }
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
    const [item, accounts, txns, liab] = await Promise.all([
      getJSON(env, `item:${id}`, null),
      getJSON(env, `accounts:${id}`, []),
      getJSON(env, `txns:${id}`, {}),
      getJSON(env, `liab:${id}`, {}),
    ]);
    for (const a of accounts) if (liab[a.id]) a.liability = liab[a.id];
    if (!item) continue;
    if (isManual(item)) manualBalances(accounts, Object.values(txns));
    items.push({
      item_id: id,
      institution: item.institution,
      source: item.source || "plaid",
      region: item.region || null,
      notice: item.notice || null,
      last_synced: item.last_synced,
      error: item.error,
      liab_status: isManual(item) ? (Object.keys(liab).length ? "manual" : "none") : item.liab_status || null,
      accounts,
    });
    transactions = transactions.concat(Object.values(txns));
  }
  transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const [benefits, rewards] = await Promise.all([
    getJSON(env, "benefits", []),
    getJSON(env, "rewards", { cards: {}, rules: {}, balances: {}, closing: {}, cardface: {} }),
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

// ---------------------------------------------------------------- 手动导入（不走 Plaid）

const INGEST_ROUTES = new Set(["POST /api/manual/import"]);
const isManual = (item) => item?.source === "manual";

async function verifyIngest(request, env) {
  if (!env.INGEST_TOKEN) return false;
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") && safeEqual(h.slice(7), env.INGEST_TOKEN);
}

// 当前欠款 = 已导入的全部交易之和（开卡时余额为 0；还款是负数）。额度扣掉欠款就是可用额度
function manualBalances(accounts, txns) {
  for (const a of accounts) {
    if (!a.balance_from_txns) continue;
    const bal = txns.filter((t) => t.account_id === a.id && !t.pending).reduce((s, t) => s + t.amount, 0);
    a.balance_current = round2(bal);
    a.balance_available = typeof a.limit === "number" ? round2(a.limit - bal) : null;
  }
}
const round2 = (n) => Math.round(n * 100) / 100;

const str = (v, max = 200) => (v == null ? null : String(v).slice(0, max));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
// 问卷里的「N/A」原样保留（前端显示为「没有」）；空着的是 null（显示为「—」）
const numOrNA = (v) => (v === "N/A" ? "N/A" : num(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateOrNull = (v) => (typeof v === "string" && DATE_RE.test(v) ? v : null);

function cleanManualAccount(a) {
  if (!a || typeof a !== "object") throw httpError(400, "account 必须是对象");
  const id = str(a.id, 64);
  if (!id || !/^[A-Za-z0-9_:-]+$/.test(id)) throw httpError(400, `account id 不合法：${a.id}`);
  const currency = str(a.currency, 3) || "USD";
  if (!/^[A-Z]{3}$/.test(currency)) throw httpError(400, `币种不合法：${a.currency}`);
  return {
    id,
    name: str(a.name) || id,
    official_name: str(a.official_name),
    mask: str(a.mask, 8),
    type: ["credit", "depository", "investment", "loan"].includes(a.type) ? a.type : "credit",
    subtype: str(a.subtype, 40),
    balance_current: num(a.balance_current),
    balance_available: num(a.balance_available),
    limit: num(a.limit),
    currency,
    balance_from_txns: !!a.balance_from_txns,
    opened: dateOrNull(a.opened),
  };
}

function cleanManualLiability(L) {
  if (!L || typeof L !== "object") return null;
  const aprs = L.aprs === "N/A" ? "N/A" : Array.isArray(L.aprs)
    ? L.aprs.slice(0, 6).map((x) => ({ type: str(x?.type, 40), pct: numOrNA(x?.pct), balance: null, interest: null })).filter((x) => x.type)
    : [];
  return {
    last_statement_balance: num(L.last_statement_balance),
    last_statement_issue_date: dateOrNull(L.last_statement_issue_date),
    minimum_payment_amount: numOrNA(L.minimum_payment_amount),
    next_payment_due_date: L.next_payment_due_date === "N/A" ? "N/A" : dateOrNull(L.next_payment_due_date),
    last_payment_amount: num(L.last_payment_amount),
    last_payment_date: dateOrNull(L.last_payment_date),
    is_overdue: typeof L.is_overdue === "boolean" ? L.is_overdue : null,
    aprs,
    statement_day: num(L.statement_day),
    due_day: numOrNA(L.due_day),
    source: str(L.source, 80),
  };
}

function cleanManualTxn(t, acctIds) {
  if (!t || typeof t !== "object") return "不是对象";
  const id = str(t.id, 80);
  if (!id) return "缺少 id";
  if (!acctIds.has(t.account_id)) return `账户 ${t.account_id} 不存在`;
  if (!dateOrNull(t.date)) return `日期不合法：${t.date}`;
  if (num(t.amount) == null) return `金额不合法：${t.amount}`;
  const currency = str(t.currency, 3) || "USD";
  if (!/^[A-Z]{3}$/.test(currency)) return `币种不合法：${t.currency}`;
  const detail = t.detail && typeof t.detail === "object" ? t.detail : {};
  if (JSON.stringify(detail).length > 4000) return "detail 太大";
  return {
    id,
    account_id: t.account_id,
    date: t.date,
    authorized_date: dateOrNull(t.authorized_date),
    name: str(t.name) || "",
    merchant: str(t.merchant),
    amount: t.amount, // 和 Plaid 一致：正数 = 支出，负数 = 退款 / 还款
    currency,
    category: str(t.category, 60),
    category_detail: str(t.category_detail, 80),
    mcc: str(t.mcc, 4),
    channel: str(t.channel, 20),
    website: str(t.website),
    detail,
    pending: !!t.pending,
    logo: null,
    source: str(t.source, 40),
  };
}

async function manualImport(env, body) {
  const id = String(body.item_id || "");
  if (!/^manual:[a-z0-9_-]{1,40}$/.test(id)) throw httpError(400, "item_id 必须形如 manual:<小写名字>");
  const prev = await getJSON(env, `item:${id}`, null);
  if (prev && !isManual(prev)) throw httpError(409, "这个 item_id 已被 Plaid 连接占用");
  if (!prev && !body.item) throw httpError(400, "首次导入需要提供 item（机构名等）");
  const now = new Date().toISOString();
  const meta = body.item || {};
  const item = {
    ...(prev || { added_at: now, cursor: null, error: null }),
    source: "manual",
    institution: str(meta.institution) || prev?.institution || "Manual",
    region: str(meta.region, 8) ?? prev?.region ?? null,
    notice: str(meta.notice, 600) ?? prev?.notice ?? null,
    last_synced: now,
  };

  // 账户：按 id 覆盖，没提到的账户保留
  let accounts = await getJSON(env, `accounts:${id}`, []);
  if (Array.isArray(body.accounts)) {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const a of body.accounts.slice(0, 20)) { const c = cleanManualAccount(a); byId.set(c.id, c); }
    accounts = [...byId.values()];
  }
  const acctIds = new Set(accounts.map((a) => a.id));

  // 账单信息：按账户覆盖
  const liab = await getJSON(env, `liab:${id}`, {});
  if (body.liabilities && typeof body.liabilities === "object") {
    for (const [aid, L] of Object.entries(body.liabilities)) {
      if (!acctIds.has(aid)) throw httpError(400, `账单信息里的账户 ${aid} 不存在`);
      const c = cleanManualLiability(L);
      if (c) liab[aid] = c;
    }
  }

  // 交易：已有的跳过（或 overwrite 时覆盖）；remove 用来删掉被正式入账取代的待入账交易
  const list = Array.isArray(body.transactions) ? body.transactions : [];
  if (list.length > 5000) throw httpError(413, "一次最多 5000 笔交易");
  const store = await getJSON(env, `txns:${id}`, {});
  let added = 0, skipped = 0, updated = 0, removed = 0;
  const rejected = [];
  for (const t of list) {
    const c = cleanManualTxn(t, acctIds);
    if (typeof c === "string") { rejected.push({ id: t?.id ?? null, reason: c }); continue; }
    // 已存在的跳过；但待入账的可以被更新（金额 / 状态会变）
    if (store[c.id] && !body.overwrite && !store[c.id].pending) { skipped++; continue; }
    if (store[c.id]) updated++; else added++;
    store[c.id] = c;
  }
  for (const rid of Array.isArray(body.remove) ? body.remove : []) {
    if (store[rid]) { delete store[rid]; removed++; }
  }
  if (Array.isArray(body.replace_pending)) {
    const accts = new Set(body.replace_pending), incoming = new Set(list.map((t) => t?.id));
    for (const [k, v] of Object.entries(store)) {
      if (v.pending && accts.has(v.account_id) && !incoming.has(k)) { delete store[k]; removed++; }
    }
  }

  const ids = await getJSON(env, "items", []);
  if (!ids.includes(id)) ids.push(id);
  await Promise.all([
    putJSON(env, `item:${id}`, item),
    putJSON(env, `accounts:${id}`, accounts),
    putJSON(env, `liab:${id}`, liab),
    putJSON(env, `txns:${id}`, store),
    putJSON(env, "items", ids),
  ]);
  return { ok: true, item_id: id, added, skipped, updated, removed, rejected, total: Object.keys(store).length };
}

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
