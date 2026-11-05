// Reward Tracker — 交易类别图标。
// 先看 MCC，没有 MCC 时用 Plaid 的 personal_finance_category，再用商户名补几个常见特例（咖啡、打车）。
// 图标是 24×24 线条 SVG，颜色由类别决定，底色是同色的浅色块。

(function () {
  // ------------------------------------------------------------ 图标路径
  const P = {
    luggage: '<path d="M9.5 7V3.5h5V7"/><rect x="6" y="7" width="12" height="12.5" rx="2.2"/><path d="M10 10.5v5.5M14 10.5v5.5"/><circle cx="9" cy="21.2" r=".9"/><circle cx="15" cy="21.2" r=".9"/>',
    plane: '<path d="M12 2.8c.8 0 1.4.7 1.4 1.5v5.5l7.6 4.7v2l-7.6-2.4v4.3l2.3 1.8v1.6L12 20.8l-3.7 1v-1.6l2.3-1.8v-4.3L3 16.5v-2l7.6-4.7V4.3c0-.8.6-1.5 1.4-1.5Z"/>',
    bed: '<path d="M3 19V6M3 15h18v4M21 15v-2.5A3 3 0 0 0 18 9.5h-7V15"/><circle cx="7" cy="11.5" r="2"/>',
    car: '<path d="M4.5 12.5 6.4 7.6A1.6 1.6 0 0 1 7.9 6.5h8.2a1.6 1.6 0 0 1 1.5 1.1l1.9 4.9"/><rect x="3" y="12.5" width="18" height="5" rx="1.6"/><path d="M6.5 17.5v2M17.5 17.5v2"/><circle cx="7" cy="15" r=".9"/><circle cx="17" cy="15" r=".9"/>',
    taxi: '<path d="M10 4.5h4l.8 2"/><path d="M4.5 12.5 6.4 7.6A1.6 1.6 0 0 1 7.9 6.5h8.2a1.6 1.6 0 0 1 1.5 1.1l1.9 4.9"/><rect x="3" y="12.5" width="18" height="5" rx="1.6"/><path d="M6.5 17.5v2M17.5 17.5v2"/><circle cx="7" cy="15" r=".9"/><circle cx="17" cy="15" r=".9"/>',
    train: '<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 10h12M10 6.2h4M9 21l1.5-4M15 21l-1.5-4"/><circle cx="9.2" cy="13.5" r=".9"/><circle cx="14.8" cy="13.5" r=".9"/>',
    parking: '<rect x="4" y="3" width="16" height="18" rx="3.5"/><path d="M10 17V8h3a2.5 2.5 0 0 1 0 5h-3"/>',
    fork: '<path d="M6.5 3v5.5a2.2 2.2 0 0 0 4.4 0V3M8.7 3v18"/><path d="M17.5 21V3c-2 1.4-3.2 4.6-3.2 9.2h3.2"/>',
    burger: '<path d="M4 10.5a8 5.5 0 0 1 16 0Z"/><path d="M3.5 13c1.4 1 2.8 1 4.2 0s2.8-1 4.2 0 2.8 1 4.2 0 2.8-1 4.2 0"/><path d="M5 16.5h14a.8.8 0 0 1 .8.9l-.3 1.4a1.6 1.6 0 0 1-1.6 1.2H6.1a1.6 1.6 0 0 1-1.6-1.2l-.3-1.4a.8.8 0 0 1 .8-.9Z"/>',
    coffee: '<path d="M5 9h11.5v5a5 5 0 0 1-5 5h-1.5a5 5 0 0 1-5-5Z"/><path d="M16.5 10.5h1.2a2.4 2.4 0 0 1 0 4.8h-1.4M9 3.5v2.5M12.5 3.5v2.5"/>',
    wine: '<path d="M8 3h8l-.4 5.2a3.6 3.6 0 0 1-7.2 0Z"/><path d="M12 11.8V20M8.5 20h7"/>',
    cart: '<path d="M3 4h2.4l2.3 10.4a1.5 1.5 0 0 0 1.5 1.2h8.2a1.5 1.5 0 0 0 1.4-1.1L21 8H6.3"/><circle cx="10" cy="19.8" r="1.3"/><circle cx="17" cy="19.8" r="1.3"/>',
    fuel: '<rect x="4" y="4" width="9" height="16" rx="1.6"/><path d="M4 10h9M3 20h11M13 8l3 2.6V17a1.5 1.5 0 0 0 3 0V9.2L16.6 6"/>',
    bolt: '<path d="M13.5 2.5 5 13.5h6.2l-1.2 8 8.5-11h-6.2Z"/>',
    pill: '<path d="M10.6 20.4a5 5 0 0 1-7-7l6.2-6.2a5 5 0 0 1 7 7Z"/><path d="m6.7 10.3 7 7"/>',
    medical: '<path d="M12 20.5s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.5c0 5.8-7.5 10.4-7.5 10.4Z"/><path d="M12 10.5v4.5M9.8 12.7h4.4"/>',
    play: '<rect x="3" y="4.5" width="18" height="12.5" rx="2.2"/><path d="M10.2 8.2v5.2l4.3-2.6ZM8 20.5h8"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.6"/><path d="M11 18.5h2"/>',
    laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.6"/><path d="M2.5 19h19"/>',
    shirt: '<path d="M8.5 3.5 3.5 6.2l1.9 3.9 2.1-1V20.5h9V9.1l2.1 1 1.9-3.9-5-2.7a3.5 3.5 0 0 1-7 0Z"/>',
    bag: '<path d="M5.2 8.5h13.6l-.9 11.4a1.3 1.3 0 0 1-1.3 1.1H7.4a1.3 1.3 0 0 1-1.3-1.1Z"/><path d="M9 10.5V7a3 3 0 0 1 6 0v3.5"/>',
    home: '<path d="m3 11 9-7 9 7"/><path d="M5.2 9.5V20h13.6V9.5M10 20v-5.2h4V20"/>',
    dumbbell: '<path d="M6.5 6.5v11M17.5 6.5v11M3.8 9v6M20.2 9v6M6.5 12h11"/>',
    ticket: '<path d="M3.5 7h17v3.2a1.8 1.8 0 0 0 0 3.6V17h-17v-3.2a1.8 1.8 0 0 0 0-3.6Z"/><path d="M14.5 7v2M14.5 11v2M14.5 15v2"/>',
    scissors: '<circle cx="6" cy="7" r="2.6"/><circle cx="6" cy="17" r="2.6"/><path d="M8.2 8.4 20 17.5M8.2 15.6 20 6.5"/>',
    book: '<path d="M4.5 19.5V5a2 2 0 0 1 2-2h13v15h-13a2 2 0 0 0-2 2 2 2 0 0 0 2 2h13v-4"/>',
    paw: '<circle cx="8.3" cy="6.8" r="1.7"/><circle cx="15.7" cy="6.8" r="1.7"/><circle cx="4.8" cy="11.8" r="1.7"/><circle cx="19.2" cy="11.8" r="1.7"/><path d="M12 11.5c-3 0-5.6 4-5.6 6.2a2.1 2.1 0 0 0 2.7 2c1-.3 1.9-.7 2.9-.7s1.9.4 2.9.7a2.1 2.1 0 0 0 2.7-2c0-2.2-2.6-6.2-5.6-6.2Z"/>',
    gift: '<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5.2 12v8.5h13.6V12M12 8v12.5M12 8c-.9-3-5-4.2-5-1.6C7 7.7 9.6 8 12 8c2.4 0 5-.3 5-1.6C17 3.8 12.9 5 12 8Z"/>',
    shield: '<path d="M12 3 19 6v5.2c0 4.4-3 7.9-7 9.8-4-1.9-7-5.4-7-9.8V6Z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
    bank: '<path d="M3 20.5h18M4.5 9.5h15M12 3.5l8 4.5H4ZM7 9.5v8M12 9.5v8M17 9.5v8"/>',
    swap: '<path d="M4 8h14.5l-3.2-3.2M20 16H5.5l3.2 3.2"/>',
    percent: '<circle cx="12" cy="12" r="9"/><path d="m8.8 15.2 6.4-6.4"/><circle cx="9.3" cy="9.3" r=".9"/><circle cx="14.7" cy="14.7" r=".9"/>',
    income: '<path d="M12 3.5v12M7 11l5 5 5-5M5 20.5h14"/>',
    tag: '<path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l9 9-8.8 8.8Z"/><circle cx="8" cy="8" r="1.4"/>',
  };

  // ------------------------------------------------------------ 类别：图标 + 颜色 + 名称
  const C = {
    flights:     ["plane",    "#2b7bd6", "机票"],
    hotels:      ["bed",      "#6c5ce7", "酒店"],
    travel:      ["luggage",  "#0f8f88", "旅行"],
    car_rental:  ["car",      "#3a6db3", "租车"],
    taxi:        ["taxi",     "#d99a00", "打车"],
    transit:     ["train",    "#00897b", "公共交通"],
    parking:     ["parking",  "#5866c2", "停车 / 过路费"],
    dining:      ["fork",     "#e0533d", "餐厅"],
    fast_food:   ["burger",   "#ee8a00", "快餐"],
    coffee:      ["coffee",   "#8d5a3b", "咖啡"],
    bar:         ["wine",     "#a8326e", "酒吧 / 酒水"],
    grocery:     ["cart",     "#3f9b45", "超市"],
    gas:         ["fuel",     "#d1453b", "加油"],
    ev:          ["bolt",     "#20a774", "充电"],
    drugstore:   ["pill",     "#e2568a", "药店"],
    medical:     ["medical",  "#d43a58", "医疗"],
    streaming:   ["play",     "#7b4dd6", "流媒体 / 数字内容"],
    phone:       ["phone",    "#3d8bd9", "通讯 / 网络"],
    utilities:   ["bolt",     "#e3a400", "水电煤"],
    electronics: ["laptop",   "#4f6470", "数码"],
    apparel:     ["shirt",    "#d6457f", "服饰"],
    shopping:    ["bag",      "#b8613a", "购物"],
    home:        ["home",     "#8d6e4c", "家居 / 家装"],
    fitness:     ["dumbbell", "#00a0a0", "健身"],
    entertainment:["ticket",  "#8e44ad", "娱乐"],
    beauty:      ["scissors", "#c4569b", "美容 / 个护"],
    education:   ["book",     "#3b5998", "教育 / 书籍"],
    pets:        ["paw",      "#b07a3a", "宠物"],
    gifts:       ["gift",     "#e04f5f", "礼品 / 捐赠"],
    insurance:   ["shield",   "#5f7d8c", "保险"],
    government:  ["bank",     "#6d6a64", "政府 / 税费"],
    payment:     ["swap",     "#2f6b55", "还款 / 转账"],
    fee:         ["percent",  "#8f8a82", "费用 / 利息"],
    income:      ["income",   "#2f6b55", "收入 / 返现"],
    other:       ["tag",      "#9b9285", "其他"],
  };

  // MCC 区间 → 类别（区间含两端，先匹配先得）
  const MCC = [
    [3000, 3350, "flights"], [4511, 4511, "flights"], [4582, 4582, "flights"],
    [3351, 3500, "car_rental"], [7512, 7513, "car_rental"], [7519, 7519, "car_rental"],
    [3501, 3999, "hotels"], [7011, 7012, "hotels"],
    [4411, 4411, "travel"], [4722, 4722, "travel"], [4789, 4789, "travel"], [7032, 7033, "travel"],
    [4121, 4121, "taxi"], [4111, 4112, "transit"], [4131, 4131, "transit"],
    [4784, 4784, "parking"], [7523, 7523, "parking"],
    [5812, 5812, "dining"], [5814, 5814, "fast_food"], [5813, 5813, "bar"], [5921, 5921, "bar"],
    [5411, 5411, "grocery"], [5422, 5422, "grocery"], [5441, 5441, "grocery"], [5451, 5451, "grocery"], [5462, 5462, "grocery"], [5499, 5499, "grocery"], [5300, 5300, "grocery"],
    [5541, 5542, "gas"], [5983, 5983, "gas"], [5552, 5552, "ev"],
    [5912, 5912, "drugstore"], [5122, 5122, "drugstore"],
    [8011, 8099, "medical"], [5975, 5976, "medical"], [8062, 8062, "medical"],
    [5815, 5818, "streaming"], [4899, 4899, "streaming"],
    [4812, 4816, "phone"], [4900, 4900, "utilities"],
    [5045, 5045, "electronics"], [5732, 5734, "electronics"], [5946, 5946, "electronics"],
    [5611, 5699, "apparel"], [5651, 5651, "apparel"], [5661, 5661, "apparel"], [5944, 5944, "apparel"],
    [5200, 5200, "home"], [5211, 5211, "home"], [5231, 5231, "home"], [5251, 5251, "home"], [5261, 5261, "home"], [5712, 5719, "home"], [5722, 5722, "home"],
    [7997, 7997, "fitness"], [5655, 5655, "fitness"], [5941, 5941, "fitness"],
    [7832, 7832, "entertainment"], [7922, 7922, "entertainment"], [7929, 7929, "entertainment"], [7941, 7941, "entertainment"], [7991, 7999, "entertainment"],
    [7230, 7230, "beauty"], [7297, 7298, "beauty"], [5977, 5977, "beauty"],
    [8211, 8299, "education"], [5942, 5942, "education"], [5192, 5192, "education"],
    [742, 742, "pets"], [5995, 5995, "pets"],
    [8398, 8398, "gifts"], [8661, 8661, "gifts"], [5947, 5947, "gifts"], [5992, 5992, "gifts"],
    [6300, 6300, "insurance"], [5960, 5960, "insurance"],
    [9211, 9402, "government"],
    [5310, 5311, "shopping"], [5331, 5331, "shopping"], [5399, 5399, "shopping"], [5964, 5969, "shopping"], [5999, 5999, "shopping"],
  ];

  // Plaid personal_finance_category（没有 MCC 时）
  const PFC_DETAIL = {
    FOOD_AND_DRINK_RESTAURANT: "dining", FOOD_AND_DRINK_FAST_FOOD: "fast_food", FOOD_AND_DRINK_COFFEE: "coffee",
    FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: "bar", FOOD_AND_DRINK_GROCERIES: "grocery", FOOD_AND_DRINK_VENDING_MACHINES: "fast_food",
    TRANSPORTATION_GAS: "gas", TRANSPORTATION_PUBLIC_TRANSIT: "transit", TRANSPORTATION_TAXIS_AND_RIDE_SHARES: "taxi",
    TRANSPORTATION_TOLLS: "parking", TRANSPORTATION_PARKING: "parking", TRANSPORTATION_BIKES_AND_SCOOTERS: "transit",
    TRAVEL_FLIGHTS: "flights", TRAVEL_LODGING: "hotels", TRAVEL_RENTAL_CARS: "car_rental",
    MEDICAL_PHARMACIES_AND_SUPPLEMENTS: "drugstore",
    ENTERTAINMENT_TV_AND_MOVIES: "streaming", ENTERTAINMENT_MUSIC_AND_AUDIO: "streaming", ENTERTAINMENT_VIDEO_GAMES: "streaming",
    RENT_AND_UTILITIES_TELEPHONE: "phone", RENT_AND_UTILITIES_INTERNET_AND_CABLE: "phone",
    GENERAL_MERCHANDISE_ELECTRONICS: "electronics", GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: "apparel",
    GENERAL_MERCHANDISE_PET_SUPPLIES: "pets", GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: "gifts",
    GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS: "education", GENERAL_MERCHANDISE_SPORTING_GOODS: "fitness",
    PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: "fitness", PERSONAL_CARE_HAIR_AND_BEAUTY: "beauty",
    GENERAL_SERVICES_INSURANCE: "insurance", GENERAL_SERVICES_EDUCATION: "education",
    GOVERNMENT_AND_NON_PROFIT_DONATIONS: "gifts", BANK_FEES_INTEREST_CHARGE: "fee",
  };
  const PFC_PRIMARY = {
    FOOD_AND_DRINK: "dining", TRAVEL: "travel", TRANSPORTATION: "transit", MEDICAL: "medical",
    ENTERTAINMENT: "entertainment", GENERAL_MERCHANDISE: "shopping", HOME_IMPROVEMENT: "home",
    PERSONAL_CARE: "beauty", RENT_AND_UTILITIES: "utilities", GOVERNMENT_AND_NON_PROFIT: "government",
    LOAN_PAYMENTS: "payment", TRANSFER_IN: "payment", TRANSFER_OUT: "payment", BANK_FEES: "fee", INCOME: "income",
  };

  const NAME_HINTS = [
    [/starbucks|coffee|caf[eé]\b|blue bottle|peet'?s|dunkin|tim hortons|% arabica|luckin/i, "coffee"],
    [/\buber\b(?!\s*eats)|\blyft\b|\btaxi\b|\bcab\b/i, "taxi"],
    [/uber\s*eats|doordash|grubhub|seamless|postmates/i, "fast_food"],
    [/netflix|spotify|hulu|disney\+|youtube premium|apple\.com\/bill|hbo|max\.com/i, "streaming"],
    [/chargepoint|electrify america|evgo|tesla supercharg/i, "ev"],
    [/amazon|amzn/i, "shopping"],
  ];

  function mccCat(mcc) {
    const n = Number(mcc);
    if (!Number.isFinite(n)) return null;
    for (const [lo, hi, c] of MCC) if (n >= lo && n <= hi) return c;
    return null;
  }

  function classify(t) {
    // 还款、转账、费用、收入优先：这些交易的 MCC 没有意义
    if (["LOAN_PAYMENTS", "TRANSFER_IN", "TRANSFER_OUT", "BANK_FEES", "INCOME"].includes(t.category)) {
      return PFC_DETAIL[t.category_detail] || PFC_PRIMARY[t.category];
    }
    const text = `${t.merchant || ""} ${t.name || ""}`;
    const fromMcc = t.mcc ? mccCat(t.mcc) : null;
    for (const [re, c] of NAME_HINTS) {
      // 名称提示只细化餐饮 / 交通 / 购物，避免覆盖更可靠的 MCC
      if (re.test(text) && (!fromMcc || ["dining", "fast_food", "transit", "shopping", "gas", "education"].includes(fromMcc))) return c;
    }
    return fromMcc || PFC_DETAIL[t.category_detail] || PFC_PRIMARY[t.category] || "other";
  }

  function info(t) {
    const key = classify(t) || "other";
    const [icon, color, label] = C[key] || C.other;
    return { key, icon, color, label };
  }

  const svg = (icon) =>
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[icon] || P.tag}</svg>`;

  window.RT_ICONS = { info, svg, CATEGORIES: C };
})();
