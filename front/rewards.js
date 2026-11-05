// Reward Tracker — 积分计划、卡片权益目录、交易分类与积分估算。
// 卡片倍数整理自 2026 年 10–11 月的公开资料（NerdWallet / TPG / OMAAT / Upgraded Points / Apple 官网），
// 银行随时可能调整；点页面上的「更新」可以逐笔改倍数，改过的会按 MCC（或商户名）记住。

(function () {
  // ------------------------------------------------------------ 积分计划
  // unit: "pts" = 点数（倍数 = 每 $1 几点）；"cash" = 现金（倍数 = 百分比）
  const PROGRAMS = {
    chase_ur:   { name: "Ultimate Rewards",   short: "UR",  issuer: "Chase",            domain: "chase.com",            color: "#117ACA", unit: "pts" },
    citi_ty:    { name: "ThankYou Points",    short: "TYP", issuer: "Citi",             domain: "citi.com",             color: "#003B70", unit: "pts" },
    amex_mr:    { name: "Membership Rewards", short: "MR",  issuer: "American Express", domain: "americanexpress.com",  color: "#016FD0", unit: "pts" },
    amex_cash:  { name: "Reward Dollars",     short: "$",   issuer: "American Express", domain: "americanexpress.com",  color: "#016FD0", unit: "cash" },
    barclays:   { name: "Cash Back",          short: "$",   issuer: "Barclays",         domain: "barclays.com",         color: "#00AEEF", unit: "cash" },
    marriott:   { name: "Marriott Bonvoy",    short: "MB",  issuer: "Marriott",         domain: "marriott.com",         color: "#B04A2F", unit: "pts" },
    apple_cash: { name: "Daily Cash",         short: "$",   issuer: "Apple",            domain: "apple.com",            color: "#1D1D1F", unit: "cash" },
  };

  // ------------------------------------------------------------ 消费类别
  const CATS = {
    dining: "餐饮", grocery: "超市", online_grocery: "线上超市", gas: "加油 / 充电",
    flights: "机票", hotels: "酒店", car_rental: "租车", travel: "其他旅行",
    transit: "公共交通 / 打车", drugstore: "药店", streaming: "流媒体", phone_internet: "通讯 / 网络",
    medical: "医疗", home_improvement: "家装", fitness: "健身", entertainment: "现场娱乐",
    portal: "银行旅行平台", merchant3: "Apple 3% 商户", marriott: "万豪旗下酒店", other: "其他",
  };

  // MCC → 类别（区间含两端）
  const MCC_RANGES = [
    [3000, 3350, "flights"], [4511, 4511, "flights"],
    [3351, 3500, "car_rental"], [7512, 7512, "car_rental"], [7513, 7513, "car_rental"],
    [3501, 3999, "hotels"], [7011, 7011, "hotels"],
    [5812, 5814, "dining"],
    [5411, 5411, "grocery"], [5422, 5422, "grocery"], [5441, 5441, "grocery"], [5451, 5451, "grocery"], [5462, 5462, "grocery"], [5499, 5499, "grocery"],
    [5541, 5542, "gas"], [5552, 5552, "gas"], [5983, 5983, "gas"],
    [4111, 4112, "transit"], [4121, 4121, "transit"], [4131, 4131, "transit"], [4784, 4784, "transit"], [7523, 7523, "transit"],
    [4411, 4411, "travel"], [4722, 4722, "travel"], [4789, 4789, "travel"], [7032, 7033, "travel"],
    [5912, 5912, "drugstore"],
    [4899, 4899, "streaming"], [5815, 5818, "streaming"],
    [4812, 4814, "phone_internet"], [4816, 4816, "phone_internet"],
    [8011, 8099, "medical"],
    [5200, 5200, "home_improvement"], [5211, 5211, "home_improvement"], [5251, 5251, "home_improvement"],
    [7997, 7997, "fitness"], [7941, 7941, "entertainment"], [7922, 7922, "entertainment"], [7929, 7929, "entertainment"], [7991, 7991, "entertainment"], [7996, 7996, "entertainment"],
  ];

  // Plaid personal_finance_category.detailed → 类别（没有 MCC 时的后备）
  const PFC = {
    FOOD_AND_DRINK_RESTAURANT: "dining", FOOD_AND_DRINK_FAST_FOOD: "dining", FOOD_AND_DRINK_COFFEE: "dining",
    FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: "other", FOOD_AND_DRINK_GROCERIES: "grocery",
    TRANSPORTATION_GAS: "gas", TRANSPORTATION_PUBLIC_TRANSIT: "transit", TRANSPORTATION_TAXIS_AND_RIDE_SHARES: "transit",
    TRANSPORTATION_TOLLS: "transit", TRANSPORTATION_PARKING: "transit",
    TRAVEL_FLIGHTS: "flights", TRAVEL_LODGING: "hotels", TRAVEL_RENTAL_CARS: "car_rental", TRAVEL_OTHER_TRAVEL: "travel",
    MEDICAL_PHARMACIES_AND_SUPPLEMENTS: "drugstore",
    ENTERTAINMENT_TV_AND_MOVIES: "streaming", ENTERTAINMENT_MUSIC_AND_AUDIO: "streaming",
    ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: "entertainment",
    RENT_AND_UTILITIES_TELEPHONE: "phone_internet", RENT_AND_UTILITIES_INTERNET_AND_CABLE: "phone_internet",
    HOME_IMPROVEMENT_HARDWARE: "home_improvement", PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: "fitness",
  };
  const PFC_PRIMARY = { MEDICAL: "medical", TRAVEL: "travel" };

  // 卡片权益返现（Dining Credit、Uber Cash、Amex Offers 等）：是发卡行给的抵扣，不扣积分
  const BENEFIT_CREDIT = /\b(dining|hotel|resort|property|airline|uber|digital entertainment|entertainment|saks|walmart\+?|clear|equinox|lululemon|oura|resy|streaming|travel|statement|platinum|brilliant|gold|offer)\b.*\bcredit\b|\bamex offer\b|\bcredit\b.*\b(amex|american express)\b/i;
  const isBenefitCredit = (t) => t.amount < 0 && BENEFIT_CREDIT.test(`${t.name || ""} ${t.merchant || ""}`);

  // 不产生积分的交易（还款、转账、利息、费用）
  const NO_EARN_PRIMARY = new Set(["LOAN_PAYMENTS", "TRANSFER_IN", "TRANSFER_OUT", "BANK_FEES", "INCOME"]);

  // ------------------------------------------------------------ 卡片目录
  // rules 按顺序匹配；cap 用满后继续往下找下一条匹配规则，最后落到 base。
  // period: year / quarter / month（按自然年 / 季 / 月近似账单周期）
  const PRODUCTS = {
    // ---------- Chase · Ultimate Rewards
    csr: { name: "Sapphire Reserve", issuer: "Chase", program: "chase_ur", match: /sapphire\s*reserve/i, base: 1,
      portal: /chase\s*travel/i, rules: [
        { cats: ["portal"], rate: 8 },
        { cats: ["flights", "hotels"], rate: 4, note: "直接向航司 / 酒店订" },
        { cats: ["dining"], rate: 3 },
      ] },
    csp: { name: "Sapphire Preferred", issuer: "Chase", program: "chase_ur", match: /sapphire\s*pref/i, base: 1,
      portal: /chase\s*travel/i, rules: [
        { cats: ["portal"], rate: 5 },
        { cats: ["dining", "online_grocery", "streaming"], rate: 3 },
        { cats: ["flights", "hotels", "car_rental", "travel", "transit"], rate: 2 },
      ] },
    cfu: { name: "Freedom Unlimited", issuer: "Chase", program: "chase_ur", match: /freedom\s*unlimited/i, base: 1.5,
      portal: /chase\s*travel/i, rules: [
        { cats: ["portal"], rate: 5 },
        { cats: ["dining", "drugstore"], rate: 3 },
      ] },
    cff: { name: "Freedom Flex", issuer: "Chase", program: "chase_ur", match: /freedom\s*flex/i, base: 1,
      portal: /chase\s*travel/i, rules: [
        { cats: ["portal"], rate: 5 },
        // 季度轮换 5%（需激活，每季合计 $1,500）。新季度公布后在这里加一行
        { cats: ["gas", "transit", "entertainment"], rate: 5, cap: 1500, from: "2026-07-01", to: "2026-09-30", note: "Q3 轮换",
          rotation: { title: "2026 Q3 5% 轮换", items: ["加油站和电动车充电", "公共交通", "部分现场娱乐", "United Way 捐款"], activateBy: "2026-09-14" } },
        // 2026 年 Q4（10–12 月）：超市 5x（1+4），餐饮 7x（1+4+2）；轮换额度合计 $1,500，用满后超市 1x、餐饮 3x
        { cats: ["grocery", "dining"], rate: 5, rates: { dining: 7 }, after: { dining: 3 }, cap: 1500,
          merchants: /american red cross|redcross/i,
          from: "2026-10-01", to: "2026-12-31", note: "Q4 轮换",
          rotation: { title: "2026 Q4 5% 轮换", activateBy: "2026-12-14",
            items: ["餐厅（含外卖），合计 7x = 1 + 4 + 日常餐饮 2", "超市（不含 Walmart、Target），5x", "American Red Cross 捐款，5x"] } },
        { cats: ["dining", "drugstore"], rate: 3 },
      ] },
    chase_other: { name: "Chase 其他卡", issuer: "Chase", program: "chase_ur", match: null, base: 1, rules: [] },

    // ---------- Citi · ThankYou
    strata_elite: { name: "Strata Elite", issuer: "Citi", program: "citi_ty", match: /strata\s*elite/i, base: 1.5,
      portal: /citi\s*travel|cititravel/i, rules: [
        { cats: ["portal"], rate: 12, note: "Citi Travel 酒店 / 租车（机票为 6x）" },
        { cats: ["dining"], rate: 3, note: "周五、周六 18:00–6:00 ET 为 6x，可手动改" },
      ] },
    strata_premier: { name: "Strata Premier", issuer: "Citi", program: "citi_ty", match: /strata\s*premier|\bpremier\b/i, base: 1,
      portal: /citi\s*travel|cititravel/i, rules: [
        { cats: ["portal"], rate: 10 },
        { cats: ["flights", "hotels", "dining", "grocery", "gas"], rate: 3 },
      ] },
    strata: { name: "Strata", issuer: "Citi", program: "citi_ty", match: /\bstrata\b/i, base: 1,
      portal: /citi\s*travel|cititravel/i, rules: [
        { cats: ["portal"], rate: 5 },
        { cats: ["grocery", "gas", "transit"], rate: 3 },
      ] },
    double_cash: { name: "Double Cash", issuer: "Citi", program: "citi_ty", match: /double\s*cash/i, base: 2,
      portal: /citi\s*travel|cititravel/i, rules: [{ cats: ["portal"], rate: 5 }] },
    custom_cash: { name: "Custom Cash", issuer: "Citi", program: "citi_ty", match: /custom\s*cash/i, base: 1,
      portal: /citi\s*travel|cititravel/i,
      // 每个账单周期消费最多的合格类别 5%，前 $500
      top: { cats: ["dining", "grocery", "gas", "drugstore", "home_improvement", "fitness", "entertainment", "transit", "travel", "streaming"], rate: 5, cap: 500 },
      rules: [{ cats: ["portal"], rate: 4 }] },
    citi_other: { name: "Citi 其他卡", issuer: "Citi", program: "citi_ty", match: null, base: 1, rules: [] },

    // ---------- Amex · Membership Rewards
    bonvoy_brilliant: { name: "Marriott Bonvoy Brilliant", issuer: "American Express", program: "marriott",
      match: /bonvoy\s*brilliant|marriott.*brilliant|brilliant/i, base: 2,
      merchants: /marriott|ritz[- ]?carlton|st\.? ?regis|\bw hotels?\b|westin|sheraton|le m[eé]ridien|renaissance|courtyard|fairfield|residence inn|springhill|towneplace|aloft|moxy|four points|\belement\b|delta hotels|gaylord|autograph collection|tribute portfolio|luxury collection|edition hotel|design hotels|bulgari/i,
      merchantCat: "marriott",
      rules: [
        { cats: ["marriott"], rate: 6 },
        { cats: ["dining", "flights"], rate: 3 },   // 机票限直接向航司订
      ] },
    amex_plat: { name: "Platinum Card", issuer: "American Express", program: "amex_mr", match: /platinum/i, base: 1,
      portal: /amex\s*travel|amextravel|american\s*express\s*travel/i, rules: [
        { cats: ["flights"], rate: 5, cap: 500000, period: "year" },
        { cats: ["portal"], rate: 5, note: "Amex Travel 预付酒店" },
      ] },
    amex_gold: { name: "Gold Card", issuer: "American Express", program: "amex_mr", match: /\bgold\b/i, base: 1,
      portal: /amex\s*travel|amextravel|american\s*express\s*travel/i, rules: [
        { cats: ["dining"], rate: 4, cap: 50000, period: "year" },
        { cats: ["grocery"], rate: 4, cap: 25000, period: "year", note: "美国超市" },
        { cats: ["flights"], rate: 3 },
        { cats: ["portal"], rate: 5, note: "Amex Travel 预付酒店" },
      ] },
    amex_green: { name: "Green Card", issuer: "American Express", program: "amex_mr", match: /\bgreen\b/i, base: 1, rules: [
        { cats: ["dining", "flights", "hotels", "car_rental", "travel", "transit"], rate: 3 },
      ] },
    amex_bbp: { name: "Blue Business Plus", issuer: "American Express", program: "amex_mr", match: /blue\s*business\s*plus/i, base: 1, rules: [
        { cats: Object.keys(CATS), rate: 2, cap: 50000, period: "year" },
      ] },
    amex_bce: { name: "Blue Cash Everyday", issuer: "American Express", program: "amex_cash", match: /blue\s*cash\s*every/i, base: 1, rules: [
        { cats: ["grocery", "gas", "online_grocery"], rate: 3, cap: 6000, period: "year", note: "各类别各 $6,000" },
      ] },
    amex_bcp: { name: "Blue Cash Preferred", issuer: "American Express", program: "amex_cash", match: /blue\s*cash\s*pref/i, base: 1, rules: [
        { cats: ["grocery"], rate: 6, cap: 6000, period: "year" },
        { cats: ["streaming"], rate: 6 },
        { cats: ["gas", "transit"], rate: 3 },
      ] },
    amex_everyday: { name: "Amex EveryDay", issuer: "American Express", program: "amex_mr", match: /every\s*day(?!.*cash)/i, base: 1, rules: [
        { cats: ["grocery"], rate: 2, cap: 6000, period: "year" },
      ] },
    amex_other: { name: "Amex 其他卡", issuer: "American Express", program: "amex_mr", match: null, base: 1, rules: [] },

    // ---------- Barclays · Cash Back
    aarp_travel: { name: "AARP Travel Rewards", issuer: "Barclays", program: "barclays", match: /aarp.*travel/i, base: 1, rules: [
        { cats: ["flights", "hotels", "car_rental"], rate: 3 },
        { cats: ["dining"], rate: 2 },
      ] },
    aarp_essential: { name: "AARP Essential Rewards", issuer: "Barclays", program: "barclays", match: /aarp/i, base: 1, rules: [
        { cats: ["gas", "drugstore"], rate: 3 },
        { cats: ["medical"], rate: 2 },
      ] },
    barclays_view: { name: "Barclays View", issuer: "Barclays", program: "barclays", match: /\bview\b/i, base: 1, rules: [
        { cats: ["dining"], rate: 3 },
        { cats: ["grocery", "streaming", "phone_internet"], rate: 2 },
      ] },
    barclays_other: { name: "Barclays 其他卡", issuer: "Barclays", program: "barclays", match: null, base: 1, rules: [] },

    // ---------- Apple Card · Daily Cash
    apple_card: { name: "Apple Card", issuer: "Apple", program: "apple_cash", match: /apple/i, base: 2,
      note: "默认按 Apple Pay 2% 估算；实体卡消费 1%，可手动改",
      merchants: /\bapple\b|apple\.com|itunes|\buber\b|walgreens|duane\s*reade|\bnike\b|exxon|\bmobil\b|ace\s*hardware|chargepoint|\bhertz\b|booking\.com/i,
      rules: [{ cats: ["merchant3"], rate: 3 }] },
  };

  const ISSUER_FALLBACK = { Chase: "chase_other", Citi: "citi_other", "American Express": "amex_other", Barclays: "barclays_other", Apple: "apple_card" };

  // ------------------------------------------------------------ helpers
  function issuerOf(institution) {
    const s = String(institution || "").toLowerCase();
    if (s.includes("chase")) return "Chase";
    if (s.includes("citi")) return "Citi";
    if (s.includes("american express") || s.includes("amex")) return "American Express";
    if (s.includes("barclay")) return "Barclays";
    if (s.includes("apple") || s.includes("goldman")) return "Apple";
    return null;
  }

  // 根据银行 + 账户名猜卡片产品
  function guessProduct(account) {
    const issuer = issuerOf(account.institution);
    if (!issuer) return null;
    const text = `${account.name || ""} ${account.official_name || ""}`;
    for (const [key, p] of Object.entries(PRODUCTS)) {
      if (p.issuer === issuer && p.match && p.match.test(text)) return key;
    }
    return ISSUER_FALLBACK[issuer] || null;
  }

  function mccCat(mcc) {
    const n = Number(mcc);
    if (!Number.isFinite(n)) return null;
    for (const [lo, hi, c] of MCC_RANGES) if (n >= lo && n <= hi) return c;
    return null;
  }

  function classify(t, product) {
    const text = `${t.merchant || ""} ${t.name || ""}`;
    if (product?.portal && product.portal.test(text)) return "portal";
    if (product?.merchants && product.merchants.test(text)) return product.merchantCat || "merchant3";
    const c = (t.mcc && mccCat(t.mcc)) || PFC[t.category_detail] || PFC_PRIMARY[t.category];
    if (c === "grocery" && t.channel === "online") return "online_grocery_or_grocery";
    return c || "other";
  }

  const ruleKey = (t) => (t.mcc ? `mcc:${t.mcc}` : `m:${String(t.merchant || t.name || "").trim().toLowerCase()}`);
  const ruleKeyLabel = (k) => (k.startsWith("mcc:") ? `MCC ${k.slice(4)}` : `商户「${k.slice(2)}」`);

  function periodKey(date, period) {
    const y = date.slice(0, 4), m = Number(date.slice(5, 7));
    if (period === "year") return y;
    if (period === "quarter") return `${y}-Q${Math.ceil(m / 3)}`;
    return date.slice(0, 7);
  }

  const catMatches = (ruleCats, c) =>
    ruleCats.includes(c) ||
    (c === "online_grocery_or_grocery" && (ruleCats.includes("online_grocery") || ruleCats.includes("grocery")));

  // ------------------------------------------------------------ 核心计算
  // 返回 Map<txnId, {rate, earned, cat, source, unit, program, product, key}>
  function compute(txns, accounts, settings) {
    const out = new Map();
    const rotations = [];
    out.rotations = rotations;
    const cards = settings.cards || {};
    const learned = settings.rules || {};

    // 按账户分组、时间正序，保证 cap 按先后顺序消耗
    const byAcct = new Map();
    for (const t of txns) {
      const a = accounts[t.account_id];
      if (!a || a.type !== "credit") continue;
      if (!byAcct.has(t.account_id)) byAcct.set(t.account_id, []);
      byAcct.get(t.account_id).push(t);
    }

    for (const [acctId, list] of byAcct) {
      const a = accounts[acctId];
      const pKey = Object.hasOwn(cards, acctId) ? cards[acctId] : guessProduct(a);
      const product = PRODUCTS[pKey];
      if (!product) continue;
      const unit = PROGRAMS[product.program].unit;
      const acctRules = learned[acctId] || {};
      list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

      // Custom Cash：每月消费最多的合格类别
      const topCat = {};
      if (product.top) {
        const sums = {};
        for (const t of list) {
          if (t.amount <= 0 || NO_EARN_PRIMARY.has(t.category)) continue;
          const c = classify(t, product), m = t.date.slice(0, 7);
          if (!product.top.cats.includes(c)) continue;
          sums[m] = sums[m] || {};
          sums[m][c] = (sums[m][c] || 0) + t.amount;
        }
        for (const [m, s] of Object.entries(sums)) topCat[m] = Object.entries(s).sort((x, y) => y[1] - x[1])[0][0];
      }

      const used = {}; // cap 已用额度：`${ruleIdx}|${period}`
      for (const t of list) {
        const key = ruleKey(t);
        const base = { cat: null, unit, program: product.program, product: pKey, key };
        if (isBenefitCredit(t)) { out.set(t.id, { ...base, rate: 0, earned: 0, cat: "none", source: "权益返现，不扣积分" }); continue; }
        if (NO_EARN_PRIMARY.has(t.category)) { out.set(t.id, { ...base, rate: 0, earned: 0, cat: "none", source: "不计积分" }); continue; }

        const cat = classify(t, product);
        let rate = product.base, source = "基础倍数";

        if (acctRules[key] != null) {
          rate = Number(acctRules[key]); source = `已记住 · ${ruleKeyLabel(key)}`;
        } else {
          let done = false;
          if (product.top && topCat[t.date.slice(0, 7)] === cat && t.amount > 0) {
            const u = `top|${t.date.slice(0, 7)}`;
            const room = product.top.cap - (used[u] || 0);
            if (room > 0) {
              const eligible = Math.min(room, t.amount);
              used[u] = (used[u] || 0) + eligible;
              rate = (eligible * product.top.rate + (t.amount - eligible) * product.base) / t.amount;
              source = `本月最高类别 ${fmtRate(product.top.rate, unit)}`; done = true;
            }
          }
          if (!done) {
            product.rules.forEach((r, i) => {
              if (done || !(catMatches(r.cats, cat) || (r.merchants && r.merchants.test(`${t.merchant || ""} ${t.name || ""}`)))) return;
              if (r.quarters && !r.quarters.includes(periodKey(t.date, "quarter"))) return;
              if (r.from && t.date < r.from) return;
              if (r.to && t.date > r.to) return;
              const full = r.rates?.[cat] ?? r.rate;          // 本规则下该类别的倍数
              const rest = r.after?.[cat] ?? product.base;    // 额度用满后的倍数
              if (r.cap && t.amount > 0) {
                // 有日期区间的规则整段共用一个额度；否则按 year / quarter / month 重置
                const u = `${i}|${r.from ? "range" : periodKey(t.date, r.period || "year")}`;
                const room = r.cap - (used[u] || 0);
                if (room <= 0) return;
                const eligible = Math.min(room, t.amount);
                used[u] = (used[u] || 0) + eligible;
                rate = (eligible * full + (t.amount - eligible) * rest) / t.amount;
              } else {
                rate = full;
              }
              source = `${catLabel(cat)} ${fmtRate(full, unit)}${r.note ? " · " + r.note : ""}`;
              done = true;
            });
          }
        }
        const earned = unit === "cash" ? (t.amount * rate) / 100 : t.amount * rate;
        out.set(t.id, { ...base, cat, rate, earned, source });
      }
      // 轮换类别的额度使用情况（给「权益任务」画进度条）
      product.rules.forEach((r, i) => {
        if (r.rotation) rotations.push({ account_id: acctId, product: pKey, ...r.rotation, from: r.from, to: r.to, cap: r.cap, used: used[`${i}|range`] || 0 });
      });
    }
    return out;
  }

  const catLabel = (c) => (c === "online_grocery_or_grocery" ? "超市" : CATS[c] || "其他");
  const fmtRate = (r, unit) => {
    const n = Math.round(r * 100) / 100;
    return unit === "cash" ? `${n}%` : `${n}x`;
  };
  const fmtEarned = (v, unit) =>
    unit === "cash"
      ? (v < 0 ? "−$" : "$") + Math.abs(v).toFixed(2)
      : (v < 0 ? "−" : "") + Math.round(Math.abs(v)).toLocaleString("en-US");

  window.RT_REWARDS = { isBenefitCredit, PROGRAMS, PRODUCTS, CATS, guessProduct, issuerOf, compute, ruleKey, ruleKeyLabel, catLabel, fmtRate, fmtEarned };
})();
