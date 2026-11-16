// Reward Tracker — Service Worker：只负责周报推送通知，不做离线缓存（页面照旧每次从网络加载）。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data?.text() }; }
  const scope = self.registration.scope;
  e.waitUntil(self.registration.showNotification(msg.title || "Reward Tracker", {
    body: msg.body || "",
    tag: msg.tag || "weekly",
    icon: new URL("icon-192.png", scope).href,
    badge: new URL("favicon-64.png", scope).href,
    data: { url: msg.url || scope },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || self.registration.scope, self.registration.scope);
  const ws = target.searchParams.get("weekly");
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) {
      // App 已经开着：切到前台，让页面自己打开那一期周报
      await win.focus();
      win.postMessage({ type: "rt-open-weekly", ws });
      return;
    }
    // 推送里的地址是线上地址；本机调试时换成当前 scope
    const url = new URL(self.registration.scope);
    if (ws) url.searchParams.set("weekly", ws);
    await self.clients.openWindow(url.href);
  })());
});
