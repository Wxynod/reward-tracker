// Reward Tracker — 「分析」页：日 / 周 / 月 / 季消费趋势、按卡、按类别、星期规律、消费日历、商户排行。
// 纯 SVG 手绘，不依赖图表库。用到 app.js 里的全局：state、R、I、fmt、esc、creditAccounts、productOf。
// 配色：按卡用 8 色分类色板（固定顺序、跟着卡走，不随排名变），日历用单一色相的深浅；文字一律用墨色。

(function () {
  const CAT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const OTHER_COLOR = "#a39c90";
  const HEAT = ["#efe7dc", "#f0c9b8", "#de9580", "#c4614d", "#a3312a"]; // 浅 → 深，单一色相
  const NO_SPEND = new Set(["LOAN_PAYMENTS", "TRANSFER_IN", "TRANSFER_OUT", "INCOME", "BANK_FEES"]);
  const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

  const ui = { card: "", range: "180", grain: "week" };

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
    const from = ui.range === "all"
      ? (all.length ? all.reduce((m, t) => (t.date < m ? t.date : m), today) : today)
      : addDays(today, -Number(ui.range) + 1);
    const inRange = all.filter((t) => t.date >= from && t.date <= today);

    root.innerHTML = `
      <div class="an-filters">
        <select id="an-card"><option value="">全部卡片</option>${cards.map((c) =>
          `<option value="${esc(c.id)}" ${c.id === ui.card ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
        <select id="an-range">${[["30", "近 30 天"], ["90", "近 3 个月"], ["180", "近 6 个月"], ["365", "近 12 个月"], ["all", "全部"]].map(([v, l]) =>
          `<option value="${v}" ${v === ui.range ? "selected" : ""}>${l}</option>`).join("")}</select>
      </div>
      ${kpis(all, today)}
      <section class="an-card">
        <div class="an-head">
          <h3>消费趋势</h3>
          <div class="seg" role="tablist">${[["day", "日"], ["week", "周"], ["month", "月"], ["quarter", "季"]].map(([v, l]) =>
            `<button data-grain="${v}" class="${v === ui.grain ? "on" : ""}">${l}</button>`).join("")}</div>
        </div>
        ${trend(inRange, from, today, cards)}
      </section>
      <div class="an-grid">
        <section class="an-card">${byCard(inRange, cards)}</section>
        <section class="an-card">${byCategory(inRange)}</section>
      </div>
      <div class="an-grid">
        <section class="an-card">${weekday(inRange, from, today)}</section>
        <section class="an-card">${merchants(inRange)}</section>
      </div>
      <section class="an-card">${calendar(all, today)}</section>
      <section class="an-card">${biggest(inRange, cards)}</section>`;
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
  function trend(list, from, today, cards) {
    const g = ui.grain;
    let start = bucketOf(from, g);
    if (g === "day" && ui.range !== "30" && ui.range !== "90") start = bucketOf(addDays(today, -89), g); // 日视图最多 90 天
    const end = bucketOf(today, g);
    const keys = [];
    for (let b = start; b <= end && keys.length < 400; b = nextBucket(b, g)) keys.push(b);
    const series = ui.card ? cards.filter((c) => c.id === ui.card) : cards;
    const data = keys.map((k) => ({ k, total: 0, by: Object.fromEntries(series.map((c) => [c.id, 0])) }));
    const idx = new Map(keys.map((k, i) => [k, i]));
    for (const t of list) {
      const i = idx.get(bucketOf(t.date, g));
      if (i == null || data[i].by[t.account_id] == null) continue;
      data[i].by[t.account_id] += t.amount; data[i].total += t.amount;
    }
    if (!data.some((d) => d.total)) return `<div class="empty small">这段时间没有消费</div>`;

    const W = 760, H = 250, L = 52, Rm = 10, T = 12, B = 28;
    const pw = W - L - Rm, ph = H - T - B;
    const max = niceMax(Math.max(...data.map((d) => d.total), 1));
    const y = (v) => T + ph - (Math.max(0, v) / max) * ph;
    const step = pw / data.length, bw = Math.max(2, Math.min(36, step * 0.68));
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const v = max * f, yy = y(v);
      return `<line x1="${L}" x2="${W - Rm}" y1="${yy}" y2="${yy}" class="grid${f === 0 ? " base" : ""}"/><text x="${L - 8}" y="${yy + 4}" class="tick" text-anchor="end">${short(v)}</text>`;
    }).join("");
    const every = Math.ceil(data.length / 8);
    const xlabels = data.map((d, i) => (i % every === 0 || i === data.length - 1) && !(i !== data.length - 1 && data.length - 1 - i < every / 2)
      ? `<text x="${L + step * i + step / 2}" y="${H - 8}" class="tick" text-anchor="middle">${bucketLabel(d.k, g)}</text>` : "").join("");
    const bars = data.map((d, i) => {
      const x = L + step * i + (step - bw) / 2;
      let acc = 0;
      const segs = series.map((c) => {
        const v = Math.max(0, d.by[c.id]);
        if (!v) return "";
        const y1 = y(acc + v), y0 = y(acc); acc += v;
        return `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, y0 - y1).toFixed(1)}" fill="${c.color}" class="seg-rect"/>`;
      }).join("");
      const tip = `${bucketLabel(d.k, g, true)}|合计 ${money(d.total)}|` +
        series.filter((c) => d.by[c.id]).sort((a, b) => d.by[b.id] - d.by[a.id]).map((c) => `${c.color}~${c.label}~${money(d.by[c.id])}`).join("|");
      return `<g class="col">${segs}<rect x="${(L + step * i).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${ph}" class="hit" data-tip="${esc(tip)}"/></g>`;
    }).join("");
    let line = "";
    if (g === "day" && data.length >= 7) {
      const pts = data.map((d, i) => {
        if (i < 6) return null;
        const avg = data.slice(i - 6, i + 1).reduce((s, x) => s + x.total, 0) / 7;
        return `${(L + step * i + step / 2).toFixed(1)},${y(avg).toFixed(1)}`;
      }).filter(Boolean);
      line = `<polyline points="${pts.join(" ")}" class="avg-line"/>`;
    }
    const avg = data.reduce((s, d) => s + d.total, 0) / data.length;
    const legend = `<div class="legend">${series.length > 1 ? series.map((c) => `<span><i style="background:${c.color}"></i>${esc(c.label)}</span>`).join("") : ""}
      ${line ? `<span><i class="line"></i>7 日平均</span>` : ""}<span class="muted">平均每${{ day: "天", week: "周", month: "月", quarter: "季" }[g]} ${money(avg)}</span></div>`;
    const table = `<details class="an-table"><summary>数据表</summary><div class="tbl-wrap"><table>
      <thead><tr><th>${{ day: "日期", week: "周", month: "月份", quarter: "季度" }[g]}</th><th>合计</th>${series.length > 1 ? series.map((c) => `<th>${esc(c.label)}</th>`).join("") : ""}</tr></thead>
      <tbody>${data.slice().reverse().filter((d) => d.total).map((d) => `<tr><td>${bucketLabel(d.k, g, true)}</td><td>${money(d.total)}</td>${series.length > 1 ? series.map((c) => `<td>${d.by[c.id] ? money(d.by[c.id]) : "—"}</td>`).join("") : ""}</tr>`).join("")}</tbody>
    </table></div></details>`;
    return `${legend}<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="消费趋势">${grid}${bars}${line}${xlabels}</svg>${table}`;
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
      if (e.target.id === "an-range") { ui.range = e.target.value; render(); }
    });
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-grain]");
      if (b) { ui.grain = b.dataset.grain; render(); }
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
