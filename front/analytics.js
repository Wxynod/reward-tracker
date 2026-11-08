// Reward Tracker — 「分析」页：日 / 周 / 月 / 季消费趋势、按卡、按类别、星期规律、消费日历、商户排行。
// 纯 SVG 手绘，不依赖图表库。用到 app.js 里的全局：state、R、I、fmt、esc、creditAccounts、productOf。
// 配色：按卡用 8 色分类色板（固定顺序、跟着卡走，不随排名变），日历用单一色相的深浅；文字一律用墨色。

(function () {
  const CAT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const OTHER_COLOR = "#a39c90";
  const HEAT = ["#efe7dc", "#f0c9b8", "#de9580", "#c4614d", "#a3312a"]; // 浅 → 深，单一色相
  const NO_SPEND = new Set(["LOAN_PAYMENTS", "TRANSFER_IN", "TRANSFER_OUT", "INCOME", "BANK_FEES"]);
  const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

  const ui = { card: "", group: "card", single: "", node: { lv: "year", k: String(new Date().getFullYear()) } };
  const D = window.RT_DRILL;

  // 消费大类：8 个固定分组，颜色跟着分组走（不按排名换色），顺序即堆叠顺序
  const GROUPS = [
    { id: "travel",   label: "出行住宿", color: "#2a78d6", keys: ["flights", "hotels", "travel", "car_rental"] },
    { id: "dining",   label: "餐饮",     color: "#eb6834", keys: ["dining", "fast_food", "coffee", "bar"] },
    { id: "grocery",  label: "超市",     color: "#1baf7a", keys: ["grocery"] },
    { id: "commute",  label: "交通加油", color: "#eda100", keys: ["taxi", "transit", "parking", "gas", "ev"] },
    { id: "shopping", label: "购物",     color: "#e87ba4", keys: ["shopping", "apparel", "electronics", "home", "gifts", "pets"] },
    { id: "health",   label: "健康个护", color: "#008300", keys: ["drugstore", "medical", "beauty", "fitness"] },
    { id: "digital",  label: "订阅通讯", color: "#6250d6", keys: ["streaming", "phone", "utilities", "education", "entertainment"] },
    { id: "other",    label: "其他",     color: "#a39c90", keys: [] },
  ];
  const GROUP_OF = Object.fromEntries(GROUPS.flatMap((g) => g.keys.map((k) => [k, g.id])));
  const groupOf = (t) => GROUP_OF[I.info(t).key] || "other";

  // ------------------------------------------------------------ 日期工具（全部按本地日历日 YYYY-MM-DD）
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const parse = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const dow = (s) => (parse(s).getDay() + 6) % 7; // 周一 = 0
  const weekStart = (s) => addDays(s, -dow(s));
  const bucketOf = (s, g) =>
    g === "day" ? s : g === "week" ? weekStart(s) : g === "month" ? s.slice(0, 7) : `${s.slice(0, 4)}-Q${Math.ceil(+s.slice(5, 7) / 3)}`;
  const nextBucket = (b, g) => {
    if (g === "day") return addDays(b, 1);
    if (g === "week") return addDays(b, 7);
    if (g === "month") { let y = +b.slice(0, 4), m = +b.slice(5, 7) + 1; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, "0")}`; }
    let y = +b.slice(0, 4), q = +b.slice(6) + 1; if (q > 4) { q = 1; y++; } return `${y}-Q${q}`;
  };
  const bucketLabel = (b, g, long) => {
    if (g === "day") return long ? `${+b.slice(5, 7)}月${+b.slice(8)}日 周${WEEK[dow(b)]}` : `${+b.slice(5, 7)}/${+b.slice(8)}`;
    if (g === "week") return long ? `${+b.slice(5, 7)}/${+b.slice(8)} 起的一周` : `${+b.slice(5, 7)}/${+b.slice(8)}`;
    if (g === "month") return long ? `${b.slice(0, 4)} 年 ${+b.slice(5)} 月` : `${+b.slice(5)}月`;
    return long ? `${b.slice(0, 4)} 年 ${b.slice(5)}` : `${b.slice(2, 4)}${b.slice(5)}`;
  };
  const money = (v) => fmt(v).replace(".00", "");
  const short = (v) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `$${Math.round(v)}`);

  // ------------------------------------------------------------ 数据
  function cardList() {
    const list = creditAccounts().slice().sort((a, b) =>
      `${a.institution}|${a.name}|${a.mask}`.localeCompare(`${b.institution}|${b.name}|${b.mask}`));
    return list.map((a, i) => ({
      id: a.id, a,
      label: `${R.PRODUCTS[productOf(a)]?.name || a.name}${a.mask ? " ··" + a.mask : ""}`,
      color: i < 8 ? CAT_COLORS[i] : OTHER_COLOR,
    }));
  }

  // 消费 = 信用卡上的购物净额（退款冲减；还款、转账、费用、权益返现不算）
  function spendTxns() {
    const credit = new Set(creditAccounts().map((a) => a.id));
    return state.txns.filter((t) =>
      credit.has(t.account_id) && !NO_SPEND.has(t.category) && !R.isBenefitCredit(t) &&
      (!ui.card || t.account_id === ui.card));
  }

  // ------------------------------------------------------------ 渲染入口
  function render() {
    const root = document.getElementById("analytics");
    if (!root) return;
    const cards = cardList();
    if (!cards.length) { root.innerHTML = `<div class="empty">连接信用卡后，这里会出现消费分析。</div>`; return; }
    if (ui.card && !cards.some((c) => c.id === ui.card)) ui.card = "";

    const today = iso(new Date());
    const all = spendTxns();
    // 时间范围 = 下钻图当前所在的节点（全部 / 某年 / 某季 / 某月 / 某周）
    const minDate = all.length ? all.reduce((m, t) => (t.date < m ? t.date : m), today) : today;
    const [from, rangeEnd] = D.range(ui.node, minDate);
    const to = rangeEnd < today ? rangeEnd : today;
    const inRange = all.filter((t) => t.date >= from && t.date <= to);

    root.innerHTML = `
      <div class="an-filters">
        <select id="an-card" data-cardselect><option value="">全部卡片</option>${cards.map((c) =>
          `<option value="${esc(c.id)}" ${c.id === ui.card ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
        <span class="an-scope">当前范围：<b>${esc(D.label(ui.node, true))}</b> · 下面所有图表都按这个范围统计，在「消费趋势」里下钻或「选择时间」切换</span>
      </div>
      ${kpis(all, today)}
      <section class="an-card">
        <div class="an-head">
          <h3>消费趋势</h3>
          <div class="seg-row">
          <div class="seg" role="tablist" aria-label="分组">${[["card", "按卡"], ["cat", "按类别"]].map(([v, l]) =>
            `<button data-group="${v}" class="${v === ui.group ? "on" : ""}">${l}</button>`).join("")}</div>
          </div>
        </div>
        ${trend(all, cards)}
      </section>
      <section class="an-card">${catMatrix(inRange, minDate)}</section>
      <div class="an-grid">
        <section class="an-card">${byCard(inRange, cards)}</section>
        <section class="an-card">${byCategory(inRange)}</section>
      </div>
      <section class="an-card single">${singleCard(cards, from, to)}</section>
      <div class="an-grid">
        <section class="an-card">${weekday(inRange, from, to)}</section>
        <section class="an-card">${merchants(inRange)}</section>
      </div>
      <section class="an-card">${calendar(all, today)}</section>
      <section class="an-card">${biggest(inRange, cards)}</section>`;
    D.bind(root, "an", (n) => { ui.node = n; render(); });
    window.RT_CARDS?.enhanceAll(root);
  }

  // ------------------------------------------------------------ KPI
  function kpis(all, today) {
    const ym = today.slice(0, 7), dom = +today.slice(8);
    const sum = (a) => a.reduce((s, t) => s + t.amount, 0);
    const mtd = sum(all.filter((t) => t.date.startsWith(ym)));
    const prevStart = (() => { const d = parse(today); d.setDate(1); d.setMonth(d.getMonth() - 1); return iso(d); })();
    const prevYm = prevStart.slice(0, 7);
    const prevDays = new Date(+prevYm.slice(0, 4), +prevYm.slice(5), 0).getDate();
    const prevSame = sum(all.filter((t) => t.date.startsWith(prevYm) && +t.date.slice(8) <= Math.min(dom, prevDays)));
    const prevFull = sum(all.filter((t) => t.date.startsWith(prevYm)));
    const daysInMonth = new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate();
    const runRate = dom ? (mtd / dom) * daysInMonth : 0;
    const last30 = all.filter((t) => t.date > addDays(today, -30));
    const buys = last30.filter((t) => t.amount > 0);
    const delta = prevSame ? (mtd - prevSame) / prevSame : null;
    const tile = (label, value, sub) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
    return `<div class="an-kpis">
      ${tile("本月至今", money(mtd), delta == null ? "上月同期无数据" :
        `<span class="${delta > 0 ? "up" : "down"}">${delta > 0 ? "▲" : "▼"} ${Math.abs(delta * 100).toFixed(0)}%</span> 对比上月同期 ${money(prevSame)}`)}
      ${tile("本月预计", money(runRate), `按日均推算 · 上月全月 ${money(prevFull)}`)}
      ${tile("近 30 天日均", money(sum(last30) / 30), `${buys.length} 笔消费`)}
      ${tile("近 30 天客单价", buys.length ? money(sum(buys) / buys.length) : "—", buys.length ? `最大一笔 ${money(Math.max(...buys.map((t) => t.amount)))}` : "&nbsp;")}
    </div>`;
  }

  // ------------------------------------------------------------ 趋势：堆叠柱（按卡）+ 日视图的 7 日均线
  function trend(all, cards) {
    const series = ui.group === "cat" ? GROUPS : ui.card ? cards.filter((c) => c.id === ui.card) : cards;
    const keyOf = ui.group === "cat" ? groupOf : (t) => t.account_id;
    return D.chart({
      id: "an", node: ui.node, series,
      entries: all.map((t) => ({ date: t.date, s: keyOf(t), v: t.amount })),
      fmt: money, short,
    });
  }

  // 最大值取「整齐的刻度 × 4」，这样 4 条网格线都是整数
  function niceMax(v) {
    const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p * 4;
    return 40 * p;
  }

  // ------------------------------------------------------------ 按卡：消费、占比、平均倍数
  function byCard(list, cards) {
    const rows = cards.map((c) => {
      const ts = list.filter((t) => t.account_id === c.id);
      const spend = ts.reduce((s, t) => s + t.amount, 0);
      let earned = 0, unit = "pts";
      for (const t of ts) { const e = state.earn.get(t.id); if (e && e.cat !== "none") { earned += e.earned; unit = R.PROGRAMS[e.program].unit; } }
      return { c, spend, n: ts.filter((t) => t.amount > 0).length, rate: spend > 0 ? (earned / spend) * (unit === "cash" ? 100 : 1) : 0, unit };
    }).filter((r) => r.spend > 0).sort((a, b) => b.spend - a.spend);
    const total = rows.reduce((s, r) => s + r.spend, 0);
    if (!rows.length) return `<h3>按卡</h3><div class="empty small">没有消费</div>`;
    const max = rows[0].spend;
    return `<h3>按卡</h3><p class="an-sub">合计 ${money(total)} · 平均倍数 = 估算积分 ÷ 消费</p>
      ${rows.map((r) => `<div class="hbar" data-tip="${esc(`${r.c.label}|消费 ${money(r.spend)}|${r.n} 笔 · 占 ${(r.spend / total * 100).toFixed(1)}%`)}">
        <div class="hbar-label"><i style="background:${r.c.color}"></i>${esc(r.c.label)}</div>
        <div class="hbar-track"><b style="width:${(r.spend / max * 100).toFixed(1)}%;background:${r.c.color}"></b></div>
        <div class="hbar-val">${money(r.spend)}<small>${(r.spend / total * 100).toFixed(0)}% · ${R.fmtRate(r.rate, r.unit)}</small></div>
      </div>`).join("")}`;
  }

  // ------------------------------------------------------------ 按类别（前 10，其余合并）
  function byCategory(list) {
    const m = new Map();
    for (const t of list) {
      const ic = I.info(t);
      const x = m.get(ic.key) || { ...ic, v: 0, n: 0 };
      x.v += t.amount; if (t.amount > 0) x.n++; m.set(ic.key, x);
    }
    let rows = [...m.values()].filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
    const total = rows.reduce((s, r) => s + r.v, 0);
    if (rows.length > 10) {
      const rest = rows.slice(9);
      rows = rows.slice(0, 9).concat([{ label: `其他 ${rest.length} 类`, icon: "tag", color: "#9b9285", v: rest.reduce((s, r) => s + r.v, 0), n: rest.reduce((s, r) => s + r.n, 0) }]);
    }
    if (!rows.length) return `<h3>按类别</h3><div class="empty small">没有消费</div>`;
    const max = Math.max(...rows.map((r) => r.v));
    return `<h3>按类别</h3><p class="an-sub">按 MCC 分类 · 退款已冲减</p>
      ${rows.map((r) => `<div class="hbar" data-tip="${esc(`${r.label}|${money(r.v)}|${r.n} 笔 · 占 ${(r.v / total * 100).toFixed(1)}%`)}">
        <div class="hbar-label"><span class="mini-icon" style="--c:${r.color}">${I.svg(r.icon)}</span>${esc(r.label)}</div>
        <div class="hbar-track"><b style="width:${(r.v / max * 100).toFixed(1)}%" class="neutral"></b></div>
        <div class="hbar-val">${money(r.v)}<small>${(r.v / total * 100).toFixed(0)}%</small></div>
      </div>`).join("")}`;
  }

  // ------------------------------------------------------------ 星期规律：每个星期几的日均消费
  function weekday(list, from, today) {
    const sums = Array(7).fill(0), days = Array(7).fill(0);
    for (let d = from; d <= today; d = addDays(d, 1)) days[dow(d)]++;
    for (const t of list) sums[dow(t.date)] += t.amount;
    const avg = sums.map((s, i) => (days[i] ? s / days[i] : 0));
    const max = niceMax(Math.max(...avg, 1));
    const W = 360, H = 190, L = 8, T = 18, B = 26, ph = H - T - B, step = (W - L * 2) / 7, bw = step * 0.56;
    const top = avg.indexOf(Math.max(...avg));
    const bars = avg.map((v, i) => {
      const h = (Math.max(0, v) / max) * ph, x = L + step * i + (step - bw) / 2;
      return `<rect x="${x}" y="${T + ph - h}" width="${bw}" height="${Math.max(h, 0.5)}" rx="3" class="${i >= 5 ? "wk-end" : "wk-day"}"/>
        ${i === top ? `<text x="${x + bw / 2}" y="${T + ph - h - 5}" class="val" text-anchor="middle">${short(v)}</text>` : ""}
        <text x="${x + bw / 2}" y="${H - 8}" class="tick" text-anchor="middle">周${WEEK[i]}</text>
        <rect x="${L + step * i}" y="${T}" width="${step}" height="${ph}" class="hit" data-tip="${esc(`周${WEEK[i]}|日均 ${money(v)}|共 ${days[i]} 天 · 合计 ${money(sums[i])}`)}"/>`;
    }).join("");
    const wkd = avg.slice(0, 5).reduce((s, v) => s + v, 0) / 5, wke = (avg[5] + avg[6]) / 2;
    return `<h3>星期规律</h3><p class="an-sub">每个星期几的日均消费 · 工作日 ${money(wkd)}，周末 ${money(wke)}</p>
      <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="星期规律"><line x1="${L}" x2="${W - L}" y1="${T + ph}" y2="${T + ph}" class="grid base"/>${bars}</svg>`;
  }

  // ------------------------------------------------------------ 常去商户
  function merchants(list) {
    const m = new Map();
    for (const t of list) {
      const k = (t.merchant || t.name || "").trim();
      const x = m.get(k) || { k, v: 0, n: 0, last: "" , t };
      x.v += t.amount; if (t.amount > 0) x.n++; if (t.date > x.last) x.last = t.date; m.set(k, x);
    }
    const rows = [...m.values()].filter((r) => r.v > 0).sort((a, b) => b.v - a.v).slice(0, 8);
    if (!rows.length) return `<h3>常去商户</h3><div class="empty small">没有消费</div>`;
    return `<h3>常去商户</h3><p class="an-sub">按消费额排序的前 8 名</p>
      <div class="mlist">${rows.map((r, i) => {
        const ic = I.info(r.t);
        return `<div class="mrow"><span class="rank">${i + 1}</span><span class="mini-icon" style="--c:${ic.color}">${I.svg(ic.icon)}</span>
          <span class="mname">${esc(r.k)}<small>${r.n} 次 · 最近 ${+r.last.slice(5, 7)}/${+r.last.slice(8)}</small></span><b>${money(r.v)}</b></div>`;
      }).join("")}</div>`;
  }

  // ------------------------------------------------------------ 消费日历：近 26 周，每格一天
  function calendar(all, today) {
    const end = addDays(weekStart(today), 6), start = addDays(weekStart(today), -25 * 7);
    const day = new Map();
    for (const t of all) if (t.date >= start && t.date <= today) day.set(t.date, (day.get(t.date) || 0) + t.amount);
    const vals = [...day.values()].filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
    const cuts = [q(0.25), q(0.5), q(0.75), q(0.92)];
    const level = (v) => (v <= 0 ? -1 : cuts.filter((c) => v > c).length);
    const cell = 13, gap = 3, L = 26, T = 18;
    let cells = "", months = "";
    for (let w = 0; w < 26; w++) {
      const ws = addDays(start, w * 7);
      if (w === 0 || +ws.slice(8) <= 7) months += `<text x="${L + w * (cell + gap)}" y="11" class="tick">${+ws.slice(5, 7)}月</text>`;
      for (let d = 0; d < 7; d++) {
        const date = addDays(ws, d);
        if (date > end) continue;
        const v = day.get(date) || 0, lv = level(v), future = date > today;
        cells += `<rect x="${L + w * (cell + gap)}" y="${T + d * (cell + gap)}" width="${cell}" height="${cell}" rx="3"
          fill="${future ? "transparent" : lv < 0 ? "#f3eee6" : HEAT[lv]}" class="${future ? "future" : "day-cell"}"
          ${future ? "" : `data-tip="${esc(`${bucketLabel(date, "day", true)}|${v ? money(v) : "没有消费"}`)}"`}/>`;
      }
    }
    const rows = [0, 2, 4].map((d) => `<text x="0" y="${T + d * (cell + gap) + 10}" class="tick">${WEEK[d]}</text>`).join("");
    const W = L + 26 * (cell + gap), H = T + 7 * (cell + gap);
    const busiest = [...day.entries()].sort((a, b) => b[1] - a[1])[0];
    const active = vals.length, span = Math.round((parse(today) - parse(start)) / 864e5) + 1;
    return `<h3>消费日历</h3><p class="an-sub">近 26 周，颜色越深当天花得越多 · ${active}/${span} 天有消费${busiest ? ` · 最高 ${bucketLabel(busiest[0], "day")} ${money(busiest[1])}` : ""}</p>
      <div class="cal-wrap"><svg viewBox="0 0 ${W} ${H}" class="chart cal" role="img" aria-label="消费日历">${months}${rows}${cells}</svg></div>
      <div class="legend heat-legend"><span class="muted">少</span>${["#f3eee6", ...HEAT].map((c) => `<i style="background:${c}"></i>`).join("")}<span class="muted">多</span></div>`;
  }

  // ------------------------------------------------------------ 大额消费
  function biggest(list, cards) {
    const color = Object.fromEntries(cards.map((c) => [c.id, c]));
    const rows = list.filter((t) => t.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 6);
    if (!rows.length) return `<h3>大额消费</h3><div class="empty small">没有消费</div>`;
    return `<h3>大额消费</h3><p class="an-sub">所选时间内金额最大的 6 笔</p>
      <div class="mlist">${rows.map((t) => {
        const ic = I.info(t), c = color[t.account_id];
        return `<div class="mrow"><span class="mini-icon" style="--c:${ic.color}">${I.svg(ic.icon)}</span>
          <span class="mname">${esc(t.merchant || t.name)}<small>${+t.date.slice(5, 7)}/${+t.date.slice(8)} · <i class="dot" style="background:${c?.color || OTHER_COLOR}"></i>${esc(c?.label || "")}</small></span><b>${money(t.amount)}</b></div>`;
      }).join("")}</div>`;
  }

  // ------------------------------------------------------------ 分类 × 时间：热力表（跟随上面的日 / 周 / 月 / 季）
  function catMatrix(list, minDate) {
    const { lv, keys } = D.children(ui.node, minDate);
    const g = lv;
    const bucketLabel2 = (k, gg, long) => D.label({ lv: gg, k }, long);
    const cell = {}, rowTot = {}, colTot = {};
    for (const t of list) {
      const k = D.bucket(t.date, g);
      if (!keys.includes(k)) continue;
      const gr = groupOf(t);
      cell[`${gr}|${k}`] = (cell[`${gr}|${k}`] || 0) + t.amount;
      rowTot[gr] = (rowTot[gr] || 0) + t.amount;
      colTot[k] = (colTot[k] || 0) + t.amount;
    }
    const rows = GROUPS.filter((gr) => rowTot[gr.id] > 0);
    if (!rows.length) return `<h3>分类 × 时间</h3><div class="empty small">没有消费</div>`;
    const vals = Object.values(cell).filter((v) => v > 0).sort((a, c) => a - c);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
    const cuts = [q(0.3), q(0.55), q(0.8), q(0.95)];
    const shade = (v) => (v <= 0 ? "" : `background:${HEAT[cuts.filter((c) => v > c).length]};${cuts.filter((c) => v > c).length >= 3 ? "color:#fff;" : ""}`);
    const unit = { day: "天", month: "月", quarter: "季", year: "年" }[g];
    // 每类在最近一期 vs 前几期平均的变化，找出异常
    const past = keys.filter((k) => (g === "day" ? k : D.range({ lv: g, k })[0]) <= D.today());
    const last = past[past.length - 1], prev = past.slice(0, -1);
    const movers = rows.map((gr) => {
      const now = cell[`${gr.id}|${last}`] || 0;
      const base = prev.length ? prev.reduce((s, k) => s + (cell[`${gr.id}|${k}`] || 0), 0) / prev.length : 0;
      return { gr, now, base, d: now - base };
    }).filter((m) => m.base > 0 || m.now > 0).sort((a, c) => Math.abs(c.d) - Math.abs(a.d)).slice(0, 3);
    return `<h3>分类 × 时间</h3>
      <p class="an-sub">每${unit}各大类花了多少，颜色越深越多 · 跟随「消费趋势」当前所在的层级</p>
      <div class="tbl-wrap matrix-wrap"><table class="matrix">
        <thead><tr><th></th>${keys.map((k) => `<th>${bucketLabel2(k, g)}</th>`).join("")}<th>合计</th></tr></thead>
        <tbody>${rows.map((gr) => `<tr><th><i style="background:${gr.color}"></i>${gr.label}</th>${keys.map((k) => {
          const v = cell[`${gr.id}|${k}`] || 0;
          return `<td style="${shade(v)}" ${v ? `data-tip="${esc(`${gr.label} · ${bucketLabel2(k, g, true)}|${money(v)}|占当期 ${colTot[k] ? (v / colTot[k] * 100).toFixed(0) : 0}%`)}"` : ""}>${v ? short(v) : "·"}</td>`;
        }).join("")}<td class="tot">${money(rowTot[gr.id])}</td></tr>`).join("")}
        <tr class="sum"><th>合计</th>${keys.map((k) => `<td>${colTot[k] ? short(colTot[k]) : "·"}</td>`).join("")}<td class="tot">${money(Object.values(rowTot).reduce((s, v) => s + v, 0))}</td></tr></tbody>
      </table></div>
      ${prev.length && movers.length ? `<div class="movers">${movers.map((m) => `<span><i style="background:${m.gr.color}"></i>${m.gr.label}：本${unit} ${money(m.now)}，${m.d >= 0 ? "比" : "比"}前 ${prev.length} ${unit}平均${m.d >= 0 ? "多" : "少"} <b class="${m.d >= 0 ? "up" : "down"}">${money(Math.abs(m.d))}</b></span>`).join("")}</div>` : ""}`;
  }

  // ------------------------------------------------------------ 单卡分析
  function singleCard(cards, from, today) {
    const credit = new Set(creditAccounts().map((a) => a.id));
    const spendOf = (id) => state.txns.filter((t) => t.account_id === id && credit.has(id) && !NO_SPEND.has(t.category) && !R.isBenefitCredit(t));
    // 默认选：上方筛选的卡；否则所选时间内消费最多的卡
    let id = ui.single || ui.card;
    if (!id || !cards.some((c) => c.id === id)) {
      id = cards.map((c) => [c.id, spendOf(c.id).filter((t) => t.date >= from).reduce((s, t) => s + t.amount, 0)]).sort((a, b) => b[1] - a[1])[0][0];
    }
    const c = cards.find((x) => x.id === id);
    const pk = productOf(c.a), product = R.PRODUCTS[pk], prog = product && R.PROGRAMS[product.program];
    const txs = spendOf(id);
    const inR = txs.filter((t) => t.date >= from && t.date <= today);
    const spend = inR.reduce((s, t) => s + t.amount, 0);
    const buys = inR.filter((t) => t.amount > 0);
    let earned = 0;
    const byRate = new Map();
    for (const t of inR) {
      const e = state.earn.get(t.id);
      if (!e || e.cat === "none") continue;
      earned += e.earned;
      if (t.amount > 0) {
        const r = Math.round(e.rate * 2) / 2;
        byRate.set(r, (byRate.get(r) || 0) + t.amount);
      }
    }
    const unit = prog?.unit || "pts";
    const eff = spend > 0 ? (earned / spend) * (unit === "cash" ? 100 : 1) : 0;
    const base = product?.base ?? 1;
    const bonusSpend = [...byRate.entries()].filter(([r]) => r > base).reduce((s, [, v]) => s + v, 0);
    const buyTotal = buys.reduce((s, t) => s + t.amount, 0);

    // 近 12 个月每月消费（小柱图）
    const months = [];
    let m = today.slice(0, 7);
    for (let i = 0; i < 12; i++) { months.unshift(m); let y = +m.slice(0, 4), mm = +m.slice(5) - 1; if (!mm) { mm = 12; y--; } m = `${y}-${String(mm).padStart(2, "0")}`; }
    const mv = months.map((k) => txs.filter((t) => t.date.startsWith(k)).reduce((s, t) => s + t.amount, 0));
    const mmax = niceMax(Math.max(...mv, 1));
    const W = 360, H = 130, T = 14, B = 22, ph = H - T - B, step = W / 12, bw = step * 0.6;
    const spark = mv.map((v, i) => {
      const h = (Math.max(0, v) / mmax) * ph, x = step * i + (step - bw) / 2;
      return `<rect x="${x}" y="${T + ph - h}" width="${bw}" height="${Math.max(h, 0.5)}" rx="3" fill="${c.color}" opacity="${months[i] === today.slice(0, 7) ? 1 : 0.8}"/>
        ${i % 3 === 2 || i === 11 ? `<text x="${x + bw / 2}" y="${H - 6}" class="tick" text-anchor="middle">${+months[i].slice(5)}月</text>` : ""}
        <rect x="${step * i}" y="${T}" width="${step}" height="${ph}" class="hit" data-tip="${esc(`${months[i].slice(0, 4)} 年 ${+months[i].slice(5)} 月|${money(v)}`)}"/>`;
    }).join("");

    // 类别构成（100% 条）
    const gsum = {};
    for (const t of inR) gsum[groupOf(t)] = (gsum[groupOf(t)] || 0) + t.amount;
    const gpos = GROUPS.filter((gr) => gsum[gr.id] > 0);
    const gtot = gpos.reduce((s, gr) => s + gsum[gr.id], 0);
    const mix = gtot ? `<div class="mix">${gpos.map((gr) => `<b style="flex:${gsum[gr.id]};background:${gr.color}" data-tip="${esc(`${gr.label}|${money(gsum[gr.id])}|占 ${(gsum[gr.id] / gtot * 100).toFixed(0)}%`)}"></b>`).join("")}</div>
      <div class="legend">${gpos.map((gr) => `<span><i style="background:${gr.color}"></i>${gr.label} ${(gsum[gr.id] / gtot * 100).toFixed(0)}%</span>`).join("")}</div>` : "";

    // 倍数分布：每档倍数下的消费额
    const rates = [...byRate.entries()].sort((a, b) => b[0] - a[0]);
    const rmax = Math.max(...rates.map(([, v]) => v), 1);
    const rateRows = rates.map(([r, v]) => `<div class="hbar" data-tip="${esc(`${R.fmtRate(r, unit)}|${money(v)}|占消费 ${buyTotal ? (v / buyTotal * 100).toFixed(0) : 0}%`)}">
      <div class="hbar-label">${R.fmtRate(r, unit)}${r > base ? ' <span class="tag bonus">加成</span>' : ""}</div>
      <div class="hbar-track"><b style="width:${(v / rmax * 100).toFixed(1)}%;background:${c.color};opacity:${r > base ? 1 : 0.45}"></b></div>
      <div class="hbar-val">${money(v)}</div></div>`).join("");

    // 这张卡最常去的商户
    const mm2 = new Map();
    for (const t of inR) { const k = (t.merchant || t.name || "").trim(); const x = mm2.get(k) || { k, v: 0, n: 0, t }; x.v += t.amount; if (t.amount > 0) x.n++; mm2.set(k, x); }
    const tops = [...mm2.values()].filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 5);

    const closing = state.rewards.closing?.[id];
    return `<div class="an-head">
        <h3>单卡分析</h3>
        <select id="an-single" data-cardselect>${cards.map((x) => `<option value="${esc(x.id)}" ${x.id === id ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select>
      </div>
      <p class="an-sub"><i class="dot" style="background:${c.color}"></i>${esc(product?.name || c.a.name)} · ${esc(c.a.institution)}${prog ? ` · ${esc(prog.name)}` : ""} · 账单日 ${closing ? `每月 ${closing} 号` : "未设置（按月底）"} · 时间范围跟随上方筛选</p>
      <div class="an-kpis small">
        <div class="stat"><div class="label">消费</div><div class="value">${money(spend)}</div><div class="sub">${buys.length} 笔 · 客单价 ${buys.length ? money(buyTotal / buys.length) : "—"}</div></div>
        <div class="stat"><div class="label">估算积分</div><div class="value">${prog ? esc(R.fmtEarned(earned, unit)) : "—"}</div><div class="sub">${prog ? esc(prog.name) : "未设置卡型"}</div></div>
        <div class="stat"><div class="label">平均倍数</div><div class="value">${esc(R.fmtRate(eff, unit))}</div><div class="sub">基础 ${esc(R.fmtRate(base, unit))}</div></div>
        <div class="stat"><div class="label">吃到加成的消费</div><div class="value">${buyTotal ? (bonusSpend / buyTotal * 100).toFixed(0) : 0}%</div><div class="sub">${money(bonusSpend)} 拿到高于基础的倍数</div></div>
      </div>
      <div class="an-grid inner">
        <div><h4>近 12 个月</h4><svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="近 12 个月消费"><line x1="0" x2="${W}" y1="${T + ph}" y2="${T + ph}" class="grid base"/>${spark}</svg></div>
        <div><h4>倍数分布</h4>${rateRows || '<div class="empty small">没有消费</div>'}</div>
      </div>
      <div class="an-grid inner">
        <div><h4>类别构成</h4>${mix || '<div class="empty small">没有消费</div>'}</div>
        <div><h4>常去商户</h4><div class="mlist">${tops.map((x) => {
          const ic = I.info(x.t);
          return `<div class="mrow"><span class="mini-icon" style="--c:${ic.color}">${I.svg(ic.icon)}</span><span class="mname">${esc(x.k)}<small>${x.n} 次</small></span><b>${money(x.v)}</b></div>`;
        }).join("") || '<div class="empty small">没有消费</div>'}</div></div>
      </div>`;
  }

  // ------------------------------------------------------------ 悬停提示（所有图共用一个）
  function tooltip() {
    let tip = document.getElementById("an-tip");
    if (!tip) { tip = document.createElement("div"); tip.id = "an-tip"; tip.setAttribute("role", "tooltip"); document.body.appendChild(tip); }
    return tip;
  }
  function showTip(el, x, y) {
    const tip = tooltip();
    const [title, value, ...rest] = el.dataset.tip.split("|");
    tip.replaceChildren();
    const h = document.createElement("div"); h.className = "t-title"; h.textContent = title; tip.appendChild(h);
    const v = document.createElement("div"); v.className = "t-value"; v.textContent = value; tip.appendChild(v);
    for (const r of rest) {
      const row = document.createElement("div"); row.className = "t-row";
      const parts = r.split("~");
      if (parts.length === 3) {
        const sw = document.createElement("i"); sw.style.background = parts[0]; row.appendChild(sw);
        const l = document.createElement("span"); l.textContent = parts[1]; row.appendChild(l);
        const n = document.createElement("b"); n.textContent = parts[2]; row.appendChild(n);
      } else row.textContent = r;
      tip.appendChild(row);
    }
    tip.style.display = "block";
    const w = tip.offsetWidth, hgt = tip.offsetHeight;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x + 14))}px`;
    tip.style.top = `${Math.max(8, y - hgt - 12)}px`;
  }
  function hideTip() { const t = document.getElementById("an-tip"); if (t) t.style.display = "none"; }

  function bind() {
    const root = document.getElementById("analytics");
    root.addEventListener("change", (e) => {
      if (e.target.id === "an-card") { ui.card = e.target.value; render(); }
      if (e.target.id === "an-single") { ui.single = e.target.value; render(); }
    });
    root.addEventListener("click", (e) => {
      const gb = e.target.closest("[data-group]");
      if (gb) { ui.group = gb.dataset.group; render(); }
    });
    root.addEventListener("pointermove", (e) => {
      const el = e.target.closest("[data-tip]");
      root.querySelectorAll(".col.hover").forEach((c) => c.classList.remove("hover"));
      if (!el) return hideTip();
      el.closest(".col")?.classList.add("hover");
      showTip(el, e.clientX, e.clientY);
    });
    root.addEventListener("pointerleave", hideTip);
  }

  window.RT_ANALYTICS = { render, bind };
})();
