// Reward Tracker — 周报：每周一到周日为一期，周日当天出具。
// 「分析」页顶部是最新一期的入口卡片，点开是完整周报（按周翻页、所有历史周报目录、选卡、按类别 / 按商户、最大几笔、本周积分）。
// 所有周报都由已有交易实时算出，不另外存储；选卡存在 localStorage rt_weekly_excl（存「排除的卡」，以后新加的卡默认算进去）。
// 用到 app.js 的全局：state、R、I、B、fmt、fmtOrig、esc、cardName、creditAccounts、earningsGroup、earningsGroupInfo、programLogo、RT_CARDS、RT_DETAIL。
// 文案：整块带 data-i18n-skip，中英文都在这里按 RT_I18N.lang 直接生成（类别名走 RT_I18N.t）。

(function () {
  const NO_SPEND = new Set(["LOAN_PAYMENTS", "TRANSFER_IN", "TRANSFER_OUT", "INCOME", "BANK_FEES"]);
  const KEY = "rt_weekly_excl";
  const EN = () => window.RT_I18N?.lang === "en";
  const L = (zh, en) => (EN() ? en : zh);
  const T = (s) => (window.RT_I18N?.t ? RT_I18N.t(s) : s);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WD = { zh: ["一", "二", "三", "四", "五", "六", "日"], en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] };
  const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ------------------------------------------------------------ 日期（本地日历日 YYYY-MM-DD，周一为一周第一天）
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const dow = (s) => (parse(s).getDay() + 6) % 7;
  const weekStart = (s) => addDays(s, -dow(s));
  const todayLocal = () => iso(new Date());
  // 最新一期：周日 ≤ 今天的那一周（周日当天出具当周）
  const latestWeek = () => { const t = todayLocal(); return dow(t) === 6 ? weekStart(t) : addDays(weekStart(t), -7); };
  const nextIssue = () => addDays(latestWeek(), 13);

  const md = (s) => (EN() ? `${MON[+s.slice(5, 7) - 1]} ${+s.slice(8)}` : `${+s.slice(5, 7)}月${+s.slice(8)}日`);
  function rangeLabel(ws, withYear) {
    const we = addDays(ws, 6), sameMonth = ws.slice(0, 7) === we.slice(0, 7);
    const y = withYear || ws.slice(0, 4) !== todayLocal().slice(0, 4) ? we.slice(0, 4) : "";
    if (EN()) return `${md(ws)} – ${sameMonth ? +we.slice(8) : md(we)}${y ? `, ${y}` : ""}`;
    return `${y ? `${y} 年 ` : ""}${md(ws)} – ${sameMonth ? `${+we.slice(8)}日` : md(we)}`;
  }
  const shortRange = (ws) => { const we = addDays(ws, 6); return `${+ws.slice(5, 7)}/${+ws.slice(8)} – ${+we.slice(5, 7)}/${+we.slice(8)}`; };

  // ------------------------------------------------------------ 选卡
  const cards = () => creditAccounts().slice().sort((a, b) =>
    `${a.institution}|${cardName(a)}|${a.mask}`.localeCompare(`${b.institution}|${cardName(b)}|${b.mask}`));
  function excluded() { try { return new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch { return new Set(); } }
  function saveExcluded(set) { try { localStorage.setItem(KEY, JSON.stringify([...set])); } catch { /* 隐私模式 */ } }
  const selected = () => { const ex = excluded(); return cards().filter((a) => !ex.has(a.id)); };

  // ------------------------------------------------------------ 数据
  // 消费 = 信用卡上的购物净额（退款冲减；还款、转账、费用、年费、权益返现不算），和「分析」页口径一致
  function spendOf(ids) {
    return state.txns.filter((t) => ids.has(t.account_id) && !NO_SPEND.has(t.category) && !R.isBenefitCredit(t) && !R.isAnnualFee(t));
  }
  function weeksIndex(list) {
    const by = new Map();
    for (const t of list) { const w = weekStart(t.date); (by.get(w) || by.set(w, []).get(w)).push(t); }
    return by;
  }
  function weekStats(ws, by) {
    const list = by.get(ws) || [];
    const daily = [0, 0, 0, 0, 0, 0, 0];
    let net = 0, refunds = 0, buys = 0;
    for (const t of list) {
      net += t.amount; daily[dow(t.date)] += t.amount;
      if (t.amount < 0) refunds += t.amount; else buys++;
    }
    return { ws, list, daily, net, refunds, buys };
  }
  function groupBy(list, keyFn) {
    const m = new Map();
    for (const t of list) {
      const k = keyFn(t); const g = m.get(k) || { k, v: 0, n: 0, t };
      g.v += t.amount; if (t.amount > 0) g.n++; m.set(k, g);
    }
    return m;
  }
  const catKey = (t) => I.info(t).key;
  const merchKey = (t) => (t.merchant || t.name || "").trim();

  // 本周积分：按积分计划合计（现金返现合并成 Cash Back）
  function weekEarn(list) {
    const m = new Map();
    for (const t of list) {
      const e = state.earn?.get(t.id);
      if (!e || e.cat === "none" || !e.earned) continue;
      const g = earningsGroup(e.program);
      m.set(g, (m.get(g) || 0) + e.earned);
    }
    return [...m].filter(([, v]) => Math.abs(v) > 0.004).sort((a, b) => {
      const ua = earningsGroupInfo(a[0]).unit === "cash", ub = earningsGroupInfo(b[0]).unit === "cash";
      return ua === ub ? b[1] - a[1] : ua ? 1 : -1;
    });
  }

  // ------------------------------------------------------------ 小部件
  const money = (v) => fmt(v);
  const money0 = (v) => fmt(v).replace(/\.00$/, "");
  const deltaChip = (cur, prev, cls = "") => {
    if (!prev && !cur) return "";
    const d = cur - prev;
    if (Math.abs(d) < 0.005) return `<span class="wk-delta flat ${cls}">${L("与上周持平", "Same as last week")}</span>`;
    const pct = prev > 0 ? Math.round((d / prev) * 100) : null;
    const up = d > 0;
    return `<span class="wk-delta ${up ? "up" : "down"} ${cls}">
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="${up ? "M6 2.5 10 8H2z" : "M6 9.5 2 4h8z"}" fill="currentColor"/></svg>
      ${L(`比上周${up ? "多" : "少"} `, up ? "Up " : "Down ")}<b>${money(Math.abs(d))}</b>${pct != null && Math.abs(pct) < 1000 ? ` · ${Math.abs(pct)}%` : ""}</span>`;
  };
  const catIcon = (t, ic, size = "") => {
    const srcs = [B.url(t), t.logo].filter(Boolean);
    const brand = srcs.length
      ? `<img class="blogo" src="${esc(srcs[0])}" ${srcs[1] ? `data-fallback="${esc(srcs[1])}"` : ""} alt="" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" onload="brandLoaded(this)" onerror="brandFail(this)"><span class="cat-dot">${I.svg(ic.icon)}</span>`
      : "";
    return `<div class="cat-icon ${size}" style="--c:${ic.color}">${I.svg(ic.icon)}${brand}</div>`;
  };

  // 周一到周日的柱子；虚线 = 上周日均
  function bars(st, prevAvg, { mini = false } = {}) {
    const vals = st.daily.map((v) => Math.max(0, v));
    const max = Math.max(...vals, prevAvg, 1);
    const top = vals.indexOf(Math.max(...vals));
    const t0 = todayLocal();
    const cols = vals.map((v, i) => {
      const day = addDays(st.ws, i), future = day > t0;
      const h = v > 0 ? Math.max(3, (v / max) * 100) : 0;
      return `<div class="wk-col${i === top && v > 0 ? " top" : ""}${future ? " future" : ""}" title="${esc(md(day))} · ${esc(money(st.daily[i]))}">
        ${mini ? "" : `<span class="wk-v">${v > 0 ? esc(money0(Math.round(v))) : ""}</span>`}
        <span class="wk-bar"><i style="--h:${h}%;--d:${i * 40}ms"></i></span>
        ${mini ? "" : `<span class="wk-d">${WD[EN() ? "en" : "zh"][i]}</span>`}
      </div>`;
    }).join("");
    const avgLine = prevAvg > 0 ? `<span class="wk-avg" style="--y:${(prevAvg / max).toFixed(4)}" title="${esc(L("上周日均", "Last week’s daily avg"))} ${esc(money(prevAvg))}">${mini ? "" : `<em>${L("上周日均", "Last wk avg")} ${esc(money0(Math.round(prevAvg)))}</em>`}</span>` : "";
    return `<div class="wk-bars${mini ? " mini" : ""}"><div class="wk-plot">${avgLine}${cols}</div></div>`;
  }

  // ------------------------------------------------------------ 多选下拉（卡片）
  function mselLabel(sel, all) {
    if (!sel.length) return `<b>${L("未选卡片", "No cards")}</b><small>${L("至少选一张", "Pick at least one")}</small>`;
    if (sel.length === all.length) return `<b>${L("全部卡片", "All cards")}</b><small>${all.length} ${L("张", all.length === 1 ? "card" : "cards")}</small>`;
    if (sel.length === 1) { const a = sel[0]; return `<b class="cname">${esc(cardName(a))}${a.mask ? ` <small>··${esc(a.mask)}</small>` : ""}</b><small class="cinst">${esc(a.institution)}</small>`; }
    return `<b>${sel.length} ${L("张卡", "cards")}</b><small class="cinst">${sel.slice(0, 3).map((a) => esc(cardName(a))).join(", ")}${sel.length > 3 ? "…" : ""}</small>`;
  }
  function mselFaces(sel) {
    const show = sel.slice(0, 3);
    if (!show.length) return `<span class="msel-faces none"><span class="cc cc-xs cc-all"><i></i><i></i><i></i></span></span>`;
    return `<span class="msel-faces n${show.length}">${show.map((a) => RT_CARDS.face(a, "xs")).join("")}</span>`;
  }
  function msel(open) {
    const all = cards(), ex = excluded(), sel = all.filter((a) => !ex.has(a.id));
    return `<div class="msel${open ? " open" : ""}" data-msel>
      <button type="button" class="msel-btn" data-msel-toggle aria-haspopup="listbox" aria-expanded="${open ? "true" : "false"}">
        ${mselFaces(sel)}<span class="msel-label">${mselLabel(sel, all)}</span>
        <svg class="caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="msel-menu" role="listbox" aria-multiselectable="true">
        <div class="msel-head">
          <span>${L("选择卡片", "Cards")} <em>${sel.length}/${all.length}</em></span>
          <span class="msel-quick">
            <button type="button" data-msel-all ${sel.length === all.length ? "disabled" : ""}>${L("全选", "Select all")}</button>
            <button type="button" data-msel-none ${!sel.length ? "disabled" : ""}>${L("全不选", "Clear")}</button>
          </span>
        </div>
        <div class="msel-list">${all.map((a, i) => `
          <button type="button" class="msel-opt${ex.has(a.id) ? "" : " on"}" role="option" aria-selected="${!ex.has(a.id)}" data-msel-id="${esc(a.id)}" style="--i:${i}">
            <span class="msel-check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg></span>
            ${RT_CARDS.face(a, "xs")}
            <span class="msel-name"><b class="cname">${esc(cardName(a))}${a.mask ? ` <small>··${esc(a.mask)}</small>` : ""}</b><small class="cinst">${esc(a.institution)}</small></span>
          </button>`).join("")}
        </div>
      </div>
    </div>`;
  }

  // ------------------------------------------------------------ 入口卡片（分析页顶部）
  function entry() {
    const all = cards();
    if (!all.length) return "";
    const sel = selected(), ids = new Set(sel.map((a) => a.id));
    const ws = latestWeek(), by = weeksIndex(spendOf(ids));
    const st = weekStats(ws, by), prev = weekStats(addDays(ws, -7), by);
    const body = !sel.length
      ? `<p class="wk-entry-empty">${L("周报里还没选卡片，点开选卡。", "No cards selected for the weekly report — open it to pick cards.")}</p>`
      : `<div class="wk-entry-num"><b class="wk-big">${esc(money(st.net))}</b>${deltaChip(st.net, prev.net)}</div>
         <p class="wk-entry-sub">${st.buys} ${L("笔消费", st.buys === 1 ? "purchase" : "purchases")} · ${L("日均", "daily avg")} ${esc(money(st.net / 7))}</p>`;
    return `<button type="button" class="wk-entry" data-wk-open data-i18n-skip>
      <span class="wk-entry-main">
        <span class="wk-kicker"><i></i>${L("周报 · 每周日出具", "Weekly · every Sunday")}</span>
        <span class="wk-entry-range">${esc(rangeLabel(ws))}</span>
        ${body}
      </span>
      ${sel.length ? bars(st, prev.net / 7, { mini: true }) : ""}
      <span class="wk-entry-go"><span>${L("查看周报", "Open")}
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg></span>
        <small>${L("下一期", "Next")} ${esc(md(nextIssue()))}</small></span>
    </button>`;
  }

  // ------------------------------------------------------------ 完整周报
  const ui = { ws: null, view: "cat", archive: false, menu: false, dir: 0 };

  function report() {
    const all = cards(), sel = selected(), ids = new Set(sel.map((a) => a.id));
    const latest = latestWeek();
    const list = spendOf(ids), by = weeksIndex(list);
    const first = list.length ? weekStart(list.reduce((m, t) => (t.date < m ? t.date : m), latest)) : latest;
    if (!ui.ws || ui.ws > latest) ui.ws = latest;
    if (ui.ws < first) ui.ws = first;
    const ws = ui.ws, st = weekStats(ws, by), prev = weekStats(addDays(ws, -7), by);
    const atFirst = ws <= first, atLatest = ws >= latest;

    const head = `
      <header class="wk-head">
        <div class="wk-title">
          <span class="wk-kicker"><i></i>${L("周报", "Weekly report")}</span>
          <div class="wk-nav">
            <button class="d-btn" data-wk-step="-1" ${atFirst ? "disabled" : ""} aria-label="${L("上一周", "Previous week")}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg></button>
            <button class="wk-range" data-wk-archive aria-expanded="${ui.archive}">${esc(rangeLabel(ws))}<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></button>
            <button class="d-btn" data-wk-step="1" ${atLatest ? "disabled" : ""} aria-label="${L("下一周", "Next week")}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg></button>
            ${atLatest ? "" : `<button class="btn small" data-wk-latest>${L("最新一期", "Latest")}</button>`}
          </div>
          ${archive(by, first, latest)}
        </div>
        <div class="wk-tools">${msel(ui.menu)}
          <button class="d-btn close" data-wk-close aria-label="${L("关闭", "Close")}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
      </header>`;

    if (!all.length) return head + `<div class="wk-empty">${L("连接信用卡后，这里会生成每周的消费周报。", "Link a credit card to get weekly reports.")}</div>`;
    if (!sel.length) return head + `<div class="wk-empty"><p>${L("选一张或几张卡，生成这一周的周报。", "Pick one or more cards to build this week’s report.")}</p><button class="btn primary" data-msel-all>${L("全选", "Select all")}</button></div>`;

    const cur = [...groupBy(st.list, ui.view === "cat" ? catKey : merchKey).values()];
    const prevG = groupBy(prev.list, ui.view === "cat" ? catKey : merchKey);
    const rows = cur.filter((g) => g.v > 0.004).sort((a, b) => b.v - a.v);
    const shown = rows.slice(0, 8), rest = rows.slice(8);
    const biggest = st.list.filter((t) => t.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 5);
    const earn = weekEarn(st.list);
    const avg = st.net / 7, pavg = prev.net / 7;
    const avgMax = Math.max(avg, pavg, 0.01);
    const issued = addDays(ws, 6) <= todayLocal();

    const listRow = (g) => {
      const ic = I.info(g.t), p = prevG.get(g.k)?.v || 0, d = g.v - p;
      const name = ui.view === "cat" ? esc(T(ic.label)) : `<span class="wk-merch">${esc(g.k)}</span>`;
      const delta = Math.abs(d) < 0.005 ? "" : `<small class="wk-chg ${d > 0 ? "up" : "down"}">${d > 0 ? "↑" : "↓"} ${esc(money(Math.abs(d)))}</small>`;
      return `<div class="wk-row">${ui.view === "cat" ? `<div class="cat-icon sm" style="--c:${ic.color}">${I.svg(ic.icon)}</div>` : catIcon(g.t, ic, "sm")}
        <div class="wk-row-main"><b>${name}</b><small>${g.n} ${L("笔", g.n === 1 ? "purchase" : "purchases")}</small></div>
        <div class="wk-row-amt"><b>${esc(money(g.v))}</b>${delta}</div></div>`;
    };

    return head + `
      <div class="wk-body${ui.dir ? ` slide-${ui.dir > 0 ? "l" : "r"}` : ""}">
        <section class="wk-hero">
          <div class="wk-hero-l">
            <span class="wk-label">${L("本周消费", "Spent this week")}${issued ? "" : ` · <em>${L(`本周进行中，${md(addDays(ws, 6))}（周日）出具`, `in progress — issued ${md(addDays(ws, 6))} (Sun)`)}</em>`}</span>
            <b class="wk-total" data-count="${st.net}">${esc(money(st.net))}</b>
            ${deltaChip(st.net, prev.net)}
            <p class="wk-sub">${st.buys} ${L("笔消费", st.buys === 1 ? "purchase" : "purchases")}${st.refunds ? ` · ${L("退款", "refunds")} <span class="wk-refund">${esc(money(st.refunds))}</span>` : ""} · ${L("上周", "last week")} ${esc(money(prev.net))}</p>
          </div>
          ${bars(st, pavg)}
        </section>

        <div class="wk-grid">
          <section class="wk-card wk-avgcard">
            <h4>${L("日均", "Daily average")}</h4>
            <p class="wk-lede">${Math.abs(avg - pavg) < 0.005 ? L("和前一周每天花得一样多。", "You spent the same per day as the week before.")
              : L(`比前一周每天${avg < pavg ? "少" : "多"}花 <b>${esc(money(Math.abs(avg - pavg)))}</b>。`,
                  `You spent <b>${esc(money(Math.abs(avg - pavg)))}</b> ${avg < pavg ? "less" : "more"} per day than the week before.`)}</p>
            <div class="wk-avgrow"><b>${esc(money(avg))}</b><small>/${L("天", "day")}</small></div>
            <div class="wk-avgbar now" style="--w:${Math.max(4, (Math.max(avg, 0) / avgMax) * 100)}%"><span>${esc(shortRange(ws))}</span></div>
            <div class="wk-avgrow prev"><b>${esc(money(pavg))}</b><small>/${L("天", "day")}</small></div>
            <div class="wk-avgbar" style="--w:${Math.max(4, (Math.max(pavg, 0) / avgMax) * 100)}%"><span>${esc(shortRange(addDays(ws, -7)))}</span></div>
          </section>
          <section class="wk-card wk-earn">
            <h4>${L("本周积分", "Earned this week")}</h4>
            ${earn.length ? `<div class="wk-earn-list">${earn.map(([k, v]) => {
              const p = earningsGroupInfo(k);
              const logo = k === "cash_back" ? `<span class="plogo xs" style="--brand:${p.color}"><i>$</i></span>` : programLogo(k, "plogo xs");
              return `<div class="wk-earn-row">${logo}<span class="wk-earn-name">${esc(p.name)}</span><b style="--brand:${p.color}">${v > 0 ? "+" : ""}${esc(R.fmtEarned(v, p.unit))}<small>${p.unit === "cash" ? "" : L(" 点", " pts")}</small></b></div>`;
            }).join("")}</div><p class="wk-note">${L("按交易估算，含 Pending，以银行账单为准", "Estimated from transactions, incl. pending; the bank statement is authoritative")}</p>`
              : `<p class="wk-none">${L("这一周没有估算到积分。", "No points estimated this week.")}</p>`}
          </section>
        </div>

        <section class="wk-card">
          <div class="wk-card-head">
            <h4>${L("消费去向", "Where it went")}</h4>
            <div class="seg wk-seg">${[["cat", L("按类别", "By category")], ["merch", L("按商户", "By merchant")]].map(([v, l]) =>
              `<button data-wk-view="${v}" class="${ui.view === v ? "on" : ""}">${l}</button>`).join("")}</div>
          </div>
          ${shown.length ? `<div class="wk-rows">${shown.map(listRow).join("")}${rest.length ? `<div class="wk-row more"><div class="wk-row-main"><b>${L(`其他 ${rest.length} 项`, `${rest.length} more`)}</b></div><div class="wk-row-amt"><b>${esc(money(rest.reduce((s, g) => s + g.v, 0)))}</b></div></div>` : ""}</div>`
            : `<p class="wk-none">${L("这一周没有消费。", "No spending this week.")}</p>`}
        </section>

        ${biggest.length ? `<section class="wk-card">
          <h4>${L("最大几笔", "Largest transactions")}</h4>
          <div class="wk-rows">${biggest.map((t) => {
            const ic = I.info(t), a = state.accounts[t.account_id];
            return `<div class="wk-row wk-txn" data-wk-txn="${esc(t.id)}" role="button" tabindex="0">${catIcon(t, ic, "sm")}
              <div class="wk-row-main"><b class="wk-merch">${esc(t.merchant || t.name)}</b><small>${esc(md(t.date))} · <span class="wk-card-name">${esc(a ? cardName(a) : "")}</span>${t.pending ? ` · ${L("待入账", "Pending")}` : ""}</small></div>
              <div class="wk-row-amt"><b>${esc(t.orig_currency ? fmtOrig(t.orig_amount, t.orig_currency) : money(t.amount))}</b>${t.orig_currency ? `<small>${esc(money(t.amount))}</small>` : ""}</div></div>`;
          }).join("")}</div>
        </section>` : ""}

        <p class="wk-foot">${L("每周一到周日为一期，周日出具 · 按交易日期统计，含 Pending · 消费为退款后的净额，不含还款、年费和权益返现",
          "Weeks run Monday to Sunday and are issued on Sunday · by transaction date, incl. pending · net of refunds; excludes payments, annual fees and statement credits")}</p>
      </div>`;
  }

  // 所有历史周报：按月分组，最新的在上面
  function archive(by, first, latest) {
    const weeks = [];
    for (let w = latest; w >= first; w = addDays(w, -7)) weeks.push(w);
    const totals = weeks.map((w) => (by.get(w) || []).reduce((s, t) => s + t.amount, 0));
    const max = Math.max(...totals, 1);
    let lastM = "";
    const rows = weeks.map((w, i) => {
      const m = addDays(w, 6).slice(0, 7);
      const head = m !== lastM ? `<div class="wk-arch-m">${EN() ? `${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}` : `${m.slice(0, 4)} 年 ${+m.slice(5)} 月`}</div>` : "";
      lastM = m;
      return `${head}<button class="wk-arch-row${w === ui.ws ? " on" : ""}" data-wk-go="${w}">
        <span>${esc(shortRange(w))}</span><i style="--w:${Math.max(0, totals[i] / max) * 100}%"></i><b>${esc(money0(Math.round(totals[i])))}</b></button>`;
    }).join("");
    return `<div class="wk-arch${ui.archive ? " open" : ""}" role="listbox">
      <div class="wk-arch-head">${L(`全部周报 · ${weeks.length} 期`, `All reports · ${weeks.length} weeks`)}</div>
      <div class="wk-arch-list">${rows}</div></div>`;
  }

  // ------------------------------------------------------------ 面板
  function shell() {
    let el = document.getElementById("weekly");
    if (el) return el;
    el = document.createElement("div");
    el.id = "weekly";
    el.hidden = true;
    el.setAttribute("data-i18n-skip", "");
    el.innerHTML = `<div class="d-backdrop" data-wk-close></div>
      <div class="d-panel wk-panel" role="dialog" aria-modal="true" aria-label="Weekly report" tabindex="-1">
        <div class="d-grab" aria-hidden="true"><span></span></div>
        <div class="wk-scroll"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", (e) => {
      const r = e.target.closest?.("[data-wk-txn]");
      if (r && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openTxn(r.dataset.wkTxn); }
    });
    return el;
  }

  function onClick(e) {
    const el = document.getElementById("weekly");
    if (e.target.closest("[data-wk-close]")) return close();
    // 多选下拉
    if (e.target.closest("[data-msel-toggle]")) { ui.menu = !ui.menu; ui.archive = false; return syncMenus(el); }
    const opt = e.target.closest("[data-msel-id]");
    if (opt) {
      const ex = excluded(), id = opt.dataset.mselId;
      ex.has(id) ? ex.delete(id) : ex.add(id);
      saveExcluded(ex); return refresh({ keepMenu: true });
    }
    if (e.target.closest("[data-msel-all]")) { saveExcluded(new Set()); return refresh({ keepMenu: true }); }
    if (e.target.closest("[data-msel-none]")) { saveExcluded(new Set(cards().map((a) => a.id))); return refresh({ keepMenu: true }); }
    // 周导航
    const step = e.target.closest("[data-wk-step]");
    if (step && !step.disabled) return go(addDays(ui.ws, 7 * +step.dataset.wkStep), +step.dataset.wkStep);
    if (e.target.closest("[data-wk-latest]")) return go(latestWeek(), 1);
    if (e.target.closest("[data-wk-archive]")) {
      ui.archive = !ui.archive; ui.menu = false; syncMenus(el);
      if (ui.archive) el.querySelector(".wk-arch-row.on")?.scrollIntoView({ block: "center" });
      return;
    }
    const g = e.target.closest("[data-wk-go]");
    if (g) { const w = g.dataset.wkGo; ui.archive = false; return go(w, w > ui.ws ? 1 : -1); }
    const v = e.target.closest("[data-wk-view]");
    if (v) { ui.view = v.dataset.wkView; return paint(); }
    const t = e.target.closest("[data-wk-txn]");
    if (t) return openTxn(t.dataset.wkTxn);
    // 点在菜单外面：收起菜单
    if ((ui.menu && !e.target.closest("[data-msel]")) || (ui.archive && !e.target.closest(".wk-arch"))) { ui.menu = false; ui.archive = false; syncMenus(el); }
  }

  function syncMenus(el) {
    el.querySelector("[data-msel]")?.classList.toggle("open", ui.menu);
    el.querySelector("[data-msel-toggle]")?.setAttribute("aria-expanded", String(ui.menu));
    el.querySelector(".wk-arch")?.classList.toggle("open", ui.archive);
    el.querySelector("[data-wk-archive]")?.setAttribute("aria-expanded", String(ui.archive));
  }

  function go(ws, dir) { if (ws === ui.ws) return; ui.ws = ws; ui.dir = dir; ui.menu = false; paint(); ui.dir = 0; }

  // 只换数据、保留下拉菜单打开的状态（勾选时菜单不闪）
  function refresh({ keepMenu } = {}) {
    const el = document.getElementById("weekly");
    if (el && !el.hidden) {
      const scroll = el.querySelector(".msel-list")?.scrollTop || 0;
      if (keepMenu) ui.menu = true;
      paint({ noAnim: true });
      const list = el.querySelector(".msel-list");
      if (list) list.scrollTop = scroll;
      el.querySelector("[data-msel]")?.classList.add("instant");
      requestAnimationFrame(() => el.querySelector("[data-msel]")?.classList.remove("instant"));
    }
    renderEntry();
  }

  let prevTotal = null;
  function paint({ noAnim = false } = {}) {
    const el = document.getElementById("weekly");
    if (!el || el.hidden) return;
    el.querySelector(".wk-scroll").innerHTML = report();
    if (noAnim) el.querySelector(".wk-body")?.classList.add("no-anim");
    countUp(el.querySelector(".wk-total"));
  }

  // 总额数字滚动到新值
  function countUp(node) {
    if (!node) return;
    const to = +node.dataset.count, from = prevTotal;
    prevTotal = to;
    if (from == null || reduce() || Math.abs(to - from) < 0.01) return;
    const t0 = performance.now(), dur = 520;
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      node.textContent = money(from + (to - from) * e);
      if (k < 1 && node.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function openTxn(id) {
    if (!window.RT_DETAIL) return;
    RT_DETAIL.open(id);
    // 交易详情关掉后，周报还开着：恢复背景锁定
    const d = document.getElementById("txn-detail");
    if (!d) return;
    const mo = new MutationObserver(() => {
      if (d.hidden) { mo.disconnect(); if (!document.getElementById("weekly")?.hidden) document.documentElement.classList.add("d-lock"); }
    });
    mo.observe(d, { attributes: true, attributeFilter: ["hidden"] });
  }

  function open() {
    const el = shell();
    ui.ws = latestWeek(); ui.menu = false; ui.archive = false; ui.dir = 0; prevTotal = null;
    el.hidden = false;
    paint();
    document.documentElement.classList.add("d-lock");
    requestAnimationFrame(() => { el.classList.add("open"); el.querySelector(".d-panel").focus({ preventScroll: true }); });
  }
  function close() {
    const el = document.getElementById("weekly");
    if (!el || el.hidden) return;
    el.classList.remove("open");
    document.documentElement.classList.remove("d-lock");
    setTimeout(() => { el.hidden = true; }, 240);
  }

  document.addEventListener("keydown", (e) => {
    const el = document.getElementById("weekly");
    if (!el || el.hidden) return;
    const d = document.getElementById("txn-detail");
    if (d && !d.hidden) return; // 交易详情叠在上面时，按键交给它
    if (e.key === "Escape") {
      e.stopPropagation();
      if (ui.menu || ui.archive) { ui.menu = false; ui.archive = false; return syncMenus(el); }
      return close();
    }
    if (e.target.closest?.("input, textarea")) return;
    if (e.key === "ArrowLeft") el.querySelector('[data-wk-step="-1"]:not([disabled])')?.click();
    if (e.key === "ArrowRight") el.querySelector('[data-wk-step="1"]:not([disabled])')?.click();
  }, true);

  // 手机：左右滑动翻周
  let touchX = null;
  document.addEventListener("touchstart", (e) => { if (e.target.closest?.("#weekly .wk-hero")) touchX = e.touches[0].clientX; }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX; touchX = null;
    if (Math.abs(dx) > 60) document.querySelector(`#weekly [data-wk-step="${dx < 0 ? 1 : -1}"]:not([disabled])`)?.click();
  });

  // 分析页顶部的入口
  function renderEntry() {
    const slot = document.getElementById("wk-entry");
    if (slot) slot.innerHTML = entry();
  }
  document.addEventListener("click", (e) => { if (e.target.closest?.("#wk-entry [data-wk-open]")) open(); });

  window.RT_WEEKLY = { open, close, entry, renderEntry, refresh: () => { renderEntry(); paint({ noAnim: true }); } };
})();
