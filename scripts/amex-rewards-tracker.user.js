// ==UserScript==
// @name         Amex HK · Platinum & Explorer 活动追踪
// @namespace    local.amex-hk-rewards
// @version      2.5.0
// @description  自动展开积分记录，保存完整月度快照，追踪两张卡的季度加赏进度；并把季度 / 月度汇总推送到记账本（Reward Tracker）。
// @match        https://global.americanexpress.com/*
// @run-at       document-idle
// @author       You
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      reward-tracker.tom-rt.workers.dev
// ==/UserScript==

// 记账本推送（2.3.0）：每次保存完一个月的快照后，把该月所在季度两张卡的汇总（各类别的加赏积分、折算签账额、上限、
// 每月小计、各月扫描时间）POST 到记账本 Worker 的 /api/manual/tracker。只推汇总，不推逐笔记录；内容没变就不重复推。
// 界面（2.4.0）：和「Amex HK → 记账本 · 交易推送」脚本共用右下角的 Amex 液态玻璃球体（谁先运行谁建球体）。
// 球体菜单里的「活动追踪」一组 = 原来 Tampermonkey 菜单的选项；「打开活动进度」时面板从球体的位置展开，收起时变回球体。
// 扫描积分记录、推送季度汇总时，先唤醒球体，再从球体里长出进度卡片（进度条 + 百分比 + 当前步骤）。
// 首次使用：点球体 → 活动追踪 →「设置记账本写入令牌」，填 Worker 的 INGEST_TOKEN（和交易推送脚本用的是同一个）。

(() => {
  'use strict';
  const VERSION = 2;
  const PREFIX = 'amex-hk-v2:';
  const DEFAULTS = {
    platinumTail: '52004', explorerTail: '01006', autoExpand: true,
    explorerPolicy: 'official', aliases: [],
    platinumCap: 15000, explorerPeriod: 'quarter',
    explorerLocalCap: 15000, explorerFxCap: 10000, explorerMerchantCap: 45000,
    platinumLocalRate: 7, platinumFxRate: 5, platinumTravelRate: 7,
    explorerLocalRate: 3, explorerFxRate: 7, explorerMerchantRate: 2
  };
  const LABELS = { local: '本地日常', fx: '外币签账', travel: '指定旅游', merchant: '指定商户 5X' };
  // Explorer has no HKD travel offer in the 2026-10-01 T&C (Explorer_MR_1001/26C);
  // it now has the designated-merchant 5X offer instead.
  const CATEGORIES = { platinum: ['local', 'fx', 'travel'], explorer: ['local', 'fx', 'merchant'] };
  const DEFAULT_DIVISOR = { platinum: { local: 7, fx: 5, travel: 7 }, explorer: { local: 3, fx: 7, merchant: 2 } };
  const cap1 = s => s[0].toUpperCase() + s.slice(1);
  const norm = x => String(x ?? '').replace(/\s+/g, ' ').trim();
  const pad = n => String(n).padStart(2, '0');
  const tail = text => norm(text).match(/(?:^|\D)(\d{5})(?!\d)/)?.[1] || '';
  function parseMonth(text) {
    const s = norm(text);
    const m = s.match(/(20\d{2})\s*(?:年|[-/])\s*(\d{1,2})(?:月|\b)/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad(+m[2])}`;
    const en = s.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/i);
    if (en) return `${en[2]}-${pad('january february march april may june july august september october november december'.split(' ').indexOf(en[1].toLowerCase()) + 1)}`;
    return '';
  }
  function parseNumber(text) {
    let s = norm(text).replace(/[,\s]/g, '').replace(/[−–]/g, '-');
    if (/^\([\d.]+\)$/.test(s)) s = '-' + s.slice(1, -1);
    return /^[+-]?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
  }
  function dateInMonth(text, month) {
    const m = norm(text).match(/^(?:(20\d{2})年\s*)?(\d{1,2})月\s*(\d{1,2})日$/);
    if (!m) return '';
    const [selectedYear, selectedMonth] = month.split('-').map(Number);
    const mo = +m[2], day = +m[3];
    // The website's selected month can include the preceding month's transactions.
    // Infer December's year when viewing January; never guess a future year.
    const year = m[1] ? +m[1] : selectedYear - (selectedMonth === 1 && mo === 12 ? 1 : 0);
    const offset = (selectedYear - year) * 12 + selectedMonth - mo;
    if (mo < 1 || mo > 12 || ![0, 1].includes(offset) || day < 1 || day > new Date(year, mo, 0).getDate()) return '';
    return `${year}-${pad(mo)}-${pad(day)}`;
  }
  function quarterMonths(month) {
    const [year, m] = month.split('-').map(Number);
    const start = Math.floor((m - 1) / 3) * 3 + 1;
    return [0, 1, 2].map(i => `${year}-${pad(start + i)}`);
  }
  function rules(config) {
    return [
      { card: 'platinum', description: 'Platinum Accelerator Travel', category: 'travel', divisor: config.platinumTravelRate },
      { card: 'platinum', description: 'Platinum Accelerator Foreign Currency', category: 'fx', divisor: config.platinumFxRate },
      { card: 'platinum', description: 'Platinum Acceleartor Everyday Spend', category: 'local', divisor: config.platinumLocalRate },
      { card: 'platinum', description: 'Platinum Accelerator Everyday Spend', category: 'local', divisor: config.platinumLocalRate },
      { card: 'explorer', description: '2026 Explorer Local', category: 'local', divisor: config.explorerLocalRate },
      { card: 'explorer', description: '2026 Explorer 7X', category: 'fx', divisor: config.explorerFxRate },
      ...config.aliases
    ];
  }
  function classify(row, card, config) {
    return rules(config).findLast(r => r.card === card && norm(r.description).toLowerCase() === row.description.toLowerCase());
  }
  function relevant(row) {
    return /platinum (?:accelerator|acceleartor)|explorer/i.test(row.description);
  }
  // Rows that are stored but never converted into spend: the 0.75X companion rows
  // (same spend as the 7X row) and the H1-2026 airline offer, which is no longer tracked.
  function auxiliary(row) {
    return /^Explorer 0\.75x (?:foreign spend bonus|Airlines)$/i.test(row.description) ||
      /^Explorer 7X Airline 2026$/i.test(row.description);
  }
  function categoryPolicy(card, category, month, config) {
    if (card === 'platinum') return { period: 'quarter', cap: config.platinumCap,
      note: config.platinumCap !== 15000 ? '自定义上限' : month >= '2026-07' && month <= '2027-12' ? '' : '此月份不在已核实的白金条款有效期（2026-07至2027-12）内' };
    if (config.explorerPolicy === 'custom') return { period: config.explorerPeriod,
      cap: config[`explorer${cap1(category)}Cap`], note: '自定义限额' };
    const y2026 = month >= '2026-01' && month <= '2026-12';
    const h2 = month >= '2026-07' && month <= '2026-12';
    if (category === 'local') return { period: 'quarter', cap: h2 ? 15000 : null, note: h2 ? '' : '此月份不在本地签账赏优惠期（2026-07-02至12-31）内' };
    if (category === 'fx') return { period: 'quarter', cap: y2026 ? 10000 : null, note: y2026 ? '' : '此月份的外币签账赏规则未核实' };
    return { period: 'quarter', cap: y2026 ? 45000 : null, note: y2026 ? '' : '此月份不在指定商户5X优惠期（2026全年）内' };
  }
  function summarize(snapshots, card, category, month, config) {
    const policy = categoryPolicy(card, category, month, config);
    const months = policy.period === 'quarter' ? quarterMonths(month) : [month];
    let points = 0, spend = 0, count = 0;
    const unknown = new Set();
    for (const m of months) for (const row of snapshots[m]?.rows || []) {
      const rule = classify(row, card, config);
      if (rule?.category === category) { points += row.points; spend += row.points / rule.divisor; count++; }
      else if (!rule && relevant(row) && !auxiliary(row)) unknown.add(row.description);
    }
    return { ...policy, months, points, spend, count, unknown: [...unknown],
      complete: months.every(m => snapshots[m]?.complete) && !unknown.size };
  }
  // "month" is the website filter month; "date" retains the displayed transaction
  // date, which can fall in the previous month. Do not silently reassign quarters.
  // A month is an authoritative snapshot, not an append-only ledger. Identical
  // legitimate rows stay separate; sorting, new DOM IDs and revisits do not add rows.
  function makeSnapshot(context, rows, totalRows, now, completion) {
    return { version: VERSION, card: context.card, tail: context.tail, month: context.month,
      complete: true, scannedAt: now, totalRows, completion,
      rows: rows.filter(relevant).map(({ date, cardTail, description, points, status }) =>
        ({ date, cardTail, description, points, status })) };
  }
  // 给记账本的季度汇总：load(tail, month) 返回该月快照（没有则为 null）
  const round2 = n => Math.round(n * 100) / 100;
  function buildReport(load, config, month) {
    const months = quarterMonths(month);
    const cards = {};
    for (const card of ['platinum', 'explorer']) {
      const snaps = Object.fromEntries(months.map(m => [m, load(config[card + 'Tail'], m)]));
      const categories = {};
      for (const category of CATEGORIES[card]) {
        const t = summarize(snaps, card, category, month, config);
        const monthly = {};
        for (const m of months) {
          let points = 0, spend = 0, count = 0;
          for (const row of snaps[m]?.rows || []) {
            const rule = classify(row, card, config);
            if (rule?.category === category) { points += row.points; spend += row.points / rule.divisor; count++; }
          }
          monthly[m] = { points, spend: round2(spend), count };
        }
        categories[category] = { label: LABELS[category], period: t.period, cap: t.cap ?? null, points: t.points,
          spend: round2(t.spend), count: t.count, complete: t.complete, note: t.note || '', unknown: t.unknown.length, monthly };
      }
      cards[card] = { tail: config[card + 'Tail'], categories,
        scanned: Object.fromEntries(months.map(m => [m, snaps[m]?.complete ? snaps[m].scannedAt : null])) };
    }
    return { source: 'amex_hk_tracker', version: VERSION, quarter: `${month.slice(0, 4)}-Q${Math.ceil(+month.slice(5) / 3)}`, months, cards };
  }
  if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
    module.exports = { DEFAULTS, CATEGORIES, parseMonth, parseNumber, dateInMonth, quarterMonths,
      rules, classify, auxiliary, categoryPolicy, summarize, makeSnapshot, readTable, buildReport };
    return;
  }
  if (typeof GM_getValue !== 'function') return;
  if (document.getElementById('amex-hk-tracker-host')) return;
  let config = { ...DEFAULTS, ...GM_getValue(PREFIX + 'config', {}) };
  if (!Array.isArray(config.aliases)) config.aliases = [];
  if (config.explorerPolicy !== 'custom') config.explorerPolicy = 'official'; // retired 'monthly' preset
  let session = null, status = '等待积分页面…', severity = 'warn', paused = false;
  let manualCard = '', manualMonth = '', batch = null, storageError = '';
  let cache = new Map(), minimized = GM_getValue(PREFIX + 'minimized', true), renderKey = '', routeWasActive = false;

  const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAnsElEQVR42u2dd5ykVZX3v6eqZxiGgVHiEuRlQZGwC7gkWViCZIUBhgkwBAlDGnAX17T76rqrGJdV1hWQIDlIHiQnQUBdFFjCiyAICig5x4GZrjrvH/fe7UvT3XWrn/tUPd11fp9PfWqgu6uedH733HN+5xwwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg6FXIXYJqgNVrfT9EBEdj+dV1nmPp2tgMBjMAzCU7AHUgAmAVujeKFADFopIc5ycUzvnXheRBZk8gMWAZpWugxFAdYx/ceAyYBWgv0L3pglMBB4A9gUaKS6xqtZEpKmqOwLHAo0x+Lw1gMnAKSJynKpKu9sBb/gCnAJsBrzrCdUIwACqWheRhqrOAc6r+OFuB9wM1ESkMY7OqxUeA9YWkUXtej+eBNcEfldFe+szE+x60K/p3eTD/GrbAOoVXAn7gHki8jNVbWcr0O/Pa6xuAQRYHdgKuCkQW5sL7Ez/7/4qrf5GAN1Hza+Sfwds4R+SCVQzViTAp1R1XRH5bVjdEv+2NkYJIBBYH7AHcNMoyH0xYLdwv6tGADWzwa6vMABH+XvRpLrB4gYuiHVoj20fg41MU9WpnrAlkdwVWB/YIAqmYgRgCNFxVdW1gJ2r+oAM8azMUdW/aMMQxgMBKC44u80o7GaG9+qaVb6phu4JTOYCU6qWHhrGC2gCywKf7rHnp+FJYHaq++8JcnFg9yp7TEYA3V39V8Cl1nSM3Av1r4NUdUm/x+0VL0CAbVR1RW/ctQS72hIXQGxW9f5aELB7wb9+Vd0LWCEx8t+MYgZlrvIjPah1f6xrAruKyPmqGv4fmTQH2mUjH+5nDX+vtlfVc1qs6OEc9vDXrFX0X7u1RTAC6ELqzxv/YrjUX4p72EkPITVaf6SqXpTR+MeKR7q3iJytqjrC/W2q6lQGov/1BOKtGwH0TlS5AewKrJ3gHoaf/xj4b2DxzEYXjmmhX9m/kPC7TeDjwJYicnObufGRzvEk4C4GJLOdimssBnwdmDoCAYZ79LequoaIPDZMKjTc352Bv2hxf8N3vQR8DVjk/1vNTMbp6h+9blKHfh0eDVVtquqfVXVKh47x3ui7h0M45oujmMb7lID+fbb/3eYIn7fIv2/fxXtzzqBjGem8/z4+x8H31//7wjY+73SLAfTO6h9Wz61DsUmC63+WiLypqhNLWP3j/f0inGb9hERXfVdVXRd4sA1h0EhYwhtVvcTzHC6uMR8XkE0RLc0C/msIrye4/ysBOyW4/+E7LujCeRu6FP1HVc9NWP2b/vWGqq7hV5daB7yTpVX1qYRVOxz7fw6zGo7GA5g21Gd1ogeDqi6lqk+28H7CObyrqusP9n5Utc+/H57gRYWfPayqS8beg6UBx3fqbw1gl4TAXtAFXC4ij/nMQbNkTYKIyMvAWdExtBLI7KOqy49VYZCIqPdeXgeuGBTFH04ROZGh8/uhrmPPKGXaKlNwpYi8ESkHjQAY38Kfg32wqZXwJxjYCS0eyjJWxDOA16JjaCUMOmCMP0/hPlwSBe20xe/urqoTA/FFW6A1gc0TUqrhOy7o5P01Auhe1Z+q6jLA/gmrf6id/xnwm5Ba6gBBNb0X8HvgqsjIRzIcBQ70QcpmmduUEhEETb8GHmxx3sFwNwA2HEJDsBsDmRppcX9/A9wXng8jAMa18Ed98GjlhNU//Oxkb5S1LqyGJ9BawBKMYS2cMGhMVvz54675zj8/TUxbAuwVe0OqOgFX+puKn/oeA/VuuP9GAJ17wBr+4Tg8QfgTDP7BaE/a7MJqeAdwW7RitdrLHumDYGM1hx2O+yJcNqSWQJI7q+pSUZekDYH1Wnh4IfPzrt9y0M1CISOADnT8CQ9LwsMRP4iniMhCL7LRLqyGCpwc9QJoldrcFPg7nwarj81bpeKJ9w4GAn4jnfNHgM2i+zMNV/k3kvsfjP3nfqtFJ7Z3RgDdf7AOT2D7sPo/B5zfxeBQOMafAg+16FUQ9q99wBHdDGhlIL66iPRH24AUvf+cqKfjDNKkv4TVP6QOjQDGb7+/JvA3wA6Jwh8BzhGRFzKJa0abGquLyLteGNTKqEMsYBdVXWcMVTcOR3yXAgsStwE7quok4G+9R9Aq9VfHSX+vTtheGQGME8zzN75Ja9Xf28BpUTfZbkfGzwee98ffKj++ODB3rAYDg7cmIo/jMjC02AaECsFtPMGT6P7fKCLPeIJXI4DxK/xpqupqwPQ2hD9XicjvUjrvdigW8DxwbsL2JXg2+6nqcrhA2pjcBvj/vCxhGxB+9iVchifV/b+gAgRvBFD+8ySKE8l8IFH4A611+N2IX5wGvNWOMKjbKxvFuv/gXfQXW5xzuGdbAau1IIymJ4c/Arf669M0Ahjf7b6negJo5RIHt/E24FfeNWxUgMGCMOhB4NoEYRBRx6ClxmLz0Ega/DxwfWKarpXsN46hXCsir3Y6u2ME0B3hzwzg/yTU/MfCnyy941W1lkmbHz7j+Dbky2vh+h2M1WcsXLsL22ybToJq8ifWE3D8I0hi2xH+/B5XkpolMiwizUwrTAgG/gL4VYv8+HuEQd0WuWTYBtzuXfZ6wfNo+Ht8P3B3la6LEUA5qT/F1YNvlLD6B4M5VUQWFHUNo/LWTX3jzlzBwEaiMCgYyyaq+jHgjTEsDX4VuCajtuEKf4/7qhIjMQIoL3B2WMKDEzIDL5IWaW9HffifwCcz1dc3o8j4owmxgBBNnzcOBohckMFWQqOPi6rmFRkBZE79+cDZX3vjayX8CcG/n+TIC0eG/je4rkPTc6xekTDobVxGQBKEQeAq4zahWtOO29363A3cl7D1abWd+AXw225W/hkBdK6Sbh5OGpuySi4ATsmUF1ZPIGF816dU9cNen1/LZBBnAy8nCIMUWA6XBWmMYWnwAuDKDB95afSZmqOzlBFANYU/q+Ci/5oQ/BPgehF5wKfbGkW9D9+Pbg///UswMMVHMnUMepqBOoVmAhl+CNd1t9Nt19b2g1cokA1pRhWCjRakNxLJvxGRSLNg27aNgMkFz8sIoEThz/7AMgnBv8HCn6I3U6KGlct4txtgb1VdKlPLLomEQQsSW1hrl7zaTYDN/fHWRptJ8X//W+CXozDgMOjkZhF5PENjlyWBfXClxOYBVFD4MwXX8osE4Q+4DjS3hr/P0HOgDzhoUDR+jRAMLHq/vYciInIvcGPiRGPpYsfr/TwpFyGhUNA1vwAxFwokRrGdLYENfBMRIwCqJ/zZAzcLrpEg/BGc8GdR0YaQ0QOyAy4AqYNW50NCU9LMHYOqXPTzDrCtb1haJAYSl0a/2cY2IEh/nwZuzuQN7YmTlZOrAasRAFkjxke0MQXnceDiHPvC6ME6cFB8IazQm+MyA5ojJei/8+fAnQWi42VjgXeZtysSYA3bABH5I3BrG/creB43iMjzUWn4aEbJNVR1Mq4T8ZuWBaim8GdbXOqtVeovPASn+WEfRaPCYRjFR4BPDapIi0dfHZDBHY5FMgtxvQIqUdU2AuZkKLxpVxocNwo9v+BqHWx0R7/6v2sEUM1ecoe1IZB5hYHe+5rpHh7A0HMDw89nZXCHh4qOP5FYJNStFPdWqvrRUORTML16A/BsgjQ4eGAPAf+dqfJvVhlThI0AMgh/fBecaYmrvwAXi8ifinb88StLw1cd7jXMnjw0rliOgY61kkkY9AZuhkAVB1qGc5zCwJTeItuAmog8l7ifDz+7uoiXF6pCVfVDwHZlTBE2AsjzkB2OmxbTTGj39S5wUqYgTgge7owLPg7XdCR814Feh54jJRgkz2fi8tz1CvcCnJVhgnFIgZ6XQCbhWlxY0MsL37ELrs9C9qyKEUDx1N+KI6y+QwX/bhaRe8LePZMrfliLmvSQAdjQN6/IkRIMvQKeYCDNVcXKv9CTcZOCKrpQXfkLXD3EcCnQ8P/uBO4p2PU3bNf2NikwlU397ePd61Thz/E5mDwavrkxsFnC/Qyr38ElEOGpwMIW3XO6hUX+Wu9VcBsQtj2vA9eNsLJrJP1tjLbrb7RtWI+BqlIjgIqt/pOBuYkdfwD+B7gph/AnCkwdgIvyNxPcUnzn3tX8w5nFCwDuwqUFqxwM3DWDIlIHVQjWhwnyvg1cnskr2h0X3F1kBFAdBHbeFfhoYscfwQ/7KFoQEiSlqrp81IyylrCfbOBy4/tn3E8GCfTxFW0BFlz1vwS2Lvjca+Te3zeEgYd//0JEHiki/Y2mSc0u01aNACjUMebINoQ/f46CQkWFM/UoNbRsi1bUQ1Xp7eObhTQzBAPDZ9wE3FtRYVCIj+xbJCjntwF9nsTnj/BZoetvfbTuv//7bXDThktTXBoBjHJvpqpb4hR2qaO+zszRDDJK/fVFY7nbud/qH6rtg6gn42DNUysqDArHtK2qrppJGjzfxz3qEcHUcTMUri+Y+w/bu+lRGtcIoILCn1Y3JxjY67h8eRbhj384tsZF9bXNlSZ8/6EZq/XCg/4T4KkK6gLCfVoa16qtkCbAv9+PG+/NIIHOLSLy9Gg1HtH27gN+/0/u3L8RQHHhz0eibjt9CcKf+SLyh8yjvg4e5XYieAHbqOoGOYZ5RhHyV3ANQ6oYDPzf7U+G+ou+QcHA2EU/r2Bzl1qU+18hIbhrBNAF4c+hwKSE7rji3cSTcnT8iZRhq+G04f0RCaS+mpHrOiejFxCEQafjouBVEwaF67+pqq5fUBocyOM64DV/rjXgD8Dto3X/Q2GXf59ZhvTXCKB46m/5aBWpJQT/bheROzKlhAKBHAV80Hsfff4BbOe1mH8/SlVXihpf5BAGPYobrlk1YVAITi4WudZFpcGP+dbhg4d+jLbrb8garOYDgKW6/63cV8P7994NVZ0NrBi1iEoZqEHRWX9RWWjNex83+JW8iOEuhpto+3SmfXuQy56MU6/VK9YzQCJp8LdFZKG/rlrgs8737rpmUESGz9wDl65t2iJdkdXfvyar6gOq2lTVhg6Pfv8796vqpPD3vRIn8a9bomvRCov8+7SibczD/lxVZ7b4/k8U+a6o9+Byqvqyqj4YfbcUeMZqqnrHEMce/n1z/Pu2Beis7HdHYN2E1F/Yb/5YRN4p2vFnmDxxX6aXlNAbsVlhYVCIm8wuuuXxgc8XcP0CrxeR/gJp3vCMbAhskPCM2RaAzhaUwIDwJ2XYx7NkHPYxRG++qndHug7XTHOdirmysSR6GRF5qcA2IPzNcbhUb46A6gy/NevvhH2aB5Au/NkMl3vXhOAfwNki8nJVpsB2YazWW6QNEelGHKAJrARsX8QOIk3AzSJyV5HKPx/fmYTr+9cx2zQCaE/4U2+Rlw3k8BYuHUaFa+Q74TGdBzxXwSrBoNybk2MLVPQzIl3BdriaBTUCqJbw5y+9a0Zix58rROThDH3gx6wX4D2f5z0JVE0YFPr1bQWsUbQyMoOH14zc/1onr5URQNr1mYubstNIcC8XMSD8qZnnxKm4LkhVEgYFTcBSDDRSlW5lmPwisxyuurSjdmkE0LroZmlgv8Sa/xpwB65rTNWDdWV7AUEs8ztcT/0qCoPw24B6F48teJTTcLUKzU6SkRFA67TMTNx8u9RI9vHe7bdrOyAMOim6flqx2oCPARuFbUuXFhlhIPinNh24OrLfSbiGn5pY8/8QcFWmjj/jwQsIHtBt3jOq0nUJ24AJOOVdN+dJfoSBDFPdCKA6q/92DIgy6gkP1Bki8nZu4c94kFCTbwhqGc//TFWdlKlb8mi+fwau7VezWxfAMHQAqx3hz4sMDPto2iV8nzDoKuCRinkBYUuyOgU1AQXc/4mR+48RQDWEP00/h33bNoQ/5/oZcLb6Dy0Mej0aIkIF27vN7JKXuTGwfjfcfzAp8Eir/yF+f9iq6q+Gm0R7Wm4NQgWMpZmJzP5XHQl8DlimQlWC4d7urKoriMhzmRu3tHrOZvlj6O+GPZoHMLTw50MM9JGvt1g9BLhGRB7IKfwRkaaINLr80ozCoJqIPI1rjFqlxqFhS7Isrqy39DhF1PhjKTrQ9ss8gPZzwwfjRCIjrf4aPcgnRsKfRqaHZH2/UvZ3YaVU7/38D/BqJrVbwCm4jkoTKuQFhHObrapndCAVV/eVg9sDq3Y6928EMHLqbyqub37KqK86Lr11aw7hj3f7FVgFuAXX9adbBiHAt0Tkyz4/3sgkDLpfVa/BDexsdmvlGyYYuDnwURF5qORtQCz9pZPaf9sCtA7KTKe9gowTRaQ/07UMeeE53vj7u1wsc4CqTs2YHguf8aOIZLRC24DJDGgCpGTp74p+qGtX7dAI4L1NLRcDjmgxaDMW/jxKphFQkQeyxCAPRLvwiktmZ+bao0ZE8jPg7op2D57tU3PNkoOO04GpZfb8NwJoM/WHqw7bOHHYhwBnicgbmWr+gweyDQNNNOpRd6FOv8J5Hhi2ABlHmvcDJ1KtISKhCm8dYLMypMFR7r8etZWvhBLKUn+8T/gzUs1/HRccy1nzP3hgBxVJj20GbO7JSTIKgy4HHq+QFxCOoy8yTi1J+rsWsGU3o/9GAO8ds60+6r5TwuofgmEX+Akw9aLBokh8tA5OkaYVuTchOn1orn1xJAx6BTizYh2DgjHuqapTcrRLH8beZnuiaZgHUB212lxgYsKorzqu5v+UElaJ/RgYOCIVio7v4puiNIuOFB8ULznDe1J9FdMErAx8MqeNRO7/ZAZy/7YF6HbqzwemVmRgcmxKx5/rReSeHMKf6BimRsdQq5hBTAX2zbUNiDoGPYkbIlKnWu3MlPem6HLa2qbAX1WlUWqvewDh/A8EPpCw8gaDODHj/q0WDYNYpYLDIML12N9nKHK5xcGwTsINOKFC2wABdlTVVQpOEh5q4u/e0bZHjAC6L/xZEvh0Gx1/7gV+5h+KRqZjqONGfbdKP3Zzsu6HgV1yjBSPhEHiu+ne4M+7USGvZ6lcmoAo979Mp+TGRgDpabdpwJptBN5+JCILo4hujmPYENiiClHhFjgkc7lzONeQEqxVrKvxTN+xt+h9rnuy3wE3Vq4yXl5fD6/+qqoTaE/48wRwWTQWSjK514d4Y2hUlABCMHArVd0YuMsbRiNDSrAG3Ag8CUwJU5QLXFvJMIk5NDDdGDcJ6v6CfQObPu4xK0dcIT4/VTUCKDDocytcnrvVyhu8gzP9sI9cVX/9PgC5W8WGaA7XPqsPOFBE7swkU9aICI4PHpGqjroSUVX7w2dkON9JwEwRua8g2amvMN0hg+cdYglqHkDxB29etMett0j9vQ5c4NM4oqrNDO5vP073v1yFV//B28VZqnos8EymJp/hM671HsDiQK3A9e1T1UXeeHN4ZzNU9Tjg7VFqFvpwaeN9cLUGRd3/ur9GksObkF6s+fcXbR3gLtwcNlrk/gV4E/h95uvWxAXXlhxj9+IPwCuZCSuXBxRmMywLrJbpuB72BFAr0HVoDVymqeh5hucwy/MiPdz04/vAZ8fAyltF70nsMjCuGmD0kvBHVXV53OTaZdt8oJsl3QMZo7P/qv5sS4XON9fxZE0V91oMIOy79/PG3+5+zKTTvXkdauOU2HrHA4jSSosDdwJrU52iG4PBmLxDwp9dcAFAM36DEUCPdfzpwwl/qKDk1mAwAii548+mOMlt0yL/BkPvBAHDan+4J73+LhFArc2Mg/bggtTsUCCtNgYyLVp6K4weyvtvANxjnG8YA3qGjhUL9VIacBJwLAOSzk7e/KAt342BacOtvv9S4DF/j3rFE1jFn3OZk3IF1/NvtYqKwMIx3Y8rk65lvv8ayd+n2DrQWW/kR+rQr0Oj6V+qqlv04PU5WVV36sD3rK+qz/vr3NDqIDwXD6nqyh24Dmf39ZgOoN6l1TTsbRdr42+m+qxFvUJz9Mr0RPv9qnyFqm4nIrf5OQ2N3KufiNznS3OvBJaoyHYgBKb/BOwuIk/5cvWcY8Mkut4XMdCcxNCBAiRU9bQ2PICdGOhaPN6vT59/v8Sf+7N+PHsp5x99356qutB7Ac0urvzBC3nR91ugjJkEqlpT1bqqnuu/b6EJYQxUTKqtwArAfFVd1/dt6MvcBbpfVftE5FLcLIhaF7MuYU++ANhbRO70x9bI7P2GHhYn40qT+4EJRgAGKljE8y4uIHi5qq7uDbZeAgnUReRU4MuefJpdmsGouEYrN/pj6s9s/CET9kPc5Ov+kAAwAjBUNSYQGpFeoaore08g9/Pa9Ab3LeD7UbFYp4w/pPvmiciFJa38dX/t/h04anDmwwjAUOXtQAPXk++nqrpsxhbd8UCYQAKfA86KApJ0KN33f0XkJG/8/SXUv/Sr6r8BX4i+U4wADGOJBDYELlXVJUskgRquOeuVHSCB0F/xP0Tk22W4/f4zG6r6ReBfh9M8GAEYxgoJbAlc6Ed3a86ZfaEBqYiE3n2/LHF2X5Chny4iXyjYbbhV09vPAN8dSVloBGAYS41cdgbOC89tZk+g6WXjb+DGgj1YQmAwBN/mA0f4429mmC/xnhSnN/65wH9FOgIxAjAwDsRCM4DTgtFk9gRCPOBZ3ADPP2csUApu/89xk6gWxd5HJuOf4Pf8++BGrjVbyd6NAAxjkQQ+rarH+7y2ZCaBhieB3+NGg72agQTC/vseYJb3MnLNlohX/kWqOh03dbmW0vXLCMAwVmMCR6rqd7wR1UoigbuAWThdgoxSKBQkvo8Ce4jIC6FCNbPx93v16PnAhMSOV2oEYGAMCoVCNduXVPUrPndeyywUCiRwI25wq9B+R95wXM94ff8TUXOa3Ma/JXAhrt4kpZxYATECMFTCqNsM6MUkcIyqHl2SZLjhDewCnIimHclwWPlfAaaLyG9Daq4E498EVz6+VKLxh9jAy0YAhiqgMYpVUSKDPE5V5wZ5b+btQKgbOAH4WrQF0YRmIwuAOSJyRwkqv7o/tvWBy3Ft7huJxl8DXgZ277Nnj17ohvRX3j3UqraD9/P8Vqe92FQ8H+9kVX1TRC7wnkBOIU/YDvybqi6HmynZP0xDnXibcJCIXJdb5ReJfNYGrsCNHE9pbtKMCo9misjtRgC9MflpCVwr9PE4sUqiFfdMVX1DRK7OaXR+mlRQC34GWAaYPQQJaOT6HxXIqCTjX90b/6ptGL8AC4HZInKzqvbZFqA30PSvhn81K/rSAoShuADYBar6ieC651YLhso9XLuu2NPQyBC/KiInlGD8QeG3CnAVrlgqxfg1eg72E5Erw7EZAdBTHXer/pIMXZemABer6ma5y4iD7kBEFgB7A7+JJMNB6PMDETnGf2+jhO3c8n7lXzuxu7VGHtIhInJRTExGAIbx2FZ8aVxDkY/lzg5EkuGXcarER7wR9gFni8jRuSW+kfFPxQX8PhYRTmrJ8VEicsZgr8QIwDAeSaCB6yp0uaquVYYn4Pfif8JJhl8GrgMO8RkILcH4pwCXAZu1sfKHeMQXReTEoaoOjQAMjGO14Kq4XgKrBWFPCUKhh4BPAPuKyEK/Rcht/IvjsjifGCH7wDDy46+JyLHDVR0aARjGOwms6bcDy+fuKhQ+T0TuE5GXVDWbvj94Er78+Rzgk4nGr9H24Hs+dVkfbktiBGDoBRLYALhMVaeW0FCk6bvt5lz5JRI6nQbsOYqV/2QR+fxIxm8EQM+Nwqryq+xeApvjsgOLl0ECuY3fexInAvsmBvyISOIcYF5KMNIIgJ4RBMmgdFvVXnSgjHh74CdldBXKbfyq+n3g0DYG2QbjvwyYG0i1FTGZEpBxLwACV4o6i2rOGAzTmv8Z2KjEwZiBBHbD1cvv540ua1OODO27G6r6DeCzbbj94feu9R7Dotz9Bgw2Gajsa3RZi2uTC4v8+6nh3lTBEwj3WVW/POg4U8/nFp8qbKtVmnkAvTMXsarbvSDemUBnuwrN9cVDn/UVhM1ueQJRWe8/At9oY2pxiA38Gtds5M12m40YAfRCAMA92I2KkpP6Pa92ocno0Z4E/kVV+1S10WkSiIx/HvC9aAskbYwR311EXh1NvwELAhp6NSgaUoRfUdUveoVcrUvGfwBwQkoTz0HG/ygwTUSeDYVCo3G/DIZebi3WBL6rqkfkVgsmGv9ewOlt9GoIxv8ksEvRNmNGAAZLjzoSOF5V9/ckIB1o1NKvqtNw48hIbOIZtP3P+pX/4aJtxowADEYCA6+TVXW27zJcK7lL067AucDERFsMJb1P4AJ+9+VoM2YEYDA4w+oHJuHm6E0oQyg06PO2AJbE5+xJ03QI8EjoMZhjYIkRgMHg9tUTgBdwHXPeyVnVF2dj/OovIvIlnM5/QmL/wlDNt72qnhGyOkVJygjAgKklqQOv4dJpd+ce3DGCN3A4cDHp04hDr4MDgONyDEUxAjD0uvHXgLeAGSLyK7+vbnZAlyHemPcHrhkFCfyDqn6j6FAUIwBDLxu/4MZ+zRGRm3I38UzsL/gOsBduaGgKCcQahi97DUPDC5nECMBgSCuNDnv/g0Tkik4a/zAjyffESXr7ElWbwRP4rqrO88deH40u2tAbtQBVvdc1VW3SuWElGuXcDxeR87th/EM1GVXV3XG9BddPqAeIhUzHe0nz2e2eixEAPVMLsKjiJPVOh4w/BP3+UUROzd2+u2CT0We9OOgG4KOJJBDwY1V9S0QubYcEjAB6YzTYyrjmElXNwSuwXsnb0tj4/1VEjss9rDNTk9EnPQncSNrUn3D9+oCzPQkkjyMzAuiN0WCrAl8dh2PB2jH+UDr7HyLy9eG65FaEBB5R1d2A64HlE5qkBDnzZNxkpGkiclsKCRgB9AYW+Vdlh4P6Z1FKFPr0ASeJyBdaNcqsCAncq6rTgauBqQkkEOIBU4FLVPWTInJXKy/HCKB3PIEJFSeAshA3yjyyhKk9oY4g2zCQkNYTkV+q6ixcn78lEkmgASyHa4W+g4g8NBIJWBrQ0AvGfylwcMgA5DT+IO/1E4QloyfQ70ngBlz/woXRfp+EVuirAFdEQ1FqRgCGXjT+67wB9Wee2lP3Rr+qqv5QVZcokQTmxwTWBgl8GDcebYWQaTACMPSS8d8GzPLTfHNO7Qnde6cA5wFHAaf6VVZKIoFzgSO8zaaSQD9OUzDfD0V5nydgBGBgHFb29QF3AtNF5I2cxT3egFRVJ+Dm9W2BkxPvDfwwFOhkDgwGEjgF+FwU8NPEBqibAZeq6uTBQ1GMAAzjzfjrwIO4phkvZTb+eGU/nYF5fRP9+zxV/VrukeTh3DwJfB+X0k0VMAUS2JYhhqIYAdAz2vfGGHhpBuP/I7CbiDxVgvGHzzsON4CjP0pfBoP8qqr+fVi1c3d29rGHY4Bj26ggDL83DTgzdB1WVbE0YG+gbzSFIoy9mv5nvPE/WoLKL+z7/wX4hyGm9ki0P/+Bqr6Yu87ABxlD7cAXfQziiMQ5AoEE9gbeEpFDVLVuBNAbVW8v+P1qs6I6AMEJlbbGpa+0jWMMe+6XvNv//3IX9wzq3f/1EQxOogDdaZ4EbiiBBEIs4iicPmD/xDFi8VCU10Tk82YiNhqsStfpkjbHgzX8+2uqunUw1tztu/37Xv77GtE9anVcL6nqxmXcxzDSTFUnRtctZZxYM7q+3zYPoMdIqMJblP42lalh5X8H2EtEfl7iyr8TbqCoJHpQIUq/NC76vp3X92fblkRlxAtVdX/vCeyUcB1DvEKBfzLLMA+gCtcnrLLzEz2AcJ0WqeqMklf+j6vqq4NW9lSE83hQVVcsg4ijZ2uqqt7e5mDRpmUBDGMxrhEaiMwVkUtKWPnrfuVfx8uIp45ybHnIDKwNXObFOM2cJBB5Aq8BuwN3t9FVSIwADGPR+OvAUSJyll+pG5l7KDRU9UPAfGAl//m1goNIP47Lw0/K0c57GBJ4CdgNeChVJ2AEYBiLxv/PInJCWKkz6vtDA5UP+pV/zTZGdafEOHYGTg12WwIJ1EXkKVy+//EUEjACMDDGcv3fFJHv5M7zRxLfSbiU6caZjH8wCewLfK8kyXAQCj0K7IrTRYxIAkYABsZIcU8d+IGIfCV3N59BK/GZwPbRd6ZqLTSRBBrA0ar6lTKmEUck8IDfDrwUTRUyAjCM2cq+04DPltTQI0h8fwTMbiMl2RyUGtQ22nkfE40k7yuJBO7EtRt/PUpNGgEYxpzxXwAclrvzTmT8DVU9xn9H6srf7+3nCu9uvxX15qONdt6zctcNDOoqdCtu8MjbicdnwHQAVdABhFz2lV7tJiXk0MP3Ht2mAjH83m9UdTn/GdP9MacoBTX6vbdVdfuy7nV0jjNUdeGgZ0zNOo0AqkgA7/j3m1V1ckkCmvCd+/lrnmq44d497FOF+BJbVHXuKKXML6nqRiWSQN2/HzCIfIwAjAAqRwDBKO7w6bgyjf9TqrqgzVVbVfVpLxKKjSt85j+1qcYLz8ITqvrhsmTb0fF9JiYBqwWoPrLmi6l+Q48acC+usu+VkO7LcQ18JV3Q928OnA9MGhTMa1V78Cqu09CDg1KRIfD2HVVdFte5JyWYGNJ0q+L6920rIs/lPO/o+CaIyA99GfG3gIYFAatt+L1yf2r+XD8IPAvsLiLP+FUrm3Q2Mv6/xgl9lkqU+Iby5HeAvUXkDv9ZjUENO4Ii7/PAWW007AgksK4vHlqyjBRhRALfBv59nPeIGPNbgG178Dp9V1XXK/k71lDVR9so7onjA/u0KjzywcpQpnt1m9uBOPA5qQPX+xgx8+zojL7TgIMSFWZ34ZRcE3sodTMZeM2fc+4AVQ3XvHM9YLU2invCvTpaRH6QUngU3e+puPFem7ahKgzHdTfwNO8d6JJ7HmPDCKC6BGAot65A2qg9+GZQIKbKj6M9/ErAzaRN+x1MAnSiEYOBymrfmz02xqsThl9rY+UP8wTblh9Haryn/bTfW3CVhSnGXYuapIoRQG8i9UE1UJoC8WIKzBMcNO13Om5K0QcSSaDeqYfMYDC8f+W/Cfh00XmCkST318AcXCZBStjXGwEYDJkGi9wFzI5GihUy1miyz7XAIdEWT40ADIZqGf8jwJ4i8nLOwSKDZvx9LirRVSMAg4HKDBbZU0Se9Hv3Zgkz/uoichzwzZHq9OlgO2ZDZx+0fivJrNw9mYCrmZ8pIg/kbjI6+Ps8CXxFVZcBDscNRRG6kPExAugsptg1rxzqwEKcxPeXJRv/e8Z7AZ8BlgVmmAdAT4zougx4Hlhg26/K3JfFgZtE5JrQZLTsL/UkIH5LcBBwPy492I/pPgyG3picVIUqT2Obzt7wejRB1kBlBpM2M08SbpcETBZuMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBkPH8f8B14BLYJGfrewAAAAASUVORK5CYII=';
  // 共用的 Amex 玻璃球体（交易推送脚本先运行时它已经建好了，这里只是找到它）
  const kit = glassOrb({
    brand: 'amex', title: 'Amex HK · 记账本', short: '记账本',
    rgb: '0,111,207', deep: '0,46,122', alpha: 0.5, ink: '#071e3d',
    logo: LOGO, logoBox: ['56.5%', '50%', '87%'],
    ledgerUrl: 'https://wxynod.github.io/reward-tracker/',
  });
  const host = document.createElement('div');
  host.id = 'amex-hk-tracker-host';
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const el = (tag, text, className) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (className) e.className = className;
    return e;
  };
  const TRACKER_CSS = `
    :host{all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483646;color-scheme:light;
      --rgb:0,111,207;--deep:0,46,122;--a0:.5;--a:calc(var(--a0,.5) * .8);--ink:#071e3d;
      --ink2:color-mix(in srgb,var(--ink) 64%,transparent);--ink3:color-mix(in srgb,var(--ink) 54%,transparent);
      --logo-x:56.5%;--logo-y:50%;--logo-w:87%;
      --panel-w:min(440px,calc(100vw - 40px));--panel-h:min(800px,calc(100dvh - 40px));--orb:64px;
      --ease:cubic-bezier(.22,1,.36,1);--spring:cubic-bezier(.34,1.45,.5,1);--settle:cubic-bezier(.55,0,.25,1.18);
      --open:680ms;--close:520ms;
      font:500 13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
      color:var(--ink);-webkit-font-smoothing:antialiased;letter-spacing:.005em}
    *{box-sizing:border-box}
    button,select,input{font:inherit;color:inherit;letter-spacing:inherit}
    .hidden,[hidden]{display:none!important}
    .defs{position:absolute;width:0;height:0;pointer-events:none}

    /* ---------- 液态玻璃材质（五层，与交易推送球体 / 菜单一致）----------
       mb 背景模糊 · ml 边缘折射（SVG 位移贴图）· mt 品牌色玻璃 · mh 指针高光 + 内阴影 · mr 高光描边
       注意：带 backdrop-filter 的层的祖先不设 overflow:hidden / opacity / filter，确保背景模糊与折射完整生效 */
    .surf{--lx:32%;--ly:18%;--ang:-35deg}
    .mat{position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0}
    .mat>i{position:absolute;inset:0;border-radius:inherit;opacity:var(--o,1);transition:opacity .22s ease}
    .mb{backdrop-filter:blur(var(--bl,22px)) saturate(190%) brightness(var(--br,1.08));-webkit-backdrop-filter:blur(var(--bl,22px)) saturate(190%) brightness(var(--br,1.08));
      transition:backdrop-filter var(--open) var(--ease),-webkit-backdrop-filter var(--open) var(--ease)}
    :host(.lens) .ml{backdrop-filter:var(--lensf,none);clip-path:inset(0 round var(--rr,28px))}
    .mt{background:
      linear-gradient(rgba(255,255,255,var(--veil,.46)),rgba(255,255,255,var(--veil,.46))),
      radial-gradient(140% 120% at 28% 12%,rgba(var(--rgb),calc(var(--a) - .12)),rgba(var(--rgb),var(--a)) 52%,rgba(var(--deep),calc(var(--a) + .1)))}
    .mh{background:radial-gradient(70% 55% at var(--lx) var(--ly),rgba(255,255,255,var(--sheen,.3)),rgba(255,255,255,0) 72%);
      box-shadow:inset 0 1.5px 1px -.5px rgba(255,255,255,.95),inset 0 -1.5px 1.5px -.5px rgba(255,255,255,.45),
        inset 0 -10px 18px -10px rgba(var(--deep),.22),inset 0 0 0 .5px rgba(255,255,255,.28)}
    .mr{padding:1.2px;background:conic-gradient(from var(--ang),rgba(255,255,255,.98),rgba(255,255,255,.2) 18%,rgba(255,255,255,.06) 34%,rgba(255,255,255,.5) 50%,rgba(255,255,255,.06) 66%,rgba(255,255,255,.2) 82%,rgba(255,255,255,.98));
      -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;transition:opacity .3s ease}

    /* ---------- 容器形变：球体 <-> 面板 ---------- */
    .shell{position:relative;width:var(--panel-w);height:var(--panel-h);border-radius:28px;
      --veil:.46;--bl:22px;--br:1.08;--sheen:.3;--a:calc(var(--a0,.5) * .8);--rr:28px;
      box-shadow:0 30px 70px -22px rgba(var(--deep),.5),0 8px 22px -8px rgba(var(--deep),.22);
      transition:width var(--open) var(--spring),height var(--open) var(--spring),border-radius var(--open) var(--ease),
        box-shadow var(--open) var(--ease),transform 320ms var(--spring)}
    .shell.compact{width:var(--orb);height:var(--orb);border-radius:50%;cursor:pointer;
      --veil:0;--bl:3px;--br:1.04;--sheen:.42;--a:var(--a0,.5);--rr:32px;
      box-shadow:0 14px 30px -10px rgba(var(--deep),.55),0 3px 8px -2px rgba(var(--deep),.25);
      transition-duration:var(--close),var(--close),var(--close),var(--close),320ms;
      transition-timing-function:var(--settle),var(--settle),var(--ease),var(--ease),var(--spring)}
    .shell.compact:hover{transform:scale(1.07);box-shadow:0 18px 38px -10px rgba(var(--deep),.6),0 4px 10px -2px rgba(var(--deep),.25)}
    .shell.compact:active{transform:scale(.9);transition-duration:140ms}

    /* ---------- 球体态 ---------- */
    .orb{position:absolute;right:0;bottom:0;width:var(--orb);height:var(--orb);padding:0;border:0;border-radius:50%;background:none;cursor:pointer;
      z-index:4;overflow:hidden;opacity:0;visibility:hidden;pointer-events:none;transform:scale(.55) rotate(-18deg);
      transition:opacity 140ms ease,transform 260ms var(--ease),visibility 0s linear 140ms}
    .orb img{position:absolute;left:var(--logo-x);top:var(--logo-y);width:var(--logo-w);transform:translate(-50%,-50%);display:block;pointer-events:none;
      filter:drop-shadow(0 .6px .6px rgba(var(--deep),.55)) drop-shadow(0 0 6px rgba(var(--deep),.25))}
    .orb::after{content:'';position:absolute;inset:0;border-radius:50%;pointer-events:none;
      background:radial-gradient(42% 26% at 40% 16%,rgba(255,255,255,.55),rgba(255,255,255,0) 100%)}
    .compact .orb{opacity:1;visibility:visible;pointer-events:auto;transform:none;
      transition:opacity 220ms ease 200ms,transform 620ms var(--spring) 150ms,visibility 0s}
    .orb:focus-visible{outline:3px solid #fff;outline-offset:-5px}

    /* ---------- 面板内容 ---------- */
    .pane{position:absolute;right:0;bottom:0;z-index:2;width:var(--panel-w);height:var(--panel-h);border-radius:inherit;overflow:hidden;
      display:flex;flex-direction:column;
      opacity:1;filter:none;transition:opacity 260ms ease 150ms,filter 380ms var(--ease) 120ms}
    .compact .pane{opacity:0;filter:blur(8px);pointer-events:none;transition:opacity 120ms ease,filter 180ms ease}
    .pane .stag{transition:opacity 360ms ease calc(160ms + var(--i,0) * 48ms),transform 560ms var(--spring) calc(140ms + var(--i,0) * 48ms)}
    .compact .pane .stag{opacity:0;transform:translateY(14px) scale(.985);transition:opacity 100ms ease,transform 180ms ease}

    header{flex:none;display:flex;align-items:center;gap:11px;padding:16px 16px 4px}
    .brand{width:38px;height:38px;flex:none;border-radius:50%;position:relative;overflow:hidden;
      background:radial-gradient(140% 120% at 28% 12%,rgba(var(--rgb),.78),rgb(var(--rgb)) 52%,rgb(var(--deep)));
      box-shadow:inset 0 1px 1px rgba(255,255,255,.7),inset 0 -2px 4px rgba(var(--deep),.35),0 4px 10px -3px rgba(var(--deep),.5)}
    .brand img{position:absolute;left:var(--logo-x);top:var(--logo-y);width:var(--logo-w);transform:translate(-50%,-50%)}
    .titles{flex:1;min-width:0}
    .title{font-size:15px;font-weight:650;letter-spacing:.01em;line-height:1.3}
    .sub{font-size:12px;color:var(--ink2);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .close{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;padding:0;border:0;cursor:pointer;color:rgb(var(--deep));
      background:rgba(255,255,255,.52);box-shadow:inset 0 .5px 0 rgba(255,255,255,.92),0 1px 3px rgba(var(--deep),.12);
      transition:background-color .18s ease,transform .35s var(--spring)}
    .close:hover{background:rgba(255,255,255,.78)}.close:active{transform:scale(.9)}
    .close svg{width:15px;height:15px}

    .body{flex:1;min-height:0;overflow:auto;padding:8px 14px 16px;overscroll-behavior:contain;
      scrollbar-width:thin;scrollbar-color:rgba(var(--deep),.22) transparent;
      mask-image:linear-gradient(180deg,transparent 0,#000 6px,#000 calc(100% - 14px),transparent);-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 6px,#000 calc(100% - 14px),transparent)}
    .body>*+*{margin-top:10px}

    .status{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;border-radius:14px;font-size:12.5px;font-weight:500;line-height:1.45;overflow-wrap:anywhere;
      background:rgba(255,255,255,.36);color:color-mix(in srgb,var(--ink) 88%,transparent);
      box-shadow:inset 0 .5px 0 rgba(255,255,255,.82),0 1px 3px rgba(var(--deep),.08)}
    .status::before{content:'';flex:none;width:7px;height:7px;margin-top:5.5px;border-radius:50%;background:#f0a800;box-shadow:0 0 0 3px rgba(240,168,0,.2)}
    .status.good{color:var(--ink)}.status.good::before{background:#22b573;box-shadow:0 0 0 3px rgba(34,181,115,.18)}
    .status.error{background:rgba(255,226,228,.58);color:#8f1515}.status.error::before{background:#ff3b30;box-shadow:0 0 0 3px rgba(255,59,48,.18)}

    .actions{display:flex;gap:7px;flex-wrap:wrap}
    .btn{height:34px;padding:0 15px;border:0;border-radius:17px;cursor:pointer;font-size:13px;font-weight:600;color:rgb(var(--deep));white-space:nowrap;
      background:rgba(255,255,255,.56);box-shadow:inset 0 .5px 0 rgba(255,255,255,.95),0 1px 3px rgba(var(--deep),.14);
      transition:background-color .18s ease,transform .35s var(--spring),filter .2s ease}
    .btn:hover{background:rgba(255,255,255,.78);filter:brightness(1.03)}.btn:active{transform:scale(.94);transition-duration:.1s}
    .btn.primary{color:#fff;letter-spacing:.01em;
      background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,0) 55%),linear-gradient(180deg,rgba(var(--rgb),.92),rgb(var(--deep)));
      box-shadow:inset 0 1px .5px rgba(255,255,255,.65),inset 0 -1px 1px rgba(0,0,0,.18),0 8px 18px -8px rgba(var(--deep),.75)}
    .btn.primary:hover{background:linear-gradient(180deg,rgba(255,255,255,.26),rgba(255,255,255,0) 55%),linear-gradient(180deg,rgba(var(--rgb),.95),rgb(var(--deep)));filter:brightness(1.06)}
    .btn.small{height:28px;padding:0 12px;font-size:12px;border-radius:14px}
    .btn:disabled{opacity:.42;cursor:default;filter:none;transform:none}
    button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid rgb(var(--rgb));outline-offset:2px}

    section.card{padding:13px 14px 12px;border-radius:18px;
      background:rgba(255,255,255,.35);
      box-shadow:inset 0 .5px 0 rgba(255,255,255,.85),inset 0 0 0 .5px rgba(255,255,255,.28),0 4px 14px -8px rgba(var(--deep),.16)}
    .card-head{display:flex;align-items:center;gap:7px;margin-bottom:10px}
    .card-head h3{margin:0;font-size:14.5px;font-weight:650;letter-spacing:.005em}
    .tailno{font-size:12px;font-weight:500;color:var(--ink3);font-variant-numeric:tabular-nums}
    .badge{margin-left:auto;font-size:11.5px;font-weight:600;padding:2.5px 9px;border-radius:999px;color:rgb(var(--deep));
      background:rgba(255,255,255,.5);box-shadow:inset 0 .5px 0 rgba(255,255,255,.88)}
    .badge.live{color:#fff;
      background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,0) 55%),linear-gradient(180deg,rgba(var(--rgb),.92),rgb(var(--deep)));
      box-shadow:inset 0 .5px 0 rgba(255,255,255,.6),0 4px 10px -4px rgba(var(--deep),.65)}

    .months{display:flex;gap:4px;padding:3.5px;border-radius:14px;background:rgba(var(--deep),.09);box-shadow:inset 0 1px 2px rgba(var(--deep),.1);margin-bottom:4px}
    .months button{flex:1;border:0;border-radius:11px;padding:5px 4px;cursor:pointer;background:transparent;line-height:1.25;font-variant-numeric:tabular-nums;
      display:flex;flex-direction:column;align-items:center;gap:1px;transition:background-color .18s ease,transform .35s var(--spring)}
    .months button b{font-size:13px;font-weight:600}
    .months button span{font-size:11px;font-weight:500;color:var(--ink3)}
    .months .done{background:rgba(255,255,255,.64);box-shadow:inset 0 .5px 0 rgba(255,255,255,.92),0 1px 4px rgba(var(--deep),.12)}
    .months .done span{color:#14865c}
    .months .missing span{color:#b27200}
    .months button:not(:disabled):hover{background:rgba(255,255,255,.82)}
    .months button:not(:disabled):active{transform:scale(.95)}
    .months button:disabled{cursor:default}

    .metric{padding:10px 2px 2px}
    .metric+.metric{border-top:.5px solid rgba(var(--deep),.1)}
    .mhead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
    .mlabel{font-size:13px;font-weight:550;color:var(--ink)}
    .mval{font-size:16.5px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
    .mval small{font-size:11.5px;font-weight:500;color:var(--ink3);margin-left:2px}
    .track{position:relative;height:7px;margin:7px 0 5px;border-radius:4px;overflow:hidden;
      background:rgba(var(--deep),.13);box-shadow:inset 0 1px 1.5px rgba(var(--deep),.18)}
    .fill{height:100%;width:0;border-radius:inherit;position:relative;overflow:hidden;
      background:linear-gradient(90deg,rgba(var(--rgb),.72),rgb(var(--rgb)) 70%,rgb(var(--deep)));
      box-shadow:0 0 8px rgba(var(--rgb),.45);transition:width .7s var(--ease) .08s,background .4s ease}
    .fill.ok{background:linear-gradient(90deg,rgba(var(--rgb),.72),rgb(var(--rgb)) 70%,rgb(var(--deep)));
      box-shadow:0 0 8px rgba(var(--rgb),.45)}
    .fill.full{background:linear-gradient(90deg,#4cd690,#1fb26b);box-shadow:0 0 8px rgba(31,178,107,.4)}
    .fill::before{content:'';position:absolute;left:0;right:0;top:1px;height:2px;border-radius:2px;background:rgba(255,255,255,.55)}
    .mfoot{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--ink2);font-variant-numeric:tabular-nums}
    .note{margin-top:6px;font-size:11.5px;color:color-mix(in srgb,var(--ink) 78%,transparent);padding:5px 9px;border-radius:10px;
      background:rgba(255,255,255,.38);box-shadow:inset 0 .5px 0 rgba(255,255,255,.75)}

    .unknown{padding:11px 13px;border-radius:16px;background:rgba(255,255,255,.42);box-shadow:inset 0 .5px 0 rgba(255,255,255,.85);overflow-wrap:anywhere}
    .unknown .q{font-size:12.5px;margin-bottom:7px}.unknown .q b{font-weight:650}
    .inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:var(--ink2)}

    details.glass{border-radius:18px;background:rgba(255,255,255,.34);box-shadow:inset 0 .5px 0 rgba(255,255,255,.82)}
    details.glass>summary{list-style:none;cursor:pointer;padding:11px 14px;font-weight:600;font-size:13.5px;display:flex;align-items:center;justify-content:space-between}
    details.glass>summary::-webkit-details-marker{display:none}
    details.glass>summary::after{content:'';width:7px;height:7px;border-right:1.8px solid var(--ink2);border-bottom:1.8px solid var(--ink2);transform:rotate(45deg) translateY(-2px);transition:transform 260ms var(--spring)}
    details.glass[open]>summary::after{transform:rotate(225deg) translateY(-2px)}
    .form{padding:0 14px 14px;display:grid;grid-template-columns:1fr 1fr;gap:9px 10px}
    .form .full{grid-column:1/-1}
    .form label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:550;color:var(--ink2);min-width:0}
    .form label.check{flex-direction:row;align-items:center;gap:8px;font-size:13px;font-weight:550;color:var(--ink)}
    .form h4{grid-column:1/-1;margin:6px 0 -2px;font-size:11px;font-weight:650;color:var(--ink3);letter-spacing:.06em}
    input,select{height:36px;width:100%;padding:0 11px;border:0;border-radius:11px;color:var(--ink);font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;
      background:rgba(255,255,255,.68);box-shadow:inset 0 1px 2px rgba(var(--deep),.14),inset 0 0 0 .5px rgba(var(--deep),.12);outline:none;transition:box-shadow .2s ease}
    input:focus,select:focus{box-shadow:inset 0 1px 2px rgba(var(--deep),.14),0 0 0 2.5px rgba(var(--rgb),.55)}
    input[type=checkbox]{width:17px;height:17px;padding:0;accent-color:rgb(var(--rgb));box-shadow:none}
    .unknown select,.unknown input,.alias select,.alias input{width:auto;height:30px;font-size:12.5px}
    .unknown input,.alias input{width:70px}
    .alias{padding:9px 11px;border-radius:13px;background:rgba(255,255,255,.46);box-shadow:inset 0 .5px 0 rgba(255,255,255,.8);font-size:12.5px;overflow-wrap:anywhere}
    .alias .inline{margin-top:6px}
    .muted{font-size:11.5px;color:var(--ink3);line-height:1.5;margin:0}
    a{color:rgb(var(--deep));font-weight:600;text-decoration:none}a:hover{text-decoration:underline}
    .foot{padding:2px 4px 0;border-top:.5px solid rgba(var(--deep),.12)}
    .stack{display:grid;gap:10px}.stack:empty{display:none}

    @media(max-width:520px){:host{right:12px;bottom:12px;--panel-w:calc(100vw - 24px);--panel-h:min(800px,calc(100dvh - 24px))}.form{grid-template-columns:1fr}}
    @media(prefers-reduced-motion:reduce){.shell,.pane,.orb,.mat>i,.stag,.fill,.compact .pane,.compact .orb,.compact .pane .stag{transition:none!important}}
    @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.mt{--veil:.82}}`;
  try { const sh = new CSSStyleSheet(); sh.replaceSync(TRACKER_CSS); shadow.adoptedStyleSheets = [sh]; }
  catch { const style = el('style', TRACKER_CSS); shadow.append(style); }

  const svgDefs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgDefs.setAttribute('class', 'defs'); svgDefs.setAttribute('width', '0'); svgDefs.setAttribute('height', '0'); svgDefs.setAttribute('aria-hidden', 'true');
  const defsEl = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); defsEl.id = 'rtt-defs';
  svgDefs.append(defsEl);

  const shell = el('div', undefined, 'shell surf');
  const mat = el('span', undefined, 'mat');
  mat.innerHTML = '<i class="mb"></i><i class="ml"></i><i class="mt"></i><i class="mh"></i><i class="mr"></i>';
  // Official Amex blue-box mark with the #006FCF blue turned transparent, so the
  // orb's own blue glass fills the whole circle and the square edge disappears.
  const logoImg = (alt = '') => { const i = el('img'); i.src = LOGO; i.alt = alt; i.draggable = false; return i; };
  const orb = el('button', undefined, 'orb');
  orb.append(logoImg('American Express'));
  orb.title = '展开 Amex 活动进度'; orb.setAttribute('aria-label', '展开 Amex 活动进度');
  const pane = el('div', undefined, 'pane'); pane.id = 'amex-panel';
  orb.setAttribute('aria-controls', pane.id);

  const header = el('header', undefined, 'stag'); header.style.setProperty('--i', 0);
  const brand = el('div', undefined, 'brand'); brand.append(logoImg());
  const titles = el('div', undefined, 'titles');
  const contextText = el('div', '等待月份与卡片信息', 'sub');
  titles.append(el('div', 'Amex 活动进度', 'title'), contextText);
  const collapse = el('button', undefined, 'close');
  collapse.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h8"/></svg>';
  collapse.title = '收起 (Esc)'; collapse.setAttribute('aria-label', '收起');
  header.append(brand, titles, collapse);

  const body = el('div', undefined, 'body');
  const live = el('div', status, 'status stag'); live.setAttribute('role', 'status'); live.style.setProperty('--i', 1);
  const actions = el('div', undefined, 'actions stag'); actions.style.setProperty('--i', 2);
  const batchButton = el('button', '扫描本季度', 'btn primary'), scanButton = el('button', '重新扫描', 'btn'), pauseButton = el('button', '暂停', 'btn');
  actions.append(batchButton, scanButton, pauseButton);
  const charts = el('div', undefined, 'stack'), diagnostic = el('div', undefined, 'stack');

  // ---------- settings ----------
  const settings = el('details', undefined, 'glass stag'); settings.style.setProperty('--i', 6);
  settings.append(el('summary', '设置'));
  const form = el('div', undefined, 'form'); settings.append(form);
  function field(parent, label, value, type = 'text', full = false) {
    const box = el('label', label), f = el('input');
    f.type = type; f.value = value; if (full) box.classList.add('full');
    box.append(f); parent.append(box); return f;
  }
  function choose(parent, label, options, value, full = false) {
    const box = el('label', label), f = el('select');
    for (const [v, text] of options) { const o = el('option', text); o.value = v; f.append(o); }
    f.value = value; if (full) box.classList.add('full');
    box.append(f); parent.append(box); return f;
  }
  form.append(el('h4', '卡片'));
  const pTail = field(form, '白金卡末五位', config.platinumTail), eTail = field(form, 'Explorer 末五位', config.explorerTail);
  pTail.inputMode = eTail.inputMode = 'numeric'; pTail.maxLength = eTail.maxLength = 5;
  form.append(el('h4', '限额'));
  const platCap = field(form, '白金每类季度上限 HK$', config.platinumCap, 'number');
  const policySelect = choose(form, 'Explorer 限额', [['official', '官方条款'], ['custom', '自定义']], config.explorerPolicy);
  const customBox = el('div', undefined, 'form full'); customBox.style.padding = '0';
  const explorerPeriod = choose(customBox, 'Explorer 周期', [['quarter', '每季度'], ['month', '每月']], config.explorerPeriod);
  const localCap = field(customBox, '本地日常 HK$', config.explorerLocalCap, 'number');
  const fxCap = field(customBox, '外币签账 HK$', config.explorerFxCap, 'number');
  const merchantCap = field(customBox, '指定商户 5X HK$', config.explorerMerchantCap, 'number');
  form.append(customBox);
  const syncCustom = () => customBox.classList.toggle('hidden', policySelect.value !== 'custom');
  policySelect.addEventListener('change', syncCustom); syncCustom();
  const autoBox = el('label', undefined, 'check full'), auto = el('input'); auto.type = 'checkbox'; auto.checked = config.autoExpand;
  autoBox.append(auto, document.createTextNode('自动点击「展示更多」／「請重試」')); form.append(autoBox);
  const saveRow = el('div', undefined, 'actions full'), saveButton = el('button', '保存设置', 'btn primary small');
  saveRow.append(saveButton); form.append(saveRow);

  const advanced = el('details', undefined, 'glass full'); advanced.append(el('summary', '高级'));
  const adv = el('div', undefined, 'form'); advanced.append(adv); form.append(advanced);
  adv.append(el('p', '换算除数＝该加赏行每 HK$1 发放的额外积分（不是宣传总倍数）。修改后重新计算所有已存月份。', 'muted full'));
  const rateFields = {};
  for (const card of ['platinum', 'explorer']) for (const category of CATEGORIES[card]) {
    const name = `${card}${cap1(category)}Rate`;
    rateFields[name] = field(adv, `${card === 'platinum' ? '白金' : 'Explorer'} ${LABELS[category]} ÷`, config[name], 'number');
    rateFields[name].step = '0.01'; rateFields[name].min = '0.01';
  }
  const manualSelect = choose(adv, '临时指定卡片', [['', '自动识别'], ['platinum', '白金卡'], ['explorer', 'Explorer']], '');
  const monthInput = field(adv, '临时指定月份', '', 'month');
  adv.append(el('p', '仅在网页没有月份下拉框时生效；行内卡号冲突仍会停止扫描。', 'muted full'));
  const aliasHead = el('h4', '已确认的加赏名称'); adv.append(aliasHead);
  const aliasManager = el('div', undefined, 'full'); aliasManager.style.cssText = 'display:grid;gap:6px'; adv.append(aliasManager);
  adv.append(el('h4', '备份'));
  const backupActions = el('div', undefined, 'actions full');
  const exportButton = el('button', '导出', 'btn small'), importButton = el('button', '导入', 'btn small'), deleteButton = el('button', '删除当前月快照', 'btn small');
  backupActions.append(exportButton, importButton, deleteButton); adv.append(backupActions);
  const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = '.json,application/json'; fileInput.hidden = true; adv.append(fileInput);

  const foot = el('div', undefined, 'foot stag'); foot.style.setProperty('--i', 7);
  const links = el('p', undefined, 'muted');
  for (const [label, href] of [
    ['白金条款', 'https://www.americanexpress.com/content/dam/amex/hk/benefits/pdf/TnCs_platinum-membership-rewards-accelerator.pdf'],
    ['Explorer条款', 'https://www.americanexpress.com/content/dam/amex/hk/en/staticassets/pdf/cards/explorer-credit-card/MRTnC_ENG.pdf']
  ]) { const a = el('a', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; links.append(a, document.createTextNode('　')); }
  foot.append(links, el('p', '条款核对：2026-11-05。金额由已入账加赏积分反推，按网站所选月份归集；✓ 只表示该月已展开到底，不代表加赏已发齐。', 'muted'));

  body.append(live, actions, charts, diagnostic, settings, foot);
  pane.append(header, body);
  shell.append(mat, pane, orb);
  shadow.append(svgDefs, shell);
  shell.addEventListener('click', e => { if (minimized && e.target === shell) setMinimized(false, true); });

  // 指针跟随高光 + 边缘折射贴图（与 glassOrb 保持同款液态玻璃渲染）
  shadow.addEventListener('pointermove', e => {
    const r = shell.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    shell.style.setProperty('--lx', (x * 100).toFixed(1) + '%');
    shell.style.setProperty('--ly', (y * 100).toFixed(1) + '%');
    shell.style.setProperty('--ang', (Math.atan2(y - 0.5, x - 0.5) * 180 / Math.PI + 90).toFixed(0) + 'deg');
  });
  shadow.addEventListener('pointerout', e => {
    if (!shell.contains(e.relatedTarget)) { shell.style.removeProperty('--lx'); shell.style.removeProperty('--ly'); shell.style.removeProperty('--ang'); }
  });
  function trackerLensMap(w, h, r, band) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
    const sd = (x, y) => {
      const qx = Math.abs(x - w / 2) - (w / 2 - r), qy = Math.abs(y - h / 2) - (h / 2 - r);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5, i = (y * w + x) * 4;
      const depth = -sd(px, py);
      let dx = 0, dy = 0;
      if (depth > 0 && depth < band) {
        const nx = sd(px + 1, py) - sd(px - 1, py), ny = sd(px, py + 1) - sd(px, py - 1);
        const n = Math.hypot(nx, ny) || 1, t = 1 - depth / band, m = 1 - Math.sqrt(1 - t * t);
        dx = (nx / n) * m; dy = (ny / n) * m;
      }
      d[i] = 128 + dx * 127; d[i + 1] = 128 + dy * 127; d[i + 2] = 128; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL();
  }
  const trackerLensCache = new Map();
  function lensShell(compactMode = minimized) {
    if (!host.classList.contains('lens') || !shell.isConnected) return;
    const w = compactMode ? 64 : Math.round(Math.min(440, innerWidth - (innerWidth <= 520 ? 24 : 40)));
    const hh = compactMode ? 64 : Math.round(Math.min(800, innerHeight - (innerWidth <= 520 ? 24 : 40)));
    if (!w || !hh) return;
    const r = compactMode ? 32 : 28;
    const key = `${w}x${hh}r${r}`;
    let id = trackerLensCache.get(key);
    if (!id) {
      id = 'rttl-' + key;
      if (!shadow.getElementById(id)) {
        const band = compactMode ? 15 : 13, scale = compactMode ? 30 : 24;
        defsEl.insertAdjacentHTML('beforeend',
          `<filter id="${id}" x="0" y="0" width="${w}" height="${hh}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
          `<feImage href="${trackerLensMap(w, hh, r, band)}" x="0" y="0" width="${w}" height="${hh}" preserveAspectRatio="none" result="m"/>` +
          `<feDisplacementMap in="SourceGraphic" in2="m" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/></filter>`);
      }
      trackerLensCache.set(key, id);
    }
    shell.style.setProperty('--lensf', `url(#${id})`);
    shell.style.setProperty('--rr', r + 'px');
  }
  const lensProbe = new Image();
  lensProbe.onload = () => { host.classList.add('lens'); lensShell(minimized); };
  lensProbe.src = trackerLensMap(8, 8, 4, 3);

  // 收起时面板不单独显示：右下角那个共用的玻璃球体就是它的「球」。
  // 展开：球体藏起来，面板从同一位置（同样大小的圆）展开；收起：面板缩回圆，动画结束后换回球体。
  let morphTimer = 0;
  const panelWidth = () => Math.min(440, innerWidth - 40);
  function setMinimized(value, focus = false) {
    minimized = value;
    clearTimeout(morphTimer);
    pane.inert = minimized; pane.setAttribute('aria-hidden', String(minimized));
    orb.inert = !minimized; orb.setAttribute('aria-expanded', String(!minimized));
    GM_setValue(PREFIX + 'minimized', minimized);
    if (!minimized) {
      host.style.display = '';
      shell.classList.add('compact');
      lensShell(true);
      void shell.offsetWidth;
      kit.conceal(true);
      // 有空间时，进度卡片挪到面板左边
      kit.shift(innerWidth >= panelWidth() + 380 ? panelWidth() - 64 : 0);
      requestAnimationFrame(() => { shell.classList.remove('compact'); lensShell(false); if (focus) collapse.focus({ preventScroll: true }); });
    } else {
      shell.classList.add('compact');
      lensShell(true);
      kit.shift(0);
      morphTimer = setTimeout(() => { host.style.display = 'none'; kit.conceal(false); if (focus) kit.orb.focus({ preventScroll: true }); }, 540);
    }
  }
  host.style.display = 'none';
  shell.classList.add('compact');
  const activeRoute = () => /^\/rewards\/summary\/?$/.test(location.pathname);
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const monthKey = (cardTail, month) => `${PREFIX}month:${cardTail}:${month}`;
  function loadMonth(cardTail, month) {
    const key = monthKey(cardTail, month);
    if (!cache.has(key)) cache.set(key, GM_getValue(key, null));
    return cache.get(key);
  }
  function save(key, value) {
    try { GM_setValue(key, value); cache.set(key, value); storageError = ''; return true; }
    catch (e) { storageError = `保存失败：${e.message}。尚未持久保存，请导出备份。`; return false; }
  }
  function categorySelect(card, value) {
    const s = el('select');
    for (const c of CATEGORIES[card]) { const o = el('option', LABELS[c]); o.value = c; s.append(o); }
    s.value = CATEGORIES[card].includes(value) ? value : CATEGORIES[card][0]; return s;
  }
  function renderAliases() {
    aliasManager.replaceChildren();
    if (!config.aliases.length) aliasManager.append(el('p', '暂无。网页出现新的加赏名称时会提示分类。', 'muted'));
    config.aliases.forEach((rule, index) => {
      const box = el('div', undefined, 'alias');
      box.append(el('div', `${rule.card === 'platinum' ? '白金' : 'Explorer'} · ${rule.description}`));
      const row = el('div', undefined, 'inline');
      const category = categorySelect(rule.card, rule.category);
      const divisor = el('input'); divisor.type = 'number'; divisor.min = '0.01'; divisor.step = '0.01'; divisor.value = rule.divisor;
      const update = el('button', '更新', 'btn small'), remove = el('button', '移除', 'btn small');
      const persist = () => { save(PREFIX + 'config', config); renderAliases(); renderKey = ''; render(readContext()); };
      update.onclick = () => {
        if (!Number.isFinite(+divisor.value) || +divisor.value <= 0) return;
        config.aliases[index] = { ...rule, category: category.value, divisor: +divisor.value }; persist();
      };
      remove.onclick = () => { config.aliases.splice(index, 1); persist(); };
      row.append(category, document.createTextNode('÷'), divisor, update, remove); box.append(row); aliasManager.append(box);
    });
  }
  function readContext() {
    const buttons = [...document.querySelectorAll('button.account-switcher-toggler')];
    const shown = buttons.filter(visible);
    const tails = [...new Set((shown.length ? shown : buttons).map(b => tail(b.textContent)).filter(Boolean))];
    const detected = tails.length === 1 ? tails[0] : '';
    const cardTail = manualCard ? config[manualCard + 'Tail'] : detected;
    const card = cardTail === config.platinumTail ? 'platinum' : cardTail === config.explorerTail ? 'explorer' : '';
    const select = document.querySelector('#time-filter');
    const month = select ? parseMonth(select.selectedOptions?.[0]?.textContent) : manualMonth;
    const statusSelect = document.querySelector('#status-filter');
    return { card, tail: cardTail, month, filterOK: !!statusSelect && statusSelect.value === 'ALL',
      key: `${cardTail}|${month}|${statusSelect?.value || '?'}`,
      error: manualCard && detected && cardTail !== detected ? '手动卡片与网站右上角卡号不一致，请切回自动识别。' :
        !card ? '无法识别卡片；请检查末五位设置或临时指定卡片。' :
          !month ? '无法识别月份；请检查月份下拉框或临时指定月份。' : '' };
  }
  function readTable(ctx, root = document, isVisible = visible) {
    const container = root.querySelector('#points-summary-table');
    const table = root.querySelector('#global-rewards-transactions-table');
    const rows = [], issues = [];
    let totalRows = 0;
    for (const tr of table?.querySelectorAll('tbody tr') || []) {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 8) continue;
      totalRows++;
      const field = (name, index) => norm(tr.querySelector(`[id^="#transaction-${name}-"], [id^="transaction-${name}-"]`)?.textContent ?? cells[index]?.textContent);
      const rawDate = field('date', 0), date = dateInMonth(rawDate, ctx.month);
      const cardTail = tail(field('card', 1)), description = field('description', 3), points = parseNumber(field('points', 7));
      if (!date) issues.push(`日期「${rawDate}」格式未知或超出 ${ctx.month} 及上月范围，等待表格切换完成`);
      if (cardTail && cardTail !== ctx.tail) issues.push(`行内发现其他卡号 ${cardTail}，停止以免混入另一张卡`);
      if (!cardTail && relevant({ description })) issues.push('加赏行缺少卡号，无法确认所属卡片');
      if (points === null && relevant({ description })) issues.push('加赏积分不是可识别数字');
      if (date && points !== null) rows.push({ date, cardTail, description, points, status: field('status', 2) });
    }
    // Mixed current/previous month rows are legitimate (observed October 2026).
    // An entirely previous-month table is still ambiguous: keep waiting rather
    // than saving stale React content under the newly selected month.
    if (totalRows && !rows.some(r => r.date.startsWith(ctx.month + '-')))
      issues.push('当前表格日期全部不在所选月份，尚不能区分跨月记录与切换中的旧表格；请确认网页已加载完成');
    const buttons = [...(container?.querySelectorAll('button') || [])].filter(isVisible);
    const control = buttons.find(b => /^(展示更多|顯示更多|显示更多|請重試|请重试|關閉展示|关闭展示|Show more|Show less|Retry|Try again)$/i.test(norm(b.textContent)));
    const text = norm(control?.textContent);
    const kind = /^(關閉展示|关闭展示|Show less)$/i.test(text) ? 'done' :
      /^(請重試|请重试|Retry|Try again)$/i.test(text) ? 'retry' : control ? 'more' : 'none';
    const disabled = !!control && (control.disabled || control.getAttribute('aria-disabled') === 'true');
    const busy = !![...(container?.querySelectorAll('[aria-busy="true"], [role="progressbar"], [class*="loading"], [class*="Loading"], [class*="spinner"], [class*="Spinner"]') || [])].find(isVisible);
    const error = [...(container?.querySelectorAll('[role="alert"]') || [])].some(e => isVisible(e) && /失敗|失败|錯誤|错误|error|try again/i.test(e.textContent));
    const empty = !!container && /沒有(?:任何)?(?:交易|紀錄|記錄)|尚無交易|没有(?:任何)?(?:交易|记录)|no (?:transactions|activity|results)/i.test(norm(container.textContent));
    const fingerprint = JSON.stringify(rows.map(r => [r.date, r.cardTail, r.description, r.points, r.status]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    const carriedRows = rows.filter(r => !r.date.startsWith(ctx.month + '-')).length;
    return { container, table, rows, totalRows, carriedRows, issues: [...new Set(issues)], control, kind, disabled, busy, error, empty, fingerprint };
  }
  // ---------------------------------------------------------------- 推送到记账本
  const LEDGER_URL = 'https://reward-tracker.tom-rt.workers.dev';
  let ledgerNote = '', ledgerBusy = false;
  const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
  function pushReport(month, manual = false) {
    const token = GM_getValue(PREFIX + 'ledgerToken', '');
    if (typeof GM_xmlhttpRequest !== 'function') { if (manual) ledgerNote = '记账本：脚本缺少 GM_xmlhttpRequest 权限'; return; }
    if (!token) {
      ledgerNote = manual ? '记账本：还没设置写入令牌（点球体 → 活动追踪 → 设置记账本写入令牌）' : '';
      if (manual) kit.toast('还没设置记账本写入令牌：点球体 → 活动追踪 →「设置记账本写入令牌」。', 'warn', 9000, '记账本未连接');
      return;
    }
    if (!month || ledgerBusy) return;
    const report = buildReport(loadMonth, config, month);
    const sig = fnv(JSON.stringify(report));
    const sent = GM_getValue(PREFIX + 'ledgerSent', {}) || {};
    if (!manual && sent[report.quarter] === sig) return;
    ledgerBusy = true;
    const t = kit.task('tracker-push', `推送 ${report.quarter} 积分汇总`);
    const scanned = Object.values(report.cards).reduce((n, c) => n + Object.values(c.scanned).filter(Boolean).length, 0);
    t.step(`整理白金卡和 Explorer 的季度汇总（已扫描 ${scanned}/6 个月）`, 28);
    setTimeout(() => t.step('上传到记账本', 52).trickle(95, 2500), 260);
    const fail = (msg) => {
      ledgerBusy = false; ledgerNote = `记账本推送失败：${msg}`; renderKey = '';
      t.fail(msg, { title: '汇总推送失败', retry: () => pushReport(month, true) });
    };
    GM_xmlhttpRequest({
      method: 'POST', url: LEDGER_URL + '/api/manual/tracker', timeout: 30000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ ...report, pushed_at: new Date().toISOString() }),
      onload: r => {
        if (r.status !== 200) { let msg = r.statusText; try { msg = JSON.parse(r.responseText).error || msg; } catch { /* 非 JSON */ } return fail(`记账本返回 ${r.status}：${msg}`); }
        ledgerBusy = false;
        sent[report.quarter] = sig; GM_setValue(PREFIX + 'ledgerSent', sent);
        ledgerNote = `记账本：已推送 ${report.quarter} 汇总`; renderKey = '';
        const incomplete = Object.values(report.cards).some(c => Object.values(c.categories).some(x => !x.complete));
        t.done(`已推送 ${report.quarter} 汇总 · 已扫描 ${scanned}/6 个月${incomplete ? ' · 部分月份未扫描完整' : ''}`, 'good', 5200);
      },
      onerror: () => fail('连不上记账本 Worker'),
      ontimeout: () => fail('请求超时'),
    });
  }

  // ---------------------------------------------------------------- 扫描进度卡片
  // 一次扫描（单月，或「扫描本季度」的 3 个月）对应一张卡片；进度 = 已完成月份 + 当前月份的展开进度
  const expandPct = () => (session ? 10 + 74 * (1 - Math.exp(-session.clicks / 5)) : 10);
  const scanUi = {
    task: null, key: '', last: 0,
    title(ctx) { return batch ? `扫描 ${ctx.month.slice(0, 4)} Q${Math.ceil(+ctx.month.slice(5) / 3)} 积分记录` : `扫描 ${+ctx.month.slice(5)} 月积分记录 · ${ctx.card === 'platinum' ? '白金卡' : 'Explorer'}`; },
    overall(p) {
      if (!batch) return p;
      const total = batch.total || 1, done = total - batch.queue.length - 1;
      return (Math.max(0, done) + p / 100) / total * 100;
    },
    begin(ctx) {
      const key = batch ? `batch:${batch.tail}:${batch.original}` : `one:${session.key}:${session.started}`;
      if (this.task && this.key === key) return;
      if (this.task && !this.key.startsWith('batch:')) this.task.close();
      this.key = key; this.last = -1;
      this.task = kit.task('tracker-scan', this.title(ctx));
      this.task.step(batch ? `读取 ${ctx.month} 的积分记录（${(batch.total || 1) - batch.queue.length}/${batch.total || 1}）` : '读取积分记录表格', this.overall(4));
    },
    step(text, p) {
      if (!this.task) return;
      const v = this.overall(p);
      if (v < this.last - 0.5 && !batch) return;          // 单月扫描进度只往前走
      this.last = v;
      this.task.step(batch ? `${session?.context?.month || ''} · ${text}` : text, v);
    },
    finish(ctx, view) {
      if (!this.task || session.uiDone) return;
      session.uiDone = true;
      if (batch && batch.queue.length) { this.step(`已保存 ${ctx.month}，切换到下个月…`, 100); return; }
      const t = this.task; this.task = null; this.key = '';
      t.done(batch ? `本季度 ${batch.total || 1} 个月都已保存（${ctx.month} ${view.totalRows} 行）` : `已保存 ${ctx.month} · ${view.totalRows} 行${view.carriedRows ? `（含 ${view.carriedRows} 行上月日期）` : ''}`, 'good', 4200);
    },
    warn(text) { if (!this.task) return; const t = this.task; this.task = null; this.key = ''; t.done(text, 'warn', 9000); },
    fail(text) { if (!this.task) return; const t = this.task; this.task = null; this.key = ''; t.fail(text, { title: '扫描停止', retry: () => scanButton.click() }); },
    stop() { if (!this.task) return; const t = this.task; this.task = null; this.key = ''; t.close(); },
  };

  // ---------------------------------------------------------------- 球体菜单（活动追踪一组）
  function refreshTrackerMenu(route = activeRoute()) {
    const off = route ? '' : '在「积分记录」页面可用';
    kit.section('tracker', {
      title: '活动追踪 · 积分加赏', order: 2,
      items: [
        { label: '打开活动进度', icon: 'chart', hint: off || '两张卡本季度的加赏进度', disabled: !route, onClick: () => setMinimized(false, true) },
        { label: '扫描本季度', icon: 'scan', hint: off || '自动切换 3 个月份并展开保存', disabled: !route, onClick: () => { if (batch) return; batchButton.click(); } },
        { label: '立即推送季度汇总', icon: 'upload', hint: off, disabled: !route, onClick: () => { const ctx = readContext(); if (!ctx.month) { kit.toast('请先打开积分记录页面', 'warn'); return; } pushReport(ctx.month, true); renderKey = ''; } },
        { label: '设置', icon: 'gear', hint: off || '卡号、限额、自动展开', disabled: !route, onClick: () => { setMinimized(false); settings.open = true; } },
        { label: '导出备份', icon: 'download', onClick: () => exportButton.click() },
        { label: '设置记账本写入令牌', icon: 'key', value: GM_getValue(PREFIX + 'ledgerToken', '') ? '已设置' : '未设置', keepOpen: true, onClick: setLedgerToken },
      ],
    });
  }
  async function setLedgerToken() {
    const has = !!GM_getValue(PREFIX + 'ledgerToken', '');
    const v = await kit.dialog({ title: '写入令牌（活动追踪）', message: '记账本 Worker 的 INGEST_TOKEN，只用于写入。和交易推送脚本用的是同一个，但两个脚本各存一份。' + (has ? '已设置；留空保持不变。' : ''),
      fields: [{ name: 'token', label: 'INGEST_TOKEN', type: 'password', placeholder: has ? '••••••••（不变）' : '粘贴令牌' }], ok: '保存' });
    if (v?.token?.trim()) { GM_setValue(PREFIX + 'ledgerToken', v.token.trim()); ledgerNote = '记账本：写入令牌已保存'; renderKey = ''; kit.toast('活动追踪的写入令牌已保存', 'good'); refreshTrackerMenu(); }
  }

  function reset(ctx = readContext()) {
    session = { key: ctx.key, context: ctx, started: Date.now(), stableSince: Date.now(), signature: '',
      pending: null, clicks: 0, retries: 0, failed: '', saved: '', done: false, lastProgress: Date.now() };
    renderKey = '';
  }
  function say(text, level = 'warn') { status = text; severity = level; }
  function snapshotsFor(card, month) {
    return Object.fromEntries(quarterMonths(month).map(m => [m, loadMonth(config[card + 'Tail'], m)]));
  }
  const money = n => n.toLocaleString('en-HK', { maximumFractionDigits: 0 });
  function metric(name, t, forceWarn = false) {
    const box = el('div', undefined, 'metric'), head = el('div', undefined, 'mhead');
    const val = el('span', undefined, 'mval');
    const hasData = t.complete || t.count;
    val.textContent = hasData ? `$${money(t.spend)}` : '—';
    if (hasData && t.cap) val.append(el('small', `/ ${money(t.cap)}`));
    head.append(el('span', name, 'mlabel'), val); box.append(head);
    if (t.cap) {
      const track = el('div', undefined, 'track'), fill = el('div', undefined, 'fill');
      if (t.complete && !t.note && !forceWarn) fill.classList.add(t.spend >= t.cap ? 'full' : 'ok');
      const pct = Math.max(0, Math.min(100, t.spend / t.cap * 100));
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${pct}%`; }));
      track.append(fill); box.append(track);
    }
    const foot = el('div', undefined, 'mfoot');
    foot.append(el('span', !hasData ? '尚无完整数据' : t.cap
      ? `${(t.spend / t.cap * 100).toFixed(1)}% · 尚余 $${money(Math.max(0, t.cap - t.spend))}${t.period === 'month' ? '（本月）' : ''}`
      : '无上限资料'),
    el('span', `${t.points.toLocaleString('en-HK')} 分 · ${t.count} 笔${t.complete ? '' : ' · 未齐'}`));
    box.append(foot);
    if (t.note) box.append(el('div', t.note, 'note'));
    return box;
  }
  function render(ctx) {
    live.textContent = (storageError || status) + (ledgerNote ? ` · ${ledgerNote}` : '');
    live.className = 'status stag' + (storageError || severity === 'error' ? ' error' : severity === 'good' ? ' good' : '');
    contextText.textContent = ctx.month ? `${ctx.card === 'platinum' ? 'Platinum' : ctx.card === 'explorer' ? 'Explorer' : '未识别'} · ${ctx.tail || '—'} · ${ctx.month.replace('-', '年')}月 · Q${Math.ceil(+ctx.month.slice(5) / 3)}` : '等待月份与卡片信息';
    pauseButton.textContent = paused ? '继续' : '暂停';
    batchButton.textContent = batch ? '停止季度扫描' : '扫描本季度';
    if (!ctx.month) return;
    const data = Object.fromEntries(['platinum', 'explorer'].map(card => [card, snapshotsFor(card, ctx.month)]));
    const key = JSON.stringify([ctx.card, ctx.month, data, config, session?.done, paused]);
    if (key === renderKey) return;
    renderKey = key; charts.replaceChildren(); diagnostic.replaceChildren();
    const order = [ctx.card || 'platinum', ctx.card === 'platinum' ? 'explorer' : 'platinum'];
    order.forEach((card, i) => {
      const section = el('section', undefined, 'card stag'); section.style.setProperty('--i', 3 + i);
      const head = el('div', undefined, 'card-head');
      head.append(el('h3', card === 'platinum' ? 'Platinum' : 'Explorer'), el('span', `·${config[card + 'Tail']}`, 'tailno'),
        el('span', card === ctx.card ? '当前' : '已存快照', card === ctx.card ? 'badge live' : 'badge'));
      section.append(head);
      const months = el('div', undefined, 'months');
      for (const m of quarterMonths(ctx.month)) {
        const snap = data[card][m];
        const button = el('button', undefined, snap ? 'done' : 'missing');
        button.append(el('b', `${+m.slice(5)}月`), el('span', snap ? `✓ ${snap.totalRows}行` : '待扫描'));
        button.disabled = card !== ctx.card;
        button.title = snap ? `完整快照：${new Date(snap.scannedAt).toLocaleString()}；当前月仍可能新增记录` : '点击切换到此月份并自动扫描';
        button.onclick = () => { batch = null; changeMonth(m); };
        months.append(button);
      }
      section.append(months);
      const values = [];
      for (const category of CATEGORIES[card]) {
        const t = summarize(data[card], card, category, ctx.month, config); values.push(t);
        if (!t.note && !rules(config).some(r => r.card === card && r.category === category))
          t.note = t.count ? '' : '入账名称尚未确认；出现新加赏行时会提示分类。';
        section.append(metric(LABELS[category], t, card === ctx.card && !session?.done));
      }
      charts.append(section);
      for (const description of [...new Set(values.flatMap(t => t.unknown))]) {
        const box = el('div', undefined, 'unknown');
        const q = el('div', undefined, 'q'); q.append(document.createTextNode(`${card === 'platinum' ? '白金' : 'Explorer'} 新加赏名称：`), el('b', description));
        const row = el('div', undefined, 'inline');
        const choice = categorySelect(card, card === 'explorer' && /5x/i.test(description) ? 'merchant' : 'local');
        const divisor = el('input'); divisor.type = 'number'; divisor.min = '0.01'; divisor.step = '0.01';
        const updateDivisor = () => { divisor.value = DEFAULT_DIVISOR[card][choice.value]; };
        choice.onchange = updateDivisor; updateDivisor();
        const map = el('button', '确认分类', 'btn small primary');
        map.onclick = () => {
          const d = +divisor.value;
          if (!Number.isFinite(d) || d <= 0) return;
          config.aliases.push({ card, description, category: choice.value, divisor: d });
          if (!save(PREFIX + 'config', config)) return;
          renderAliases(); renderKey = ''; render(readContext());
        };
        row.append(choice, document.createTextNode('÷'), divisor, map); box.append(q, row); diagnostic.append(box);
      }
    });
  }
  function changeMonth(month) {
    const select = document.querySelector('#time-filter');
    const option = [...(select?.options || [])].find(o => parseMonth(o.textContent) === month);
    if (!option) { say(`网站月份列表没有 ${month}；请手动选择。`); return false; }
    // Native setter + bubbling change also works with React-controlled selects.
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    reset(); return true;
  }
  function advanceBatch(ctx) {
    if (!batch || !session.done) return;
    if (batch.tail !== ctx.tail || batch.expected !== ctx.month) { batch = null; return; }
    const next = batch.queue.shift();
    if (next) { batch.expected = next; if (!changeMonth(next)) batch = null; }
    else { const original = batch.original; batch = null; if (ctx.month !== original) changeMonth(original); }
  }
  function tick() {
    const route = activeRoute();
    if (route !== routeWasActive) {
      refreshTrackerMenu(route);
      if (!route) { clearTimeout(morphTimer); host.style.display = 'none'; shell.classList.add('compact'); kit.conceal(false); kit.shift(0); }
      else if (!minimized) setMinimized(false);
    }
    if (!route) { session = null; batch = null; routeWasActive = false; scanUi.stop(); return; }
    if (!routeWasActive) { cache.clear(); routeWasActive = true; }
    const ctx = readContext();
    if (!session || session.key !== ctx.key) {
      if (batch && (batch.tail !== ctx.tail || batch.expected !== ctx.month)) batch = null;
      reset(ctx);
    }
    if (ctx.error) { say(ctx.error); scanUi.warn(ctx.error); render(ctx); return; }
    if (paused) { say('已暂停自动扫描；显示已保存的快照。'); scanUi.stop(); render(ctx); return; }
    if (!ctx.filterOK) { say('请将网页「狀況」改为「所有」；筛选后的数据不能标为完整。'); scanUi.warn('请将网页「狀況」改为「所有」后再扫描'); render(ctx); return; }
    const view = readTable(ctx), now = Date.now();
    if (!session.done) scanUi.begin(ctx);
    const signature = JSON.stringify([view.fingerprint, view.totalRows, view.kind, view.disabled, view.busy, view.error]);
    if (signature !== session.signature) {
      session.signature = signature; session.stableSince = now; session.done = false;
    }
    if (view.issues.length) { say(view.issues.join('；')); scanUi.step('等待表格切换到所选月份…', 6); render(ctx); return; }
    if (session.failed) { say(session.failed, 'error'); scanUi.fail(session.failed); render(ctx); return; }
    if (view.busy || view.disabled) {
      if (now - session.lastProgress > 45000) session.failed = '加载超过45秒；已停止，请完成网页验证或手动重试后点「重新扫描」。';
      say(`正在等待 ${ctx.month} 加载…（${view.totalRows}行）`); scanUi.step(`等待网页加载…（已读 ${view.totalRows} 行）`, expandPct()); render(ctx); return;
    }
    if (session.pending) {
      const p = session.pending;
      if (view.fingerprint !== p.fingerprint || view.kind === 'done' || (view.kind === 'retry' && p.kind !== 'retry')) {
        session.pending = null; session.lastProgress = now;
      } else if (now - p.at < (p.kind === 'retry' ? 8000 : 18000)) {
        say(`已点击${p.kind === 'retry' ? '重试' : '展示更多'}，等待网页响应…（${view.totalRows}行）`);
        scanUi.step(`已点「${p.kind === 'retry' ? '請重試' : '展示更多'}」，等待网页响应…（已读 ${view.totalRows} 行）`, expandPct()); render(ctx); return;
      } else if (p.kind === 'retry' && view.kind === 'retry' && session.retries < 3) {
        session.pending = null;
      } else {
        session.failed = '按钮点击后没有加载新记录；请手动操作网页，再点「重新扫描」。';
        say(session.failed, 'error'); scanUi.fail(session.failed); render(ctx); return;
      }
    }
    if (view.kind === 'more' || view.kind === 'retry') {
      say(`${ctx.month} 尚未展开完：${view.totalRows}行${config.autoExpand ? '，自动加载中…' : '；请手动展开或开启自动展开。'}`);
      if (config.autoExpand) scanUi.step(`自动展开记录…（已读 ${view.totalRows} 行）`, expandPct());
      else scanUi.warn('列表没展开完：请手动点「展示更多」，或在设置里开启自动展开');
      if (config.autoExpand && now - session.stableSince >= 1800) {
        if (session.clicks >= 100 || (view.kind === 'retry' && session.retries >= 3)) session.failed = '已达自动加载／重试次数上限；请手动检查后重新扫描。';
        else {
          session.clicks++; if (view.kind === 'retry') session.retries++;
          session.pending = { at: now, fingerprint: view.fingerprint, kind: view.kind };
          view.control.click();
        }
      }
      render(ctx); return;
    }
    if (view.error) { say('网页报告加载错误，尚未保存完整快照。', 'error'); scanUi.fail('网页报告加载错误，尚未保存完整快照'); render(ctx); return; }
    const ready = (view.kind === 'done' && (view.totalRows > 0 || view.empty)) || (view.kind === 'none' &&
      ((view.totalRows > 0 && view.totalRows < 15 && !!view.table) || view.empty));
    if (!ready) {
      say(view.totalRows >= 15 ? '找不到展开按钮，但已有15行或以上；不能确认读全，请检查网页布局。' : '等待交易表格或明确的「没有记录」提示…');
      scanUi.step(view.totalRows >= 15 ? '找不到展开按钮，无法确认已读全' : '等待积分记录表格…', 6);
      render(ctx); return;
    }
    if (now - session.stableSince < 4000 || now - session.started < 5000) {
      say(`已到列表底端，等待内容稳定…（${view.totalRows}行）`); scanUi.step(`已到列表底端，确认内容稳定…（${view.totalRows} 行）`, 90); render(ctx); return;
    }
    if (session.saved !== signature) {
      const snap = makeSnapshot(ctx, view.rows, view.totalRows, now, view.kind === 'done' ? 'show-less' : view.empty ? 'empty-state' : 'short-table');
      if (save(monthKey(ctx.tail, ctx.month), snap)) { session.saved = signature; session.done = true; session.pushed = false; }
    } else session.done = true;
    if (session.done) scanUi.finish(ctx, view);
    if (session.done && !session.pushed) { session.pushed = true; setTimeout(() => pushReport(ctx.month), 700); }
    say(`${ctx.month} 已展开并保存 ${view.totalRows} 行${view.carriedRows ? `（含 ${view.carriedRows} 行上月日期，按网站所选月份归集）` : ''}；同月重扫替换旧快照。`, 'good');
    render(ctx); advanceBatch(ctx);  }

  collapse.onclick = () => setMinimized(true, true);
  orb.onclick = () => setMinimized(false, true);
  shadow.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !minimized) { event.preventDefault(); setMinimized(true, true); }
  });
  scanButton.onclick = () => { paused = false; cache.clear(); reset(); tick(); };
  pauseButton.onclick = () => { paused = !paused; batch = null; if (!paused) reset(); tick(); };
  batchButton.onclick = () => {
    if (batch) { batch = null; renderKey = ''; scanUi.stop(); tick(); return; }
    const ctx = readContext();
    if (ctx.error || !ctx.filterOK) { say(ctx.error || '请先将网页状态筛选改为「所有」。'); render(ctx); return; }
    const select = document.querySelector('#time-filter');
    const available = new Set([...(select?.options || [])].map(o => parseMonth(o.textContent)));
    const queue = quarterMonths(ctx.month).filter(m => available.has(m));
    if (!queue.length) return;
    paused = false;
    batch = { tail: ctx.tail, original: ctx.month, expected: queue.shift(), queue, total: queue.length + 1 };
    if (!changeMonth(batch.expected)) batch = null;
  };
  manualSelect.onchange = () => { manualCard = manualSelect.value; batch = null; reset(); tick(); };
  monthInput.onchange = () => { manualMonth = parseMonth(monthInput.value); batch = null; reset(); tick(); };
  saveButton.onclick = () => {
    if (!/^\d{5}$/.test(pTail.value) || !/^\d{5}$/.test(eTail.value) || pTail.value === eTail.value) {
      say('两张卡的末五位必须是不同的五位数字。', 'error'); render(readContext()); return;
    }
    const numeric = { platinumCap: +platCap.value, explorerLocalCap: +localCap.value,
      explorerFxCap: +fxCap.value, explorerMerchantCap: +merchantCap.value,
      ...Object.fromEntries(Object.entries(rateFields).map(([k, f]) => [k, +f.value])) };
    if (Object.values(numeric).some(v => !Number.isFinite(v) || v <= 0)) {
      say('上限及积分除数必须为大于0的数字。', 'error'); render(readContext()); return;
    }
    config = { ...config, platinumTail: pTail.value, explorerTail: eTail.value, ...numeric,
      explorerPeriod: explorerPeriod.value, explorerPolicy: policySelect.value, autoExpand: auto.checked };
    save(PREFIX + 'config', config); renderAliases(); cache.clear(); batch = null; reset(); tick();
  };
  document.addEventListener('change', event => {
    if (event.isTrusted && event.target.matches?.('#time-filter, #status-filter')) { batch = null; reset(); }
  }, true);
  window.addEventListener('focus', () => { cache.clear(); renderKey = ''; });
  deleteButton.onclick = () => {
    const ctx = readContext(); if (ctx.error) return;
    if (!confirm(`删除 ${ctx.tail} / ${ctx.month} 的本地快照？网页记录不会改变。`)) return;
    const key = monthKey(ctx.tail, ctx.month); GM_deleteValue(key); cache.delete(key); paused = true; reset(); tick();
  };
  exportButton.onclick = () => {
    const entries = Object.fromEntries(GM_listValues().filter(k => k.startsWith(PREFIX)).map(k => [k, GM_getValue(k)]));
    const blob = new Blob([JSON.stringify({ format: 'amex-hk-tracker', version: VERSION, exportedAt: new Date().toISOString(), entries }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = `amex-rewards-${new Date().toISOString().slice(0, 10)}.json`;
    shadow.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  importButton.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    try {
      const file = fileInput.files[0]; if (!file) return;
      if (file.size > 10 * 1024 * 1024) throw new Error('备份大于10MB');
      const data = JSON.parse(await file.text());
      if (data.format !== 'amex-hk-tracker' || data.version !== VERSION || !data.entries) throw new Error('不是此脚本的v2备份');
      const accepted = Object.entries(data.entries).filter(([k]) => k.startsWith(PREFIX + 'month:'));
      for (const [k, v] of accepted) {
        if (!v || !['platinum', 'explorer'].includes(v.card) || !/^\d{5}$/.test(v.tail) ||
          !/^20\d{2}-(0[1-9]|1[0-2])$/.test(v.month) || k !== monthKey(v.tail, v.month) ||
          !v.complete || !Number.isFinite(v.scannedAt) || !Number.isInteger(v.totalRows) || v.totalRows < 0 ||
          !Array.isArray(v.rows) || !v.rows.every(r => typeof r.description === 'string' && Number.isFinite(r.points) &&
            r.cardTail === v.tail && typeof r.date === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(r.date) &&
            dateInMonth(r.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1年$2月$3日'), v.month) === r.date)) throw new Error('备份快照字段不合法');
      }
      for (const [k, v] of accepted) {
        const old = GM_getValue(k, null);
        if (!old || v.scannedAt > old.scannedAt) save(k, v);
      }
      cache.clear(); renderKey = ''; say(`已合并 ${accepted.length} 个月度快照；同月采用较新的版本。设置不覆盖。`, 'good'); render(readContext());
    } catch (e) { say(`导入失败：${e.message}`, 'error'); render(readContext()); }
    fileInput.value = '';
  };
  setInterval(() => { try { tick(); } catch (e) { say(`扫描异常：${e.message}；未保存此轮结果。`, 'error'); live.textContent = status; live.className = 'status stag error'; } }, 750);
  refreshTrackerMenu(false); renderAliases(); tick();
  // ==========================================================================================
  // Glass Orb kit v1 · 三个脚本里是同一份代码（改动请同步）
  // 右下角的液态玻璃球体：点开是菜单；同步 / 推送时先唤醒球体，再从球体里长出进度卡片。
  // 同一网站上有两个脚本时（Amex 交易推送 + 活动追踪）共用一个球体：先运行的脚本建球体，
  // 后来的脚本找到同一个元素（#rt-orb-<brand>，开放的 shadow root）往里加自己的菜单分组和进度卡片。
  // 不用 GM_* 存储，也不跨脚本传函数，只操作共享的 DOM。
  // ==========================================================================================
  function glassOrb(opt) {
    const ORB = 64, GAP = 12;
    const doc = document;
    const ID = 'rt-orb-' + opt.brand;
    let host = doc.getElementById(ID);
    const created = !host;
    if (created) {
      host = doc.createElement('div');
      host.id = ID;
      const root = host.attachShadow({ mode: 'open' });
      // 样式优先用 adoptedStyleSheets（不受网页 CSP 对内联 <style> 的限制），不支持再退回 <style>
      try { const sh = new CSSStyleSheet(); sh.replaceSync(ORB_CSS()); root.adoptedStyleSheets = [sh]; }
      catch { const st = doc.createElement('style'); st.textContent = ORB_CSS(); root.append(st); }
      const tpl = doc.createElement('template'); tpl.innerHTML = TEMPLATE(); root.append(tpl.content);
      host.style.setProperty('--rgb', opt.rgb);
      host.style.setProperty('--deep', opt.deep);
      host.style.setProperty('--a0', String(opt.alpha));
      host.style.setProperty('--ink', opt.ink);
      (doc.documentElement || doc).append(host);
    }
    const R = host.shadowRoot;
    const $ = (s, r = R) => r.querySelector(s);
    const orb = $('.orb'), menu = $('.menu'), cards = $('.cards'), defs = $('#rto-defs');
    const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const h = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // ---------------------------------------------------------------- 初始化（只由建球体的脚本做一次）
    if (created) {
      $('.orb .logo').src = opt.logo;
      $('.m-logo img').src = opt.logo;
      $('.m-title').textContent = opt.title;
      orb.setAttribute('aria-label', opt.title);
      orb.style.setProperty('--logo-x', opt.logoBox?.[0] ?? '50%');
      orb.style.setProperty('--logo-y', opt.logoBox?.[1] ?? '50%');
      orb.style.setProperty('--logo-w', opt.logoBox?.[2] ?? '66%');
      $('.m-logo').style.cssText = orb.style.cssText;
      if (opt.ledgerUrl) {
        const a = $('.m-ledger'); a.href = opt.ledgerUrl; a.hidden = false;
      }
      // 弹簧曲线：CSS linear() 模拟质量-弹簧-阻尼系统（不支持时用 cubic-bezier 兜底）
      if (CSS.supports('transition-timing-function', 'linear(0, 1)')) {
        for (const [name, k, c] of [['bounce', 320, 21], ['soft', 240, 27], ['snap', 520, 40]]) {
          const s = springCurve(k, c);
          host.style.setProperty('--' + name, s.easing);
          host.style.setProperty('--' + name + '-ms', s.ms + 'ms');
        }
      }
      // 折射：先确认页面的 CSP 允许 data: 图片（feImage 要用），不允许就只用模糊
      const probe = new Image();
      probe.onload = () => { host.classList.add('lens'); lensAll(); };
      probe.src = lensMap(8, 8, 4, 3);

      // 指针跟随高光（球体和面板都用）
      R.addEventListener('pointermove', (e) => {
        const s = e.target.closest?.('.surf');
        if (!s) return;
        const r = s.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        s.style.setProperty('--lx', (x * 100).toFixed(1) + '%');
        s.style.setProperty('--ly', (y * 100).toFixed(1) + '%');
        s.style.setProperty('--ang', (Math.atan2(y - 0.5, x - 0.5) * 180 / Math.PI + 90).toFixed(0) + 'deg');
      });
      R.addEventListener('pointerout', (e) => {
        const s = e.target.closest?.('.surf');
        if (s && !s.contains(e.relatedTarget)) { s.style.removeProperty('--lx'); s.style.removeProperty('--ly'); s.style.removeProperty('--ang'); }
      });
      orb.addEventListener('click', (e) => (menu.classList.contains('open') ? closeMenu() : openMenu('main', e.detail === 0)));
      doc.addEventListener('pointerdown', (e) => { if (menu.classList.contains('open') && !e.composedPath().includes(host)) closeMenu(); }, true);
      doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.classList.contains('open')) { e.stopPropagation(); closeMenu(true); } }, true);
      $('.m-hide').addEventListener('click', () => { closeMenu(); setTimeout(() => { host.style.display = 'none'; }, 260); });
      orb.dataset.r = '32'; menu.dataset.r = '28';
      lens(orb);
    }

    // ---------------------------------------------------------------- 折射贴图
    function lensMap(w, h, r, band) {
      const c = doc.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); const img = g.createImageData(w, h); const d = img.data;
      const sd = (x, y) => {
        const qx = Math.abs(x - w / 2) - (w / 2 - r), qy = Math.abs(y - h / 2) - (h / 2 - r);
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const px = x + 0.5, py = y + 0.5, i = (y * w + x) * 4;
        const depth = -sd(px, py);
        let dx = 0, dy = 0;
        if (depth > 0 && depth < band) {
          const nx = sd(px + 1, py) - sd(px - 1, py), ny = sd(px, py + 1) - sd(px, py - 1);
          const n = Math.hypot(nx, ny) || 1;
          const t = 1 - depth / band;                 // 边缘 = 1，往里减到 0
          const m = 1 - Math.sqrt(1 - t * t);         // 圆弧形的玻璃边：越靠边折得越厉害
          dx = (nx / n) * m; dy = (ny / n) * m;       // 往外取样：把边外的内容折进玻璃边里
        }
        d[i] = 128 + dx * 127; d[i + 1] = 128 + dy * 127; d[i + 2] = 128; d[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c.toDataURL();
    }
    const lensCache = new Map();
    function lens(el) {
      if (!host.classList.contains('lens') || !el.isConnected) return;
      const w = Math.round(el.offsetWidth), hh = Math.round(el.offsetHeight);
      if (!w || !hh) return;
      const r = Math.min(Number(el.dataset.r) || 22, w / 2, hh / 2);
      const key = `${w}x${hh}r${Math.round(r)}`;
      let id = lensCache.get(key);
      if (!id) {
        id = 'rtl-' + key;
        if (!R.getElementById(id)) {
          const band = el === orb ? 15 : 13, scale = el === orb ? 30 : 24;
          defs.insertAdjacentHTML('beforeend',
            `<filter id="${id}" x="0" y="0" width="${w}" height="${hh}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
            `<feImage href="${lensMap(w, hh, r, band)}" x="0" y="0" width="${w}" height="${hh}" preserveAspectRatio="none" result="m"/>` +
            `<feDisplacementMap in="SourceGraphic" in2="m" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/></filter>`);
        }
        lensCache.set(key, id);
      }
      el.style.setProperty('--lensf', `url(#${id})`);
      el.style.setProperty('--rr', r + 'px');
    }
    function lensAll() { R.querySelectorAll('.surf').forEach(lens); }

    // ---------------------------------------------------------------- 形变：元素从球体里长出来 / 收回球体
    // 关闭状态 = 把元素平移缩放到球体的位置和大小，圆角 50% 让它看起来就是那个圆球
    function morphVars(el) {
      const o = orb.getBoundingClientRect(), r = el.getBoundingClientRect();
      const tr = getComputedStyle(el).transform;
      // 读未变换时的几何：offset* 不受 transform 影响
      const w = el.offsetWidth, hh = el.offsetHeight;
      let cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (tr && tr !== 'none') { const m = new DOMMatrixReadOnly(tr); cx -= m.e; cy -= m.f; }
      el.style.setProperty('--mx', (o.left + o.width / 2 - cx).toFixed(1) + 'px');
      el.style.setProperty('--my', (o.top + o.height / 2 - cy).toFixed(1) + 'px');
      el.style.setProperty('--sx', (ORB / w).toFixed(4));
      el.style.setProperty('--sy', (ORB / hh).toFixed(4));
    }

    // ---------------------------------------------------------------- 菜单
    let lastFocus = null;
    async function openMenu(view = 'main', kbd = false) {
      if (host.style.display === 'none') host.style.display = '';
      showView(view, false);
      cards.classList.add('aside');
      menu.classList.add('measuring');
      sizeMenu(false);
      morphVars(menu);
      menu.classList.remove('measuring');
      lens(menu);
      await frame();
      menu.classList.add('open'); orb.classList.add('open'); orb.setAttribute('aria-expanded', 'true');
      host.dispatchEvent(new Event('rto-open'));
      lastFocus = doc.activeElement;
      if (view === 'dialog' || kbd) setTimeout(() => { (R.querySelector('.m-view.on input, .m-view.on .row:not([disabled]), .m-view.on .m-primary:not([disabled])'))?.focus({ preventScroll: true }); }, 120);
    }
    function closeMenu(focusOrb = false) {
      if (!menu.classList.contains('open')) return;
      if (pendingDialog) pendingDialog(null, true);
      morphVars(menu);
      menu.classList.remove('open'); orb.classList.remove('open'); orb.setAttribute('aria-expanded', 'false');
      cards.classList.remove('aside');
      if (focusOrb) orb.focus({ preventScroll: true });
      orb.classList.remove('gulp'); void orb.offsetWidth; orb.classList.add('gulp');
    }
    function sizeMenu(animate = true) {
      const v = R.querySelector('.m-view.on');
      const max = Math.min(640, innerHeight - ORB - GAP - 44);
      const target = Math.min(max, v.scrollHeight);
      v.classList.toggle('scroll', v.scrollHeight > max + 1);
      if (!animate) menu.style.transition = 'none';
      menu.style.height = target + 'px';
      if (!animate) { void menu.offsetHeight; menu.style.transition = ''; }
      setTimeout(() => lens(menu), animate ? 420 : 0);
    }
    function showView(name, animate = true) {
      const views = R.querySelectorAll('.m-view');
      for (const v of views) {
        const on = v.dataset.view === name;
        v.classList.toggle('on', on);
        v.inert = !on;
      }
      if (animate) sizeMenu(true);
    }

    // ---------------------------------------------------------------- 菜单内容
    const ICONS = {
      sync: '<path d="M4 10a6 6 0 0 1 10.4-4.1L16 7.5M16 4v3.5h-3.5M16 10a6 6 0 0 1-10.4 4.1L4 12.5M4 16v-3.5h3.5"/>',
      upload: '<path d="M10 13V3.5M6.5 7 10 3.5 13.5 7M4 12.5V15a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 15v-2.5"/>',
      clock: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.6"/>',
      key: '<circle cx="7" cy="12.5" r="3"/><path d="m9.2 10.3 6.3-6.3M13 6.5l2 2M11.3 8.2l1.6 1.6"/>',
      server: '<rect x="3.5" y="4" width="13" height="5" rx="1.5"/><rect x="3.5" y="11" width="13" height="5" rx="1.5"/><path d="M6.5 6.5h.01M6.5 13.5h.01"/>',
      erase: '<path d="m8 16.5-4-4a1.4 1.4 0 0 1 0-2L11 3.5a1.4 1.4 0 0 1 2 0l3.5 3.5a1.4 1.4 0 0 1 0 2L9.5 16.5M8 16.5h8.5M6.5 8l5.5 5.5"/>',
      cards: '<rect x="3" y="5" width="14" height="10" rx="2"/><path d="M3 8.5h14M6 12h3"/>',
      reset: '<path d="M4 10a6 6 0 1 0 1.8-4.3L4 7.5M4 4v3.5h3.5"/>',
      chart: '<path d="M4 16V9M8.5 16V5M13 16v-5M17 16H3"/>',
      download: '<path d="M10 3.5V13M6.5 9.5 10 13l3.5-3.5M4 16.5h12"/>',
      gear: '<circle cx="10" cy="10" r="2.5"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6 15 15M5 15l1.4-1.4M13.6 6.4 15 5"/>',
      scan: '<path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4H7M13 4h1.5A1.5 1.5 0 0 1 16 5.5V7M16 13v1.5a1.5 1.5 0 0 1-1.5 1.5H13M7 16H5.5A1.5 1.5 0 0 1 4 14.5V13M4 10h12"/>',
      bolt: '<path d="M11 3 5 11h4.5L9 17l6-8h-4.5z"/>',
    };
    const icon = (name) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name] || ICONS.gear}</svg>`;

    function section(key, def) {
      const box = $('.m-sections');
      let s = box.querySelector(`section[data-key="${key}"]`);
      const fresh = !s;
      if (fresh) { s = h('section'); s.dataset.key = key; s.style.order = def.order ?? 0; box.append(s); }
      s.replaceChildren();
      if (def.title) s.append(h('h6', '', def.title));
      for (const it of def.items || []) s.append(it.rows ? rowsBlock(it) : rowButton(it));
      if (menu.classList.contains('open')) sizeMenu(true);
    }
    function rowButton(it) {
      const b = h('button', 'row' + (it.danger ? ' danger' : ''));
      b.type = 'button';
      b.setAttribute('role', it.toggle != null ? 'menuitemcheckbox' : 'menuitem');
      if (it.toggle != null) b.setAttribute('aria-checked', String(!!it.toggle));
      b.disabled = !!it.disabled;
      b.innerHTML = `<span class="r-ico">${icon(it.icon)}</span><span class="r-txt"><span class="r-label"></span><span class="r-hint"></span></span><span class="r-trail"></span>`;
      $('.r-label', b).textContent = it.label;
      if (it.hint) $('.r-hint', b).textContent = it.hint; else $('.r-hint', b).remove();
      const trail = $('.r-trail', b);
      if (it.toggle != null) trail.innerHTML = `<span class="sw${it.toggle ? ' on' : ''}"><i></i></span>`;
      else if (it.value) trail.textContent = it.value;
      else if (it.external) trail.innerHTML = '<svg viewBox="0 0 20 20"><path d="M8 4.5H5.5A1.5 1.5 0 0 0 4 6v8.5A1.5 1.5 0 0 0 5.5 16H14a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7"/></svg>';
      b.addEventListener('click', async () => {
        if (b.disabled) return;
        if (it.toggle != null) {
          const sw = $('.sw', b); const on = !sw.classList.contains('on');
          sw.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
          it.onClick?.(on);
          return;
        }
        if (!it.keepOpen) closeMenu();
        await wait(it.keepOpen ? 0 : 140);
        it.onClick?.();
      });
      return b;
    }
    function rowsBlock(it) {
      const box = h('div', 'kv');
      for (const [label, value, sub] of it.rows) {
        const r = h('div', 'kv-row');
        r.append(h('span', 'kv-l', label), h('span', 'kv-v', value));
        if (sub) r.append(h('span', 'kv-s', sub));
        box.append(r);
      }
      if (!it.rows.length) box.append(h('div', 'kv-empty', it.empty || '暂无'));
      return box;
    }
    function setPrimary(p) {
      const b = $('.m-primary');
      if (!p) { b.hidden = true; return; }
      b.hidden = false;
      $('.mp-label', b).textContent = p.label;
      b.disabled = !!p.disabled; b.classList.toggle('busy', !!p.disabled);
      b.onclick = async () => { closeMenu(); await wait(140); p.onClick(); };
    }
    function status(text, level = 'quiet') {
      const s = $('.m-sub');
      s.dataset.level = level;
      $('span', s).textContent = text;
    }
    function badge(n) {
      const b = $('.orb .badge');
      if (!n) { b.classList.remove('on'); return; }
      b.textContent = n > 99 ? '99+' : String(n);
      b.classList.remove('on'); void b.offsetWidth; b.classList.add('on');
    }

    // ---------------------------------------------------------------- 对话框（在菜单里切换到表单页）
    let pendingDialog = null;
    function dialog(d) {
      return new Promise((resolve) => {
        if (pendingDialog) pendingDialog(null, true);
        const v = $('.m-view[data-view="dialog"]');
        v.replaceChildren();
        const form = h('form', 'dlg');
        const head = h('div', 'dlg-head');
        const back = h('button', 'dlg-back'); back.type = 'button'; back.setAttribute('aria-label', '返回');
        back.innerHTML = '<svg viewBox="0 0 20 20"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg>';
        head.append(back, h('b', '', d.title));
        form.append(head);
        if (d.message) form.append(h('p', 'dlg-msg', d.message));
        const inputs = {};
        for (const f of d.fields || []) {
          const l = h('label', 'fld'); l.append(h('span', '', f.label));
          const i = h('input'); i.type = f.type || 'text'; i.value = f.value || ''; i.placeholder = f.placeholder || '';
          i.autocomplete = 'off'; i.spellcheck = false; i.name = f.name;
          l.append(i); form.append(l); inputs[f.name] = i;
        }
        const row = h('div', 'dlg-btns');
        const cancel = h('button', 'btn', d.cancel || '取消'); cancel.type = 'button';
        const ok = h('button', 'btn ' + (d.danger ? 'danger' : 'prim'), d.ok || '确定'); ok.type = 'submit';
        row.append(cancel, ok); form.append(row); v.append(form);
        let settled = false;
        const finish = (val, silent = false) => {
          if (settled) return;
          settled = true;
          if (pendingDialog === finish) pendingDialog = null;
          for (const i of Object.values(inputs)) i.value = '';     // 不把输入（例如令牌）留在页面里
          showView('main', false); sizeMenu(!silent);
          resolve(val);
        };
        pendingDialog = finish;
        back.onclick = cancel.onclick = () => finish(null);
        form.onsubmit = (e) => {
          e.preventDefault();
          finish(Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])));
        };
        if (menu.classList.contains('open')) { showView('dialog'); setTimeout(() => (v.querySelector('input') || ok).focus({ preventScroll: true }), 200); }
        else openMenu('dialog');
      });
    }
    const confirmBox = (title, message, ok = '确定', danger = false) => dialog({ title, message, ok, danger }).then((v) => !!v);

    // ---------------------------------------------------------------- 进度卡片 / 通知
    const tasks = new Map();
    function makeCard(kind) {
      const c = h('div', 'card surf ' + kind);
      c.setAttribute('role', 'status');
      c.innerHTML = `${MAT()}<div class="ct"><div class="c-top"><span class="c-ico"><i class="spin"></i><svg class="ok" viewBox="0 0 20 20"><path d="M5 10.5 8.5 14 15 6.5"/></svg><svg class="bad" viewBox="0 0 20 20"><path d="M10 5.5v5.5M10 14.2v.1"/></svg></span><b class="c-title"></b><button class="c-x" type="button" aria-label="关闭"><svg viewBox="0 0 20 20"><path d="m6 6 8 8M14 6l-8 8"/></svg></button></div>` +
        `<div class="c-bar"><span class="track"><i class="fill"></i></span><span class="pct">0%</span></div><div class="c-step"></div><div class="c-act"></div></div>`;
      $('.c-x', c).onclick = () => dismiss(c);
      c.addEventListener('pointerenter', () => { c.dataset.hold = '1'; });
      c.addEventListener('pointerleave', () => { delete c.dataset.hold; if (c.dataset.dieAt && Date.now() > +c.dataset.dieAt) dismiss(c); });
      return c;
    }
    async function emerge(c) {
      if (!c.isConnected) cards.prepend(c);
      c.classList.add('measuring');
      morphVars(c); lens(c);
      c.classList.remove('measuring');
      await frame();
      c.classList.add('in');
    }
    async function dismiss(c) {
      if (!c.isConnected || c.classList.contains('leaving')) return;
      c.classList.add('leaving');
      morphVars(c);
      c.classList.remove('in');
      await wait(reduce() ? 0 : 420);
      // 其它卡片平滑补位（FLIP）
      const sibs = [...cards.children].filter((x) => x !== c);
      const before = new Map(sibs.map((x) => [x, x.getBoundingClientRect().top]));
      c.remove();
      for (const x of sibs) {
        const dy = before.get(x) - x.getBoundingClientRect().top;
        if (!dy) continue;
        x.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: 420, easing: getComputedStyle(host).getPropertyValue('--soft') || 'ease-out' });
      }
      orb.classList.remove('gulp'); void orb.offsetWidth; orb.classList.add('gulp');
      for (const t of tasks.values()) if (t.card === c) tasks.delete(t.key);
      refreshRing();
    }
    function setStep(c, text) {
      const box = $('.c-step', c);
      if (box.lastElementChild?.textContent === text) return;
      const old = box.lastElementChild;
      const s = h('span', '', text);
      box.append(s);
      if (old) { old.classList.add('out'); setTimeout(() => old.remove(), 320); }
      requestAnimationFrame(() => s.classList.add('show'));
      requestAnimationFrame(() => lens(c));
    }
    function setPct(c, p) {
      p = Math.max(0, Math.min(100, p));
      c.dataset.pct = String(p);
      $('.fill', c).style.width = p + '%';
      // 百分比数字平滑滚动
      const el = $('.pct', c);
      const from = Number(c.dataset.shown || 0), t0 = performance.now(), dur = 520;
      cancelAnimationFrame(c._raf);
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        const v = from + (p - from) * e;
        c.dataset.shown = String(v);
        el.textContent = Math.round(v) + '%';
        if (k < 1) c._raf = requestAnimationFrame(tick);
      };
      c._raf = requestAnimationFrame(tick);
      refreshRing();
    }
    // 光环看共享 DOM 里所有还在进行的卡片（两个脚本的任务都算）
    function refreshRing() {
      const run = [...cards.querySelectorAll('.card.task:not(.end):not(.leaving)')];
      orb.classList.toggle('busy', run.length > 0);
      if (run.length) {
        const p = Math.min(...run.map((c) => Number(c.dataset.pct || 0)));
        orb.style.setProperty('--p', String(Math.max(3, p)));
        orb.classList.toggle('indet', p <= 0);
      }
    }
    function task(key, title) {
      const old = tasks.get(key);
      if (old && old.state === 'run') return old.api;
      if (old) dismiss(old.card);
      const c = makeCard('task');
      c.dataset.r = '22';
      $('.c-title', c).textContent = title;
      const t = { key, card: c, state: 'run', trickle: 0 };
      tasks.set(key, t);
      cards.prepend(c);          // 先放进去（关闭态 = 藏在球体里），光环据此立刻转起来
      // 先唤醒球体（光环转起来），再从球体里长出卡片
      orb.classList.remove('wake'); void orb.offsetWidth; orb.classList.add('wake');
      refreshRing();
      const shown = wait(reduce() ? 0 : 380).then(() => emerge(c)).then(refreshRing);
      const stopTrickle = () => { clearInterval(t.trickle); t.trickle = 0; };
      const api = {
        step(text, pct) { if (text) setStep(c, text); if (pct != null) { stopTrickle(); setPct(c, pct); } return api; },
        // 等待网络时进度慢慢往 to 靠近（永远到不了），避免卡在一个数字上
        trickle(to, ms = 6000) {
          stopTrickle();
          const start = Number(c.dataset.pct || 0), t0 = Date.now();
          t.trickle = setInterval(() => { const k = 1 - Math.exp(-(Date.now() - t0) / ms); setPct(c, start + (to - start) * k); }, 400);
          return api;
        },
        async done(text, level = 'good', ms = 4600) {
          stopTrickle(); await shown;
          t.state = level;
          c.classList.add('end', level);
          setPct(c, 100);
          if (text) setStep(c, text);
          refreshRing();
          if (level === 'good' || level === 'quiet') { orb.classList.remove('ok'); void orb.offsetWidth; orb.classList.add('ok'); }
          autoDismiss(c, ms);
          return api;
        },
        async fail(text, { retry, title: t2 } = {}) {
          stopTrickle(); await shown;
          t.state = 'error';
          c.classList.add('end', 'error');
          if (t2) $('.c-title', c).textContent = t2;
          setStep(c, text);
          if (retry) {
            const b = h('button', 'btn small', '重试'); b.type = 'button';
            b.onclick = () => { dismiss(c); setTimeout(retry, 300); };
            $('.c-act', c).replaceChildren(b);
          }
          refreshRing();
          return api;
        },
        title(s) { $('.c-title', c).textContent = s; return api; },
        close() { stopTrickle(); dismiss(c); },
      };
      t.api = api;
      return api;
    }
    function autoDismiss(c, ms) {
      if (!ms) return;
      c.dataset.dieAt = String(Date.now() + ms);
      setTimeout(() => { if (!c.dataset.hold) dismiss(c); }, ms);
    }
    function toast(text, level = 'good', ms = 4200, title) {
      const c = makeCard('note ' + level);
      c.dataset.r = '22';
      $('.c-title', c).textContent = title || ({ good: '完成', warn: '注意', error: '出错了', quiet: opt.short || '记账本' })[level] || opt.short;
      setStep(c, text);
      c.classList.add('end', level);
      orb.classList.remove('wake'); void orb.offsetWidth; orb.classList.add('wake');
      wait(reduce() ? 0 : 260).then(() => emerge(c));
      autoDismiss(c, ms + 400);
    }

    // 给活动追踪面板用：球体暂时藏起来（让位给从同一位置展开的面板）
    function conceal(on) { host.classList.toggle('concealed', !!on); if (on) closeMenu(); }
    // 卡片整体往左让位（例如活动追踪面板展开时）
    function shift(px) { cards.style.setProperty('--shift', (px || 0) + 'px'); }
    function onOpen(fn) { host.addEventListener('rto-open', fn); }

    return {
      host, created, orb,
      section, setPrimary, status, badge, task, toast, dialog, confirm: confirmBox,
      open: () => openMenu(), close: () => closeMenu(), conceal, shift, onOpen,
      show() { host.style.display = ''; },
      isOpen: () => menu.classList.contains('open'),
    };

    // ---------------------------------------------------------------- 模板
    function springCurve(k, c) {
      let x = 0, v = 0, t = 0, rest = 0; const dt = 1 / 240, pts = [0];
      while (t < 2.5) {
        v += (k * (1 - x) - c * v) * dt; x += v * dt; t += dt; pts.push(x);
        if (Math.abs(1 - x) < 0.0015 && Math.abs(v) < 0.02) { if (++rest > 24) break; } else rest = 0;
      }
      const n = 64, out = [];
      for (let i = 0; i < n; i++) out.push(+pts[Math.round(i * (pts.length - 1) / (n - 1))].toFixed(4));
      out[n - 1] = 1;
      return { easing: `linear(${out.join(', ')})`, ms: Math.round(t * 1000) };
    }
  }
  // 用函数而不是 const：脚本在初始化阶段就会调用 glassOrb()，这时文件末尾的 const 还没赋值
  function MAT() { return '<span class="mat"><i class="mb"></i><i class="ml"></i><i class="mt"></i><i class="mh"></i><i class="mr"></i></span>'; }
  function TEMPLATE() {
    return `<svg class="defs" width="0" height="0" aria-hidden="true"><defs id="rto-defs"></defs></svg>
<div class="cards" aria-live="polite"></div>
<div class="menu surf" role="menu">
  ${MAT()}
  <div class="m-wrap">
    <div class="m-view on" data-view="main">
      <div class="m-head"><span class="m-logo"><img alt=""></span><div class="m-ht"><div class="m-title"></div><div class="m-sub" data-level="quiet"><i></i><span>准备就绪</span></div></div></div>
      <button class="m-primary" type="button" hidden><svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 0 1 10.4-4.1L16 7.5M16 4v3.5h-3.5M16 10a6 6 0 0 1-10.4 4.1L4 12.5M4 16v-3.5h3.5"/></svg><span class="mp-label">立即同步</span></button>
      <div class="m-sections"></div>
      <div class="m-foot"><a class="m-ledger" target="_blank" rel="noopener noreferrer" hidden>打开记账本<svg viewBox="0 0 20 20"><path d="M8 4.5H5.5A1.5 1.5 0 0 0 4 6v8.5A1.5 1.5 0 0 0 5.5 16H14a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7"/></svg></a><button class="m-hide" type="button">隐藏球体</button></div>
    </div>
    <div class="m-view" data-view="dialog"></div>
  </div>
</div>
<button class="orb surf" type="button" aria-haspopup="menu" aria-expanded="false">
  ${MAT()}
  <span class="lw"><img class="logo" alt="" draggable="false"></span>
  <svg class="ring" viewBox="0 0 76 76" aria-hidden="true"><circle class="rb" cx="38" cy="38" r="36"/><circle class="rf" cx="38" cy="38" r="36" pathLength="100"/></svg>
  <span class="badge"></span>
</button>`;
  }
  function ORB_CSS() { return `
:host{all:initial;position:fixed;right:20px;bottom:20px;width:64px;height:64px;z-index:2147483645;color-scheme:light;--a:var(--a0,.42);
  --bounce:cubic-bezier(.34,1.45,.5,1);--bounce-ms:620ms;--soft:cubic-bezier(.25,1.1,.4,1);--soft-ms:520ms;--snap:cubic-bezier(.3,1,.4,1);--snap-ms:260ms;
  --out:cubic-bezier(.55,0,.75,.3);
  font:500 13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  color:var(--ink);-webkit-font-smoothing:antialiased;letter-spacing:.005em}
:host(.concealed) .orb,:host(.concealed) .menu{visibility:hidden!important;transition:none!important}
*{box-sizing:border-box}
button{font:inherit;color:inherit;letter-spacing:inherit}
svg{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
[hidden]{display:none!important}
.defs{position:absolute;width:0;height:0}

/* ---------------- 液态玻璃材质（五层）----------------
   mb 背景模糊 · ml 边缘折射（SVG 位移贴图）· mt 品牌色玻璃 · mh 指针高光 + 内阴影 · mr 高光描边
   注意：带 backdrop-filter 的层的祖先都不能有 opacity / filter，否则背景取不到，所以淡入淡出都只作用在各层自己身上 */
.surf{--lx:32%;--ly:18%;--ang:-35deg}
.mat{position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0}
.mat>i{position:absolute;inset:0;border-radius:inherit;opacity:var(--o,1);transition:opacity var(--fd,.22s) ease var(--fdl,0s)}
.mb{backdrop-filter:blur(var(--bl,4px)) saturate(190%) brightness(var(--br,1.04));-webkit-backdrop-filter:blur(var(--bl,4px)) saturate(190%) brightness(var(--br,1.04))}
:host(.lens) .ml{backdrop-filter:var(--lensf,none);clip-path:inset(0 round var(--rr,50%))}
.mt{background:
  linear-gradient(rgba(255,255,255,var(--veil,0)),rgba(255,255,255,var(--veil,0))),
  radial-gradient(140% 120% at 28% 12%,rgba(var(--rgb),calc(var(--a) - .12)),rgba(var(--rgb),var(--a)) 52%,rgba(var(--deep),calc(var(--a) + .1)))}
.mh{background:radial-gradient(70% 55% at var(--lx) var(--ly),rgba(255,255,255,var(--sheen,.38)),rgba(255,255,255,0) 72%);
  box-shadow:inset 0 1.5px 1px -.5px rgba(255,255,255,.95),inset 0 -1.5px 1.5px -.5px rgba(255,255,255,.45),
    inset 0 -10px 18px -10px rgba(var(--deep),.22),inset 0 0 0 .5px rgba(255,255,255,.28)}
.mr{padding:1.2px;background:conic-gradient(from var(--ang),rgba(255,255,255,.98),rgba(255,255,255,.2) 18%,rgba(255,255,255,.06) 34%,rgba(255,255,255,.5) 50%,rgba(255,255,255,.06) 66%,rgba(255,255,255,.2) 82%,rgba(255,255,255,.98));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;transition:opacity .3s ease}

/* ---------------- 球体 ---------------- */
.orb{position:absolute;inset:0;width:64px;height:64px;padding:0;border:0;border-radius:50%;background:none;cursor:pointer;outline:none;
  --veil:0;--bl:3px;--sheen:.42;-webkit-tap-highlight-color:transparent;
  box-shadow:0 14px 30px -10px rgba(var(--deep),.55),0 3px 8px -2px rgba(var(--deep),.25);
  transition:transform var(--bounce-ms) var(--bounce),box-shadow .35s ease}
.orb:hover{transform:scale(1.07);box-shadow:0 18px 38px -10px rgba(var(--deep),.6),0 4px 10px -2px rgba(var(--deep),.25)}
.orb:active{transform:scale(.9);transition-duration:.14s;transition-timing-function:ease-out}
.orb.open{transform:scale(.94)}
.orb:focus-visible{box-shadow:0 0 0 3px #fff,0 0 0 5.5px rgba(var(--rgb),.85),0 14px 30px -10px rgba(var(--deep),.55)}
.lw{position:absolute;inset:0;border-radius:50%;overflow:hidden;z-index:1;pointer-events:none}
.orb .logo{position:absolute;left:var(--logo-x);top:var(--logo-y);width:var(--logo-w);transform:translate(-50%,-50%);pointer-events:none;
  filter:drop-shadow(0 .6px .6px rgba(var(--deep),.55)) drop-shadow(0 0 6px rgba(var(--deep),.25));
  transition:transform var(--bounce-ms) var(--bounce)}
.orb:active .logo{transform:translate(-50%,-50%) scale(.94)}
.orb::after{content:'';position:absolute;inset:0;border-radius:50%;pointer-events:none;z-index:2;
  background:radial-gradient(42% 26% at 40% 16%,rgba(255,255,255,.55),rgba(255,255,255,0) 100%)}
.orb.wake{animation:wake .72s var(--bounce) 1}
@keyframes wake{0%{transform:scale(1)}28%{transform:scale(1.16)}100%{transform:scale(1)}}
.orb.gulp{animation:gulp .5s var(--bounce) 1}
@keyframes gulp{0%{transform:scale(1)}30%{transform:scale(.9,.94)}100%{transform:scale(1)}}
.orb.ok .mr{animation:okrim 1.1s ease 1}
@keyframes okrim{0%,100%{filter:none}30%{filter:drop-shadow(0 0 4px rgba(255,255,255,.95))}}

.ring{position:absolute;left:-6px;top:-6px;width:76px;height:76px;pointer-events:none;z-index:3;opacity:0;transform:rotate(-90deg) scale(.86);
  transition:opacity .35s ease,transform var(--bounce-ms) var(--bounce)}
.ring circle{stroke-width:2.4;fill:none}
.ring .rb{stroke:rgba(var(--rgb),.16)}
.ring .rf{stroke:rgb(var(--rgb));stroke-dasharray:calc(var(--p,3) * 1) 100;transition:stroke-dasharray .6s cubic-bezier(.22,1,.36,1);
  filter:drop-shadow(0 0 2px rgba(var(--rgb),.6))}
.orb.busy .ring{opacity:1;transform:rotate(-90deg) scale(1)}
.orb.indet .ring{animation:spin 1.1s linear infinite}
.orb.indet .rf{stroke-dasharray:26 100}
@keyframes spin{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}

.badge{position:absolute;right:-4px;top:-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;z-index:4;
  font:700 11px/20px -apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;text-align:center;color:rgb(var(--deep));
  background:rgba(255,255,255,.92);box-shadow:0 3px 8px -2px rgba(var(--deep),.45),inset 0 0 0 .5px rgba(var(--rgb),.3);
  transform:scale(0);transition:transform .45s var(--bounce)}
.badge.on{transform:scale(1)}

/* ---------------- 形变（从球体长出 / 收回）----------------
   关闭态：平移到球体中心 + 缩放成 64×64 + 圆角 50% → 和球体重合 */
.menu,.card{transform:translate(var(--mx,0),var(--my,0)) scale(var(--sx,.2),var(--sy,.2));border-radius:50%;visibility:hidden;--o:0;
  transition:transform var(--snap-ms) var(--out),border-radius var(--snap-ms) var(--out),box-shadow .12s ease,visibility 0s linear var(--snap-ms);--fd:.1s;--fdl:0s}
.menu:not(.open),.card:not(.in){box-shadow:none!important}
.menu.open,.card.in{transform:none;visibility:visible;--o:1;
  transition:transform var(--bounce-ms) var(--bounce),border-radius calc(var(--bounce-ms) * .55) cubic-bezier(.2,.9,.3,1),box-shadow .5s ease .15s,visibility 0s;--fd:.18s}
.menu.measuring,.card.measuring{transition:none!important;transform:none!important;visibility:hidden}

/* ---------------- 菜单 ---------------- */
.menu{position:absolute;right:0;bottom:calc(100% + 14px);width:296px;max-width:calc(100vw - 40px);height:200px;border-radius:50%;
  --veil:.46;--bl:22px;--br:1.08;--sheen:.3;--a:calc(var(--a0,.42) * .8);
  box-shadow:0 30px 70px -22px rgba(var(--deep),.5),0 8px 22px -8px rgba(var(--deep),.22)}
.menu.open{border-radius:28px;transition:transform var(--bounce-ms) var(--bounce),border-radius calc(var(--bounce-ms) * .55) cubic-bezier(.2,.9,.3,1),height var(--soft-ms) var(--soft),visibility 0s}
.m-wrap{position:relative;z-index:1;height:100%;overflow:hidden;border-radius:inherit}
.m-view{position:absolute;left:0;right:0;top:0;padding:16px 12px 10px;max-height:100%;overflow:auto;scrollbar-width:none;
  opacity:0;transform:translateX(18px) scale(.98);filter:blur(4px);pointer-events:none;
  transition:opacity .2s ease,transform .45s var(--soft),filter .3s ease}
.m-view[data-view=main]{transform:translateX(-18px) scale(.98)}
.m-view.on{opacity:1;transform:none;filter:none;pointer-events:auto;transition:opacity .3s ease .08s,transform var(--soft-ms) var(--soft) .04s,filter .35s ease .06s}
.menu:not(.open) .m-view.on{opacity:0;filter:blur(6px);transition:opacity .12s ease,filter .12s ease}
.menu.open .m-view.on{transition:opacity .32s ease .12s,transform var(--soft-ms) var(--soft) .06s,filter .4s ease .1s}
.m-view::-webkit-scrollbar{display:none}
.m-view.scroll{-webkit-mask-image:linear-gradient(#000 calc(100% - 28px),transparent);mask-image:linear-gradient(#000 calc(100% - 28px),transparent);padding-bottom:22px}

.m-head{display:flex;align-items:center;gap:11px;padding:0 6px 12px}
.m-logo{position:relative;flex:none;width:38px;height:38px;border-radius:50%;overflow:hidden;
  background:radial-gradient(140% 120% at 28% 12%,rgba(var(--rgb),.78),rgb(var(--rgb)) 52%,rgb(var(--deep)));
  box-shadow:inset 0 1px 1px rgba(255,255,255,.7),inset 0 -2px 4px rgba(var(--deep),.35),0 4px 10px -3px rgba(var(--deep),.5)}
.m-logo img{position:absolute;left:var(--logo-x);top:var(--logo-y);width:var(--logo-w);transform:translate(-50%,-50%)}
.m-ht{min-width:0;flex:1}
.m-title{font-size:15px;font-weight:650;letter-spacing:.01em;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m-sub{display:flex;align-items:center;gap:6px;font-size:12px;color:color-mix(in srgb,var(--ink) 64%,transparent);min-width:0}
.m-sub span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m-sub i{flex:none;width:7px;height:7px;border-radius:50%;background:#9aa6b2}
.m-sub[data-level=good] i{background:#22b573;box-shadow:0 0 0 3px rgba(34,181,115,.18)}
.m-sub[data-level=warn] i{background:#f0a800;box-shadow:0 0 0 3px rgba(240,168,0,.2)}
.m-sub[data-level=error] i{background:#ff3b30;box-shadow:0 0 0 3px rgba(255,59,48,.18)}
.m-sub[data-level=run] i{background:rgb(var(--rgb));animation:pulse 1.2s ease infinite}
@keyframes pulse{50%{box-shadow:0 0 0 5px rgba(var(--rgb),0);transform:scale(.8)}0%{box-shadow:0 0 0 0 rgba(var(--rgb),.45)}}

.m-primary{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:42px;margin:0 0 10px;border:0;border-radius:21px;cursor:pointer;
  color:#fff;font-size:14px;font-weight:650;letter-spacing:.02em;
  background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,0) 55%),linear-gradient(180deg,rgba(var(--rgb),.92),rgb(var(--deep)));
  box-shadow:inset 0 1px .5px rgba(255,255,255,.65),inset 0 -1px 1px rgba(0,0,0,.18),0 8px 20px -8px rgba(var(--deep),.75);
  transition:transform .4s var(--bounce),filter .2s ease}
.m-primary:hover{filter:brightness(1.08)}
.m-primary:disabled{cursor:default;filter:saturate(.7) brightness(1.05);opacity:.8}
.m-primary.busy svg{animation:spin2 1s linear infinite}
.m-primary:active{transform:scale(.96);transition-duration:.12s}
.m-primary svg{width:17px;height:17px;stroke-width:1.9}
.m-primary:hover svg{animation:spin360 .9s var(--soft) 1}
@keyframes spin360{to{transform:rotate(360deg)}}
.m-primary:focus-visible,.row:focus-visible,.btn:focus-visible,.m-foot>*:focus-visible,.dlg-back:focus-visible,.c-x:focus-visible{outline:2px solid rgb(var(--rgb));outline-offset:2px}

.m-sections{display:flex;flex-direction:column;gap:6px}
section{display:flex;flex-direction:column;gap:1px}
section h6{margin:6px 10px 3px;font-size:11px;font-weight:650;letter-spacing:.06em;color:color-mix(in srgb,var(--ink) 52%,transparent)}
.row{display:flex;align-items:center;gap:11px;width:100%;min-height:40px;padding:7px 10px;border:0;border-radius:14px;background:transparent;cursor:pointer;text-align:left;
  transition:background-color .18s ease,transform .35s var(--bounce)}
.row:hover{background:rgba(255,255,255,.42);box-shadow:inset 0 .5px 0 rgba(255,255,255,.8)}
.row:active{transform:scale(.975);transition-duration:.1s}
.row:disabled{opacity:.42;cursor:default;background:transparent;box-shadow:none;transform:none}
.r-ico{flex:none;width:28px;height:28px;border-radius:9px;display:grid;place-items:center;color:rgb(var(--deep));
  background:rgba(255,255,255,.55);box-shadow:inset 0 .5px 0 rgba(255,255,255,.9),0 1px 3px rgba(var(--deep),.12)}
.r-ico svg{width:17px;height:17px}
.danger .r-ico{color:#d70015}
.r-txt{flex:1;min-width:0;display:flex;flex-direction:column}
.r-label{font-size:13.5px;font-weight:550;line-height:1.3}
.r-hint{font-size:11.5px;line-height:1.35;color:color-mix(in srgb,var(--ink) 55%,transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.r-trail{flex:none;font-size:12px;color:color-mix(in srgb,var(--ink) 55%,transparent);font-variant-numeric:tabular-nums}
.r-trail svg{width:15px;height:15px;display:block}
.sw{display:block;width:38px;height:23px;border-radius:12px;position:relative;background:rgba(var(--deep),.16);box-shadow:inset 0 1px 2px rgba(0,0,0,.12);transition:background-color .25s ease}
.sw i{position:absolute;left:2px;top:2px;width:19px;height:19px;border-radius:50%;background:#fff;box-shadow:0 2px 5px rgba(0,0,0,.22),inset 0 0 0 .5px rgba(0,0,0,.04);transition:transform .45s var(--bounce),width .2s ease}
.sw.on{background:rgb(var(--rgb))}
.sw.on i{transform:translateX(15px)}
.row:active .sw i{width:23px}
.row:active .sw.on i{transform:translateX(11px)}

.kv{margin:2px 4px 4px;padding:6px 10px;border-radius:14px;background:rgba(255,255,255,.34);box-shadow:inset 0 .5px 0 rgba(255,255,255,.8);
  display:grid;grid-template-columns:1fr auto;column-gap:10px}
.kv-row{display:contents}
.kv-l{font-size:12.5px;font-weight:550;padding:5px 0 0}
.kv-v{font-size:12.5px;text-align:right;font-variant-numeric:tabular-nums;padding:5px 0 0}
.kv-s{grid-column:1/-1;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:color-mix(in srgb,var(--ink) 55%,transparent);padding:0 0 5px;border-bottom:.5px solid rgba(var(--deep),.1)}
.kv-row:last-child .kv-s{border-bottom:0}
.kv-empty{grid-column:1/-1;font-size:12px;padding:6px 0;color:color-mix(in srgb,var(--ink) 55%,transparent)}

.m-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 4px 0;padding:10px 6px 2px;border-top:.5px solid rgba(var(--deep),.12)}
.m-foot>*{display:inline-flex;align-items:center;gap:5px;border:0;background:none;padding:4px 6px;border-radius:8px;cursor:pointer;
  font-size:12.5px;font-weight:600;color:rgb(var(--deep));text-decoration:none}
.m-foot>*:hover{background:rgba(255,255,255,.4)}
.m-foot svg{width:13px;height:13px}
.m-hide{color:color-mix(in srgb,var(--ink) 55%,transparent)!important;font-weight:500!important}

/* 对话框 */
.dlg{display:flex;flex-direction:column;gap:10px;padding:0 4px 4px}
.dlg-head{display:flex;align-items:center;gap:8px;font-size:15px}
.dlg-head b{font-weight:650}
.dlg-back{width:30px;height:30px;border-radius:50%;border:0;display:grid;place-items:center;cursor:pointer;background:rgba(255,255,255,.5);
  box-shadow:inset 0 .5px 0 rgba(255,255,255,.9),0 1px 3px rgba(var(--deep),.12);transition:transform .35s var(--bounce)}
.dlg-back:active{transform:scale(.9)}
.dlg-back svg{width:16px;height:16px;stroke-width:2}
.dlg-msg{margin:0;font-size:12.5px;line-height:1.55;color:color-mix(in srgb,var(--ink) 75%,transparent)}
.fld{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:550;color:color-mix(in srgb,var(--ink) 70%,transparent)}
.fld input{height:38px;padding:0 12px;border:0;border-radius:12px;font:500 13.5px/1 inherit;font-family:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;color:var(--ink);
  background:rgba(255,255,255,.7);box-shadow:inset 0 1px 2px rgba(var(--deep),.16),inset 0 0 0 .5px rgba(var(--deep),.14);outline:none;transition:box-shadow .2s ease}
.fld input:focus{box-shadow:inset 0 1px 2px rgba(var(--deep),.16),0 0 0 2.5px rgba(var(--rgb),.55)}
.dlg-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}
.btn{height:34px;padding:0 16px;border:0;border-radius:17px;cursor:pointer;font-size:13px;font-weight:600;
  background:rgba(255,255,255,.58);box-shadow:inset 0 .5px 0 rgba(255,255,255,.95),0 1px 3px rgba(var(--deep),.14);transition:transform .35s var(--bounce),filter .2s}
.btn:hover{filter:brightness(1.05)}
.btn:active{transform:scale(.94);transition-duration:.1s}
.btn.prim{color:#fff;background:linear-gradient(180deg,rgba(var(--rgb),.95),rgb(var(--deep)));box-shadow:inset 0 1px .5px rgba(255,255,255,.55),0 6px 14px -6px rgba(var(--deep),.7)}
.btn.danger{color:#fff;background:linear-gradient(180deg,#ff5a4f,#d70015);box-shadow:inset 0 1px .5px rgba(255,255,255,.5),0 6px 14px -6px rgba(180,0,20,.6)}
.btn.small{height:28px;padding:0 13px;font-size:12px}

/* ---------------- 进度卡片 / 通知 ---------------- */
.cards{position:absolute;right:calc(100% + 12px);bottom:0;display:flex;flex-direction:column;gap:10px;align-items:flex-end;pointer-events:none;
  transform:translateX(calc(var(--shift,0px) * -1));transition:transform var(--soft-ms) var(--soft)}
.cards.aside{transform:translateX(calc(-236px - var(--shift,0px)))}
.card{position:relative;width:min(304px,calc(100vw - 112px));min-height:64px;pointer-events:auto;
  --veil:.5;--bl:20px;--br:1.08;--sheen:.28;--a:calc(var(--a0,.42) * .76);
  box-shadow:0 22px 50px -18px rgba(var(--deep),.5),0 6px 16px -6px rgba(var(--deep),.2)}
.card.in{border-radius:22px}
.ct{position:relative;z-index:1;padding:12px 14px 11px 14px;display:flex;flex-direction:column;gap:7px;
  opacity:0;filter:blur(5px);transform:scale(.97);transition:opacity .12s ease,filter .12s ease,transform .2s ease}
.card.in .ct{opacity:1;filter:none;transform:none;transition:opacity .3s ease .14s,filter .35s ease .12s,transform var(--soft-ms) var(--soft) .08s}
.c-top{display:flex;align-items:center;gap:8px;min-height:20px}
.c-title{flex:1;min-width:0;font-size:13.5px;font-weight:650;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c-ico{position:relative;flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center}
.c-ico>*{position:absolute;inset:0;margin:auto;transition:opacity .25s ease,transform .45s var(--bounce)}
.spin{width:16px;height:16px;border-radius:50%;background:conic-gradient(from 0deg,rgba(var(--rgb),0),rgb(var(--rgb)));animation:spin2 .85s linear infinite;
  -webkit-mask:radial-gradient(circle,transparent 5px,#000 5.5px);mask:radial-gradient(circle,transparent 5px,#000 5.5px)}
@keyframes spin2{to{transform:rotate(360deg)}}
.c-ico svg{width:20px;height:20px;padding:3px;border-radius:50%;color:#fff;stroke-width:2.4;opacity:0;transform:scale(.4)}
.c-ico .ok{background:#1fb26b;box-shadow:0 2px 6px -1px rgba(20,140,80,.55)}
.c-ico .bad{background:#f0a800;box-shadow:0 2px 6px -1px rgba(200,140,0,.5)}
.c-ico .ok path{stroke-dasharray:16;stroke-dashoffset:16;transition:stroke-dashoffset .4s ease .15s}
.card.end .spin{opacity:0;transform:scale(.4)}
.card.good .ok,.card.quiet .ok{opacity:1;transform:none}
.card.good .ok path,.card.quiet .ok path{stroke-dashoffset:0}
.card.warn .bad,.card.error .bad{opacity:1;transform:none}
.card.error .bad{background:#ff3b30;box-shadow:0 2px 6px -1px rgba(220,30,30,.5)}
.c-x{flex:none;width:22px;height:22px;margin:-2px -4px -2px 0;border:0;border-radius:50%;display:grid;place-items:center;cursor:pointer;background:transparent;
  color:color-mix(in srgb,var(--ink) 50%,transparent);opacity:0;transition:opacity .2s ease,background-color .2s ease}
.card:hover .c-x,.card.error .c-x,.c-x:focus-visible{opacity:1}
.c-x:hover{background:rgba(255,255,255,.5)}
.c-x svg{width:13px;height:13px;stroke-width:2}
.c-bar{display:flex;align-items:center;gap:10px}
.track{position:relative;flex:1;height:7px;border-radius:4px;overflow:hidden;background:rgba(var(--deep),.13);box-shadow:inset 0 1px 1.5px rgba(var(--deep),.18)}
.fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:inherit;overflow:hidden;
  background:linear-gradient(90deg,rgba(var(--rgb),.72),rgb(var(--rgb)) 70%,rgb(var(--deep)));
  box-shadow:0 0 8px rgba(var(--rgb),.45);transition:width .6s cubic-bezier(.22,1,.36,1),background .4s ease}
.fill::before{content:'';position:absolute;left:0;right:0;top:1px;height:2px;border-radius:2px;background:rgba(255,255,255,.55)}
.fill::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.55) 50%,transparent 70%);
  transform:translateX(-100%);animation:shine 1.5s ease-in-out infinite}
@keyframes shine{to{transform:translateX(100%)}}
.card.end .fill::after{animation:none;opacity:0}
.card.good .fill,.card.quiet .fill{background:linear-gradient(90deg,#4cd690,#1fb26b);box-shadow:0 0 8px rgba(31,178,107,.4)}
.card.warn .fill{background:linear-gradient(90deg,#ffcf4a,#f0a800);box-shadow:none}
.card.error .fill{background:linear-gradient(90deg,#ff7b72,#ff3b30);box-shadow:none}
.pct{flex:none;min-width:36px;text-align:right;font-size:12.5px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.c-step{position:relative;display:grid;font-size:12px;line-height:1.45;color:color-mix(in srgb,var(--ink) 72%,transparent)}
.c-step span{grid-area:1/1;opacity:0;transform:translateY(6px);filter:blur(2px);transition:opacity .28s ease,transform .38s var(--soft),filter .3s ease;overflow-wrap:anywhere}
.c-step span.show{opacity:1;transform:none;filter:none}
.c-step span.out{opacity:0;transform:translateY(-6px);filter:blur(2px)}
.c-act:empty{display:none}
.c-act{display:flex;justify-content:flex-end}
.note .c-bar{display:none}

@media (max-width:520px){:host{right:12px;bottom:12px}.cards.aside{transform:translateY(-8px)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important;transition-delay:0s!important}}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.mt{--veil:.82}}
`; }
  // ==================================== Glass Orb kit 结束 ====================================

})();