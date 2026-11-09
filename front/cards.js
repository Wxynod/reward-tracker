// Reward Tracker — 信用卡卡面。
// Plaid 不提供卡面图片，所以这里有两种来源：
//   ① 本站自己设计的卡面样式（每种卡给几款配色，用户可以选）；
//   ② 用户上传自己卡片的照片：浏览器里自动转成横版、裁成标准卡片比例、压缩后存进 Worker。
// 另外提供带卡面缩略图的下拉选择器，替换所有「选一张卡」的 <select data-cardselect>。
// 用到 app.js 的全局：state、R、esc、api、toast、productOf、cardName、saveRewards、render。

(function () {
  // ------------------------------------------------------------ 样式库（原创配色，不复刻任何官方卡面）
  // bg：卡底；fg：文字；pat：纹理层；chip：芯片颜色
  const LIB = {
    midnight: { name: "午夜", fg: "#e9edf4", bg: "linear-gradient(135deg,#27334a 0%,#121a29 55%,#0a0f18 100%)", pat: "repeating-linear-gradient(115deg,rgba(255,255,255,.035) 0 1px,transparent 1px 7px)" },
    slate:    { name: "石板", fg: "#eef0f3", bg: "linear-gradient(140deg,#4a5260 0%,#2a3039 60%,#1b1f26 100%)", pat: "radial-gradient(120% 90% at 85% 0%,rgba(255,255,255,.14),transparent 55%)" },
    ink:      { name: "墨蓝", fg: "#eaf1ff", bg: "linear-gradient(135deg,#1d4f9c 0%,#11336d 50%,#0a1f45 100%)", pat: "radial-gradient(90% 120% at 0% 100%,rgba(120,180,255,.22),transparent 60%)" },
    sky:      { name: "晴空", fg: "#ffffff", bg: "linear-gradient(135deg,#4aa3f0 0%,#1f72d1 55%,#1452a8 100%)", pat: "repeating-radial-gradient(circle at 110% -10%,rgba(255,255,255,.09) 0 2px,transparent 2px 14px)" },
    azure:    { name: "湖蓝", fg: "#ffffff", bg: "linear-gradient(160deg,#21b6d6 0%,#1a7fc2 60%,#1d5aa6 100%)", pat: "linear-gradient(115deg,transparent 40%,rgba(255,255,255,.14) 50%,transparent 60%)" },
    navy:     { name: "藏青", fg: "#e6ecf6", bg: "linear-gradient(135deg,#0f2f57 0%,#0a2240 60%,#06162b 100%)", pat: "repeating-linear-gradient(0deg,rgba(255,255,255,.03) 0 1px,transparent 1px 5px)" },
    graphite: { name: "石墨", fg: "#f2f2f2", bg: "linear-gradient(135deg,#3b3b3e 0%,#232325 55%,#141415 100%)", pat: "repeating-linear-gradient(90deg,rgba(255,255,255,.025) 0 1px,transparent 1px 3px)" },
    teal:     { name: "青碧", fg: "#effbf8", bg: "linear-gradient(135deg,#1aa39a 0%,#0f7c80 55%,#0a585f 100%)", pat: "radial-gradient(80% 100% at 100% 0%,rgba(255,255,255,.18),transparent 60%)" },
    mint:     { name: "薄荷", fg: "#0f3b33", bg: "linear-gradient(135deg,#c9f0e1 0%,#8fd9c0 55%,#5fbfa1 100%)", pat: "repeating-linear-gradient(135deg,rgba(255,255,255,.18) 0 2px,transparent 2px 10px)" },
    sunset:   { name: "晚霞", fg: "#ffffff", bg: "linear-gradient(135deg,#f4a25b 0%,#e2615a 50%,#9c3f72 100%)", pat: "radial-gradient(90% 90% at 10% 10%,rgba(255,255,255,.2),transparent 55%)" },
    platinum: { name: "铂银", fg: "#2b2f35", bg: "linear-gradient(135deg,#eef0f3 0%,#c9ced5 45%,#a7aeb7 100%)", pat: "repeating-linear-gradient(90deg,rgba(255,255,255,.35) 0 1px,transparent 1px 2px)" },
    brushed:  { name: "拉丝", fg: "#1f2328", bg: "linear-gradient(180deg,#d6dade 0%,#b7bdc4 50%,#d2d6da 100%)", pat: "repeating-linear-gradient(0deg,rgba(0,0,0,.035) 0 1px,transparent 1px 2px)" },
    gold:     { name: "金", fg: "#3a2a0e", bg: "linear-gradient(135deg,#f2d79a 0%,#d6aa5a 45%,#a9792e 100%)", pat: "linear-gradient(115deg,transparent 35%,rgba(255,255,255,.35) 48%,transparent 60%)" },
    rosegold: { name: "玫瑰金", fg: "#4a2620", bg: "linear-gradient(135deg,#f6d3c4 0%,#e1a48e 50%,#b97461 100%)", pat: "linear-gradient(115deg,transparent 35%,rgba(255,255,255,.3) 48%,transparent 60%)" },
    forest:   { name: "森林", fg: "#eef7ef", bg: "linear-gradient(135deg,#4f9a63 0%,#2d6c45 55%,#1b4a2f 100%)", pat: "repeating-linear-gradient(60deg,rgba(255,255,255,.04) 0 1px,transparent 1px 8px)" },
    sage:     { name: "鼠尾草", fg: "#21362a", bg: "linear-gradient(135deg,#d9e6d3 0%,#aec7a4 55%,#88a97d 100%)", pat: "radial-gradient(90% 90% at 100% 100%,rgba(255,255,255,.25),transparent 60%)" },
    onyx:     { name: "黑曜", fg: "#f1e2cf", bg: "linear-gradient(135deg,#2c2a2b 0%,#161415 60%,#0b0a0a 100%)", pat: "linear-gradient(115deg,transparent 30%,rgba(214,160,110,.18) 48%,transparent 62%)" },
    burgundy: { name: "酒红", fg: "#fbeae6", bg: "linear-gradient(135deg,#8e2f3c 0%,#621f2a 55%,#3d1219 100%)", pat: "radial-gradient(90% 100% at 0% 0%,rgba(255,255,255,.15),transparent 55%)" },
    galaxy:   { name: "星河", fg: "#eef0ff", bg: "linear-gradient(135deg,#2a2c5c 0%,#1b1c3d 50%,#0d0e22 100%)", pat: "radial-gradient(1px 1px at 20% 30%,#fff,transparent),radial-gradient(1px 1px at 70% 60%,#fff,transparent),radial-gradient(1.5px 1.5px at 40% 80%,#cfd6ff,transparent),radial-gradient(1px 1px at 85% 20%,#fff,transparent),radial-gradient(100% 80% at 80% 100%,rgba(140,110,255,.35),transparent 60%)" },
    pearl:    { name: "珍珠白", fg: "#2b2b2b", bg: "linear-gradient(135deg,#ffffff 0%,#f1f0ec 55%,#e2e1dc 100%)", pat: "radial-gradient(120% 90% at 0% 0%,rgba(255,255,255,.9),transparent 50%)" },
    titanium: { name: "钛", fg: "#2d2d2d", bg: "linear-gradient(135deg,#f3f3f0 0%,#dadad5 55%,#c4c4bf 100%)", pat: "repeating-linear-gradient(90deg,rgba(0,0,0,.02) 0 1px,transparent 1px 3px)" },
    coral:    { name: "珊瑚", fg: "#ffffff", bg: "linear-gradient(135deg,#ff8a7a 0%,#ef5d6c 55%,#c63f62 100%)", pat: "repeating-radial-gradient(circle at -10% 110%,rgba(255,255,255,.1) 0 2px,transparent 2px 16px)" },
  };
  // 每种卡推荐的几款（第一款为默认）；其余样式也都可以选
  const PRODUCT_STYLES = {
    csr: ["midnight", "slate", "graphite"], csp: ["ink", "navy", "midnight"], cfu: ["sky", "azure", "ink"], cff: ["azure", "sky", "ink"],
    chase_other: ["sky", "slate"],
    strata_elite: ["onyx", "navy", "graphite"], strata_premier: ["navy", "ink", "slate"], strata: ["ink", "sky"],
    double_cash: ["teal", "mint", "slate"], custom_cash: ["teal", "sunset", "azure"], citi_other: ["navy", "teal"],
    amex_plat: ["platinum", "brushed", "graphite"], amex_hk_plat: ["platinum", "brushed", "graphite"], amex_hk_explorer: ["sky", "ink", "navy"], amex_gold: ["gold", "rosegold", "onyx"], amex_green: ["forest", "sage", "graphite"],
    amex_bbp: ["ink", "sky"], amex_everyday: ["pearl", "sky"], amex_bce: ["sky", "azure"], amex_bcp: ["ink", "navy"], amex_other: ["slate", "ink"],
    bonvoy_brilliant: ["onyx", "burgundy", "graphite"],
    samsung_galaxy: ["galaxy", "graphite", "midnight"], barclays_view: ["azure", "sky", "slate"],
    aarp_travel: ["coral", "sunset"], aarp_essential: ["coral", "pearl"], barclays_other: ["azure", "slate"],
    apple_card: ["titanium", "pearl", "graphite"],
  };
  // 你自己的卡面图库（图片存在 Worker KV，登录后加载；文件名 → 卡种 / 名称）。第一项为默认
  const ART = {
    csr: [["chase_sapphire_reserve_new", "Sapphire Reserve · 新款"], ["chase_sapphire_reserve_old", "Sapphire Reserve · 旧款"]],
    csp: [["chase_sapphire_preferred_new", "Sapphire Preferred · 新款"], ["chase_sapphire_preferred_old", "Sapphire Preferred · 旧款"]],
    cff: [["chase_freedom_flex_new", "Freedom Flex · 新款"], ["chase_freedom_flex_old", "Freedom · 旧款"]],
    strata_premier: [["citi_strata_premier", "Strata Premier"]],
    amex_green: [["amex_green", "Green Card"]],
    amex_hk_plat: [["amex_platinum_original", "Platinum · 经典"], ["amex_platinum_julie_mehretu", "Platinum · Julie Mehretu"], ["amex_platinum_kehinde_wiley", "Platinum · Kehinde Wiley"]],
    amex_hk_explorer: [["amex_explorer", "Explorer"]],
    bonvoy_brilliant: [["amex_marriott_bonvoy_brilliant", "Bonvoy Brilliant"]],
    apple_card: [["apple_card", "Apple Card"]],
    samsung_galaxy: [["samsung_galaxy_card_rounded", "Samsung Galaxy · 圆角"], ["samsung_galaxy_card", "Samsung Galaxy Card"]],
    "debit:Chase": [["chase_debit_1", "Star Wars · 黑武士"], ["chase_debit_2", "Star Wars · BB-8"], ["chase_debit_3", "Disney · 城堡"]],
    "debit:Schwab": [["schwab_bank_debit", "Schwab Bank 借记卡"], ["schwab_one_brokerage", "Schwab One Brokerage 借记卡"]],
    "brokerage:Schwab": [["schwab_one_brokerage", "Schwab One Brokerage 借记卡"], ["schwab_bank_debit", "Schwab Bank 借记卡"]],
  };
  let lib = {};          // 图库：名字 → dataURL
  const artKey = (a) => {
    if (a.type === "credit") return productKey(a);
    const inst = String(a.institution || "").toLowerCase();
    if (inst.includes("schwab")) return a.type === "investment" || a.type === "brokerage" ? "brokerage:Schwab" : "debit:Schwab";
    if (inst.includes("chase")) return "debit:Chase";
    return null;
  };
  const artFor = (a) => (ART[artKey(a)] || []).filter(([n]) => lib[n]);
  const allArt = () => Object.values(ART).flat().filter(([n]) => lib[n]);

  const ISSUER_SHORT = { Chase: "CHASE", Citi: "citi", "American Express": "AMEX", Barclays: "BARCLAYS", Apple: "", Marriott: "" };

  let images = {};       // account_id → 上传的卡面 dataURL
  let imagesLoaded = false;

  const productKey = (a) => (a && typeof productOf === "function" ? productOf(state.accounts[a.id] || a) : null);
  function stylesFor(a) {
    const pk = productKey(a);
    const rec = PRODUCT_STYLES[pk] || ["slate", "ink", "graphite"];
    return [...rec, ...Object.keys(LIB).filter((k) => !rec.includes(k))];
  }
  function choice(a) {
    const c = state.rewards.cardface?.[a.id];
    if (c === "upload" && images[a.id]) return "upload";
    if (c?.startsWith("art:") && lib[c.slice(4)]) return c;
    if (c && LIB[c]) return c;
    const art = artFor(a);
    if (art.length) return `art:${art[0][0]}`;   // 图库里有这张卡就默认用真实卡面
    return stylesFor(a)[0];
  }

  // ------------------------------------------------------------ 卡面 HTML
  // size: xs（下拉里的小图，约 36px 宽）/ sm（账户列表，约 92px）/ md（选择面板，约 220px）
  function face(a, size = "sm", styleId = null) {
    if (!a) return `<span class="cc cc-${size} cc-all"><i></i><i></i><i></i></span>`;
    const full = state.accounts[a.id] || a;
    const sid = styleId || choice(full);
    if (sid === "upload" && images[full.id]) {
      return `<span class="cc cc-${size} cc-photo" style="background-image:url('${images[full.id]}')" role="img" aria-label="${esc(cardName(full))} 卡面"></span>`;
    }
    if (sid?.startsWith("art:") && lib[sid.slice(4)]) {
      return `<span class="cc cc-${size} cc-photo" style="background-image:url('${lib[sid.slice(4)]}')" role="img" aria-label="${esc(cardName(full))} 卡面"></span>`;
    }
    const st = LIB[sid] || LIB.slate;
    const pk = productKey(full);
    const issuer = R.PRODUCTS[pk]?.issuer || full.institution || "";
    const short = ISSUER_SHORT[issuer] ?? issuer;
    return `<span class="cc cc-${size}" style="--fg:${st.fg};background:${st.pat},${st.bg}" role="img" aria-label="${esc(cardName(full))} 卡面">
      <span class="cc-sheen"></span>
      <span class="cc-issuer">${esc(short)}</span>
      <span class="cc-name">${esc(cardName(full))}</span>
      <span class="cc-chip"></span>
      <span class="cc-wave"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8.5 8.5a5 5 0 0 1 0 7M12 6a8.5 8.5 0 0 1 0 12M15.5 3.5a12 12 0 0 1 0 17"/></svg></span>
      <span class="cc-mask">•••• ${esc(full.mask || "")}</span>
    </span>`;
  }

  // ------------------------------------------------------------ 加载上传的卡面
  async function loadImages() {
    const [u, l] = await Promise.allSettled([api("/api/cardimgs"), api("/api/cardlib")]);
    if (u.status === "fulfilled") images = u.value.images || {};
    if (l.status === "fulfilled") lib = l.value.images || {};
    imagesLoaded = true;
    render();
  }

  // ------------------------------------------------------------ 照片处理：转横版 + 裁成 85.6×54 比例 + 压缩
  function processPhoto(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const W = 856, H = 540;                       // 85.6 × 54 mm 的标准卡片比例
        const c = document.createElement("canvas"); c.width = W; c.height = H;
        const g = c.getContext("2d");
        const portrait = h > w;
        // 竖版卡逆时针转 90°（卡片顶部朝左，芯片通常落在左边），旋转后可画区域是 H 宽 × W 高
        if (portrait) { g.translate(0, H); g.rotate(-Math.PI / 2); }
        const tw = portrait ? H : W, th = portrait ? W : H;
        const scale = Math.max(tw / w, th / h);      // cover：铺满后居中裁掉多余部分
        const dw = w * scale, dh = h * scale;
        g.drawImage(img, (tw - dw) / 2, (th - dh) / 2, dw, dh);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("读不了这张图片"));
      img.src = URL.createObjectURL(file);
    });
  }

  // ------------------------------------------------------------ 选择卡面的面板
  function openPicker(acctId) {
    const a = state.accounts[acctId];
    if (!a) return;
    let el = document.getElementById("face-picker");
    if (!el) {
      el = document.createElement("div");
      el.id = "face-picker";
      document.body.appendChild(el);
      el.addEventListener("click", onPickerClick);
      el.addEventListener("change", onPickerFile);
    }
    el.dataset.acct = acctId;
    renderPicker();
    el.hidden = false;
    document.documentElement.classList.add("d-lock");
    requestAnimationFrame(() => el.classList.add("open"));
  }
  function closePicker() {
    const el = document.getElementById("face-picker");
    if (!el) return;
    el.classList.remove("open");
    document.documentElement.classList.remove("d-lock");
    setTimeout(() => { el.hidden = true; }, 220);
  }
  // 卡面选项（上传照片 / 官方卡面 / 本站设计），选卡面面板和账户详情共用
  function chooserHTML(a) {
    const cur = choice(a);
    const list = stylesFor(a);
    const rec = (PRODUCT_STYLES[productKey(a)] || []).length || 3;
    const tile = (sid, label, extra = "") => `<button class="fp-tile ${sid === cur ? "on" : ""}" data-face="${sid}">${face(a, "md", sid)}<span>${label}${extra}</span></button>`;
    return `
    <h4>你的卡片照片</h4>
    <div class="fp-grid">
      ${images[a.id] ? tile("upload", "我上传的照片", ' <em data-fp-del title="删除照片">删除</em>') : ""}
      <label class="fp-upload">
        <input type="file" accept="image/*" hidden>
        <span class="fp-plus">＋</span>
        <span>${images[a.id] ? "换一张照片" : "上传卡面照片"}<small>竖版会自动转成横版</small></span>
      </label>
    </div>
    ${artFor(a).length ? `<h4>官方卡面</h4><div class="fp-grid">${artFor(a).map(([n, label]) => tile(`art:${n}`, label)).join("")}</div>` : ""}
    ${allArt().length > artFor(a).length ? `<details class="fp-more"><summary>图库里的其他卡面（${allArt().length - artFor(a).length}）</summary><div class="fp-grid">${allArt().filter(([n]) => !artFor(a).some(([m]) => m === n)).map(([n, label]) => tile(`art:${n}`, label)).join("")}</div></details>` : ""}
    <h4>本站设计 · 推荐</h4>
    <div class="fp-grid">${list.slice(0, rec).map((s) => tile(s, LIB[s].name)).join("")}</div>
    <h4>本站设计 · 更多</h4>
    <div class="fp-grid">${list.slice(rec).map((s) => tile(s, LIB[s].name)).join("")}</div>
`;
  }

  function renderPicker() {
    const el = document.getElementById("face-picker");
    const a = state.accounts[el.dataset.acct];
    const cur = choice(a);
    const list = stylesFor(a);
    const rec = (PRODUCT_STYLES[productKey(a)] || []).length || 3;
    const tile = (sid, label, extra = "") => `<button class="fp-tile ${sid === cur ? "on" : ""}" data-face="${sid}">${face(a, "md", sid)}<span>${label}${extra}</span></button>`;
    el.innerHTML = `<div class="d-backdrop" data-fp-close></div>
      <div class="fp-panel" role="dialog" aria-modal="true" aria-label="选择卡面">
        <div class="d-grab" aria-hidden="true"><span></span></div>
        <header class="fp-head">
          <div><h3>选择卡面</h3><p>${esc(cardName(a))}${a.mask ? " ··" + esc(a.mask) : ""} · ${esc(a.institution)}</p></div>
          <button class="d-btn close" data-fp-close aria-label="关闭"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </header>
        <div class="fp-preview">${face(a, "lg")}</div>
        <div class="fp-body">
          ${chooserHTML(a)}
        </div>
      </div>`;
  }
  async function setFace(acctId, sid) {
    const next = JSON.parse(JSON.stringify(state.rewards));
    next.cardface = next.cardface || {};
    next.cardface[acctId] = sid;
    await saveRewards(next, "卡面已更新");
    notify();
  }
  const listeners = new Set();
  function notify() {
    const fp = document.getElementById("face-picker");
    if (fp && !fp.hidden) renderPicker();
    listeners.forEach((fn) => fn());
  }
  async function onPickerClick(e) {
    const el = document.getElementById("face-picker");
    if (e.target.closest("[data-fp-close]")) return closePicker();
    return handleChooserClick(e, el.dataset.acct);
  }
  // 卡面选项的点击 / 上传（任何容器里都能用）
  async function handleChooserClick(e, id) {
    if (e.target.closest("[data-fp-del]")) {
      e.preventDefault(); e.stopPropagation();
      try {
        await api("/api/cardimg", { method: "PUT", body: { account_id: id, data: null } });
        delete images[id];
        if (state.rewards.cardface?.[id] === "upload") await setFace(id, stylesFor(state.accounts[id])[0]);
        else { render(); notify(); }
        toast("已删除照片");
      } catch (err) { toast(err.message); }
      return;
    }
    const t = e.target.closest("[data-face]");
    if (t) setFace(id, t.dataset.face);
  }
  function onPickerFile(e) { return handleChooserFile(e, document.getElementById("face-picker").dataset.acct); }
  async function handleChooserFile(e, id) {
    const input = e.target;
    if (input.type !== "file" || !input.files[0]) return;
    try {
      toast("正在处理照片…");
      const data = await processPhoto(input.files[0]);
      await api("/api/cardimg", { method: "PUT", body: { account_id: id, data } });
      images[id] = data;
      await setFace(id, "upload");
    } catch (err) { toast(err.message); }
  }

  // ------------------------------------------------------------ 带卡面的下拉选择器
  // 把 <select data-cardselect>（选项 value 为账户 id，空值为「全部」）换成自绘的按钮 + 菜单；原 select 保留，值和事件照常
  function enhanceAll(root = document) {
    root.querySelectorAll("select[data-cardselect]").forEach(enhance);
  }
  function optionFace(v, size) { return v ? face(state.accounts[v] || { id: v }, size) : face(null, size); }
  function enhance(sel) {
    let wrap = sel.nextElementSibling?.classList?.contains("csel") ? sel.nextElementSibling : null;
    if (!wrap) {
      wrap = document.createElement("span");
      wrap.className = "csel";
      sel.after(wrap);
      sel.classList.add("csel-native");
      wrap.addEventListener("click", (e) => {
        const opt = e.target.closest("[data-v]");
        if (opt) {
          sel.value = opt.dataset.v;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          wrap.classList.remove("open"); paint(sel, wrap); return;
        }
        if (e.target.closest(".csel-btn")) {
          document.querySelectorAll(".csel.open").forEach((w) => w !== wrap && w.classList.remove("open"));
          wrap.classList.toggle("open");
        }
      });
    }
    paint(sel, wrap);
  }
  function paint(sel, wrap) {
    const opts = [...sel.options];
    const cur = sel.selectedOptions[0] || opts[0];
    const label = (o) => {
      const a = state.accounts[o.value];
      return a ? `<b>${esc(cardName(a))}${a.mask ? ` <small>··${esc(a.mask)}</small>` : ""}</b><small>${esc(a.institution)}</small>` : `<b>${esc(o.textContent)}</b>`;
    };
    wrap.innerHTML = `<button type="button" class="csel-btn">${optionFace(cur?.value, "xs")}<span class="csel-label">${cur ? label(cur) : ""}</span><svg class="caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></button>
      <div class="csel-menu" role="listbox">${opts.map((o) => `<div class="csel-opt ${o.value === sel.value ? "on" : ""}" role="option" data-v="${esc(o.value)}">${optionFace(o.value, "xs")}<span class="csel-label">${label(o)}</span></div>`).join("")}</div>`;
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".csel")) document.querySelectorAll(".csel.open").forEach((w) => w.classList.remove("open"));
    const f = e.target.closest("[data-face-acct]");
    if (f) { e.stopPropagation(); window.RT_ACCT ? RT_ACCT.open(f.dataset.faceAcct, { face: true }) : openPicker(f.dataset.faceAcct); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelectorAll(".csel.open").forEach((w) => w.classList.remove("open"));
    const fp = document.getElementById("face-picker");
    if (fp && !fp.hidden) { e.stopPropagation(); closePicker(); }
  }, true);

  window.RT_CARDS = {
    face, enhanceAll, loadImages, openPicker, chooserHTML, handleChooserClick, handleChooserFile,
    onChange: (fn) => listeners.add(fn), get loaded() { return imagesLoaded; },
  };
})();
