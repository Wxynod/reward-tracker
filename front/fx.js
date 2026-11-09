// Historical daily ECB reference rates, in CNY per USD. Requests contain only public calendar years.
const pulseCnyId = "hsbc_pulse_cny";
function bookedPulseFx(t) {
  const fx = t.usd_fx;
  return fx?.source === "ECB" && fx.date <= (t.authorized_date || t.date) &&
    Number.isFinite(fx.rate) && fx.rate > 0 && Number.isFinite(fx.amount) ? fx : null;
}
const pulseRates = (() => {
  let estimated = false;
  const years = new Map();
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  async function load(year) {
    const key = "rt_ecb_cny_v1_" + year;
    let cached = years.get(year);
    if (!cached) {
      try { cached = JSON.parse(localStorage.getItem(key)); } catch { /* private browsing */ }
    }
    const valid = (r) => r && isoDay.test(r.date) && Number.isFinite(r.rate) && r.rate > 0;
    if (!Array.isArray(cached?.rows) || !cached.rows.length || !cached.rows.every(valid)) cached = null;
    if (cached) years.set(year, cached);
    const completeAfter = Date.UTC(Number(year) + 1, 0, 2);
    if (cached && (cached.at >= completeAfter || Date.now() - cached.at < 3600000)) return;
    const params = new URLSearchParams({ base: "USD", quotes: "CNY", providers: "ECB",
      from: (Number(year) - 1) + "-12-15", to: year + "-12-31" });
    const end = new Date().toISOString().slice(0, 10);
    if (params.get("to") > end) params.set("to", end);
    try {
      const res = await fetch("https://api.frankfurter.dev/v2/rates?" + params, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const rows = (await res.json()).filter(r => valid(r) && r.base === "USD" && r.quote === "CNY")
        .map(({ date, rate }) => ({ date, rate })).sort((a, b) => a.date.localeCompare(b.date));
      if (!rows.length) return;
      const entry = { rows, at: Date.now() };
      years.set(year, entry);
      try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* memory cache still works */ }
    } catch { /* Keep previously downloaded observations when offline. */ }
  }
  function quote(day) {
    const rows = years.get(day?.slice(0, 4))?.rows || [];
    const hit = rows.findLast(r => r.date <= day);
    if (!hit || Date.parse(day) - Date.parse(hit.date) > 7 * 86400000) estimated = true;
    return hit || { date: null, rate: FX_PER_USD.CNY };
  }
  async function prepare(data) {
    estimated = false;
    const a = data.items.flatMap(it => it.accounts).find(a => a.id === pulseCnyId && a.currency === "CNY");
    if (!a) return;
    const dates = [today(), a.balance_as_of?.slice(0, 10), a.liability?.last_statement_issue_date, a.liability?.last_payment_date];
    for (const t of data.transactions) if (t.account_id === a.id && !bookedPulseFx(t)) dates.push(t.authorized_date || t.date);
    await Promise.all([...new Set(dates.filter(d => isoDay.test(d)).map(d => d.slice(0, 4)))].map(load));
  }
  return { prepare, quote, get estimated() { return estimated; } };
})();

// Remaining principal at weighted historical cost. Repayments release the average cost of outstanding CNY.
// Crossing zero starts a new debit or credit position at the rate of that day's transaction.
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
  // Older or partial imports can include a balance whose transactions are unavailable.
  return usd + (account.balance_current - native) / snapshotRate;
}
