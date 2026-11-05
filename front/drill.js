// Reward Tracker — 可下钻的时间柱状图（积分页和分析页共用）。
// 层级：全部（按年）→ 某年（4 个季度）→ 某季度（3 个月）→ 某月（每天）；另外可以直接选某一周（7 天）。
// 交互：双击柱子进入下一级；左上角 ↰ 返回上一级；面包屑可以跳回任意一级；「选择时间」按年 / 季 / 月 / 周列出有记录的时间。

(function () {
  const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const dow = (s) => (parse(s).getDay() + 6) % 7;
  const today = () => iso(new Date());
  const monthEnd = (ym) => `${ym}-${pad(new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate())}`;
  const qOf = (s) => `${s.slice(0, 4)}-Q${Math.ceil(+s.slice(5, 7) / 3)}`;
  const weekOf = (s) => addDays(s, -dow(s));

  // ------------------------------------------------------------ 节点：{ lv: all | year | quarter | month | week, k }
  function range(node, minDate) {
    const { lv, k } = node;
    if (lv === "all") return [minDate || today(), today()];
    if (lv === "year") return [`${k}-01-01`, `${k}-12-31`];
    if (lv === "quarter") { const y = k.slice(0, 4), q = +k.slice(6); return [`${y}-${pad(q * 3 - 2)}-01`, monthEnd(`${y}-${pad(q * 3)}`)]; }
    if (lv === "month") return [`${k}-01`, monthEnd(k)];
    return [k, addDays(k, 6)]; // week：k = 周一
  }
  const childLv = { all: "year", year: "quarter", quarter: "month", month: "day", week: "day" };
  function children(node, minDate) {
    const [a, b] = range(node, minDate);
    const lv = childLv[node.lv], out = [];
    if (lv === "year") for (let y = +a.slice(0, 4); y <= +b.slice(0, 4); y++) out.push(String(y));
    else if (lv === "quarter") for (let q = 1; q <= 4; q++) out.push(`${node.k}-Q${q}`);
    else if (lv === "month") { const y = node.k.slice(0, 4), q = +node.k.slice(6); for (let m = q * 3 - 2; m <= q * 3; m++) out.push(`${y}-${pad(m)}`); }
    else for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
    return { lv, keys: out };
  }
  const bucket = (date, lv) => (lv === "year" ? date.slice(0, 4) : lv === "quarter" ? qOf(date) : lv === "month" ? date.slice(0, 7) : date);
  function parent(node) {
    if (node.lv === "year") return { lv: "all", k: "" };
    if (node.lv === "quarter") return { lv: "year", k: node.k.slice(0, 4) };
    if (node.lv === "month") return { lv: "quarter", k: qOf(`${node.k}-01`) };
    if (node.lv === "week") return { lv: "month", k: node.k.slice(0, 7) };
    return null;
  }
  function crumbs(node) {
    const list = [];
    for (let n = node; n; n = parent(n)) list.unshift(n);
    return list;
  }
  function label(node, long) {
    const { lv, k } = node;
    if (lv === "all") return "全部";
    if (lv === "year") return long ? `${k} 年` : k;
    if (lv === "quarter") return long ? `${k.slice(0, 4)} 年 ${k.slice(5)}` : k.slice(5);
    if (lv === "month") return long ? `${k.slice(0, 4)} 年 ${+k.slice(5)} 月` : `${+k.slice(5)}月`;
    if (lv === "week") return `${+k.slice(5, 7)}/${+k.slice(8)} 那周`;
    return long ? `${+k.slice(5, 7)}月${+k.slice(8)}日 周${WEEK[dow(k)]}` : `${+k.slice(5, 7)}/${+k.slice(8)}`;
  }
  const childLabel = (lv, k, long) => label({ lv: lv === "day" ? "day" : lv, k }, long);
  const levelName = { all: "全部", year: "年", quarter: "季度", month: "月", week: "周" };

  function niceMax(v) {
    const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p * 4;
    return 40 * p;
  }
  const escH = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------ 图
  // opts: { id, node, entries: [{date, s, v}], series: [{id,label,color}], fmt, short, unitWord }
  const registry = new Map(); // id → { setNode, opts }

  function chart(opts) {
    const { id, node, entries, series, fmt, short } = opts;
    const minDate = entries.reduce((m, e) => (e.date < m ? e.date : m), today());
    const { lv, keys } = children(node, minDate);
    const t0 = today();
    const idx = new Map(keys.map((k, i) => [k, i]));
    const data = keys.map((k) => ({ k, total: 0, by: Object.fromEntries(series.map((s) => [s.id, 0])) }));
    for (const e of entries) {
      const i = idx.get(bucket(e.date, lv));
      if (i == null || data[i].by[e.s] == null) continue;
      data[i].by[e.s] += e.v; data[i].total += e.v;
    }
    registry.set(id, { ...registry.get(id), opts, minDate });

    const W = 760, H = 250, L = 56, Rm = 10, T = 16, B = 28, pw = W - L - Rm, ph = H - T - B;
    const max = niceMax(Math.max(...data.map((d) => d.total), 1));
    const y = (v) => T + ph - (Math.max(0, v) / max) * ph;
    const step = pw / data.length, bw = Math.max(3, Math.min(lv === "day" ? 16 : 64, step * 0.62));
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const v = max * f, yy = y(v);
      return `<line x1="${L}" x2="${W - Rm}" y1="${yy}" y2="${yy}" class="grid${f === 0 ? " base" : ""}"/><text x="${L - 8}" y="${yy + 4}" class="tick" text-anchor="end">${short(v)}</text>`;
    }).join("");
    const every = lv === "day" ? Math.ceil(data.length / 10) : 1;
    const canDrill = lv !== "day";
    const cols = data.map((d, i) => {
      const x = L + step * i + (step - bw) / 2, future = (lv === "day" ? d.k : range({ lv, k: d.k })[0]) > t0;
      let acc = 0;
      const segs = series.map((s) => {
        const v = Math.max(0, d.by[s.id]);
        if (!v) return "";
        const y1 = y(acc + v), y0 = y(acc); acc += v;
        return `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, y0 - y1).toFixed(1)}" fill="${s.color}" class="seg-rect"/>`;
      }).join("");
      const big = lv !== "day" && d.total > 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y(d.total) - 6).toFixed(1)}" class="val" text-anchor="middle">${escH(short(d.total))}</text>` : "";
      const xl = (i % every === 0) ? `<text x="${(L + step * i + step / 2).toFixed(1)}" y="${H - 8}" class="tick${future ? " future" : ""}" text-anchor="middle">${escH(childLabel(lv, d.k))}</text>` : "";
      const tip = `${childLabel(lv, d.k, true)}${canDrill ? "（双击进入）" : ""}|合计 ${fmt(d.total)}|` +
        (series.length > 1 ? series.filter((s) => d.by[s.id]).sort((a, b) => d.by[b.id] - d.by[a.id]).map((s) => `${s.color}~${s.label}~${fmt(d.by[s.id])}`).join("|") : "");
      return `<g class="col${canDrill ? " drillable" : ""}">${segs}${big}${xl}<rect x="${(L + step * i).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${ph}" class="hit"
        data-tip="${escH(tip.replace(/\|$/, ""))}" ${canDrill ? `data-drill="${escH(d.k)}" data-drill-lv="${lv}"` : ""}/></g>`;
    }).join("");

    const tot = data.reduce((s, d) => s + d.total, 0);
    const path = crumbs(node);
    const up = parent(node);
    return `<div class="drill" data-drill-id="${escH(id)}">
      <div class="drill-bar">
        <button class="drill-up" ${up ? `data-drill-go="${escH(JSON.stringify(up))}"` : "disabled"} title="返回上一级" aria-label="返回上一级">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>
        </button>
        <nav class="crumbs">${path.map((n, i) => i === path.length - 1
          ? `<b>${escH(label(n, true))}</b>`
          : `<button data-drill-go="${escH(JSON.stringify(n))}">${escH(label(n))}</button><span>›</span>`).join("")}</nav>
        <span class="drill-total">${escH(fmt(tot))}</span>
        <button class="drill-pick" data-picker-open title="选择时间">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>
          选择时间
        </button>
      </div>
      ${series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${escH(s.label)}</span>`).join("")}</div>` : ""}
      <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${escH(label(node, true))}">${grid}${cols}</svg>
      <p class="drill-hint">${canDrill ? `双击柱子进入下一级 · ` : ""}${up ? "左上角 ↰ 返回上一级 · " : ""}「选择时间」可直接跳到任一年、季度、月或周</p>
      <div class="picker" hidden></div>
    </div>`;
  }

  // ------------------------------------------------------------ 选择时间面板
  function pickerHTML(id, tab) {
    const reg = registry.get(id);
    const { entries, fmt } = reg.opts;
    const sums = { year: new Map(), quarter: new Map(), month: new Map(), week: new Map() };
    for (const e of entries) {
      for (const [lv, k] of [["year", e.date.slice(0, 4)], ["quarter", qOf(e.date)], ["month", e.date.slice(0, 7)], ["week", weekOf(e.date)]]) {
        sums[lv].set(k, (sums[lv].get(k) || 0) + e.v);
      }
    }
    const list = [...sums[tab].entries()].filter(([, v]) => v).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    const cur = reg.opts.node;
    return `<div class="picker-head">
        <div class="seg">${[["year", "年"], ["quarter", "季度"], ["month", "月"], ["week", "周"]].map(([v, l]) => `<button data-picker-tab="${v}" class="${v === tab ? "on" : ""}">${l}</button>`).join("")}</div>
        <button class="picker-all" data-drill-go='${escH(JSON.stringify({ lv: "all", k: "" }))}'>全部</button>
        <button class="picker-close" data-picker-close aria-label="关闭">✕</button>
      </div>
      <div class="picker-grid">${list.length ? list.map(([k, v]) => {
        const n = { lv: tab, k };
        return `<button class="pick ${cur.lv === tab && cur.k === k ? "on" : ""}" data-drill-go='${escH(JSON.stringify(n))}'>
          <span>${escH(tab === "week" ? `${k.slice(0, 4)} · ${+k.slice(5, 7)}/${+k.slice(8)} 起` : label(n, true))}</span><small>${escH(fmt(v))}</small></button>`;
      }).join("") : `<p class="hint">没有记录</p>`}</div>`;
  }

  // ------------------------------------------------------------ 事件（每个页面根节点绑定一次）
  function bind(root, id, setNode) {
    registry.set(id, { ...registry.get(id), setNode });
    if (root.dataset.drillBound?.includes(`|${id}|`)) return;
    root.dataset.drillBound = `${root.dataset.drillBound || ""}|${id}|`;
    const own = (e) => e.target.closest(`[data-drill-id="${CSS.escape(id)}"]`);
    root.addEventListener("dblclick", (e) => {
      const box = own(e); if (!box) return;
      const t = e.target.closest("[data-drill]");
      if (!t) return;
      e.preventDefault();
      registry.get(id).setNode({ lv: t.dataset.drillLv, k: t.dataset.drill });
    });
    root.addEventListener("click", (e) => {
      const box = own(e); if (!box) return;
      const go = e.target.closest("[data-drill-go]");
      if (go) { registry.get(id).setNode(JSON.parse(go.dataset.drillGo)); return; }
      const pk = box.querySelector(".picker");
      if (e.target.closest("[data-picker-open]")) {
        const cur = registry.get(id).opts.node;
        const tab = cur.lv === "all" || cur.lv === "year" ? "year" : cur.lv;
        pk.innerHTML = pickerHTML(id, tab); pk.hidden = !pk.hidden; return;
      }
      const tb = e.target.closest("[data-picker-tab]");
      if (tb) { pk.innerHTML = pickerHTML(id, tb.dataset.pickerTab); return; }
      if (e.target.closest("[data-picker-close]")) pk.hidden = true;
    });
  }

  window.RT_DRILL = { chart, bind, range, children, bucket, label, parent, today };
})();
