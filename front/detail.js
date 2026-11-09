// Reward Tracker — 交易明细：点一条交易打开。
// 电脑：页面中间浮出卡片，背景压暗；手机：从底部滑出的抽屉，可以下拉关闭。
// 内容是 Plaid 返回的这笔交易的全部信息，加上我们算出来的类别、积分。用到 app.js 的全局：state、R、I、B、fmt、esc、cardNameMask、CHANNELS、programLogo。

(function () {
  // 常见 MCC 的中文名（没有的就用我们自己的类别名）
  const MCC_NAMES = {
    3000: "航空公司", 3351: "租车公司", 3501: "酒店", 4111: "通勤交通", 4112: "铁路客运", 4121: "出租车 / 网约车", 4131: "长途巴士",
    4411: "邮轮", 4511: "航空公司", 4582: "机场服务", 4722: "旅行社", 4784: "过路费", 4789: "交通服务", 4812: "电信设备",
    4814: "电信服务", 4816: "网络服务", 4899: "有线电视 / 流媒体", 4900: "水电煤", 5045: "电脑设备", 5200: "家装建材",
    5211: "建材", 5251: "五金店", 5300: "仓储会员店", 5310: "折扣店", 5311: "百货商店", 5331: "杂货店", 5399: "综合零售",
    5411: "超市", 5422: "肉类", 5441: "糖果甜品", 5451: "乳制品", 5462: "面包店", 5499: "食品专卖", 5541: "加油站",
    5542: "自助加油", 5552: "电动车充电", 5611: "男装", 5621: "女装", 5651: "服装", 5655: "运动服饰", 5661: "鞋店",
    5691: "服装", 5712: "家具", 5719: "家居", 5722: "家电", 5732: "电子产品", 5734: "软件", 5812: "餐厅",
    5813: "酒吧", 5814: "快餐", 5815: "数字内容", 5816: "游戏", 5817: "App / 软件", 5818: "数字商品", 5912: "药店",
    5921: "酒类", 5940: "自行车", 5941: "体育用品", 5942: "书店", 5944: "珠宝", 5945: "玩具", 5946: "相机",
    5947: "礼品", 5964: "邮购", 5977: "化妆品", 5992: "花店", 5995: "宠物用品", 5999: "其他零售", 7011: "酒店",
    7230: "美发美容", 7298: "水疗", 7512: "租车", 7523: "停车", 7832: "电影院", 7922: "演出", 7997: "健身俱乐部",
    7999: "娱乐", 8011: "医生", 8021: "牙医", 8062: "医院", 8099: "医疗服务", 8398: "慈善捐款", 8999: "专业服务",
    9311: "税费", 9399: "政府服务",
  };
  const mccName = (mcc) => {
    const n = +mcc;
    if (MCC_NAMES[n]) return MCC_NAMES[n];
    if (n >= 3000 && n <= 3350) return "航空公司";
    if (n >= 3351 && n <= 3500) return "租车公司";
    if (n >= 3501 && n <= 3999) return "酒店";
    return null;
  };
  const PFC_ZH = {
    FOOD_AND_DRINK: "餐饮", GENERAL_MERCHANDISE: "购物", TRAVEL: "旅行", TRANSPORTATION: "交通", ENTERTAINMENT: "娱乐",
    GENERAL_SERVICES: "服务", PERSONAL_CARE: "个人护理", MEDICAL: "医疗", RENT_AND_UTILITIES: "房租水电",
    HOME_IMPROVEMENT: "家居", LOAN_PAYMENTS: "还款", TRANSFER_IN: "转入", TRANSFER_OUT: "转出", BANK_FEES: "银行费用",
    INCOME: "收入", GOVERNMENT_AND_NON_PROFIT: "政府 / 公益",
  };
  const CONF = { VERY_HIGH: "非常高", HIGH: "高", MEDIUM: "中", LOW: "低", UNKNOWN: "未知" };
  const TYPE = { place: "实体消费", digital: "线上 / 数字", special: "特殊交易", unresolved: "未识别" };
  const pretty = (s) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  const dateZh = (d) => { const x = new Date(d + "T00:00:00"); return `${x.getFullYear()} 年 ${x.getMonth() + 1} 月 ${x.getDate()} 日 · 周${WEEK[x.getDay()]}`; };
  const timeZh = (iso) => { try { return new Date(iso).toLocaleString("zh-CN", { hour12: false }); } catch { return iso; } };

  let current = null, lastFocus = null;

  // ------------------------------------------------------------ 内容
  function row(label, value, opts = {}) {
    if (value == null || value === "") return "";
    return `<div class="d-row${opts.mono ? " mono" : ""}"><dt>${label}</dt><dd>${value}</dd></div>`;
  }
  function section(title, body, extra = "") {
    return body.trim() ? `<section class="d-sec ${extra}"><h4>${title}</h4><dl>${body}</dl></section>` : "";
  }

  function content(t) {
    const d = t.detail || {};
    const a = state.accounts[t.account_id];
    const ic = I.info(t);
    const e = state.earn.get(t.id);
    const ch = CHANNELS[t.channel];
    const title = t.merchant || t.name;
    const brand = B.url(t) || t.logo;
    const amt = txnAmt(t);   // 港币交易主显 HK$
    const loc = d.location || {};
    const addr = [loc.address, loc.city, loc.region, loc.postal_code, loc.country].filter(Boolean).join(", ");
    const mapQ = loc.lat != null && loc.lon != null ? `${loc.lat},${loc.lon}` : addr;
    const pfc = d.personal_finance_category || {};
    const pm = d.payment_meta || {};
    const prog = e && R.PROGRAMS[e.program];

    // 头部
    const head = `<header class="d-head" style="--c:${ic.color}">
        <div class="d-icon">${I.svg(ic.icon)}${brand ? `<img src="${esc(brand)}" alt="" referrerpolicy="strict-origin-when-cross-origin" onload="this.parentNode.classList.add('has-logo')" onerror="this.remove()">` : ""}</div>
        <div class="d-title">
          <h3 id="d-title">${esc(title)}</h3>
          <div class="d-tags">
            ${t.pending ? '<span class="ttag pending">待入账</span>' : '<span class="ttag posted">已入账</span>'}
            ${ch ? `<span class="ttag ${ch.cls}">${ch.icon}${ch.label}</span>` : ""}
            <span class="ttag cat" style="--tc:${ic.color}">${esc(ic.label)}</span>
          </div>
        </div>
        <div class="d-amt ${t.amount < 0 ? "in" : ""}">${amt}<small>${esc(t.orig_currency || t.currency || "USD")}</small>${t.orig_currency ? `<em class="d-orig">${esc(txnAmt(t, true))}</em>` : ""}</div>
      </header>`;

    // 积分 + 卡片横条
    const strip = `<div class="d-strip">
        <div class="d-card">${a ? RT_CARDS.face(a, "sm") : ""}<div><b>${esc(cardNameMask(a) || "未知账户")}</b><small>${esc(a?.institution || "")}</small></div></div>
        ${e && e.cat !== "none" && e.earned
          ? `<div class="d-earn" style="--brand:${prog.color}"><b>${e.earned > 0 ? "+" : ""}${esc(R.fmtEarned(e.earned, prog.unit))}${prog.unit === "cash" ? "" : " " + esc(prog.short)}</b><small>${esc(R.fmtRate(e.rate, prog.unit))} · ${esc(e.source)}</small></div>`
          : a && isManual(a) && isHSBC(a)
            ? `<div class="d-earn none"><b>不估算积分</b><small>汇丰卡 · 本站不估算</small></div>`
          : a && R.PRODUCTS[productOf(a)]?.noEarn
            ? `<div class="d-earn none"><b>不估算积分</b><small>香港卡 · 见 Amex HK Tracker</small></div>`
            : `<div class="d-earn none"><b>不计积分</b><small>${esc(e?.source || "非信用卡消费")}</small></div>`}
      </div>`;

    // 时间线：授权 → 入账
    const timeline = `<div class="d-timeline">
        <div class="step done"><i></i><span>授权</span><b>${esc(d.authorized_datetime ? timeZh(d.authorized_datetime) : t.authorized_date || t.date)}</b></div>
        <div class="bar ${t.pending ? "" : "done"}"></div>
        <div class="step ${t.pending ? "wait" : "done"}"><i></i><span>${t.pending ? "等待入账" : "已入账"}</span><b>${t.pending ? "银行处理中，金额可能还会变" : esc(d.datetime ? timeZh(d.datetime) : t.date)}</b></div>
      </div>`;

    const secTxn = section("交易", [
      row("日期", esc(dateZh(t.date))),
      row("授权日期", t.authorized_date && t.authorized_date !== t.date ? esc(dateZh(t.authorized_date)) : ""),
      row("状态", t.pending ? "待入账（Pending）" : "已入账（Posted）"),
      row("由待入账转来", d.pending_transaction_id ? `<code>${esc(d.pending_transaction_id)}</code>` : "", { mono: true }),
      row("交易类型", d.transaction_type ? `${esc(TYPE[d.transaction_type] || d.transaction_type)} <small>${esc(d.transaction_type)}</small>` : ""),
      row("交易代码", d.transaction_code ? esc(d.transaction_code) : ""),
      row("支票号", d.check_number ? esc(d.check_number) : ""),
      row("币种", t.orig_currency ? `${esc(t.orig_currency)} <small>按 1 USD = ${FX_PER_USD[t.orig_currency]} ${esc(t.orig_currency)} 换算成美元显示</small>` : esc(t.currency || "USD") + (d.unofficial_currency_code ? ` <small>非官方 ${esc(d.unofficial_currency_code)}</small>` : "")),
      row("持卡人", d.account_owner ? esc(d.account_owner) : ""),
    ].join(""));

    const secMerchant = section("商户", [
      row("商户名", t.merchant ? esc(t.merchant) : /_statement$/.test(t.source || "") ? "<small>结单不提供</small>" : "<small>Plaid 未识别</small>"),
      row("银行原始描述", esc(d.original_description || t.name)),
      row("外币原始金额", d.foreign ? `${esc(d.foreign.amount)} ${esc(d.foreign.currency)} <small>汇率 ${esc(d.foreign.rate)}</small>` : ""),
      row("优惠", d.offer ? esc(d.offer) : ""),
      row("所属结单", d.statement_date ? `${esc(dateZh(d.statement_date))} 出账` : ""),
      row("汇丰类别", d.hsbc_category ? esc(d.hsbc_category) : ""),
      row("Amex 参考号", d.reference ? `<code>${esc(d.reference)}</code>` : "", { mono: true }),
      row("网站", t.website ? `<a href="${esc(/^https?:/.test(t.website) ? t.website : "https://" + t.website)}" target="_blank" rel="noopener">${esc(t.website.replace(/^https?:\/\//, ""))} ↗</a>` : ""),
      row("地址", addr ? `${esc(addr)}${loc.store_number ? ` <small>门店 #${esc(loc.store_number)}</small>` : ""}<br><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQ)}" target="_blank" rel="noopener">在地图中查看 ↗</a>` : ""),
      row("Plaid 商户 ID", d.merchant_entity_id ? `<code>${esc(d.merchant_entity_id)}</code>` : "", { mono: true }),
    ].join(""));

    const secCat = section("分类", [
      row("MCC", t.mcc ? `<span class="mcc">${esc(t.mcc)}</span> ${esc(mccName(t.mcc) || "")}` : /_statement$/.test(t.source || "") ? "<small>香港结单不提供 MCC</small>" : "<small>银行没有提供（Plaid 的 MCC 仍是 beta 字段）</small>"),
      row("本站类别", `<span class="dot" style="background:${ic.color}"></span>${esc(ic.label)}`),
      row("Plaid 大类", pfc.primary ? `${esc(PFC_ZH[pfc.primary] || pretty(pfc.primary))} <small>${esc(pfc.primary)}</small>` : (t.category ? esc(t.category) : "")),
      row("Plaid 细类", pfc.detailed ? `${esc(pretty(pfc.detailed.replace(pfc.primary + "_", "")))} <small>${esc(pfc.detailed)}</small>` : ""),
      row("分类可信度", pfc.confidence_level ? `<span class="conf ${esc(pfc.confidence_level.toLowerCase())}">${esc(CONF[pfc.confidence_level] || pfc.confidence_level)}</span>` : ""),
    ].join(""));

    const pmRows = [
      ["付款方式", pm.payment_method], ["处理方", pm.payment_processor], ["收款人", pm.payee], ["付款人", pm.payer],
      ["代表", pm.by_order_of], ["参考号", pm.reference_number], ["PPD ID", pm.ppd_id], ["原因", pm.reason],
    ].map(([l, v]) => row(l, v ? esc(v) : "")).join("");
    const secPay = section("支付", row("渠道", ch ? `<span class="ttag ${ch.cls}">${ch.icon}${ch.label}</span> <small>${esc(ch.tip)}</small>` : "") + pmRows);

    const cps = d.counterparties || [];
    const secCp = cps.length ? `<section class="d-sec"><h4>交易对手</h4><div class="cps">${cps.map((c) => `
        <div class="cp">
          ${c.logo_url ? `<img src="${esc(c.logo_url)}" alt="" onerror="this.remove()">` : `<span class="cp-ph">${esc((c.name || "?")[0])}</span>`}
          <div><b>${esc(c.name || "—")}</b><small>${esc(pretty(c.type))}${c.confidence_level ? ` · 可信度 ${esc(CONF[c.confidence_level] || c.confidence_level)}` : ""}${c.website ? ` · ${esc(c.website)}` : ""}</small></div>
        </div>`).join("")}</div></section>` : "";

    const secEarn = e ? section("积分计算", [
      row("卡型", esc(R.PRODUCTS[e.product]?.name || "—")),
      row("积分计划", prog ? esc(prog.name) : ""),
      row("命中规则", esc(e.source)),
      row("倍数", e.cat === "none" ? "—" : esc(R.fmtRate(e.rate, prog.unit))),
      row("估算积分", e.cat === "none" ? "0" : esc(R.fmtEarned(e.earned, prog.unit)) + (prog.unit === "cash" ? "" : " 点")),
      row("记忆键", `<code>${esc(e.key)}</code> <small>在「更新」模式改倍数时按这个记住</small>`, { mono: true }),
    ].join("")) : "";

    const raw = JSON.stringify({ ...t }, null, 2);
    const secRaw = `<details class="d-raw"><summary>技术信息 · 原始数据</summary>
        <dl>${row("transaction_id", `<code>${esc(t.id)}</code>`, { mono: true })}${row("account_id", `<code>${esc(t.account_id)}</code>`, { mono: true })}</dl>
        <div class="raw-bar"><span>JSON</span><button class="btn small ghost" data-copy-raw>复制</button></div>
        <pre>${esc(raw)}</pre>
      </details>`;

    return head + strip + timeline + `<div class="d-grid">${secTxn}${secMerchant}${secCat}${secPay}</div>` + secCp + secEarn + secRaw;
  }

  // ------------------------------------------------------------ 打开 / 关闭
  function shell() {
    let el = document.getElementById("txn-detail");
    if (el) return el;
    el = document.createElement("div");
    el.id = "txn-detail";
    el.hidden = true;
    el.innerHTML = `<div class="d-backdrop" data-close></div>
      <div class="d-panel" role="dialog" aria-modal="true" aria-labelledby="d-title" tabindex="-1">
        <div class="d-grab" aria-hidden="true"><span></span></div>
        <div class="d-nav">
          <button class="d-btn" data-step="-1" aria-label="上一笔" title="上一笔（←）"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg></button>
          <button class="d-btn" data-step="1" aria-label="下一笔" title="下一笔（→）"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg></button>
          <span class="d-pos"></span>
          <button class="d-btn close" data-close aria-label="关闭" title="关闭（Esc）"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
        <div class="d-body"></div>
      </div>`;
    document.body.appendChild(el);

    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return close();
      const st = e.target.closest("[data-step]");
      if (st) return step(+st.dataset.step);
      if (e.target.closest("[data-copy-raw]")) {
        const pre = el.querySelector(".d-raw pre");
        navigator.clipboard?.writeText(pre.textContent).then(() => toast("已复制"), () => {});
      }
    });

    // 手机：按住顶部把手或内容顶部往下拖，超过 100px 或甩得快就关闭
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
      el.querySelector(".d-backdrop").style.opacity = String(Math.max(0, 1 - dy / 400));
    }, { passive: true });
    panel.addEventListener("touchend", () => {
      if (y0 == null) return;
      panel.style.transition = ""; el.querySelector(".d-backdrop").style.opacity = "";
      const fast = dy / Math.max(1, Date.now() - t0) > 0.6;
      if (dy > 100 || (fast && dy > 30)) close(); else panel.style.transform = "";
      y0 = null;
    });
    return el;
  }

  function listIds() { return [...document.querySelectorAll("#txn-list [data-txn]")].map((r) => r.dataset.txn); }

  function show(id) {
    const t = state.txns.find((x) => x.id === id);
    if (!t) return;
    current = id;
    const el = shell();
    el.querySelector(".d-body").innerHTML = content(t);
    el.querySelector(".d-body").scrollTop = 0;
    const ids = listIds(), i = ids.indexOf(id);
    el.querySelector(".d-pos").textContent = i >= 0 ? `${i + 1} / ${ids.length}` : "";
    el.querySelector('[data-step="-1"]').disabled = i <= 0;
    el.querySelector('[data-step="1"]').disabled = i < 0 || i >= ids.length - 1;
    document.querySelectorAll("#txn-list .txn.active").forEach((r) => r.classList.remove("active"));
    document.querySelector(`#txn-list [data-txn="${CSS.escape(id)}"]`)?.classList.add("active");
  }

  function open(id) {
    lastFocus = document.activeElement;
    const el = shell();
    show(id);
    el.hidden = false;
    document.documentElement.classList.add("d-lock");
    requestAnimationFrame(() => { el.classList.add("open"); el.querySelector(".d-panel").focus({ preventScroll: true }); });
  }

  function close() {
    const el = document.getElementById("txn-detail");
    if (!el || el.hidden) return;
    el.classList.remove("open");
    const panel = el.querySelector(".d-panel");
    panel.style.transform = "";
    document.documentElement.classList.remove("d-lock");
    document.querySelectorAll("#txn-list .txn.active").forEach((r) => r.classList.remove("active"));
    setTimeout(() => { el.hidden = true; lastFocus?.focus?.({ preventScroll: true }); }, 240);
    current = null;
  }

  function step(dir) {
    const ids = listIds(), i = ids.indexOf(current);
    const next = ids[i + dir];
    if (next) {
      show(next);
      document.querySelector(`#txn-list [data-txn="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // ------------------------------------------------------------ 绑定
  document.addEventListener("click", (e) => {
    const r = e.target.closest("#txn-list [data-txn]");
    if (!r || state.editing || e.target.closest("input, button, a, label")) return;
    open(r.dataset.txn);
  });
  document.addEventListener("keydown", (e) => {
    const el = document.getElementById("txn-detail");
    if (e.key === "Enter" && !state.editing) {
      const r = e.target.closest?.("#txn-list [data-txn]");
      if (r) { e.preventDefault(); open(r.dataset.txn); return; }
    }
    if (!el || el.hidden) return;
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  }, true);

  window.RT_DETAIL = { open, close };
})();
