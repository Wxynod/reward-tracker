// Reward Tracker — 账户详情：点「账户」页任意一个账户打开。
// 电脑上从中间浮出、手机上从底部滑出（和交易明细同一套交互）。卡面大图放在最上面，「更换卡面」直接在卡片里展开。
// 用到 app.js / cards.js / rewards.js 的全局：state、R、fmt、esc、cardName、productOf、productOptions、closingDay、dueInfo、
// lastClosing、nextClosing、limitBar、saveRewards、today、connect、RT_CARDS、isManual、naVal、fmtOrig、origLine、regionTag。

(function () {
  let current = null, faceOpen = false;

  const md = (d) => (d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : "—");
  const ymd = (d) => (d ? `${d.slice(0, 4)} 年 ${+d.slice(5, 7)} 月 ${+d.slice(8, 10)} 日` : "—");
  const APR = { purchase_apr: "消费", cash_apr: "取现", balance_transfer_apr: "余额转移", special: "优惠" };
  const SUB = { "credit card": "信用卡", checking: "支票账户", savings: "储蓄账户", "money market": "货币市场", cd: "定期存单" };

  function itemOf(id) { return state.items.find((it) => it.accounts.some((a) => a.id === id)); }

  // ------------------------------------------------------------ 内容
  function content(a) {
    const it = itemOf(a.id);
    const isCredit = a.type === "credit";
    const pk = isCredit ? productOf(a) : null;
    const product = pk && R.PRODUCTS[pk];
    const prog = product && R.PROGRAMS[product.program];
    const due = isCredit ? dueInfo(a) : null;
    const L = a.liability;
    const cd = closingDay(a.id);
    const t0 = today();

    // 头部：大卡面 + 名字 + 操作
    const hero = `<div class="ad-hero">
        <div class="ad-stage">${RT_CARDS.face(a, "lg")}</div>
        <div class="ad-id">
          <h3 id="ad-title">${esc(cardName(a))}${a.mask ? ` <span>··${esc(a.mask)}</span>` : ""}</h3>
          <p>${regionTag(a.region)}${esc(a.institution)} · ${esc(SUB[a.subtype] || a.subtype || a.type)}${a.official_name && a.official_name !== cardName(a) ? ` · ${esc(a.official_name)}` : ""}</p>
          <button class="btn small ad-face-btn ${faceOpen ? "on" : ""}" data-ad-face>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2.5" y="5.5" width="19" height="13" rx="2.2"/><path d="M2.5 10h19M6 15h4"/></svg>
            ${faceOpen ? "收起卡面选择" : "更换卡面"}
          </button>
        </div>
      </div>
      <div class="ad-chooser ${faceOpen ? "open" : ""}" data-ad-chooser>${faceOpen ? RT_CARDS.chooserHTML(a) : ""}</div>`;

    // 不走 Plaid 的账户：说明数据从哪来、有哪些影响
    const manual = isManual(a) ? `<section class="ad-sec ad-manual">
        <h4>${regionTag(a.region)}没有通过 Plaid 连接</h4>
        <p>这张卡在香港发行，Plaid 连不上，交易来自 Amex 月结单（CSV）导入。这样会有以下影响：</p>
        <ul>
          <li><b>不会自动同步。</b>「同步」「立刻从银行刷新」对它没有作用；新交易要等下次导入（以后由 Amex 网页脚本读取）。</li>
          <li><b>当前欠款</b>是已导入交易的累计，还没导入的新消费不在里面。</li>
          <li><b>金额是港币。</b>按固定汇率 1 USD = 7.8 HKD 换算成美元参与汇总，和 Amex 实际入账汇率无关；港币原值显示在旁边。</li>
          <li><b>没有 MCC 和 Plaid 商户分类，</b>分类统计里大多归入「其他」；本站不估算这张卡的积分，季度加赏看 Amex HK Tracker。</li>
          <li><b>账单信息</b>由结单算出或来自问卷，问卷填 N/A 的项目显示「没有」。</li>
        </ul>
      </section>` : "";

    // 余额
    const avail = a.balance_available != null ? a.balance_available : a.limit ? a.limit - (a.balance_current || 0) : null;
    const bal = `<section class="ad-sec">
        <div class="ad-stats">
          <div><small>${isCredit ? "当前欠款" : "当前余额"}</small><b>${a.balance_current != null ? fmt(a.balance_current, a.currency) : "—"}</b>${origLine(a, "balance_current", "orig")}</div>
          ${isCredit ? `<div><small>信用额度</small><b>${a.limit ? fmt(a.limit, a.currency) : "—"}</b>${origLine(a, "limit", "orig")}</div>` : ""}
          <div><small>可用${isCredit ? "额度" : "余额"}</small><b>${avail != null ? fmt(avail, a.currency) : "—"}</b>${origLine(a, "balance_available", "orig")}</div>
        </div>
        ${isCredit && a.limit ? limitBar(a) : ""}
        ${isCredit && !a.limit ? `<p class="hint">这张卡没有固定额度（签账卡）或银行没有提供额度。</p>` : ""}
      </section>`;

    // 账单与还款（Liabilities）
    let bill = "";
    if (isCredit) {
      if (L) {
        const LO = L.orig || {};
        const hk = (k) => (LO[k] != null && a.orig_currency ? `<em class="orig">${esc(fmtOrig(LO[k], a.orig_currency))}</em>` : "");
        const dueTxt = L.na?.includes("next_payment_due_date") ? "没有" : !due ? "—" : due.level === "overdue" ? "已逾期" : due.nothing ? "本期无需还款" : due.paid ? "本期已还" : due.days < 0 ? "已过还款日" : `剩 ${due.days} 天`;
        bill = `<section class="ad-sec">
          <h4>账单与还款</h4>
          <div class="ad-bill ${due?.level || ""}">
            <div class="ad-due">
              <small>还款日</small>
              <b>${naVal(L, "next_payment_due_date", ymd)}</b>
              <span class="due-chip ${due?.level || ""}">${esc(dueTxt)}</span>
            </div>
            <div class="ad-grid4">
              <div><small>上期账单</small><b>${naVal(L, "last_statement_balance", (v) => fmt(v))}</b>${hk("last_statement_balance")}<em>${L.last_statement_issue_date ? `${md(L.last_statement_issue_date)} 出账` : ""}</em></div>
              <div><small>最低还款</small><b>${naVal(L, "minimum_payment_amount", (v) => fmt(v))}</b>${hk("minimum_payment_amount")}<em>&nbsp;</em></div>
              <div><small>上次还款</small><b>${naVal(L, "last_payment_amount", (v) => fmt(v))}</b>${hk("last_payment_amount")}<em>${L.last_payment_date ? md(L.last_payment_date) : ""}</em></div>
              <div><small>逾期</small><b class="${L.is_overdue ? "bad" : "good"}">${L.is_overdue == null ? "—" : L.is_overdue ? "是" : "否"}</b><em>&nbsp;</em></div>
            </div>
          </div>
          ${L.aprs?.length ? `<table class="ad-apr"><thead><tr><th>APR</th><th>年利率</th><th>计息余额</th><th>本期利息</th></tr></thead><tbody>
            ${L.aprs.map((x) => `<tr><td>${esc(APR[x.type] || x.type)}</td><td>${x.na ? "没有" : x.pct != null ? `${(+x.pct).toFixed(2)}%` : "—"}</td><td>${x.balance != null ? fmt(x.balance) : "—"}</td><td>${x.interest != null ? fmt(x.interest) : "—"}</td></tr>`).join("")}
          </tbody></table>` : L.na?.includes("aprs") ? `<p class="hint">APR：没有</p>` : ""}
        </section>`;
      } else {
        const st = it?.liab_status;
        bill = `<section class="ad-sec ad-empty">
          <h4>账单与还款</h4>
          ${isManual(a) ? `<p>还没有账单信息。运行导入脚本（scripts/import_amex_hk.mjs）后会显示。</p>`
            : st === "consent_required"
            ? `<p>这家银行还没授权账单信息。授权后会自动显示还款日、最低还款、APR，并自动设好账单日（走更新模式，不占新连接名额）。</p><button class="btn primary small" data-liab="${esc(it.item_id)}">授权账单信息</button>`
            : st === "unsupported" ? `<p>这家银行不通过 Plaid 提供账单信息。</p>`
            : `<p>还没有账单信息。部署新版后端后点「同步」即可获取；如果提示需要授权，这里会出现授权按钮。</p>`}
        </section>`;
      }
    }

    // 账单周期 + 本期积分
    let cycle = "";
    if (isCredit) {
      const last = lastClosing(a.id, t0), nextC = nextClosing(a.id, addDay(last));
      const cur = state.txns.filter((t) => t.account_id === a.id && t.date > last && t.date <= t0);
      let spend = 0, pts = 0;
      for (const t of cur) {
        const e = state.earn.get(t.id);
        if (e && e.cat === "none") continue;
        spend += t.amount; if (e) pts += e.earned;
      }
      const days = Math.round((new Date(nextC) - new Date(last)) / 864e5), gone = Math.round((new Date(t0) - new Date(last)) / 864e5);
      cycle = `<section class="ad-sec">
        <h4>本期账单周期</h4>
        <div class="ad-cycle">
          <div class="ad-cycle-bar"><i style="width:${Math.min(100, (gone / Math.max(days, 1)) * 100).toFixed(1)}%"></i></div>
          <div class="ad-cycle-dates"><span>${md(addDay(last))} 起</span><span>${md(nextC)} 出账 · 还有 ${Math.max(0, Math.round((new Date(nextC) - new Date(t0)) / 864e5))} 天</span></div>
        </div>
        <div class="ad-stats three">
          <div><small>本期消费</small><b>${fmt(spend)}</b></div>
          <div><small>本期 Pending 积分</small><b style="color:${prog?.color || "inherit"}">${prog && !product.noEarn ? `+${esc(R.fmtEarned(pts, prog.unit))}${prog.unit === "cash" ? "" : " " + esc(prog.short)}` : "—"}</b></div>
          <div><small>平均倍数</small><b>${prog && !product.noEarn && spend > 0 ? esc(R.fmtRate((pts / spend) * (prog.unit === "cash" ? 100 : 1), prog.unit)) : "—"}</b></div>
        </div>
        <label class="ad-field">账单日
          <span><input type="number" min="1" max="31" inputmode="numeric" data-closing="${esc(a.id)}" value="${esc(state.rewards.closing?.[a.id] ?? "")}" placeholder="${cd.source === "auto" ? cd.day : "末"}"> 号</span>
          <small>${cd.source === "manual" ? "手动设置 · 清空后恢复自动" : cd.source === "auto" ? `自动 · 来自上期出账日 ${md(cd.from)}` : "未知 · 暂按月底计算"}</small>
        </label>
      </section>`;
    }

    // 卡型与积分
    const kind = isCredit ? `<section class="ad-sec">
        <h4>卡型与积分</h4>
        <label class="ad-field">卡型
          <select data-map="${esc(a.id)}"><option value="">不计积分</option>${productOptions(pk)}</select>
          <small>${product?.noEarn ? esc(product.note || "本站不估算这张卡的积分") : prog ? `${esc(prog.name)} · 基础 ${esc(R.fmtRate(product.base, prog.unit))}` : "选择卡型后按对应倍数估算积分"}</small>
        </label>
        ${(() => {
          const f = window.RT_CAL?.feeInfo(a);
          return `<div class="ad-fee">${f
            ? `<span class="lg fee">年</span><span>年费 <b>${fmt(f.amount)}</b> · 上次 ${md(f.last.date)} 扣费 · 下次约 <b>${ymd(f.next)}</b>（还有 ${Math.round((new Date(f.next) - new Date(t0)) / 864e5)} 天）</span>`
            : `<span class="lg fee off">年</span><span>交易记录里没找到年费（可能没有年费，或扣费早于 Plaid 能拿到的 24 个月）</span>`}</div>`;
        })()}
        ${product?.rules?.length ? `<ul class="ad-rules">${product.rules.filter((r) => !r.to || r.to >= t0).map((r) => `<li><b>${esc(R.fmtRate(r.rates ? Math.max(r.rate, ...Object.values(r.rates)) : r.rate, prog.unit))}</b>${esc(r.cats.map((c) => R.CATS[c] || c).slice(0, 4).join("、"))}${r.cap ? ` <small>上限 $${r.cap.toLocaleString()}</small>` : ""}${r.note ? ` <small>${esc(r.note)}</small>` : ""}</li>`).join("")}</ul>` : ""}
      </section>` : "";

    // 技术信息
    const tech = `<details class="d-raw"><summary>账户信息</summary><dl>
        <div class="d-row"><dt>银行</dt><dd>${esc(a.institution)}</dd></div>
        <div class="d-row"><dt>类型</dt><dd>${esc(a.type)} / ${esc(a.subtype || "—")}</dd></div>
        <div class="d-row"><dt>币种</dt><dd>${a.orig_currency ? `${esc(a.orig_currency)} <small>按 1 USD = ${FX_PER_USD[a.orig_currency]} ${esc(a.orig_currency)} 换算成美元显示</small>` : esc(a.currency || "USD")}</dd></div>
        <div class="d-row"><dt>数据来源</dt><dd>${isManual(a) ? "月结单导入（不经 Plaid）" : "Plaid"}</dd></div>
        <div class="d-row"><dt>${isManual(a) ? "上次导入" : "上次同步"}</dt><dd>${it?.last_synced ? new Date(it.last_synced).toLocaleString("zh-CN") : "—"}</dd></div>
        <div class="d-row mono"><dt>account_id</dt><dd><code>${esc(a.id)}</code></dd></div>
      </dl></details>`;

    return hero + manual + bal + bill + cycle + kind + tech;
  }
  const addDay = (d) => { const x = new Date(d + "T00:00:00"); x.setDate(x.getDate() + 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

  // ------------------------------------------------------------ 面板
  function shell() {
    let el = document.getElementById("acct-detail");
    if (el) return el;
    el = document.createElement("div");
    el.id = "acct-detail";
    el.hidden = true;
    el.innerHTML = `<div class="d-backdrop" data-ad-close></div>
      <div class="d-panel ad-panel" role="dialog" aria-modal="true" aria-labelledby="ad-title" tabindex="-1">
        <div class="d-grab" aria-hidden="true"><span></span></div>
        <div class="d-nav">
          <button class="d-btn" data-ad-step="-1" aria-label="上一个账户"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg></button>
          <button class="d-btn" data-ad-step="1" aria-label="下一个账户"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg></button>
          <span class="d-pos"></span>
          <button class="d-btn close" data-ad-close aria-label="关闭"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
        <div class="d-body"></div>
      </div>`;
    document.body.appendChild(el);

    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-ad-close]")) return close();
      const st = e.target.closest("[data-ad-step]");
      if (st) return step(+st.dataset.adStep);
      if (e.target.closest("[data-ad-face]")) { faceOpen = !faceOpen; paint(); if (faceOpen) el.querySelector("[data-ad-chooser]")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
      const lb = e.target.closest("[data-liab]");
      if (lb) { close(); connect(lb.dataset.liab, { liabilities: true }); return; }
      if (e.target.closest("[data-ad-chooser]")) RT_CARDS.handleChooserClick(e, current);
    });
    el.addEventListener("change", (e) => { if (e.target.closest("[data-ad-chooser]")) RT_CARDS.handleChooserFile(e, current); });

    // 手机：下拉关闭
    const panel = el.querySelector(".d-panel"), body = el.querySelector(".d-body");
    let y0 = null, dy = 0, t0 = 0;
    panel.addEventListener("touchstart", (e) => {
      if (!matchMedia("(max-width: 640px)").matches) return;
      if (body.scrollTop > 0 && !e.target.closest(".d-grab, .d-nav")) return;
      y0 = e.touches[0].clientY; dy = 0; t0 = Date.now(); panel.style.transition = "none";
    }, { passive: true });
    panel.addEventListener("touchmove", (e) => {
      if (y0 == null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      panel.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    panel.addEventListener("touchend", () => {
      if (y0 == null) return;
      panel.style.transition = "";
      if (dy > 100 || (dy / Math.max(1, Date.now() - t0) > 0.6 && dy > 30)) close(); else panel.style.transform = "";
      y0 = null;
    });
    RT_CARDS.onChange(() => paint());
    return el;
  }

  const listIds = () => [...document.querySelectorAll("#account-list [data-acct]")].map((r) => r.dataset.acct);

  function paint() {
    const el = document.getElementById("acct-detail");
    if (!el || el.hidden || !current) return;
    const a = state.accounts[current];
    if (!a) return close();
    const body = el.querySelector(".d-body"), keep = body.scrollTop;
    body.innerHTML = content(a);
    body.scrollTop = keep;
    const ids = listIds(), i = ids.indexOf(current);
    el.querySelector(".d-pos").textContent = i >= 0 ? `${i + 1} / ${ids.length}` : "";
    el.querySelector('[data-ad-step="-1"]').disabled = i <= 0;
    el.querySelector('[data-ad-step="1"]').disabled = i < 0 || i >= ids.length - 1;
  }

  // over：从日历等其他面板里打开时叠在上面，关闭后回到原来的面板
  function open(id, { face = false, over = false } = {}) {
    if (!state.accounts[id]) return;
    const el = shell();
    el.classList.toggle("over", over);
    current = id; faceOpen = face;
    el.hidden = false;
    paint();
    el.querySelector(".d-body").scrollTop = 0;
    document.documentElement.classList.add("d-lock");
    requestAnimationFrame(() => {
      el.classList.add("open");
      el.querySelector(".d-panel").focus({ preventScroll: true });
      if (face) setTimeout(() => el.querySelector("[data-ad-chooser]")?.scrollIntoView({ block: "start", behavior: "smooth" }), 300);
    });
  }
  function close() {
    const el = document.getElementById("acct-detail");
    if (!el || el.hidden) return;
    el.classList.remove("open");
    el.querySelector(".d-panel").style.transform = "";
    if (!document.querySelector("#bill-cal.open")) document.documentElement.classList.remove("d-lock");
    setTimeout(() => { el.hidden = true; el.classList.remove("over"); }, 240);
    current = null;
  }
  function step(dir) {
    const ids = listIds(), i = ids.indexOf(current);
    if (ids[i + dir]) { current = ids[i + dir]; faceOpen = false; paint(); document.querySelector("#acct-detail .d-body").scrollTop = 0; }
  }

  document.addEventListener("click", (e) => {
    const r = e.target.closest("#account-list [data-acct]");
    if (r && !e.target.closest("button, a, input, select")) open(r.dataset.acct);
  });
  document.addEventListener("keydown", (e) => {
    const r = e.target.closest?.("#account-list [data-acct]");
    if (r && e.key === "Enter") { e.preventDefault(); open(r.dataset.acct); return; }
    const el = document.getElementById("acct-detail");
    if (!el || el.hidden) return;
    if (e.key === "Escape") { e.stopImmediatePropagation(); close(); return; }
    if (e.target.matches?.("input, select")) return;
    e.stopImmediatePropagation();
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  }, true);

  window.RT_ACCT = { open, close, refresh: paint };
})();
