// Reward Tracker — 账单日历：月视图上用卡面标出每张信用卡的出账日和还款日。
// 出账日：按每张卡的账单日（手动 / Liabilities 自动 / 月底）逐月推算。
// 还款日：当期用 Plaid Liabilities 返回的真实还款日；其他月份按「出账日 + 同样的间隔」推算，标成「预计」。
// 用到 app.js 的全局：state、R、fmt、esc、cardName、creditAccounts、closingDay、closingIn、lastClosing、dueInfo、today、RT_CARDS、RT_ACCT。

(function () {
  const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const diff = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
  const todayLocal = () => iso(new Date());
  const narrow = () => innerWidth < 640;
  const evKey = (e) => `${e.a.id}|${e.kind}|${e.date}`;
  const md = (s) => `${+s.slice(5, 7)}/${+s.slice(8, 10)}`;

  const ui = { ym: todayLocal().slice(0, 7), sel: null };

  const KIND = { close: ["账", "出账日"], due: ["还", "还款日"], fee: ["年", "年费日"] };

  // ------------------------------------------------------------ 年费：在交易记录里找「Annual Fee / Membership Fee」
  const FEE_EXCLUDE = /revers|refund|credit|waive|adjust/i;
  function feeInfo(a) {
    const hits = state.txns.filter((t) => t.account_id === a.id && t.amount > 0 && R.isAnnualFee(t) &&
      !FEE_EXCLUDE.test(`${t.name || ""} ${t.detail?.original_description || ""}`))
      .sort((x, y) => (x.date < y.date ? 1 : -1));
    if (!hits.length) return null;
    const last = hits[0];
    // 下次年费：上次扣费日 + 1 年（不足就继续 +1 年，直到落在今天之后）
    let next = last.date;
    const t0 = todayLocal();
    do { next = `${+next.slice(0, 4) + 1}${next.slice(4)}`; } while (next < t0);
    if (next.slice(5) === "02-29") next = `${next.slice(0, 4)}-02-28`;
    return { last, amount: last.amount, next, history: hits };
  }

  // ------------------------------------------------------------ 事件
  // { date, kind: "close" | "due", a, est, info }
  function events(from, to) {
    const out = [];
    for (const a of creditAccounts()) {
      const cd = closingDay(a.id);
      const L = a.liability;
      const due = dueInfo(a);
      const offset = L?.next_payment_due_date && L?.last_statement_issue_date ? diff(L.last_statement_issue_date, L.next_payment_due_date) : null;
      // 从 from 往前两个月开始逐月推算（还款日落在下个月）
      let y = +from.slice(0, 4), m = +from.slice(5, 7) - 2;
      while (m < 1) { m += 12; y--; }
      for (let i = 0; i < 6; i++) {
        const c = closingIn(y, m, cd.day);
        if (c >= from && c <= to) out.push({ date: c, kind: "close", a, est: cd.source === "default", info: { source: cd.source } });
        // 之后各期的还款日：出账日 + 上期的间隔（预计）；上期及以前的用真实还款日，不再推算
        if (offset != null && c > addDays(L.last_statement_issue_date, 3)) {
          const d = addDays(c, offset);
          if (d >= from && d <= to) out.push({ date: d, kind: "due", a, est: true, info: null });
        }
        if (++m > 12) { m = 1; y++; }
      }
      // 年费：历史扣费记录（真实）+ 下一次（按上次日期推算）
      const fee = feeInfo(a);
      if (fee) {
        for (const h of fee.history) if (h.date >= from && h.date <= to) out.push({ date: h.date, kind: "fee", a, est: false, info: { amount: h.amount, fee } });
        if (fee.next >= from && fee.next <= to) out.push({ date: fee.next, kind: "fee", a, est: true, info: { amount: fee.amount, fee } });
      }
      // 当期真实还款日（来自 Liabilities）
      if (L?.next_payment_due_date && L.next_payment_due_date >= from && L.next_payment_due_date <= to) {
        out.push({ date: L.next_payment_due_date, kind: "due", a, est: false, info: due });
      }
    }
    // 去重（同卡同日同类）
    const seen = new Set();
    return out.filter((e) => { const k = `${e.a.id}|${e.kind}|${e.date}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((x, y2) => (x.date < y2.date ? -1 : x.date > y2.date ? 1 : x.kind === "due" ? -1 : 1));
  }

  // 本期（尚未出账）消费与积分，用于出账日卡片上的「预计账单」
  function cycleStats(a) {
    const last = lastClosing(a.id, todayLocal());
    let spend = 0, pts = 0, unit = "pts", prog = null;
    for (const t of state.txns) {
      if (t.account_id !== a.id || t.date <= last) continue;
      const e = state.earn.get(t.id);
      if (e && e.cat === "none") continue;
      spend += t.amount;
      if (e) { pts += e.earned; prog = R.PROGRAMS[e.program]; unit = prog.unit; }
    }
    return { spend, pts, unit, prog };
  }

  // ------------------------------------------------------------ 渲染
  function grid() {
    const [y, m] = ui.ym.split("-").map(Number);
    const first = `${ui.ym}-01`;
    const start = addDays(first, -((parse(first).getDay() + 6) % 7));
    const daysInMonth = new Date(y, m, 0).getDate();
    const cells = Math.ceil(((parse(first).getDay() + 6) % 7 + daysInMonth) / 7) * 7;
    const end = addDays(start, cells - 1);
    const evs = events(start, end);
    const byDay = new Map();
    for (const e of evs) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
    const t0 = todayLocal();

    let html = WEEK.map((w, i) => `<div class="cal-dow${i >= 5 ? " wk" : ""}">${w}</div>`).join("");
    for (let i = 0; i < cells; i++) {
      const d = addDays(start, i);
      const list = byDay.get(d) || [];
      const out = d.slice(0, 7) !== ui.ym, isToday = d === t0, past = d < t0;
      const hasDue = list.some((e) => e.kind === "due"), hasClose = list.some((e) => e.kind === "close"), hasFee = list.some((e) => e.kind === "fee");
      const urgent = list.some((e) => e.kind === "due" && !e.est && e.info && ["urgent", "overdue"].includes(e.info.level));
      html += `<button class="cal-day${out ? " out" : ""}${isToday ? " today" : ""}${past ? " past" : ""}${ui.sel === d ? " sel" : ""}${hasDue ? " has-due" : ""}${hasClose ? " has-close" : ""}${hasFee ? " has-fee" : ""}${urgent ? " urgent" : ""}" data-day="${d}" aria-label="${+d.slice(5, 7)}月${+d.slice(8)}日${list.length ? `，${list.length} 个事项` : ""}">
        <span class="num">${+d.slice(8)}</span>
        ${list.length ? `<span class="evs">${list.slice(0, narrow() ? 2 : 3).map((e) => `<span class="ev ${e.kind}${e.est ? " est" : ""}" data-ev="${esc(evKey(e))}" title="${esc(cardName(e.a))} · ${KIND[e.kind][1]}${e.est ? "（预计）" : ""}">${RT_CARDS.face(e.a, "xs")}<i>${KIND[e.kind][0]}</i></span>`).join("")}${list.length > (narrow() ? 2 : 3) ? `<span class="more">+${list.length - (narrow() ? 2 : 3)}</span>` : ""}</span>` : ""}
      </button>`;
    }
    return { html, evs: evs.filter((e) => e.date.startsWith(ui.ym)) };
  }

  function evCard(e) {
    const a = e.a, t0 = todayLocal();
    const left = diff(t0, e.date);
    const when = left === 0 ? "今天" : left === 1 ? "明天" : left > 0 ? `${left} 天后` : `${-left} 天前`;
    let body = "";
    if (e.kind === "fee") {
      const f = e.info.fee;
      body = `<div class="ag-nums"><span><small>${e.est ? "预计年费" : "已扣年费"}</small><b>${fmt(e.info.amount)}</b></span>${e.est ? `<span><small>上次扣费</small><b>${md(f.last.date)}</b></span>` : ""}</div>
        <p class="ag-note">${e.est ? (left >= 0 && left <= 45 ? "快到年费日了：可以评估权益是否值、问问保留优惠或降级" : "按上次扣费日推算，以账单为准") : esc(f.last.name)}</p>`;
    } else if (e.kind === "close") {
      const isNext = e.date > lastClosing(a.id, t0) && e.date >= t0 && e.date === nextCloseOf(a);
      if (isNext) {
        const s = cycleStats(a);
        body = `<div class="ag-nums"><span><small>本期已刷</small><b>${fmt(s.spend)}</b></span>${s.prog ? `<span><small>Pending 积分</small><b style="color:${s.prog.color}">+${esc(R.fmtEarned(s.pts, s.unit))}${s.unit === "cash" ? "" : " " + esc(s.prog.short)}</b></span>` : ""}</div>`;
      }
      body += `<p class="ag-note">${e.info.source === "manual" ? "账单日为手动设置" : e.info.source === "auto" ? "账单日来自上期出账日" : "未知账单日，暂按月底"}</p>`;
    } else {
      const d = e.info;
      if (d) {
        body = `<div class="ag-nums">
          <span><small>账单金额</small><b>${d.last_statement_balance != null ? fmt(d.last_statement_balance) : "—"}</b></span>
          <span><small>最低还款</small><b>${d.minimum_payment_amount != null ? fmt(d.minimum_payment_amount) : "—"}</b></span>
        </div>
        <span class="due-chip ${d.level}">${d.level === "overdue" ? "已逾期" : d.nothing ? "本期无需还款" : d.paid ? "本期已还" : left < 0 ? "已过还款日" : `剩 ${left} 天`}</span>`;
      } else {
        body = `<p class="ag-note">按上期账单的间隔推算，以银行账单为准</p>`;
      }
    }
    return `<div class="ag-item ${e.kind}${e.est ? " est" : ""}" data-ev="${esc(evKey(e))}" data-date="${e.date}" tabindex="0">
      <span class="ag-face">${RT_CARDS.face(a, "sm")}</span>
      <span class="ag-main">
        <span class="ag-top"><span class="ag-kind ${e.kind}">${KIND[e.kind][1]}${e.est ? " · 预计" : ""}</span><span class="ag-when">${md(e.date)} · ${when}</span></span>
        <b class="ag-name">${esc(cardName(a))}${a.mask ? ` <small>··${esc(a.mask)}</small>` : ""}</b>
        ${body}
        <button class="ag-open" data-open-acct="${esc(a.id)}">账户详情 ›</button>
      </span>
    </div>`;
  }
  function nextCloseOf(a) {
    const last = lastClosing(a.id, todayLocal());
    return events(addDays(last, 1), addDays(last, 40)).find((e) => e.a.id === a.id && e.kind === "close")?.date;
  }

  function agenda(monthEvs) {
    const t0 = todayLocal();
    let title, list;
    if (ui.sel) {
      title = `${+ui.sel.slice(5, 7)} 月 ${+ui.sel.slice(8)} 日`;
      list = events(ui.sel, ui.sel);
    } else if (ui.ym === t0.slice(0, 7)) {
      title = "接下来 45 天";
      list = events(t0, addDays(t0, 45));
    } else {
      const [y, m] = ui.ym.split("-").map(Number);
      title = `${y} 年 ${m} 月`;
      list = events(`${ui.ym}-01`, `${ui.ym}-${pad(new Date(y, m, 0).getDate())}`);
    }
    return `<div class="ag-head"><h4>${title}</h4>${ui.sel ? `<button class="btn small ghost" data-cal-clear>看全部</button>` : ""}</div>
      ${list.length ? `<div class="ag-list">${list.map(evCard).join("")}</div>` : `<p class="ag-empty">${ui.sel ? "这天没有出账或还款" : "近期没有出账或还款"}</p>`}`;
  }

  function summary() {
    const t0 = todayLocal();
    const up = events(t0, addDays(t0, 60));
    const nc = up.find((e) => e.kind === "close"), nd = up.find((e) => e.kind === "due" && !(e.info?.paid || e.info?.nothing));
    const nf = events(t0, addDays(t0, 120)).find((e) => e.kind === "fee");
    return `<div class="cal-sum">
      ${nc ? `<span><i class="dot close"></i>下个出账 <b>${esc(cardName(nc.a))}</b> ${md(nc.date)}</span>` : ""}
      ${nf ? `<span><i class="dot fee"></i>下个年费 <b>${esc(cardName(nf.a))}</b> ${md(nf.date)} · ${fmt(nf.info.amount)}</span>` : ""}
      ${nd ? `<span><i class="dot due"></i>下个还款 <b>${esc(cardName(nd.a))}</b> ${md(nd.date)}${nd.info?.minimum_payment_amount != null ? ` · 最低 ${fmt(nd.info.minimum_payment_amount)}` : ""}</span>` : ""}
    </div>`;
  }

  // ------------------------------------------------------------ 联动高亮：列表 ↔ 日历
  function clearHL(el) {
    el.querySelectorAll(".hl, .pulse").forEach((n) => n.classList.remove("hl", "pulse"));
  }
  // 列表里的某条 → 日历上对应日期和卡面亮起；不在当前月份就让翻月按钮亮起
  function highlightEvent(el, key, date) {
    clearHL(el);
    const cell = el.querySelector(`.cal-day[data-day="${date}"]`);
    if (cell) {
      cell.classList.add("hl");
      el.querySelector(`.cal-grid .ev[data-ev="${CSS.escape(key)}"]`)?.classList.add("hl");
    } else {
      el.querySelector(`[data-cal-nav="${date < ui.ym ? -1 : 1}"]`)?.classList.add("pulse");
    }
    el.querySelector(`.ag-item[data-ev="${CSS.escape(key)}"]`)?.classList.add("hl");
  }
  // 只滚动事项列表本身（不带动整个页面）
  function centerInStrip(item) {
    if (!item) return;
    const list = item.parentElement;
    list.scrollTo({ left: item.offsetLeft - list.offsetLeft - (list.clientWidth - item.clientWidth) / 2, behavior: "smooth" });
  }
  // 日历上的某天 → 列表里这天的事项亮起并滚到可见
  function highlightDay(el, date) {
    clearHL(el);
    const items = el.querySelectorAll(`.ag-item[data-date="${date}"]`);
    items.forEach((n) => n.classList.add("hl"));
    const first = items[0];
    if (first) {
      if (narrow()) centerInStrip(first);
      else { const list = first.parentElement; const top = first.offsetTop - list.offsetTop; if (top < list.scrollTop || top + first.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTo({ top: top - 8, behavior: "smooth" }); }
    }
  }

  // ------------------------------------------------------------ 面板
  function shell() {
    let el = document.getElementById("bill-cal");
    if (el) return el;
    el = document.createElement("div");
    el.id = "bill-cal";
    el.hidden = true;
    el.innerHTML = `<div class="d-backdrop" data-cal-close></div>
      <div class="d-panel cal-panel" role="dialog" aria-modal="true" aria-label="账单日历" tabindex="-1">
        <div class="d-grab" aria-hidden="true"><span></span></div>
        <div class="cal-body"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-cal-close]")) return close();
      const nav = e.target.closest("[data-cal-nav]");
      if (nav) {
        const v = nav.dataset.calNav;
        if (v === "today") { ui.ym = todayLocal().slice(0, 7); ui.sel = todayLocal(); }
        else { let [y, m] = ui.ym.split("-").map(Number); m += +v; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } ui.ym = `${y}-${pad(m)}`; ui.sel = null; }
        return paint();
      }
      if (e.target.closest("[data-cal-clear]")) { ui.sel = null; return paint(); }
      const day = e.target.closest("[data-day]");
      if (day) {
        ui.sel = ui.sel === day.dataset.day ? null : day.dataset.day;
        if (day.dataset.day.slice(0, 7) !== ui.ym) ui.ym = day.dataset.day.slice(0, 7);
        paint();
        if (ui.sel) highlightDay(el, ui.sel);
        return;
      }
      const acct = e.target.closest("[data-open-acct]");
      // 账户详情叠在日历上面打开，关掉后回到日历
      if (acct) { RT_ACCT.open(acct.dataset.openAcct, { over: true }); return; }
      // 点列表里的事项：亮起日历；在别的月份就直接翻过去
      const it = e.target.closest(".ag-item");
      if (it) {
        const date = it.dataset.date;
        if (date.slice(0, 7) !== ui.ym && !el.querySelector(`.cal-day[data-day="${date}"]`)) { ui.ym = date.slice(0, 7); paint(); }
        highlightEvent(el, it.dataset.ev, date);
        if (narrow()) centerInStrip(el.querySelector(`.ag-item[data-ev="${CSS.escape(it.dataset.ev)}"]`));
      }
    });
    // 电脑：鼠标悬停联动
    el.addEventListener("pointerover", (e) => {
      if (e.pointerType === "touch") return;
      const it = e.target.closest(".ag-item");
      if (it) return highlightEvent(el, it.dataset.ev, it.dataset.date);
      const day = e.target.closest(".cal-day");
      if (day && el.querySelector(`.ag-item[data-date="${day.dataset.day}"]`)) return highlightDay(el, day.dataset.day);
    });
    el.addEventListener("pointerleave", () => clearHL(el));
    el.addEventListener("pointerout", (e) => {
      if (e.pointerType === "touch") return;
      if (!e.relatedTarget || !e.relatedTarget.closest?.(".ag-item, .cal-day")) clearHL(el);
    });
    // 手机：左右滑动切月
    let x0 = null;
    el.addEventListener("touchstart", (e) => { if (e.target.closest(".cal-grid")) x0 = e.touches[0].clientX; }, { passive: true });
    el.addEventListener("touchend", (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 60) el.querySelector(`[data-cal-nav="${dx < 0 ? 1 : -1}"]`)?.click();
    });
    return el;
  }

  function paint() {
    const el = document.getElementById("bill-cal");
    if (!el || el.hidden) return;
    const [y, m] = ui.ym.split("-").map(Number);
    const g = grid();
    el.querySelector(".cal-body").innerHTML = `
      <header class="cal-head">
        <div class="cal-title">
          <h3>账单日历</h3>
          <div class="cal-month">
            <button class="d-btn" data-cal-nav="-1" aria-label="上个月"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg></button>
            <b>${y} 年 ${m} 月</b>
            <button class="d-btn" data-cal-nav="1" aria-label="下个月"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg></button>
            <button class="btn small" data-cal-nav="today">今天</button>
          </div>
        </div>
        <button class="d-btn close" data-cal-close aria-label="关闭"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </header>
      ${summary()}
      <div class="cal-wrapx">
        <div class="cal-left">
          <div class="cal-grid">${g.html}</div>
          <div class="cal-legend">
            <span><i class="lg close">账</i>出账日</span>
            <span><i class="lg due">还</i>还款日</span>
            <span><i class="lg fee">年</i>年费日</span>
            <span><i class="lg est">还</i>预计（按间隔推算）</span>
            <span><i class="lg today"></i>今天</span>
          </div>
        </div>
        <aside class="cal-agenda">${agenda(g.evs)}</aside>
      </div>`;
  }

  function open() {
    const el = shell();
    el.hidden = false;
    ui.ym = todayLocal().slice(0, 7); ui.sel = null;
    try { paint(); }
    catch (err) { el.hidden = true; toast(`日历打不开：${err.message}`); console.error(err); return; }
    document.documentElement.classList.add("d-lock");
    requestAnimationFrame(() => { el.classList.add("open"); el.querySelector(".d-panel").focus({ preventScroll: true }); });
  }
  function close() {
    const el = document.getElementById("bill-cal");
    if (!el || el.hidden) return;
    el.classList.remove("open");
    document.documentElement.classList.remove("d-lock");
    setTimeout(() => { el.hidden = true; }, 240);
  }

  document.addEventListener("keydown", (e) => {
    const el = document.getElementById("bill-cal");
    if (!el || el.hidden) return;
    const ad = document.getElementById("acct-detail");
    if (ad && !ad.hidden) return;   // 账户详情叠在上面时，按键交给它
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    if (e.key === "ArrowLeft") el.querySelector('[data-cal-nav="-1"]')?.click();
    if (e.key === "ArrowRight") el.querySelector('[data-cal-nav="1"]')?.click();
  }, true);

  window.RT_CAL = { open, close, refresh: paint, summary, events, feeInfo };
})();
