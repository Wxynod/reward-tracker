// Reward Tracker — 商户品牌 logo（Brandfetch Logo API）。
// 找域名的顺序：① 下面的连锁品牌对照表 ② Plaid 返回的商户网站 ③ Brandfetch 按名称搜索（只接受名称完全一致的结果）
// 图片加载顺序：Brandfetch → Plaid 自带 logo → 彩色类别图标。

(function () {
  const CLIENT_ID = window.RT_CONFIG?.brandfetchClientId || "";

  // 连锁品牌 → 官网域名。按商户名 / 交易描述匹配，随时可以往里加
  const BRANDS = [
    // 咖啡 / 餐饮 / 外卖
    [/starbucks/i, "starbucks.com"], [/blue bottle/i, "bluebottlecoffee.com"], [/dunkin/i, "dunkindonuts.com"],
    [/peet'?s/i, "peets.com"], [/% ?arabica/i, "arabica.coffee"], [/pacific coffee/i, "pacificcoffee.com"],
    [/mcdonald/i, "mcdonalds.com"], [/chipotle/i, "chipotle.com"], [/sweetgreen/i, "sweetgreen.com"],
    [/shake shack/i, "shakeshack.com"], [/in-n-out/i, "in-n-out.com"], [/chick-fil-a/i, "chick-fil-a.com"],
    [/burger king/i, "bk.com"], [/subway/i, "subway.com"], [/taco bell/i, "tacobell.com"], [/kfc/i, "kfc.com"],
    [/domino'?s/i, "dominos.com"], [/pizza hut/i, "pizzahut.com"], [/panera/i, "panerabread.com"],
    [/uber\s*eats/i, "ubereats.com"], [/doordash/i, "doordash.com"], [/grubhub/i, "grubhub.com"],
    [/foodpanda/i, "foodpanda.com"], [/keeta/i, "keeta.com"], [/deliveroo/i, "deliveroo.com"],
    // 出行
    [/\buber\b/i, "uber.com"], [/\blyft\b/i, "lyft.com"], [/\bmta\b|omny/i, "mta.info"], [/\bmtr\b/i, "mtr.com.hk"],
    [/octopus/i, "octopus.com.hk"], [/airbnb/i, "airbnb.com"], [/booking\.com/i, "booking.com"],
    [/expedia/i, "expedia.com"], [/marriott/i, "marriott.com"], [/hilton/i, "hilton.com"], [/hyatt/i, "hyatt.com"],
    [/\bihg\b|intercontinental|holiday inn/i, "ihg.com"], [/delta air/i, "delta.com"], [/united air/i, "united.com"],
    [/american air/i, "aa.com"], [/southwest/i, "southwest.com"], [/jetblue/i, "jetblue.com"],
    [/cathay/i, "cathaypacific.com"], [/hertz/i, "hertz.com"], [/enterprise rent/i, "enterprise.com"],
    [/shell\b/i, "shell.com"], [/exxon|\bmobil\b/i, "exxon.com"], [/chevron/i, "chevron.com"],
    [/chargepoint/i, "chargepoint.com"], [/tesla/i, "tesla.com"],
    // 购物 / 超市
    [/amazon|amzn/i, "amazon.com"], [/apple\.com|apple store|\bapple\b/i, "apple.com"], [/target/i, "target.com"],
    [/walmart/i, "walmart.com"], [/costco/i, "costco.com"], [/whole ?foods/i, "wholefoodsmarket.com"],
    [/trader joe/i, "traderjoes.com"], [/safeway/i, "safeway.com"], [/kroger/i, "kroger.com"],
    [/\bcvs\b/i, "cvs.com"], [/walgreens/i, "walgreens.com"], [/best ?buy/i, "bestbuy.com"],
    [/home ?depot/i, "homedepot.com"], [/lowe'?s/i, "lowes.com"], [/ikea/i, "ikea.com"],
    [/nike/i, "nike.com"], [/uniqlo/i, "uniqlo.com"], [/\bzara\b/i, "zara.com"], [/sephora/i, "sephora.com"],
    [/petco/i, "petco.com"], [/chewy/i, "chewy.com"], [/wellcome/i, "wellcome.com.hk"],
    [/park ?n ?shop/i, "parknshop.com"], [/hktv ?mall/i, "hktvmall.com"], [/7-?eleven/i, "7-eleven.com"],
    // 订阅 / 通讯 / 软件
    [/netflix/i, "netflix.com"], [/spotify/i, "spotify.com"], [/hulu/i, "hulu.com"], [/disney\s*\+|disney plus/i, "disneyplus.com"],
    [/youtube/i, "youtube.com"], [/\bhbo\b|max\.com/i, "max.com"], [/verizon/i, "verizon.com"], [/at&t|\batt\b/i, "att.com"],
    [/t-mobile/i, "t-mobile.com"], [/xfinity|comcast/i, "xfinity.com"], [/google/i, "google.com"],
    [/microsoft|xbox/i, "microsoft.com"], [/adobe/i, "adobe.com"], [/openai|chatgpt/i, "openai.com"],
    [/anthropic|claude\.ai/i, "anthropic.com"], [/equinox/i, "equinox.com"],
  ];

  const domainOf = (url) => {
    try { return new URL(/^https?:/.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ""); }
    catch { return null; }
  };
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // 按名称搜索的结果只在本次打开页面期间保存（Brandfetch 要求不要长期缓存搜索结果）
  const searched = new Map(); // name → domain | null
  const queue = [];
  let busy = false, onFound = null;

  function domainFor(t) {
    const text = `${t.merchant || ""} ${t.name || ""}`;
    for (const [re, d] of BRANDS) if (re.test(text)) return d;
    if (t.website) return domainOf(t.website);
    const key = norm(t.merchant);
    if (key && searched.has(key)) return searched.get(key);
    if (key && CLIENT_ID && !queue.includes(t.merchant)) queue.push(t.merchant);
    return null;
  }

  // 依次搜索没有域名的商户（每次最多 5 个结果，只要名称完全一致的）
  async function drain() {
    if (busy || !queue.length) return;
    busy = true;
    let found = false;
    while (queue.length) {
      const name = queue.shift();
      const key = norm(name);
      if (searched.has(key)) continue;
      try {
        const r = await fetch(`https://api.brandfetch.io/v2/search/${encodeURIComponent(name)}?c=${encodeURIComponent(CLIENT_ID)}`);
        if (r.status === 429) { queue.unshift(name); break; }
        const list = r.ok ? await r.json() : [];
        const hit = Array.isArray(list) && list.find((b) => norm(b.name) === key && b.domain);
        searched.set(key, hit ? hit.domain : null);
        if (hit) found = true;
      } catch { searched.set(key, null); }
      await new Promise((res) => setTimeout(res, 400));
    }
    busy = false;
    if (found && onFound) onFound();
  }

  function logoUrl(domain, size = 96) {
    if (!domain || !CLIENT_ID) return null;
    return `https://cdn.brandfetch.io/domain/${encodeURIComponent(domain)}/w/${size}/h/${size}/fallback/404/type/icon?c=${encodeURIComponent(CLIENT_ID)}`;
  }

  window.RT_BRANDS = {
    enabled: !!CLIENT_ID,
    url: (t) => logoUrl(domainFor(t)),
    domainUrl: (domain, size = 128) => logoUrl(domain, size),
    searchPending: (cb) => { onFound = cb; drain(); },
  };
})();
