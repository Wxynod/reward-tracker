// ==UserScript==
// @name         Amex HK · Platinum & Explorer 活动追踪
// @namespace    local.amex-hk-rewards
// @version      2.3.0
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
// 首次使用：Tampermonkey 菜单 →「Amex：设置记账本写入令牌」，填 Worker 的 INGEST_TOKEN（和交易推送脚本用的是同一个）。

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

  // Google Fonts official embed. The Amex CSP allows fonts.googleapis.com (style-src)
  // and fonts.gstatic.com (font-src). @font-face must live in the document, not the
  // shadow root, to be usable inside the shadow tree.
  if (!document.getElementById('amex-hk-tracker-fonts')) {
    const head = document.head || document.documentElement;
    for (const [href, cors] of [['https://fonts.googleapis.com', false], ['https://fonts.gstatic.com', true]]) {
      const l = document.createElement('link'); l.rel = 'preconnect'; l.href = href; if (cors) l.crossOrigin = ''; head.append(l);
    }
    const font = document.createElement('link');
    font.id = 'amex-hk-tracker-fonts'; font.rel = 'stylesheet'; font.referrerPolicy = 'no-referrer';
    font.href = 'https://fonts.googleapis.com/css2?family=Noto+Serif:wght@400;500;600;700&family=Noto+Serif+SC:wght@400;500;600;700&display=swap';
    head.append(font);
  }

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
  const style = el('style');
  style.textContent = `
    :host{all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483646;color-scheme:light;
      --blue:0,111,207;--ink:#0b2a4a;--ink2:#46617c;--ink3:#6f8499;
      --panel-w:min(440px,calc(100vw - 40px));--panel-h:min(800px,calc(100dvh - 40px));--orb:64px;
      --ease:cubic-bezier(.22,1,.36,1);--spring:cubic-bezier(.32,1.28,.52,1);--settle:cubic-bezier(.55,0,.25,1.18);
      --open:700ms;--close:540ms;
      font:400 14.5px/1.6 "Noto Serif","Noto Serif SC","Songti SC","SimSun",serif;
      color:var(--ink);-webkit-font-smoothing:antialiased;letter-spacing:.01em}
    *{box-sizing:border-box}
    button,select,input{font:inherit;color:inherit;letter-spacing:inherit}
    .hidden{display:none!important}

    /* ---------- liquid-glass surface: one element morphs orb <-> panel ---------- */
    .shell{position:relative;width:var(--panel-w);height:var(--panel-h);border-radius:34px;isolation:isolate;overflow:hidden;
      background-color:rgba(232,242,252,.40);
      backdrop-filter:blur(32px) saturate(190%) brightness(1.04);-webkit-backdrop-filter:blur(32px) saturate(190%) brightness(1.04);
      box-shadow:0 34px 90px -24px rgba(6,40,84,.42),0 10px 28px rgba(6,40,84,.10),
        inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 1px rgba(255,255,255,.35);
      transition:width var(--open) var(--spring),height var(--open) var(--spring),border-radius var(--open) var(--ease),
        background-color var(--open) var(--ease),box-shadow var(--open) var(--ease),transform 320ms var(--spring)}
    .shell.compact{width:var(--orb);height:var(--orb);border-radius:50%;cursor:pointer;
      background-color:rgba(var(--blue),.62);
      box-shadow:0 14px 34px -6px rgba(var(--blue),.55),0 3px 10px rgba(6,40,84,.18),
        inset 0 1.5px 1px rgba(255,255,255,.75),inset 0 -4px 10px rgba(0,24,70,.32);
      transition-duration:var(--close),var(--close),var(--close),var(--close),var(--close),320ms;
      transition-timing-function:var(--settle),var(--settle),var(--ease),var(--ease),var(--ease),var(--spring)}
    .shell.compact:hover{transform:translateY(-3px) scale(1.06)}
    .shell.compact:active{transform:scale(.94);transition-duration:120ms}
    /* gradient rim, brighter at the top-left like a lit glass edge */
    .rim{position:absolute;inset:0;border-radius:inherit;padding:1.25px;pointer-events:none;z-index:5;
      background:linear-gradient(140deg,rgba(255,255,255,.98),rgba(255,255,255,.18) 32%,rgba(255,255,255,.04) 58%,rgba(255,255,255,.6));
      -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}
    .glare{position:absolute;left:-18%;top:-32%;width:95%;height:62%;border-radius:50%;pointer-events:none;z-index:0;
      background:radial-gradient(closest-side,rgba(255,255,255,.55),rgba(255,255,255,0));opacity:.55;transition:opacity var(--open) var(--ease)}
    .tint{position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;opacity:0;
      background:radial-gradient(120% 120% at 28% 16%,rgba(74,164,244,.95),rgba(0,111,207,.92) 52%,rgba(0,78,158,.96));
      transition:opacity 260ms ease}
    .compact .tint{opacity:1;transition:opacity 360ms ease 90ms}
    .compact .glare{opacity:0}

    /* ---------- orb ---------- */
    .orb{position:absolute;right:0;bottom:0;width:var(--orb);height:var(--orb);padding:0;border:0;border-radius:50%;background:none;cursor:pointer;
      z-index:4;overflow:hidden;opacity:0;visibility:hidden;pointer-events:none;transform:scale(.55) rotate(-18deg);
      transition:opacity 140ms ease,transform 260ms var(--ease),visibility 0s linear 140ms}
    .orb img{position:absolute;left:13%;top:6.5%;width:87%;height:87%;display:block;pointer-events:none;filter:drop-shadow(0 .5px .5px rgba(0,40,100,.25))}
    .orb::after{content:'';position:absolute;left:14%;top:5%;width:72%;height:42%;border-radius:50%;pointer-events:none;
      background:linear-gradient(180deg,rgba(255,255,255,.5),rgba(255,255,255,0));opacity:.75}
    .compact .orb{opacity:1;visibility:visible;pointer-events:auto;transform:none;
      transition:opacity 220ms ease 200ms,transform 620ms var(--spring) 150ms,visibility 0s}
    .orb:focus-visible{outline:3px solid #fff;outline-offset:-5px}

    /* ---------- panel content ---------- */
    .pane{position:absolute;right:0;bottom:0;z-index:2;width:var(--panel-w);height:var(--panel-h);display:flex;flex-direction:column;
      opacity:1;filter:none;transition:opacity 260ms ease 170ms,filter 420ms var(--ease) 140ms}
    .compact .pane{opacity:0;filter:blur(10px);pointer-events:none;transition:opacity 120ms ease,filter 200ms ease}
    .pane .stag{transition:opacity 380ms ease calc(200ms + var(--i,0) * 55ms),transform 620ms var(--spring) calc(170ms + var(--i,0) * 55ms)}
    .compact .pane .stag{opacity:0;transform:translateY(16px) scale(.985);transition:opacity 100ms ease,transform 200ms ease}

    header{flex:none;display:flex;align-items:center;gap:12px;padding:20px 20px 14px}
    .brand{width:40px;height:40px;flex:none;border-radius:50%;position:relative;overflow:hidden;
      background:radial-gradient(120% 120% at 28% 16%,#4aa4f4,#006fcf 52%,#004e9e);
      box-shadow:0 6px 14px -4px rgba(var(--blue),.55),inset 0 1px 1px rgba(255,255,255,.7)}
    .brand img{position:absolute;left:13%;top:6.5%;width:87%;height:87%}
    .titles{flex:1;min-width:0}
    .title{font-size:18px;font-weight:700;letter-spacing:.01em;line-height:1.3}
    .sub{font-size:13px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .close{flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;padding:0;border:0;cursor:pointer;color:var(--ink2);
      background:rgba(255,255,255,.5);box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 0 0 1px rgba(255,255,255,.4),0 2px 8px rgba(6,40,84,.08);
      transition:background-color 160ms ease,transform 200ms var(--spring)}
    .close:hover{background:rgba(255,255,255,.8)}.close:active{transform:scale(.9)}
    .close svg{width:16px;height:16px}

    .body{flex:1;min-height:0;overflow:auto;padding:2px 16px 18px;overscroll-behavior:contain;
      scrollbar-width:thin;scrollbar-color:rgba(0,70,140,.25) transparent;
      mask-image:linear-gradient(180deg,transparent 0,#000 10px,#000 calc(100% - 16px),transparent);-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 10px,#000 calc(100% - 16px),transparent)}
    .body>*+*{margin-top:12px}

    .status{display:flex;gap:10px;align-items:flex-start;padding:11px 14px;border-radius:18px;font-size:13.5px;line-height:1.5;overflow-wrap:anywhere;
      background:rgba(255,236,186,.62);color:#6d4b00;box-shadow:inset 0 1px 0 rgba(255,255,255,.7),inset 0 0 0 1px rgba(255,255,255,.3)}
    .status::before{content:'';flex:none;width:8px;height:8px;margin-top:7px;border-radius:50%;background:#e2a400;box-shadow:0 0 0 4px rgba(226,164,0,.18)}
    .status.good{background:rgba(214,243,231,.66);color:#0f5b43}.status.good::before{background:#18a06e;box-shadow:0 0 0 4px rgba(24,160,110,.18)}
    .status.error{background:rgba(255,222,224,.72);color:#8f1d1d}.status.error::before{background:#e0393e;box-shadow:0 0 0 4px rgba(224,57,62,.18)}

    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .btn{height:36px;padding:0 16px;border:0;border-radius:999px;cursor:pointer;font-size:14px;font-weight:500;color:#08508f;white-space:nowrap;
      background:rgba(255,255,255,.52);box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 0 0 1px rgba(255,255,255,.45),0 3px 10px -2px rgba(6,40,84,.12);
      transition:background-color 160ms ease,transform 220ms var(--spring),box-shadow 160ms ease}
    .btn:hover{background:rgba(255,255,255,.85)}.btn:active{transform:scale(.95)}
    .btn.primary{color:#fff;background:linear-gradient(180deg,#2f93f2,#006fcf);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.55),inset 0 -1px 2px rgba(0,30,80,.25),0 6px 16px -4px rgba(var(--blue),.55)}
    .btn.primary:hover{background:linear-gradient(180deg,#45a0f5,#0a78d6)}
    .btn.small{height:32px;padding:0 13px;font-size:13px}
    .btn:disabled{opacity:.45;cursor:default}
    button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid rgba(0,119,200,.75);outline-offset:2px}

    section.card{padding:16px 16px 14px;border-radius:26px;
      background:linear-gradient(180deg,rgba(255,255,255,.66),rgba(255,255,255,.40));
      box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 0 0 1px rgba(255,255,255,.35),0 10px 26px -14px rgba(6,40,84,.30)}
    .card-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
    .card-head h3{margin:0;font-size:17px;font-weight:700}
    .tailno{font-size:13px;color:var(--ink3);font-variant-numeric:tabular-nums}
    .badge{margin-left:auto;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;color:#08508f;background:rgba(var(--blue),.10)}
    .badge.live{color:#fff;background:linear-gradient(180deg,#2f93f2,#006fcf);box-shadow:inset 0 1px 0 rgba(255,255,255,.5)}

    .months{display:flex;gap:4px;padding:4px;border-radius:18px;background:rgba(0,60,120,.06);box-shadow:inset 0 1px 2px rgba(0,40,90,.08);margin-bottom:6px}
    .months button{flex:1;border:0;border-radius:14px;padding:6px 4px;cursor:pointer;background:transparent;line-height:1.3;
      display:flex;flex-direction:column;align-items:center;gap:1px;transition:background-color 160ms ease,transform 200ms var(--spring)}
    .months button b{font-size:14.5px;font-weight:600}
    .months button span{font-size:12px;color:var(--ink3)}
    .months .done{background:rgba(255,255,255,.78);box-shadow:inset 0 1px 0 #fff,0 2px 8px -2px rgba(6,40,84,.16)}
    .months .done span{color:#127a55}
    .months .missing span{color:#9a6a00}
    .months button:not(:disabled):hover{background:rgba(255,255,255,.92)}
    .months button:not(:disabled):active{transform:scale(.95)}
    .months button:disabled{cursor:default}

    .metric{padding:12px 2px 2px}
    .metric+.metric{border-top:1px solid rgba(0,60,120,.07)}
    .mhead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
    .mlabel{font-size:14.5px;font-weight:500;color:var(--ink2)}
    .mval{font-size:21px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
    .mval small{font-size:13px;font-weight:500;color:var(--ink3);margin-left:2px}
    .track{position:relative;height:9px;margin:8px 0 6px;border-radius:999px;overflow:hidden;
      background:rgba(0,60,120,.09);box-shadow:inset 0 1px 2px rgba(0,40,90,.12)}
    .fill{height:100%;width:0;border-radius:inherit;position:relative;
      background:linear-gradient(90deg,#f2c14e,#d99a00);transition:width 900ms var(--ease) 120ms}
    .fill.ok{background:linear-gradient(90deg,#62b8ff,#006fcf)}
    .fill.full{background:linear-gradient(90deg,#46d19c,#0f9d6c)}
    .fill::after{content:'';position:absolute;left:4px;right:4px;top:1.5px;height:3px;border-radius:999px;background:rgba(255,255,255,.55)}
    .mfoot{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;color:var(--ink3);font-variant-numeric:tabular-nums}
    .note{margin-top:6px;font-size:12.5px;color:#7a5600;padding:6px 10px;border-radius:12px;background:rgba(255,236,186,.5)}

    .unknown{padding:12px 14px;border-radius:20px;background:rgba(255,238,196,.62);box-shadow:inset 0 1px 0 rgba(255,255,255,.7);overflow-wrap:anywhere}
    .unknown .q{font-size:13.5px;margin-bottom:8px}.unknown .q b{font-weight:600}
    .inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--ink2)}

    details.glass{border-radius:22px;background:rgba(255,255,255,.34);box-shadow:inset 0 1px 0 rgba(255,255,255,.85),inset 0 0 0 1px rgba(255,255,255,.3)}
    details.glass>summary{list-style:none;cursor:pointer;padding:13px 16px;font-weight:600;font-size:14.5px;display:flex;align-items:center;justify-content:space-between}
    details.glass>summary::-webkit-details-marker{display:none}
    details.glass>summary::after{content:'';width:8px;height:8px;border-right:2px solid var(--ink3);border-bottom:2px solid var(--ink3);transform:rotate(45deg) translateY(-2px);transition:transform 260ms var(--spring)}
    details.glass[open]>summary::after{transform:rotate(225deg) translateY(-2px)}
    .form{padding:0 16px 16px;display:grid;grid-template-columns:1fr 1fr;gap:10px 12px}
    .form .full{grid-column:1/-1}
    .form label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--ink2);min-width:0}
    .form label.check{flex-direction:row;align-items:center;gap:8px;font-size:13.5px;color:var(--ink)}
    .form h4{grid-column:1/-1;margin:6px 0 -2px;font-size:13px;font-weight:600;color:var(--ink3);letter-spacing:.04em}
    input,select{height:36px;width:100%;padding:0 12px;border:0;border-radius:12px;color:var(--ink);font-size:14px;font-variant-numeric:tabular-nums;
      background:rgba(255,255,255,.66);box-shadow:inset 0 1px 2px rgba(0,40,90,.10),inset 0 0 0 1px rgba(0,60,120,.10)}
    input[type=checkbox]{width:18px;height:18px;padding:0;accent-color:#006fcf;box-shadow:none}
    .unknown select,.unknown input,.alias select,.alias input{width:auto;height:32px;font-size:13px}
    .unknown input,.alias input{width:72px}
    .alias{padding:10px 12px;border-radius:16px;background:rgba(255,255,255,.5);font-size:13px;overflow-wrap:anywhere}
    .alias .inline{margin-top:6px}
    .muted{font-size:12.5px;color:var(--ink3);line-height:1.55;margin:0}
    a{color:#0a63b5;text-decoration:none}a:hover{text-decoration:underline}
    .foot{padding:0 4px}
    .stack{display:grid;gap:12px}.stack:empty{display:none}

    @media(max-width:520px){:host{right:10px;bottom:10px;--panel-w:calc(100vw - 20px);--panel-h:min(800px,calc(100dvh - 20px))}.form{grid-template-columns:1fr}}
    @media(prefers-reduced-motion:reduce){.shell,.pane,.orb,.tint,.glare,.stag,.fill,.compact .pane,.compact .orb,.compact .tint,.compact .pane .stag{transition:none!important}}
    @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.shell{background-color:rgba(236,244,252,.96)}.shell.compact{background-color:rgb(var(--blue))}}`;

  const LOGO = 'data:image/png;base64,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';
  const shell = el('div', undefined, 'shell');
  const tint = el('div', undefined, 'tint'), glare = el('div', undefined, 'glare'), rim = el('div', undefined, 'rim');
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
  shell.append(tint, glare, pane, orb, rim);
  shadow.append(style, shell);
  shell.addEventListener('click', e => { if (minimized && e.target === shell) setMinimized(false, true); });

  function setMinimized(value, focus = false) {
    minimized = value;
    shell.classList.toggle('compact', minimized);
    pane.inert = minimized; pane.setAttribute('aria-hidden', String(minimized));
    orb.inert = !minimized; orb.setAttribute('aria-expanded', String(!minimized));
    GM_setValue(PREFIX + 'minimized', minimized);
    if (focus) (minimized ? orb : collapse).focus({ preventScroll: true });
  }
  setMinimized(minimized);
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
    if (!token) { ledgerNote = manual ? '记账本：还没设置写入令牌（Tampermonkey 菜单）' : ''; return; }
    if (!month || ledgerBusy) return;
    const report = buildReport(loadMonth, config, month);
    const sig = fnv(JSON.stringify(report));
    const sent = GM_getValue(PREFIX + 'ledgerSent', {}) || {};
    if (!manual && sent[report.quarter] === sig) return;
    ledgerBusy = true;
    GM_xmlhttpRequest({
      method: 'POST', url: LEDGER_URL + '/api/manual/tracker', timeout: 30000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: JSON.stringify({ ...report, pushed_at: new Date().toISOString() }),
      onload: r => {
        ledgerBusy = false;
        if (r.status === 200) { sent[report.quarter] = sig; GM_setValue(PREFIX + 'ledgerSent', sent); ledgerNote = `记账本：已推送 ${report.quarter} 汇总`; }
        else { let msg = r.statusText; try { msg = JSON.parse(r.responseText).error || msg; } catch { /* 非 JSON */ } ledgerNote = `记账本推送失败（${r.status}）：${msg}`; }
        renderKey = '';
      },
      onerror: () => { ledgerBusy = false; ledgerNote = '记账本：连不上 Worker'; renderKey = ''; },
      ontimeout: () => { ledgerBusy = false; ledgerNote = '记账本：请求超时'; renderKey = ''; },
    });
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
    const route = activeRoute(); host.style.display = route ? '' : 'none';
    if (!route) { session = null; batch = null; routeWasActive = false; return; }
    if (!routeWasActive) { cache.clear(); routeWasActive = true; }
    const ctx = readContext();
    if (!session || session.key !== ctx.key) {
      if (batch && (batch.tail !== ctx.tail || batch.expected !== ctx.month)) batch = null;
      reset(ctx);
    }
    if (ctx.error) { say(ctx.error); render(ctx); return; }
    if (paused) { say('已暂停自动扫描；显示已保存的快照。'); render(ctx); return; }
    if (!ctx.filterOK) { say('请将网页「狀況」改为「所有」；筛选后的数据不能标为完整。'); render(ctx); return; }
    const view = readTable(ctx), now = Date.now();
    const signature = JSON.stringify([view.fingerprint, view.totalRows, view.kind, view.disabled, view.busy, view.error]);
    if (signature !== session.signature) {
      session.signature = signature; session.stableSince = now; session.done = false;
    }
    if (view.issues.length) { say(view.issues.join('；')); render(ctx); return; }
    if (session.failed) { say(session.failed, 'error'); render(ctx); return; }
    if (view.busy || view.disabled) {
      if (now - session.lastProgress > 45000) session.failed = '加载超过45秒；已停止，请完成网页验证或手动重试后点「重新扫描」。';
      say(`正在等待 ${ctx.month} 加载…（${view.totalRows}行）`); render(ctx); return;
    }
    if (session.pending) {
      const p = session.pending;
      if (view.fingerprint !== p.fingerprint || view.kind === 'done' || (view.kind === 'retry' && p.kind !== 'retry')) {
        session.pending = null; session.lastProgress = now;
      } else if (now - p.at < (p.kind === 'retry' ? 8000 : 18000)) {
        say(`已点击${p.kind === 'retry' ? '重试' : '展示更多'}，等待网页响应…（${view.totalRows}行）`); render(ctx); return;
      } else if (p.kind === 'retry' && view.kind === 'retry' && session.retries < 3) {
        session.pending = null;
      } else {
        session.failed = '按钮点击后没有加载新记录；请手动操作网页，再点「重新扫描」。';
        say(session.failed, 'error'); render(ctx); return;
      }
    }
    if (view.kind === 'more' || view.kind === 'retry') {
      say(`${ctx.month} 尚未展开完：${view.totalRows}行${config.autoExpand ? '，自动加载中…' : '；请手动展开或开启自动展开。'}`);
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
    if (view.error) { say('网页报告加载错误，尚未保存完整快照。', 'error'); render(ctx); return; }
    const ready = (view.kind === 'done' && (view.totalRows > 0 || view.empty)) || (view.kind === 'none' &&
      ((view.totalRows > 0 && view.totalRows < 15 && !!view.table) || view.empty));
    if (!ready) {
      say(view.totalRows >= 15 ? '找不到展开按钮，但已有15行或以上；不能确认读全，请检查网页布局。' : '等待交易表格或明确的「没有记录」提示…');
      render(ctx); return;
    }
    if (now - session.stableSince < 4000 || now - session.started < 5000) {
      say(`已到列表底端，等待内容稳定…（${view.totalRows}行）`); render(ctx); return;
    }
    if (session.saved !== signature) {
      const snap = makeSnapshot(ctx, view.rows, view.totalRows, now, view.kind === 'done' ? 'show-less' : view.empty ? 'empty-state' : 'short-table');
      if (save(monthKey(ctx.tail, ctx.month), snap)) { session.saved = signature; session.done = true; session.pushed = false; }
    } else session.done = true;
    if (session.done && !session.pushed) { session.pushed = true; pushReport(ctx.month); }
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
    if (batch) { batch = null; renderKey = ''; tick(); return; }
    const ctx = readContext();
    if (ctx.error || !ctx.filterOK) { say(ctx.error || '请先将网页状态筛选改为「所有」。'); render(ctx); return; }
    const select = document.querySelector('#time-filter');
    const available = new Set([...(select?.options || [])].map(o => parseMonth(o.textContent)));
    const queue = quarterMonths(ctx.month).filter(m => available.has(m));
    if (!queue.length) return;
    paused = false;
    batch = { tail: ctx.tail, original: ctx.month, expected: queue.shift(), queue };
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
  GM_registerMenuCommand('Amex：展开设置', () => { setMinimized(false); settings.open = true; });
  GM_registerMenuCommand('Amex：导出备份', () => exportButton.click());
  GM_registerMenuCommand('Amex：设置记账本写入令牌', () => {
    const v = prompt('记账本 Worker 的 INGEST_TOKEN（只用于写入）', GM_getValue(PREFIX + 'ledgerToken', '') ? '（已设置，留空不变）' : '');
    if (v && !v.startsWith('（')) { GM_setValue(PREFIX + 'ledgerToken', v.trim()); ledgerNote = '记账本：写入令牌已保存'; renderKey = ''; }
  });
  GM_registerMenuCommand('Amex：立即推送到记账本', () => {
    const ctx = readContext();
    if (!ctx.month) { ledgerNote = '记账本：请先打开积分记录页面'; return; }
    pushReport(ctx.month, true); renderKey = '';
  });
  setInterval(() => { try { tick(); } catch (e) { say(`扫描异常：${e.message}；未保存此轮结果。`, 'error'); live.textContent = status; live.className = 'status stag error'; } }, 750);
  renderAliases(); tick();
})();