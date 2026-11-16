// Reward Tracker — 「不计入分析」：编辑模式下给交易设忽略规则（充值电子钱包、Balance Transfer 这类不算消费）。
// 规则存在 rewards.ignore（随「保存」一起写到 Worker）：
//   ids:   { 交易 id: true }                                    —— 只忽略这一笔
//   names: [{ name, label, from, to }]  from/to 为 YYYY-MM-DD    —— 忽略这段时间里的同名交易
//          [{ name, label, from: null, to: null }]               —— 忽略所有同名交易
// 「同名」= 商户名（没有就用交易名）去掉首尾空格、合并空格、不分大小写后相同。
// 只影响「分析」页（含周报）的统计；交易列表照常显示并标「不计入分析」，积分计算不受影响。
// 用到 app.js 的全局：state、esc、fmt、txnAmt、cardName、render、toast、saveRewards。

(function () {
  const EN = () => window.RT_I18N?.lang === "en";
  const L = (zh, en) => (EN() ? en : zh);
  const empty = () => ({ ids: {}, names: [] });
  const nameKey = (t) => String(t.merchant || t.name || "").trim().replace(/\s+/g, " ").toLowerCase();
  const label = (t) => String(t.merchant || t.name || "").trim();
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  const md = (s) => (EN() ? new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : `${+s.slice(0, 4)}/${+s.slice(5, 7)}/${+s.slice(8)}`);

  const saved = () => state.rewards.ignore || empty();
  // 编辑模式下用草稿，否则用已保存的
  const current = () => (state.editing && state.draft?.ignore) || saved();

  // 命中的规则：{ kind: "txn" } / { kind: "range", rule } / { kind: "all", rule } / null
  function match(t, ig = saved()) {
    if (!t) return null;
    if (ig.ids?.[t.id]) return { kind: "txn" };
    const k = nameKey(t);
    if (!k) return null;
    for (const r of ig.names || []) {
      if (r.name !== k) continue;
      if (!r.from && !r.to) return { kind: "all", rule: r };
      if ((!r.from || t.date >= r.from) && (!r.to || t.date <= r.to)) return { kind: "range", rule: r };
    }
    return null;
  }
  const isIgnored = (t) => !!match(t);
  const why = (m) => !m ? "" : m.kind === "txn" ? L("只忽略这一笔", "This transaction only")
    : m.kind === "all" ? L(`忽略所有「${m.rule.label}」`, `All “${m.rule.label}”`)
    : L(`忽略 ${md(m.rule.from)} 至 ${md(m.rule.to)} 的「${m.rule.label}」`, `“${m.rule.label}” from ${md(m.rule.from)} to ${md(m.rule.to)}`);

  // ------------------------------------------------------------ 交易行上的标记 / 编辑按钮
  function tag(t) {
    const m = match(t, current());
    if (!m) return "";
    return `<span class="ttag ignored" title="${esc(why(m))}" data-i18n-skip>${L("不计入分析", "Not in analytics")}</span>`;
  }
  const EYE_OFF = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3 4.1M6.6 6.6A13 13 0 0 0 2 12c1 2.5 5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;
  const EYE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;
  function cell(t) {
    if (!state.editing) return "";
    const on = !!match(t, current());
    return `<button type="button" class="ign-btn${on ? " on" : ""}" data-ign="${esc(t.id)}" data-i18n-skip title="${esc(on ? why(match(t, current())) : L("设置这笔是否计入分析", "Include in analytics?"))}">${on ? EYE_OFF : EYE}<span>${on ? L("不计入", "Excluded") : L("计入分析", "Included")}</span></button>`;
  }

  // ------------------------------------------------------------ 弹出的设置面板
  const pop = { id: null, mode: "keep", from: "", to: "" };
  function popEl() {
    let el = document.getElementById("ign-pop");
    if (el) return el;
    el = document.createElement("div");
    el.id = "ign-pop";
    el.hidden = true;
    el.setAttribute("data-i18n-skip", "");
    el.setAttribute("role", "dialog");
    document.body.appendChild(el);
    el.addEventListener("click", onPopClick);
    el.addEventListener("change", onPopInput);
    el.addEventListener("input", onPopInput);
    return el;
  }
  const sameName = (t) => { const k = nameKey(t); return k ? state.txns.filter((x) => nameKey(x) === k) : [t]; };
  const inRange = (list, from, to) => list.filter((x) => x.date >= from && x.date <= to);
  function rangeError() {
    if (pop.mode !== "range") return "";
    if (!isDate(pop.from) || !isDate(pop.to)) return L("请填开始和结束日期", "Enter both dates");
    if (pop.from > pop.to) return L("开始日期不能晚于结束日期", "Start date must be on or before the end date");
    return "";
  }

  function paintPop() {
    const el = popEl(), t = state.txns.find((x) => x.id === pop.id);
    if (!t) return closePop();
    const same = sameName(t), a = state.accounts[t.account_id];
    const err = rangeError();
    const nRange = pop.mode === "range" && !err ? inRange(same, pop.from, pop.to).length : null;
    const cur = match(t, current());
    // 恢复计入时，如果是同名规则命中的，会连带恢复其它同名交易
    const restoreNote = pop.mode === "keep" && cur && cur.kind !== "txn"
      ? `<p class="ign-note">${L(`这笔是被「${why(cur)}」这条规则忽略的；恢复计入会删掉这条规则。`, `This is excluded by “${why(cur)}”; including it removes that rule.`)}</p>` : "";
    const opt = (v, title, sub, extra = "") => `
      <label class="ign-opt${pop.mode === v ? " on" : ""}">
        <input type="radio" name="ign-mode" value="${v}" ${pop.mode === v ? "checked" : ""}>
        <span class="ign-radio" aria-hidden="true"></span>
        <span class="ign-txt"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}${extra}</span>
      </label>`;
    el.innerHTML = `
      <div class="ign-head">
        <span class="ign-kicker">${L("计入分析", "Analytics")}</span>
        <b class="ign-name">${esc(label(t))}</b>
        <small>${esc(md(t.date))} · ${txnAmt(t)}${a ? ` · <span class="ign-card">${esc(cardName(a))}</span>` : ""}</small>
      </div>
      <div class="ign-opts">
        ${opt("keep", L("计入分析", "Include"), L("默认", "Default"))}
        ${opt("txn", L("只忽略这一笔", "Exclude this transaction only"), "")}
        ${opt("range", L("忽略这段时间的同名交易", "Exclude same-name transactions in a date range"),
          nRange != null ? L(`这段时间共 ${nRange} 笔`, `${nRange} in this range`) : "",
          `<span class="ign-dates"><input type="date" data-ign-from value="${esc(pop.from)}" aria-label="${L("开始", "Start")}"><i>${L("至", "to")}</i><input type="date" data-ign-to value="${esc(pop.to)}" aria-label="${L("结束", "End")}"></span>${err ? `<span class="ign-err">${err}</span>` : ""}`)}
        ${opt("all", L("忽略所有同名交易", "Exclude all same-name transactions"), L(`共 ${same.length} 笔「${label(t)}」，以后新来的同名交易也会忽略`, `${same.length} “${label(t)}” so far; future ones too`))}
      </div>
      ${restoreNote}
      <div class="ign-actions">
        <button type="button" class="btn ghost small" data-ign-cancel>${L("取消", "Cancel")}</button>
        <button type="button" class="btn primary small" data-ign-apply ${err ? "disabled" : ""}>${L("应用", "Apply")}</button>
      </div>
      <p class="ign-foot">${L("点编辑栏的「保存」后生效，只影响「分析」页和周报", "Takes effect when you save; only affects Analytics and the weekly report")}</p>`;
  }

  function place(anchor) {
    const el = popEl();
    if (innerWidth <= 640) { el.classList.add("sheet"); el.style.left = el.style.top = ""; return; }
    el.classList.remove("sheet");
    const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    let left = Math.min(Math.max(12, r.right - w), innerWidth - w - 12);
    let top = r.bottom + 8;
    if (top + h > innerHeight - 12) top = Math.max(12, r.top - h - 8);
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  }

  function openPop(id, anchor) {
    const t = state.txns.find((x) => x.id === id);
    if (!t) return;
    const m = match(t, current());
    pop.id = id;
    pop.mode = !m ? "keep" : m.kind;
    pop.from = m?.kind === "range" ? m.rule.from : t.date;
    pop.to = m?.kind === "range" ? m.rule.to : t.date;
    const el = popEl();
    paintPop();
    el.hidden = false;
    place(anchor);
    requestAnimationFrame(() => el.classList.add("open"));
    pop.anchor = anchor;
  }
  function closePop() {
    const el = document.getElementById("ign-pop");
    if (!el || el.hidden) return;
    el.classList.remove("open");
    setTimeout(() => { if (!el.classList.contains("open")) el.hidden = true; }, 180);
    pop.id = null;
  }

  function onPopInput(e) {
    if (e.target.name === "ign-mode") { pop.mode = e.target.value; return paintPop(); }
    if (e.target.matches("[data-ign-from]")) { pop.from = e.target.value; pop.mode = "range"; }
    if (e.target.matches("[data-ign-to]")) { pop.to = e.target.value; pop.mode = "range"; }
    if (e.type === "change") paintPop();
    else {
      // 输入过程中只更新错误提示和按钮，避免重画打断日期输入
      const err = rangeError(), el = popEl();
      el.querySelector("[data-ign-apply]").disabled = !!err;
    }
  }
  function onPopClick(e) {
    if (e.target.closest("[data-ign-cancel]")) return closePop();
    if (e.target.closest("[data-ign-apply]")) return apply();
  }

  // 把选择写进草稿：先去掉这笔交易身上已有的规则，再按新选项加
  function apply() {
    if (rangeError()) return;
    const t = state.txns.find((x) => x.id === pop.id);
    if (!t || !state.draft) return closePop();
    const ig = state.draft.ignore;
    const k = nameKey(t);
    delete ig.ids[t.id];
    ig.names = ig.names.filter((r) => !(r.name === k && (!r.from || t.date >= r.from) && (!r.to || t.date <= r.to)));
    if (pop.mode === "txn") ig.ids[t.id] = true;
    if (pop.mode === "range") ig.names.push({ name: k, label: label(t), from: pop.from, to: pop.to });
    if (pop.mode === "all") { ig.names = ig.names.filter((r) => r.name !== k); ig.names.push({ name: k, label: label(t), from: null, to: null }); }
    closePop();
    render();
  }

  // ------------------------------------------------------------ 设置面板里的规则列表
  function settingsList() {
    const ig = saved();
    const ids = Object.keys(ig.ids || {});
    const rows = [
      ...(ig.names || []).map((r, i) => {
        const n = state.txns.filter((x) => match(x, { ids: {}, names: [r] })).length;
        return `<div class="rule-row ign-rule"><span><b class="ign-rname">${esc(r.label)}</b> · ${!r.from && !r.to ? L("所有同名交易", "all same-name") : `${esc(md(r.from))} – ${esc(md(r.to))}`}</span><small>${n} ${L("笔", "txns")}</small><button class="btn small ghost" data-unignore-name="${i}">${L("删除", "Delete")}</button></div>`;
      }),
      ...ids.map((id) => {
        const t = state.txns.find((x) => x.id === id);
        return `<div class="rule-row ign-rule"><span><b class="ign-rname">${esc(t ? label(t) : L("已不存在的交易", "Missing transaction"))}</b>${t ? ` · ${esc(md(t.date))}` : ""}</span><small>${t ? txnAmt(t) : ""}</small><button class="btn small ghost" data-unignore-id="${esc(id)}">${L("删除", "Delete")}</button></div>`;
      }),
    ];
    return rows.length ? rows.join("") : `<p class="hint">${L("还没有。点「更新」后，每笔交易右边可以设置不计入分析（比如电子钱包充值、Balance Transfer）。",
      "None yet. After tapping “Update”, each transaction gets an option to exclude it from analytics (e.g. e-wallet top-ups, balance transfers).")}</p>`;
  }
  async function removeRule(kind, key) {
    const next = JSON.parse(JSON.stringify(state.rewards));
    next.ignore = next.ignore || empty();
    if (kind === "name") next.ignore.names.splice(+key, 1); else delete next.ignore.ids[key];
    await saveRewards(next, L("已删除，这些交易重新计入分析", "Removed — those transactions count again"));
  }

  // ------------------------------------------------------------ 绑定
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-ign]");
    if (b) { e.preventDefault(); e.stopPropagation(); return pop.id === b.dataset.ign ? closePop() : openPop(b.dataset.ign, b); }
    const un = e.target.closest?.("[data-unignore-name], [data-unignore-id]");
    if (un) { e.stopPropagation(); return un.dataset.unignoreName != null ? removeRule("name", un.dataset.unignoreName) : removeRule("id", un.dataset.unignoreId); }
    if (pop.id && !e.target.closest?.("#ign-pop")) closePop();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop.id) { e.stopPropagation(); closePop(); } }, true);
  window.addEventListener("resize", () => { if (pop.id && pop.anchor?.isConnected) place(pop.anchor); });
  // 页面滚动时面板跟着按钮走（手机上是底部抽屉，不用跟）
  document.addEventListener("scroll", () => { if (pop.id && pop.anchor?.isConnected) place(pop.anchor); }, { capture: true, passive: true });

  window.RT_IGNORE = { match, isIgnored, tag, cell, settingsList, empty, why };
})();
