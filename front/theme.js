// Reward Tracker — 白天 / 夜间模式，以及 Serif / Sans 字体。
// 放在 <head> 里同步执行：首帧绘制前就把 data-theme 设好，夜间打开不会先闪一下白底。
// 设置（localStorage rt_theme）：{ mode: "light" | "dark", auto: bool, loc?: { lat, lng } }
//   auto 打开时按日出日落决定：日出到日落之间白天，其余夜间。位置默认按系统时区估算（不弹定位权限），
//   设置里可以改用浏览器定位，取一次后只存两位小数的经纬度。
// 过渡：手动切换从按钮处圆形展开；自动切换夜幕从上往下 / 晨光从下往上；不支持 View Transitions 时颜色渐变。
(function () {
  const KEY = "rt_theme";
  const root = document.documentElement;
  const reduce = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- 设置
  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
  }
  let pref = load();
  if (pref.mode !== "dark") pref.mode = "light";
  pref.auto = !!pref.auto;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch { /* 隐私模式 */ } };

  // ---------------------------------------------------------------- 位置：常用时区的城市坐标，其余按 UTC 偏移估经度
  const TZ = {
    "Asia/Hong_Kong": [22.32, 114.17, "香港", "Hong Kong"], "Asia/Macau": [22.2, 113.55, "澳门", "Macau"],
    "Asia/Shanghai": [31.23, 121.47, "上海", "Shanghai"], "Asia/Chongqing": [29.56, 106.55, "重庆", "Chongqing"], "Asia/Urumqi": [43.83, 87.62, "乌鲁木齐", "Ürümqi"],
    "Asia/Taipei": [25.03, 121.57, "台北", "Taipei"], "Asia/Singapore": [1.35, 103.82, "新加坡", "Singapore"],
    "Asia/Tokyo": [35.68, 139.69, "东京", "Tokyo"], "Asia/Seoul": [37.57, 126.98, "首尔", "Seoul"], "Asia/Bangkok": [13.76, 100.5, "曼谷", "Bangkok"],
    "Asia/Kuala_Lumpur": [3.14, 101.69, "吉隆坡", "Kuala Lumpur"], "Asia/Dubai": [25.2, 55.27, "迪拜", "Dubai"],
    "Europe/London": [51.51, -0.13, "伦敦", "London"], "Europe/Paris": [48.86, 2.35, "巴黎", "Paris"], "Europe/Berlin": [52.52, 13.4, "柏林", "Berlin"],
    "Europe/Zurich": [47.37, 8.54, "苏黎世", "Zurich"],
    "America/New_York": [40.71, -74.0, "纽约", "New York"], "America/Chicago": [41.88, -87.63, "芝加哥", "Chicago"],
    "America/Denver": [39.74, -104.99, "丹佛", "Denver"], "America/Phoenix": [33.45, -112.07, "凤凰城", "Phoenix"],
    "America/Los_Angeles": [34.05, -118.24, "洛杉矶", "Los Angeles"], "America/Toronto": [43.65, -79.38, "多伦多", "Toronto"],
    "America/Vancouver": [49.28, -123.12, "温哥华", "Vancouver"], "Pacific/Honolulu": [21.31, -157.86, "檀香山", "Honolulu"],
    "Australia/Sydney": [-33.87, 151.21, "悉尼", "Sydney"], "Australia/Melbourne": [-37.81, 144.96, "墨尔本", "Melbourne"],
  };
  function tzName() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } }
  function where() {
    if (pref.loc && isFinite(pref.loc.lat) && isFinite(pref.loc.lng)) return { lat: pref.loc.lat, lng: pref.loc.lng, src: "geo" };
    const tz = tzName(), hit = TZ[tz];
    if (hit) return { lat: hit[0], lng: hit[1], src: "tz", tz, zh: hit[2], en: hit[3] };
    // 未收录的时区：经度取时区中央经线，纬度用北纬 35° 的中纬度近似
    const off = -new Date().getTimezoneOffset() / 60;
    return { lat: 35, lng: off * 15, src: "tz", tz, zh: tz.split("/").pop().replace(/_/g, " "), en: tz.split("/").pop().replace(/_/g, " ") };
  }

  // ---------------------------------------------------------------- 日出日落（NOAA 简化算法，误差约 1–2 分钟）
  const rad = Math.PI / 180;
  function sunEvent(y, mo, d, lat, lng, rise) {
    const N = Math.floor((Date.UTC(y, mo, d) - Date.UTC(y, 0, 0)) / 864e5);
    const lh = lng / 15, t = N + ((rise ? 6 : 18) - lh) / 24;
    const M = 0.9856 * t - 3.289;
    const L = (M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634 + 720) % 360;
    let RA = (Math.atan(0.91764 * Math.tan(L * rad)) / rad + 720) % 360;
    RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
    const sinD = 0.39782 * Math.sin(L * rad), cosD = Math.cos(Math.asin(sinD));
    const cosH = (Math.cos(90.833 * rad) - sinD * Math.sin(lat * rad)) / (cosD * Math.cos(lat * rad));
    if (cosH > 1) return "night"; // 极夜：当天不升起
    if (cosH < -1) return "day";  // 极昼：当天不落下
    const H = (rise ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
    const UT = (((H + RA - 0.06571 * t - 6.622 - lh) % 24) + 24) % 24;
    // UT 可能落在相邻的 UTC 日：取离当地正午最近的那一个
    const noon = new Date(y, mo, d, 12).getTime();
    let ts = Date.UTC(y, mo, d) + UT * 36e5;
    while (ts - noon > 12 * 36e5) ts -= 864e5;
    while (noon - ts > 12 * 36e5) ts += 864e5;
    return ts;
  }
  function sunDay(date, p) {
    const y = date.getFullYear(), mo = date.getMonth(), d = date.getDate();
    return { rise: sunEvent(y, mo, d, p.lat, p.lng, true), set: sunEvent(y, mo, d, p.lat, p.lng, false) };
  }
  // 现在该是哪个主题，以及下一次切换的时间
  function solar(now = new Date()) {
    const p = where(), today = sunDay(now, p), t = now.getTime();
    if (today.rise === "night" || today.set === "night") return { theme: "dark", next: null, today, p };
    if (today.rise === "day" || today.set === "day") return { theme: "light", next: null, today, p };
    if (t < today.rise) return { theme: "dark", next: today.rise, today, p };
    if (t < today.set) return { theme: "light", next: today.set, today, p };
    const tm = new Date(now); tm.setDate(tm.getDate() + 1);
    const nr = sunDay(tm, p).rise;
    return { theme: "dark", next: typeof nr === "number" ? nr : null, today, p };
  }
  const want = () => (pref.auto ? solar().theme : pref.mode);

  // ---------------------------------------------------------------- 应用
  const PAPER = { light: "#f6f2ea", dark: "#141210" };
  function paint(theme) {
    root.dataset.theme = theme;
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", PAPER[theme]);
  }
  paint(want()); // 首帧前

  // ---------------------------------------------------------------- 字体：serif（Noto Serif SC）/ sans（Noto Sans SC），存 rt_font
  const FKEY = "rt_font";
  const FAMILY = { serif: "Noto Serif SC", sans: "Noto Sans SC" };
  let font = "serif";
  try { font = localStorage.getItem(FKEY) === "sans" ? "sans" : "serif"; } catch { /* 隐私模式 */ }
  root.dataset.font = font;

  // 预先下载新字体里当前屏幕上用得到的字形（Google Fonts 把中文按 unicode-range 切片，只下需要的切片）
  function preload(f) {
    const fam = FAMILY[f];
    const text = [...new Set(((document.body?.innerText || "") + "永记账本积分交易权益任务账户分析设置").replace(/\s/g, ""))].slice(0, 2500).join("");
    const loads = [400, 500, 600, 700].map((w) => document.fonts?.load(`${w} 16px "${fam}"`, text).catch(() => []));
    return Promise.all(loads);
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const timeout = (p, ms) => Promise.race([p, wait(ms)]);

  let fontBusy = false;
  async function setFont(f) {
    if (f === font || fontBusy || !FAMILY[f]) return;
    fontBusy = true;
    const from = font;
    font = f;
    try { localStorage.setItem(FKEY, f); } catch { /* ignore */ }
    syncFontUI();
    try {
      if (reduce() || !document.fonts) {
        await timeout(preload(f), 6000);
        root.dataset.font = f;
        return;
      }
      // 幕布：纸色半透明 + 背景模糊，跟随当前白天 / 夜间；中间一个「永」字从旧字体换到新字体
      const v = document.createElement("div");
      v.className = "font-veil";
      v.setAttribute("aria-hidden", "true");
      v.setAttribute("data-i18n-skip", "");
      v.innerHTML = `<div class="fv-box">
        <div class="fv-glyphs"><span class="fv-old" style="font-family:'${FAMILY[from]}'">永</span><span class="fv-new" style="font-family:'${FAMILY[f]}'">永</span></div>
        <div class="fv-names"><span>${FAMILY[from]}</span><i>→</i><b>${FAMILY[f]}</b></div>
        <div class="fv-bar"><i></i></div></div>`;
      document.body.appendChild(v);
      const t0 = performance.now();
      const all = preload(f);
      const glyph = timeout(document.fonts.load(`500 88px "${FAMILY[f]}"`, "永"), 1500);
      requestAnimationFrame(() => requestAnimationFrame(() => v.classList.add("in")));
      // 0.55s 后（字形到了才换）旧字淡出、新字浮现
      await Promise.all([wait(550), glyph]);
      v.classList.add("swap");
      // 幕布完全盖住后在后面换字体，让浏览器在这段时间里排版、绘制
      await wait(Math.max(0, 900 - (performance.now() - t0)));
      root.dataset.font = f;
      const slow = setTimeout(() => v.classList.add("slow"), Math.max(0, 1700 - (performance.now() - t0)));
      await timeout(all, 8000);
      await timeout(document.fonts.ready, 2000);
      clearTimeout(slow);
      v.classList.remove("slow"); v.classList.add("done");
      await wait(Math.max(180, 1650 - (performance.now() - t0)));
      v.classList.add("out");
      await wait(460);
      v.remove();
      window.dispatchEvent(new CustomEvent("rt-font", { detail: { font: f } }));
    } finally {
      fontBusy = false;
      syncFontUI();
    }
  }
  function syncFontUI() {
    document.querySelectorAll("[data-font-set]").forEach((b) => {
      b.classList.toggle("on", b.dataset.fontSet === font);
      b.setAttribute("aria-pressed", String(b.dataset.fontSet === font));
    });
  }

  let busy = null;
  function apply(theme, how = {}) {
    if (root.dataset.theme === theme) return;
    const animate = how.animate !== false && !reduce() && document.visibilityState === "visible";
    const done = () => { window.dispatchEvent(new CustomEvent("rt-theme", { detail: { theme } })); syncUI(); };
    if (!animate) { paint(theme); done(); return; }
    if (busy) busy.skipTransition?.();

    if (document.startViewTransition) {
      const kind = how.x != null ? "circle" : theme === "dark" ? "dusk" : "dawn";
      root.dataset.vt = kind;
      const vt = document.startViewTransition(() => paint(theme));
      busy = vt;
      vt.ready.then(() => {
        const pe = "::view-transition-new(root)";
        if (kind === "circle") {
          const r = Math.hypot(Math.max(how.x, innerWidth - how.x), Math.max(how.y, innerHeight - how.y));
          root.animate({ clipPath: [`circle(0px at ${how.x}px ${how.y}px)`, `circle(${r}px at ${how.x}px ${how.y}px)`] },
            { duration: 680, easing: "cubic-bezier(.22, 1, .36, 1)", pseudoElement: pe });
        } else {
          const from = kind === "dusk" ? "0% 100%" : "0% 0%", to = kind === "dusk" ? "0% 0%" : "0% 100%";
          root.animate({ maskPosition: [from, to], webkitMaskPosition: [from, to] },
            { duration: 1600, easing: "cubic-bezier(.45, 0, .25, 1)", pseudoElement: pe });
        }
      }).catch(() => { /* 被打断 */ });
      vt.finished.finally(() => { if (busy === vt) busy = null; delete root.dataset.vt; done(); });
      return;
    }
    // 回退：颜色统一渐变
    root.classList.add("theme-fade");
    void root.offsetWidth;
    paint(theme);
    clearTimeout(apply.t);
    apply.t = setTimeout(() => { root.classList.remove("theme-fade"); done(); }, 600);
  }

  // ---------------------------------------------------------------- 自动切换：定时到下一个日出 / 日落，回到前台时再核对
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    if (!pref.auto) return;
    const s = solar();
    // 最多 20 分钟醒一次：电脑休眠、跨时区后 setTimeout 会漂移
    const wait = s.next ? Math.min(Math.max(s.next - Date.now() + 1000, 1000), 20 * 60e3) : 20 * 60e3;
    timer = setTimeout(tick, wait);
  }
  function tick() {
    if (pref.auto) apply(solar().theme);
    syncUI();
    schedule();
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
  // 其它标签页改了设置
  window.addEventListener("storage", (e) => {
    if (e.key === FKEY) { font = e.newValue === "sans" ? "sans" : "serif"; root.dataset.font = font; syncFontUI(); return; }
    if (e.key !== KEY) return;
    pref = load(); if (pref.mode !== "dark") pref.mode = "light"; pref.auto = !!pref.auto;
    apply(want(), { animate: false }); schedule();
  });

  // ---------------------------------------------------------------- 设置面板
  const en = () => document.documentElement.lang === "en" || window.RT_I18N?.lang === "en";
  const hm = (ts) => new Date(ts).toLocaleTimeString(en() ? "en-GB" : "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  function syncUI() {
    const sec = document.getElementById("theme-sec");
    if (!sec) return;
    const cur = root.dataset.theme;
    sec.querySelectorAll("[data-theme-set]").forEach((b) => {
      b.classList.toggle("on", b.dataset.themeSet === cur);
      b.setAttribute("aria-pressed", String(b.dataset.themeSet === cur));
    });
    const sw = document.getElementById("theme-auto");
    sw.checked = pref.auto;
    const s = solar(), E = en();
    const desc = document.getElementById("theme-auto-desc");
    const sunBox = document.getElementById("theme-sun");
    if (!pref.auto) {
      desc.textContent = E ? "Light after sunrise, dark after sunset" : "日出后白天，日落后夜间";
      sunBox.hidden = true;
      return;
    }
    sunBox.hidden = false;
    if (s.next) desc.textContent = E ? `Switches to ${s.theme === "dark" ? "light" : "dark"} at ${hm(s.next)}` : `${hm(s.next)} 切换到${s.theme === "dark" ? "白天" : "夜间"}`;
    else desc.textContent = E ? (s.theme === "dark" ? "Polar night — staying dark today" : "Midnight sun — staying light today") : (s.theme === "dark" ? "极夜，今天保持夜间" : "极昼，今天保持白天");
    const { rise, set } = s.today;
    const has = typeof rise === "number" && typeof set === "number";
    sunBox.querySelector(".sr").textContent = has ? hm(rise) : "—";
    sunBox.querySelector(".ss").textContent = has ? hm(set) : "—";
    // 太阳在弧线上的位置（百分比，弧线两端在 4% / 96%，地平线在 86%）：白天沿弧线走，夜里在地平线下从日落一端移回日出一端
    const dot = sunBox.querySelector(".sun-dot");
    if (has) {
      const now = Date.now(), day = set - rise, f = (now - rise) / day;
      let x, y, night = false;
      if (f >= 0 && f <= 1) { x = 4 + f * 92; y = 86 - Math.sin(f * Math.PI) * 68; }
      else {
        const nightLen = 864e5 - day, g = f > 1 ? (now - set) / nightLen : 1 - (rise - now) / nightLen;
        x = 96 - Math.min(Math.max(g, 0), 1) * 92; y = 100; night = true;
      }
      dot.style.left = x + "%"; dot.style.top = y + "%"; dot.classList.toggle("night", night);
    }
    const src = document.getElementById("theme-src-text");
    const p = s.p;
    src.textContent = p.src === "geo"
      ? (E ? `Using your location (${p.lat.toFixed(1)}, ${p.lng.toFixed(1)})` : `按当前位置（${p.lat.toFixed(1)}, ${p.lng.toFixed(1)}）`)
      : (E ? `Estimated for ${p.en} from your time zone` : `按系统时区估算（${p.zh}）`);
    const btn = document.getElementById("theme-loc");
    btn.textContent = p.src === "geo" ? (E ? "Use time zone instead" : "改回按时区") : (E ? "Use precise location" : "用当前位置");
    btn.hidden = p.src !== "geo" && !navigator.geolocation;
  }

  function bind() {
    const sec = document.getElementById("theme-sec");
    if (!sec) return;
    sec.addEventListener("click", (e) => {
      const b = e.target.closest("[data-theme-set]");
      if (!b) return;
      const t = b.dataset.themeSet;
      pref.mode = t;
      if (pref.auto && t !== solar().theme) pref.auto = false; // 手动选了和当前太阳相反的：关掉自动
      save();
      const r = b.getBoundingClientRect();
      apply(t, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      schedule(); syncUI();
    });
    sec.addEventListener("click", (e) => {
      const b = e.target.closest("[data-font-set]");
      if (b) setFont(b.dataset.fontSet);
    });
    document.getElementById("theme-auto").addEventListener("change", (e) => {
      pref.auto = e.target.checked;
      if (!pref.auto) pref.mode = root.dataset.theme; // 关掉自动时停在当前的样子
      save();
      const r = e.target.getBoundingClientRect();
      apply(want(), { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      schedule(); syncUI();
    });
    document.getElementById("theme-loc").addEventListener("click", (e) => {
      e.preventDefault();
      if (pref.loc) { delete pref.loc; save(); tick(); return; }
      const btn = e.currentTarget;
      btn.disabled = true;
      navigator.geolocation.getCurrentPosition((pos) => {
        btn.disabled = false;
        pref.loc = { lat: Math.round(pos.coords.latitude * 100) / 100, lng: Math.round(pos.coords.longitude * 100) / 100 };
        save(); tick();
      }, () => {
        btn.disabled = false;
        document.getElementById("theme-src-text").textContent = en() ? "Location unavailable — still using your time zone" : "没拿到定位，仍按时区估算";
      }, { timeout: 10000, maximumAge: 7 * 864e5 });
    });
    // 设置打开时每分钟刷新一下太阳位置
    setInterval(() => { if (document.getElementById("settings")?.classList.contains("open")) syncUI(); }, 60e3);
    syncUI(); syncFontUI();
  }

  schedule();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
  window.RT_THEME = { get: () => root.dataset.theme, set: (t) => apply(t), solar, pref: () => ({ ...pref }), font: () => font, setFont };
})();
