// 按交易日期取历史汇率（每 1 美元兑多少外币），请求里只有公开的年份区间，不带任何交易明细。
// · 人民币：只用于汇丰 Pulse 人民币户口（hsbc_pulse_cny），欧洲央行（ECB）每日参考价。
// · 港币：所有港币户口和港币交易，优先用香港金管局（HKMA）每日收盘价；金管局按月发布、会滞后几周，
//   它还没公布的近期日期先用 ECB 当天的美元兑港币参考价补上，金管局公布后自动换回金管局价。
//   正常情况下由 Worker 每天刷新并存进 KV，随 /api/data 一起下发；后端没有数据时浏览器才自己去取。
// 都通过 Frankfurter（api.frankfurter.dev），浏览器按年缓存；当年数据缓存一小时，已过去的年份取到后复用。
// 取不到报价、或最近的报价离交易日超过 7 天时，临时用固定汇率（CNY 7.1 / HKD 7.8），页面提示「含估算值」。
const pulseCnyId = "hsbc_pulse_cny";
function bookedPulseFx(t) {
  const fx = t.usd_fx;
  return fx?.source === "ECB" && fx.date <= (t.authorized_date || t.date) &&
    Number.isFinite(fx.rate) && fx.rate > 0 && Number.isFinite(fx.amount) ? fx : null;
}

const isoDay = /^\d{4}-\d{2}-\d{2}$/;
// 一条每日汇率序列（一个数据源 × 一个币种），按年下载、按年缓存
function rateSeries(provider, currency, cacheKey) {
  const years = new Map();
  const valid = (r) => r && isoDay.test(r.date) && Number.isFinite(r.rate) && r.rate > 0;
  async function load(year) {
    const key = cacheKey + year;
    let cached = years.get(year);
    if (!cached) {
      try { cached = JSON.parse(localStorage.getItem(key)); } catch { /* 隐私模式 */ }
    }
    if (!Array.isArray(cached?.rows) || !cached.rows.length || !cached.rows.every(valid)) cached = null;
    if (cached) years.set(year, cached);
    const completeAfter = Date.UTC(Number(year) + 1, 0, 2);
    // 金管局按月发布，上一年的数据可能要到次年 2 月才齐，往后多等一个半月再视为「已完整」
    const settled = provider === "HKMA" ? completeAfter + 45 * 864e5 : completeAfter;
    if (cached && (cached.at >= settled || Date.now() - cached.at < 3600000)) return;
    const params = new URLSearchParams({ base: "USD", quotes: currency, providers: provider,
      from: (Number(year) - 1) + "-12-15", to: year + "-12-31" });
    const end = new Date().toISOString().slice(0, 10);
    if (params.get("to") > end) params.set("to", end);
    try {
      const res = await fetch("https://api.frankfurter.dev/v2/rates?" + params, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const rows = (await res.json()).filter(r => valid(r) && r.base === "USD" && r.quote === currency)
        .map(({ date, rate }) => ({ date, rate })).sort((a, b) => a.date.localeCompare(b.date));
      if (!rows.length) return;
      const entry = { rows, at: Date.now() };
      years.set(year, entry);
      try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* 内存缓存照样可用 */ }
    } catch { /* 离线时沿用之前下载的数据 */ }
  }
  // 当天或之前最近一次报价（跨年时往前一年找）
  function at(day) {
    const y = day.slice(0, 4);
    return (years.get(y)?.rows || []).findLast(r => r.date <= day) ||
      (years.get(String(+y - 1))?.rows || []).findLast(r => r.date <= day) || null;
  }
  const last = () => { let m = null; for (const e of years.values()) { const d = e.rows.at(-1)?.date; if (d && (!m || d > m)) m = d; } return m; };
  return { load, at, last };
}
const stale = (day, hit) => !hit || Date.parse(day) - Date.parse(hit.date) > 7 * 86400000;
const yearsOf = (dates) => [...new Set(dates.filter(d => isoDay.test(d || "")).map(d => d.slice(0, 4)))];

const pulseRates = (() => {
  let estimated = false;
  const ecb = rateSeries("ECB", "CNY", "rt_ecb_cny_v1_");
  function quote(day) {
    const hit = ecb.at(day);
    if (stale(day, hit)) estimated = true;
    return hit ? { ...hit, src: "ECB" } : { date: null, rate: FX_PER_USD.CNY, src: null };
  }
  async function prepare(data) {
    estimated = false;
    const a = data.items.flatMap(it => it.accounts).find(a => a.id === pulseCnyId && a.currency === "CNY");
    if (!a) return;
    const dates = [today(), a.balance_as_of?.slice(0, 10), a.liability?.last_statement_issue_date, a.liability?.last_payment_date];
    for (const t of data.transactions) if (t.account_id === a.id && !bookedPulseFx(t)) dates.push(t.authorized_date || t.date);
    await Promise.all(yearsOf(dates).map(ecb.load));
  }
  return { prepare, quote, get estimated() { return estimated; } };
})();

const hkdRates = (() => {
  let estimated = false, active = false, table = null, days = [];
  const hkma = rateSeries("HKMA", "HKD", "rt_hkma_hkd_v1_");
  const ecb = rateSeries("ECB", "HKD", "rt_ecb_hkd_v1_");
  // 后端（Worker 每天刷新的 fx:usd_hkd）给的整张表：日期 → 汇率，金管局价已覆盖 ECB 补位
  function fromTable(day) {
    let lo = 0, hi = days.length - 1, hit = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] <= day) { hit = days[mid]; lo = mid + 1; } else hi = mid - 1; }
    return hit ? { date: hit, rate: table[hit] } : null;
  }
  // 后端还没部署 / 没数据时，浏览器自己取：金管局覆盖到的日期用金管局价，之后用 ECB
  function fromBrowser(day) {
    const lastHkma = hkma.last();
    const hit = lastHkma && day <= lastHkma ? hkma.at(day) : ecb.at(day);
    if (hit && !stale(day, hit)) return hit;
    const h2 = hkma.at(day);
    return h2 && !stale(day, h2) ? h2 : hit;
  }
  function quote(day) {
    if (!isoDay.test(day || "")) day = today();
    const hit = table ? fromTable(day) : fromBrowser(day);
    if (stale(day, hit)) estimated = true;
    return hit ? { date: hit.date, rate: hit.rate } : { date: null, rate: FX_PER_USD.HKD };
  }
  async function prepare(data) {
    estimated = false;
    const accts = data.items.flatMap(it => it.accounts).filter(a => a.currency === "HKD");
    const dates = [];
    for (const a of accts) dates.push(a.balance_as_of?.slice(0, 10), a.liability?.last_statement_issue_date, a.liability?.last_payment_date);
    for (const t of data.transactions) if (t.currency === "HKD") dates.push(t.authorized_date || t.date);
    active = dates.some(Boolean);
    const rates = data.fx?.usd_hkd?.rates;
    if (rates && typeof rates === "object") {
      table = {};
      for (const [d, r] of Object.entries(rates)) if (isoDay.test(d) && Number.isFinite(r) && r > 0) table[d] = r;
      days = Object.keys(table).sort();
      if (days.length) return;
    }
    table = null; days = [];
    if (!active) return;
    dates.push(today());
    const ys = yearsOf(dates);
    await Promise.all([...ys.map(hkma.load), ...ys.map(ecb.load)]);
  }
  return { prepare, quote, get estimated() { return estimated; }, get active() { return active; } };
})();

function pulseBalance(account, transactions, snapshotRate) {
  if (account.balance_as_of || !account.balance_from_txns || account.balance_current == null)
    return account.balance_current == null ? null : account.balance_current / snapshotRate;
  const posted = transactions.filter(t => t.account_id === account.id && !t.pending)
    .sort((a, b) => (a.authorized_date || a.date).localeCompare(b.authorized_date || b.date));
  let native = account.opening_balance || 0;
  let usd = native / (posted[0]?.fx?.rate || snapshotRate);
  for (const t of posted) {
    const delta = t.orig_amount;
    const next = Math.round((native + delta) * 100) / 100;
    if (!next) usd = 0;
    else if (!native || Math.sign(delta) === Math.sign(native)) usd += t.amount;
    else if (Math.sign(next) === Math.sign(native)) usd *= next / native;
    else usd = next / t.fx.rate;
    native = next;
  }
  return usd + (account.balance_current - native) / snapshotRate;
}
