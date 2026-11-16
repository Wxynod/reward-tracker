// Reward Tracker — 周报推送（设置里的「周报通知」开关）
// · 注册 sw.js；开关打开时请求通知权限、向 Worker 取 VAPID 公钥并订阅，订阅信息存在 Worker（KV push:subs）。
// · Worker 每周日 21:07（香港时间）按这台设备在周报里选的卡算出本周花销并推送；点通知打开对应那一期周报。
// · 周报选卡或语言变了会自动同步到 Worker（只在有变化时写一次）。
// · iPhone / iPad 需要 iOS 16.4+，并且要从主屏幕图标打开（网页里没有推送接口）。
// 用到 app.js 的全局：api、$、toast（若有）、RT_I18N、RT_WEEKLY。

(function () {
  const SYNC_KEY = "rt_push_synced";
  const T = (s) => (window.RT_I18N?.t ? RT_I18N.t(s) : s);
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let busy = false;

  const reg = () => (supported ? navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }) : Promise.resolve(null));
  if (supported) reg().catch(() => {});

  function b64uToBytes(s) {
    const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  const excl = () => { try { return JSON.parse(localStorage.getItem("rt_weekly_excl") || "[]"); } catch { return []; } };
  const lang = () => (window.RT_I18N?.lang === "en" ? "en" : "zh");
  const label = () => (isIOS ? (/iPad/.test(navigator.userAgent) || navigator.maxTouchPoints > 1 && !/iPhone/.test(navigator.userAgent) ? "iPad" : "iPhone")
    : /Android/.test(navigator.userAgent) ? "Android" : "Desktop");

  async function current() {
    if (!supported) return null;
    const r = await navigator.serviceWorker.ready;
    return r.pushManager.getSubscription();
  }

  async function upload(sub) {
    const body = { subscription: sub.toJSON(), lang: lang(), excl: excl(), label: label() };
    await api("/api/push/subscribe", { method: "POST", body });
    try { localStorage.setItem(SYNC_KEY, JSON.stringify({ ep: sub.endpoint, lang: body.lang, excl: body.excl })); } catch { /* 隐私模式 */ }
  }

  async function enable() {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    await reg();
    const r = await navigator.serviceWorker.ready;
    const { key } = await api("/api/push/key");
    const appKey = b64uToBytes(key);
    let sub = await r.pushManager.getSubscription();
    const same = sub?.options?.applicationServerKey &&
      new Uint8Array(sub.options.applicationServerKey).every((b, i) => b === appKey[i]);
    if (sub && !same) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    await upload(sub);
  }

  async function disable() {
    const sub = await current();
    if (!sub) return;
    await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    try { localStorage.removeItem(SYNC_KEY); } catch { /* 隐私模式 */ }
  }

  // 选卡 / 语言变了才重新上传
  async function sync() {
    try {
      const sub = await current();
      if (!sub || Notification.permission !== "granted") return;
      let last = null;
      try { last = JSON.parse(localStorage.getItem(SYNC_KEY)); } catch { /* 没有记录 */ }
      if (last?.ep === sub.endpoint && last.lang === lang() && JSON.stringify(last.excl) === JSON.stringify(excl())) return;
      await upload(sub);
    } catch { /* 没登录或离线时下次再同步 */ }
  }

  // ------------------------------------------------------------ 设置里的开关
  async function render() {
    const box = document.getElementById("push-sec");
    if (!box) return;
    const sw = box.querySelector("#push-on"), desc = box.querySelector("#push-desc"), test = box.querySelector("#push-test");
    let on = false, text;
    if (!supported) {
      text = isIOS && !standalone
        ? "iPhone / iPad 要先在 Safari 里「添加到主屏幕」，再从主屏幕图标打开记账本，才能开启通知。"
        : isIOS ? "需要 iOS 16.4 或更新的系统才能接收网页推送。" : "这个浏览器不支持网页推送。";
    } else if (Notification.permission === "denied") {
      text = "通知权限已被关闭，请在系统设置里允许记账本发送通知后再打开。";
    } else {
      const sub = await current().catch(() => null);
      on = !!sub && Notification.permission === "granted";
      text = on ? "已开启 · 每周日晚 9 点左右推送本周花销，点通知直接打开周报；按这台设备周报里选的卡计算。"
        : "每周日晚 9 点左右把本周花销推送到这台设备。";
    }
    sw.checked = on;
    sw.disabled = !supported || Notification.permission === "denied" || busy;
    desc.textContent = T(text);
    test.hidden = !on;
  }

  function msg(text, bad) {
    const el = document.querySelector("#push-sec .push-msg");
    if (!el) return;
    el.textContent = T(text);
    el.classList.toggle("bad", !!bad);
    el.hidden = !text;
  }

  function bind() {
    const box = document.getElementById("push-sec");
    if (!box || box.dataset.bound) return;
    box.dataset.bound = "1";
    box.querySelector("#push-on").addEventListener("change", async (e) => {
      if (busy) return;
      busy = true; msg("");
      try {
        if (e.target.checked) { await enable(); if (Notification.permission === "granted") msg("已开启。可以点下面的按钮试一下。"); }
        else { await disable(); msg("已关闭，这台设备不会再收到周报通知。"); }
      } catch (err) {
        msg(err.message || "开启失败，请稍后再试", true);
      } finally {
        busy = false; render();
      }
    });
    box.querySelector("#push-test").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; msg("");
      try {
        const sub = await current();
        if (!sub) throw new Error("这台设备还没有开启通知");
        await upload(sub);
        await api("/api/push/test", { method: "POST", body: { endpoint: sub.endpoint } });
        msg("已发送最新一期周报的通知，几秒内会到。");
      } catch (err) {
        msg(err.message || "发送失败", true);
      } finally {
        btn.disabled = false;
      }
    });
    render();
  }

  // ------------------------------------------------------------ 从通知打开周报
  function openWeekly(ws) {
    let tries = 0;
    const go = () => {
      if (window.RT_WEEKLY && typeof state !== "undefined" && state.txns?.length) return RT_WEEKLY.open(ws);
      if (++tries < 60) setTimeout(go, 250);
    };
    go();
  }
  const qs = new URLSearchParams(location.search);
  if (qs.has("weekly")) {
    const ws = qs.get("weekly");
    qs.delete("weekly");
    history.replaceState(null, "", location.pathname + (qs.toString() ? `?${qs}` : "") + location.hash);
    openWeekly(ws);
  }
  if (supported) navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "rt-open-weekly") openWeekly(e.data.ws);
  });

  window.RT_PUSH = { sync, render };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
  setTimeout(sync, 3000);
})();
