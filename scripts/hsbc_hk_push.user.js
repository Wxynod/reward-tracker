// ==UserScript==
// @name         HSBC HK → 记账本 · 信用卡交易推送
// @namespace    local.hsbc-hk-ledger-push
// @version      1.2.0
// @description  在汇丰香港网银里读取各张信用卡的余额、额度、账单信息和已入账交易，推送到记账本（Reward Tracker）Worker。账户信息以网银为准；交易每张卡记住上次同步到的日期，下次从那天开始；待入账交易不推。
// @match        https://www.hsbc.com.hk/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      reward-tracker.tom-rt.workers.dev
// ==/UserScript==

// 工作方式
// 1. document-start 时挂在页面的 XMLHttpRequest 上：汇丰网银的接口要带一组请求头（X-HSBC-Client-Id、会话令牌等），
//    脚本只记下页面自己发请求时用的那组头（只放在内存里，不保存），再用它去读账户列表和交易。
// 2. 只处理信用卡（账户列表里 normalisedProductCategoryCode = "CC"），储蓄 / 往来 / 定期 / 投资 / 强积金都不碰。
//    按产品代码（找不到再按卡号末四位）对应到记账本里的账户。
// 3. 每张卡的「同步起点」存在 Tampermonkey 存储里；第一次没有记录时向记账本查这张卡最后一笔交易的日期，
//    再没有就用 2021-01-01。从起点查到今天（汇丰只给最近约两个月，更早的部分直接跳过）。
// 4. 只推已入账（HISTORIC）交易，待入账（PENDING）一律不推。
// 5. 去重：交易 id 由「账户、日期、金额、描述、当天第几笔」生成，重复推会被跳过；起点那天可能已有结单导入的同一笔交易
//    （描述写法不同），由 Worker 按「同账户、同日、同金额」点数量去重（dedupe: "date_amount"）。
// 6. 推送成功后，把起点改成这张卡最后一笔已入账交易的日期；若还有更早的待入账交易，就用最早那笔待入账的日期
//    （待入账入账后日期不变，不这样会漏）。
// 8. 账户信息（1.2.0 起）：每张卡再读一次网银的卡片详情接口（和页面打开卡片时用的同一个），
//    余额 = 戶口結餘（ledgerBalance，已入账，负数 = 有溢缴），可用额度 / 信用额度照抄网银；
//    账单信息 = 上期结单日、结单结欠、结单最低还款、到期日、上次还款额、是否逾期。
//    作为快照推给记账本（balances / liabilities 带 as_of），记账本优先显示快照，不再用「期初结余 + 交易累计」估算。
//    某张卡的详情读失败只跳过这张卡的账户信息，不影响交易同步。
// 7. 类别：先按规则（还款 / 返现 / 年费），再按商户名查对照表（来自 hsbc_hk_statements/merchant_categories.csv），
//    查不到用 MCC 兜底，都不行就是 Unclassified。MCC 也一并存进记账本。
//
// Pulse 人民币交易保留 CNY 原额，Worker 在导入时查 ECB 日参考汇率并保存美元金额，成功后才推进同步起点。
// 首次使用：Tampermonkey 菜单 →「记账本：设置写入令牌」，填 Worker 的 INGEST_TOKEN。

(() => {
  'use strict';

  const DEFAULT_URL = 'https://reward-tracker.tom-rt.workers.dev';
  const ITEM_ID = 'manual:hsbc_hk';
  const KEY = 'hsbc-hk-ledger:';
  const FIRST_DATE = '2021-01-01';
  const LOOKBACK_DAYS = 120;   // 汇丰网银只能查到最近约两个月，再往前查也是空的
  const CHUNK_DAYS = 15;       // 每次查询的日期跨度
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // 汇丰产品代码 → 记账本账户；卡号末四位做后备（换卡后末四位会变，产品代码不会）
  const PRODUCTS = {
    CRAWM: 'hsbc_red', CRCVG: 'hsbc_gold', CRDTC: 'hsbc_pulse_hkd', CRDTR: 'hsbc_pulse_cny',
    CRVPC: 'hsbc_easy', CRVS1: 'hsbc_signature', CRVST: 'hsbc_everymile',
  };
  const LAST4 = { '7407': 'hsbc_red', '9891': 'hsbc_gold', '4035': 'hsbc_pulse_hkd', '2965': 'hsbc_pulse_cny', '7552': 'hsbc_easy', '4140': 'hsbc_signature', '0864': 'hsbc_everymile' };
  const NAMES = { hsbc_red: 'Red', hsbc_gold: 'Gold', hsbc_pulse_hkd: 'Pulse 港币', hsbc_pulse_cny: 'Pulse 人民币', hsbc_easy: 'Easy', hsbc_signature: 'Visa Signature', hsbc_everymile: 'EveryMile' };

  const API_ACCOUNTS = '/api/mmf-cust-accounts--hk-hbap-banking-prod-proxy/v1/accounts/domestic';
  const API_TXNS = '/api/mmf-account-transactions--hk-hbap-prod-proxy/v2/transactions';
  // 卡片详情：路径末尾是「产品代码-账户号码」（账户号码是账户列表里那串加密的 accountNumber）
  const API_CARD = '/api/mmf-cust-accounts-details--hk-hbap-banking-prod-proxy/v1/accounts/credit-cards/';

  const cfg = {
    get url() { return (GM_getValue(KEY + 'url', DEFAULT_URL) || DEFAULT_URL).replace(/\/+$/, ''); },
    get token() { return GM_getValue(KEY + 'token', ''); },
  };
  const getWM = () => GM_getValue(KEY + 'watermarks', {}) || {};
  const setWM = (o) => GM_setValue(KEY + 'watermarks', o);

  // ---------------------------------------------------------------- 分类
  // 对照表（商户 → 类别代码），来自 merchant_categories.csv；代码含义见 CAT
  const MAP = {"MEITUAN REBATE":"C","VISA XB TRANSIT CASHBACK":"C","MKT-CASH REBATE":"C","BALANCE ADJUSTMENT":"C","TEMPORARY REFUND":"C","REFUND GLOBALBLUE.COM":"C","REWARDS REDEMPTION":"C","CUISINE CONTINENTAL GR":"D","MHK RESTAURANT":"D","BANCHAN AND COOK":"D","K TOWN BAR AND GRILL":"D","PIZZA EXPRESS":"D","BLOSSOM":"D","GRAND HYATT TAIPEI":"D","NABE ONE MK LTD":"D","YAKINIKUU AND SUKIYAKI":"D","MING BISTRO":"D","CHILL AND GRILL":"D","MINI FRIDAY":"D","DONGTING NOODLES":"D","FRITTO MISTO ITALIAN C":"D","WULAO":"D","UNCLE SHAWN":"D","MASUYA SHIBADAIMON":"D","SAPPORO DOMINIC":"D","ICHIRANHARAJIYUKUTEN":"D","HINODEYA":"D","YAKITONTAKICHI":"D","KEISUKE SHINJUKU":"D","RUTH'S CHRIS STEAK HOU":"D","YUME NO DON":"D","IL BEL PAESE":"D","ALIPAY *CHING HING FO":"D","ONON HOTPOTLAND LIMITE":"D","TURKUAZ":"D","JIANG NAN BY CRYSTAL JADE HONG KONG":"D","KATSUISEN":"D","THE BOTTLE AND STEAK":"D","L'AZUR GOURMET":"D","KAISENKYOTO HANA CHYUOGUC KYOTO":"D","ST.BARTS":"D","NIHON RYORI":"D","EFTPAY*ROCK WAGYU":"D","PIZZAEXPRESS PF":"D","ALIPAYHK*RAJDOOT INDIA":"D","KIKI NOODLE BAR":"D","MISSY HO'S":"D","PAYPAL *PIZZAEXPRES":"D","27 KEBAB HOUSE":"D","ALIPAYHK*BAYI CATERING":"D","BLZ RESTAURANT":"D","TST* TSUJITA LA ARTISAN N LOS ANGELES":"D","DAN MODERN CHINESE":"D","TST* KILLER NOODLE TSUJIT LOS ANGELES":"D","WAGYU YAKINIKU SABURO":"D","SUNIANJINSHI RESTAURANT":"D","QIUSHI CATERING":"D","PANYUAN CATERING":"D","BEIJINGYAOLAIXINJINGXICAN CHN":"D","SONGZANLIN ZHAOKANGCAN":"D","FEATHER AND BONE":"D","TST* TSUJITA LA ARTISA":"D","CHINCHIKURIN-SAWTELLE":"D","MAXIMS CATERERS LTD MA":"E","KEETA":"E","MEITUAN":"E","THE COFFEE ACADEMICS":"E","DELIVEROO":"E","FOODPANDA HONG KONG":"E","ALIPAY *MAXIMS CATERE":"E","ALIPAYHK*MAXIMS CATERE":"E","ALIPAY *CAF DE CORAL":"E","MAXIM'S CATERERS LTD":"E","STARBUCKS COFFEE":"E","MCDONALD'S HK 43":"E","FP*FOOD PANDA":"E","ALIPAYHK*CAF DE CORAL":"E","MCDONALDS":"E","STARBUCKS COFFEE CONCE":"E","CAFE DE CORAL GROUP LT":"E","ALFAFA":"E","MCDONALD'S HK":"E","STARBUCKS STORE":"E","LUCKIN COFFEE":"E","SHAKE SHACK HONG KONG":"E","ALIPAYHK*SARA DONER LI":"E","ALIPAY *SARA DONER LI":"E","SHAKE SHACK IFC":"E","MAXIMS CATERERS LTD":"E","BLUE BOTTLE COFFEE HON":"E","STARBUCKS":"E","WEIXIN*MEITUAN PLATFOR":"E","PACIFIC COFFEE COMPANY":"E","STARBUCKS COFFEE CONCEPTS QUARRY BAY":"E","ALIPAYHK*SARA DONER LIM":"E","GENKI SUSHI -":"E","OPENRICE LIMITED":"E","STARBUCKS COFFEE JAPAN":"E","SUSHI EXPRESS":"E","FIVE GUYS BURGERS AND":"E","EGGSLUT":"E","UNCLE TETSU #":"E","ALIPAYHK*MAXIMS CATERER":"E","MCDONALD'S RESTAURANTS":"E","MEITUAN FOOD":"E","HAAGEN-DAZS":"E","CREWSDESSERT_ZONGSHAN":"E","ALP*YUM CHINA":"E","KOPIKALYAN":"E","UESHIMAKO-HI-TEN DAIMON":"E","UNIQLO COFFEE SHINJUKU":"E","MCDONALD'S":"E","PRET A MANGER":"E","KPAY*COOKIES QUARTET L":"E","SOFT THUNDER":"E","MAXIM'S CAKES":"E","SHAKE SHACK TS":"E","A-1 BAKERY CO LTD":"E","MCDONALD'S HK 66":"E","DAIKISUISANKAITENZUSHI":"E","MCDONALD'S HK 55":"E","BBMSL*% ARABICA KENNEDY T HONGKONG":"E","SUBWAY HKU":"E","CUPPING ROOM COFFEE RO":"E","EFTPAY*THE MATCHA TOKYO":"E","NOC COFFEE CO.":"E","IN-N-OUT WESTWOOD":"E","SNACK* SHARETEA WESTWO":"E","TST* YIFANG TAIWAN FRUIT LOS ANGELES":"E","POKE LOVE LIMITED":"E","PAUL KEI BAKERY":"E","TIM HORTONS":"E","ELEME PLATFORM MERCHANT":"E","ALIPAYBURGER KING":"E","HSBCPCLO*KEETAHKG":"E","HSBCPCLO*FOODPANDAHKG":"E","CITYBUS":"T","DI DI CHU XING":"T","MTR - RIDES":"T","SHENZHEN METRO":"T","OCL* OCTOPUS AD":"T","UBER":"T","SZ SHENZHETONG CO.":"T","THE KOWLOON MOTO":"T","MTRSZ":"T","HONG KONG TRAMWAY":"T","OCTOPUS CARDS LTD":"T","SPTCC":"T","UBER FORMOSA CO LTD":"T","UMS*BEIJING METRO":"T","SHANGHAI SHENTONG METRO G SHANGHAI":"T","REPULSE BAY FILLING HONG KONG":"T","UBR* PENDING.UBER.COM":"T","OCTOPUS CARDS LIMITED":"T","SZML3":"T","TRANSPORT DEPT":"T","TRANS-ISLAND":"T","LONG WIN BUS":"T","GREENCAB":"T","OCL* OCTOPUS IS":"T","CHU KONG HIGH-SPEED HONG KONG":"T","LA METRO - TAP WEB SALES LOS ANGELES":"T","SPTCC CO LTD SHANGHAI":"T","KEYTOP PARKING":"T","GONGJIAOJITUAN":"T","DIDICHUXING":"T","TURBOJET TRAVEL SER LT":"T","PEAK TRAMWAYS CO LTD":"T","CTRIP":"V","12306":"V","HANEDAKUUKOU":"V","MOXY":"V","WEIXIN*CHINA RAILWAY N":"V","PRINCE HOTELS":"V","BEIJING INTERNATIONAL RES BEIJING":"V","MERCURE KYOTO STATION":"V","CATHAY PA":"V","ALLIANZ INSURANCE":"V","LOUNGE OFFER SERVICE FEE":"V","EFTPAY*MT. YOTEI":"V","Y SUITES ON ABECKETT":"V","KLOOK TRAVEL FLICKKET":"V","ROSEWOOD HONG KONG":"V","ALP* CN RAILWAY":"V","SHENZHENWENHUADONGFANG":"V","DFS GROUP LIMITED":"V","CATHAYPACAIR D HONG KONG":"V","SHENZHEN JUNYUE HOTEL":"V","CN RAILWAY":"V","AMTRAK .COM":"V","CATHAYPA D":"V","MANDARIN MANDARIN ORI":"V","TRIP.COM":"V","MASTERCARDTRAVELMEITUA":"V","TRIP COM":"V","GRAND HYATT SHENZHEN":"V","PINDUODUO PLATFORM":"S","JINGDONG":"S","TAOBAO MERCHANT":"S","TEMU.COM":"S","APPLE.COM/HK":"S","AMZN MKTP US*TK36S9KJ0":"S","AMZN MKTP US*TK7RK7HE2":"S","AMZN MKTP US*RT1U90JB0":"S","AMZN MKTP US*TK8C42D82":"S","AMZN MKTP US*R I":"S","AMZN MKTP US*RZ6NI2HF1":"S","PINDUODUO":"S","ALP*TAOBAO":"S","LITTLE RED BOOK":"S","AMZN MKTP US*TK3U28QA2":"S","AMZN MKTP US*TK98S1PP1":"S","AMZN MKTP US*TK2XW":"S","AMZN MKTP US*R04CU9HO1":"S","AMZN MKTP US*RH5KU3SN0":"S","SHOUBEIZHAOLONGJDV":"S","AMAZON.COM*SN6V43HR3":"S","MANNINGS - NEW HAIPHONG R TSIMSHATSUI":"R","SUGI PHARMACY":"R","MATSUYA DEPERTMENT GINZ":"R","AESOP.COM - HONG KONG":"R","SHIN GUANG":"R","ALP*MUJI":"R","SHENZHENSHIJICHANGGUFE":"R","QEELIN":"R","MANNINGS - HARBOUR CITY":"R","LULULEMON MACAU LIMITE":"R","SA SA COSMETIC CO LTD (HB TSIMSHATSUI":"R","MANNINGS-CHINA HK CITY-PJ TSIMSHATSUI":"R","SHIBUYA PARCO":"R","ON SPORTSWEAR":"R","MONBERU SHIBUYATEN/NFC":"R","MATSUMOTOKIYOSHURAKUCHOIT TOKYO":"R","LULULEMON SHIBUYA":"R","GINZA SIX":"R","BRANDNEWDAYKAWAGUCHIKOOOI YAMANASHI":"R","DAIKOKU DRUG":"R","MUJIRUSHIRYOHIN":"R","MATSUMOTOKIYOSHISHINJIYUK TOKYO":"R","SHINJUKUMARUIMAINBUILDING TOKYO":"R","JR EAST SHOPPING CENTER":"R","FOTOMAX (F.E.) LIMITED -":"R","CHOW TAI FOOK - ELEMENTS TSIMSHATSUI":"R","SOGO HONG KONG CO LTD":"R","COCOKARAFINE":"R","TAKASHIMAYA OSAKATEN":"R","SHINSAIBASHI PARCO":"R","MATSUMOTOKIYOSHISHINSAIBA OSAKA":"R","SONY STORE":"R","APPLE STORE R":"R","DAISO LA15 SAWTELLE":"R","UCLA STORE":"R","USC BOOKSTORE":"R","FINISH LINE":"R","SZ HUARUN WANXIANGTIANDI CHN":"R","HAIYIJIA SHOPPING CENTER":"R","HAIYIGOU SHOPPING CENTER":"R","OUTLETS SHOPPING MALL":"R","LULULEMON CLOTHING SHOP":"R","NANJINGJINYINGPAOPAOMATES CHN":"R","KUAISHANG CLOTHING":"R","MANNINGS - WESTERN DIS":"R","MUJI (PACIFIC PLACE)":"R","ADIDAS":"R","DFS SUNPLAZA":"R","BOTTEGA VENETA":"R","SA SA COSMETIC CO LTD (HA CENTRAL":"R","LULULEMON HK LIMITED":"R","MATSUMOTOKIYOSHIHARAJIYUK TOKYO":"R","MONCLER TOKYO GINZA 2F":"R","7-ELEVEN, HK":"G","7-11":"G","UCLA VENDING SERVICES":"G","TAIWAN FAMILYMART CO.,LTD TAICHUNG":"G","FAMILYMART":"G","LAWSON":"G","DAILY YAMAZAKI":"G","WELLCOME FRESH-WESTWOOD ( KENNEDY TOWN":"M","WELLCOME":"M","TARGET":"M","U SELECT DISCOUNT":"M","MARKET PLACE - DISCOVERY LANTAU ISLAND":"M","ALIPAY *PARKNSHOP HK":"M","H MART ECC LLC":"M","ZJG SAMS CLUB":"M","YATA SUPERMARKET - S":"M","GOOGLE KINGSHOT":"N","TAIPEI FINANCIAL CENTER":"N","BBMSL*ZICKET":"N","EMPEROR CINEMA MGT LTD":"N","SPOTIFY P28A D8E":"N","SPOTIFY P2A FAA7":"N","PAYTR. *OYUNFOR":"N","TAIPEI":"N","IYZICO*OYUNFOR.CO":"N","HONG KONG PALACE MUSEU":"N","SPOTIFY":"N","SPOTIFY P1F7D2AF62":"N","NEWAY KARAOKE BOX":"N","SPOTIFY P F4A6E4":"N","SPOTIFY P D":"N","SPOTIFY P21AA AD":"N","SPOTIFY P":"N","SPOTIFY P22FF2E83E":"N","SPOTIFY P23A3FF0E9":"N","SPOTIFY P A":"N","SPOTIFY P24F0AABC7":"N","HK DISNEYLAND":"N","SPOTIFY P25B E81":"N","SPOTIFY P AD":"N","IYZICO*OYUNFOR.COM":"N","SPOTIFY P B8E2CC":"N","SPOTIFY P27E CB3":"N","SPOTIFY P29C BB":"N","GOLDEN SCENE CINEMA":"N","EMPEROR CINEMA":"N","GOOGLE *YOUTUBEPREMIUM":"N","GOOGLE*YOUTUBEPREMIUM":"N","GOOGLE REDNOTE":"N","APPLE.COM/BILL":"B","CHINA MOBILE HONG KONG":"B","HKU":"B","HKU-TPG ADM OFF":"B","ALIPAY *CHINA MOBILE":"B","HKU-TRANSCRIPT FEE(OFF":"B","ALIPAYHK*CHINA MOBILE":"B","CMHK BILL PAYMENT":"B","IMMD E-SERVICES":"B","THE UNI OF HK":"B","HKU-TRANSCRIPT FEE(OFF-US HONG KONG":"B","UCLA ONLINE":"B","UNIV OF CALIFORNIA":"B","UCLA BCC WEB DEPOSIT":"B","MINT MOBILE":"B","HKU-REGISTRY TESTIMONI":"B","IMMIGRATION.GOV.TW":"B","UBER ONE":"B","ALIPAYHK*CHINA MOBILE H":"B","OVERLEAF S* TRIAL STUD":"B","US MRV EMBASSY FEE":"B","US STUDENT&EV I FEE":"B","CHINA MOBILE HK C":"B","HKU-ACADEMIC SUPPORT &":"B","TENCENT":"O","UNIONPAY MERCHANT":"O","TENPAY TECHNOLOGY COMPANY CHN":"O","PAYME FROM HSBC":"O","ALIPAY":"O","ANYTIME MAILBOX":"O","FINEPRINT":"O","ALIPAYHK":"O","C-MER DENNIS L":"O","ALIPAY *ALIPAY":"O","ALIPAYHK*ALIPAY":"O","ALIPAYHK*ALIPAY CONNEC":"O","ALIPAY NETWORK TECH":"O","NEWEBPAY-LARAKENDINGMEN S TAIPEI":"O","FUN LIMITED":"O","ALIPAY *ALIPAYHK":"O","ALIPAY *ALIPAY CONNEC":"O","PAYPAL *SOLUTIONINN":"O","KPAY MERCH*11 WESTSIDE 00 HONGKONG":"O","KPAY MERCH*CROSS CORNER":"O","ALLINPAY":"O","ALP":"O","ALIPAYZHANGJIAGANGSHIG":"O","QFPAY *MONTEREY CAPIT":"O","ALP*GOUWUXIAOFEI":"O","1":"U","XYXXKJWHYXGS":"U","TL":"U","ZGYLGFYXGS":"U","ZAKC LIMITED":"U","CHN":"U","TJMYWYKJYYGS":"U","EFTPAY*7 PO QI PO MIDDLE HONG KONG":"U","ALIPAY *PROFIT LIMITE":"U","ALIPAY *DARE":"U","ALIPAYHK*DARE":"U","HZSGGJTJTYXGS":"U","YHXXKJSHYXGS":"U","YSXXKJSHYXGS":"U","SECURE LAMOUR":"U","INTELLA":"U","LUNG MEI MAI":"U","SECURE ALESHIA TST":"U","HEI SUNG":"U","KPAY*JYU BEI":"U","INTERNATIONAL BR":"U","PAK LEK COMPANY":"U","SQ *WXYNOD WORKSHOP":"U","ZHONGXINHAIBO":"U","NO ENGLISH NAME":"U","SZSSGHRZDFZYXGS":"U","SHANGHAI LANHAI CO.,LTD":"U","TIANJIN SHU XING KE JI":"U","HANGZHOUBOBOKEJIYOUXIANGO CHN":"U","SHANGHAISHUANGHUANSHENGHU CHN":"U","LUWEIMINGXUANXIANGSHUIHUA CHN":"U","HUIZHANKEJIHANGZHOUYOUXIA CHN":"U","SHENZHENNIAOPENGJUJIUWUCA CHN":"U","SH YATUO COMMERCIAL CO.":"U","RUI MANG SI FU":"U","HK JEBN LIMITED":"U","GOLDEN VALLEY":"U"};
  const CAT = {
    D: ['Dining', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT'],
    E: ['Eating out', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_FAST_FOOD'],
    T: ['Transport and automotive', 'TRANSPORTATION', 'TRANSPORTATION_PUBLIC_TRANSIT'],
    V: ['Travel', 'TRAVEL', 'TRAVEL_OTHER_TRAVEL'],
    S: ['Shopping', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES'],
    R: ['Retail', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_DEPARTMENT_STORES'],
    G: ['Groceries', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES'],
    M: ['Supermarket', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES'],
    N: ['Entertainment and leisure', 'ENTERTAINMENT', 'ENTERTAINMENT_OTHER_ENTERTAINMENT'],
    B: ['Bills and Utilities', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_OTHER_UTILITIES'],
    O: ['Others', null, null],
    U: ['Unclassified', null, null],
    P: ['还款', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'],
    F: ['银行费用', 'BANK_FEES', 'BANK_FEES_OTHER_BANK_FEES'],
    C: ['返现 / 抵扣 / 调整', 'INCOME', 'INCOME_OTHER_INCOME'],
  };
  const RULES = [
    [/PAYMENT - THANK YOU|PAID BY AUTOPAY|PAYMENT RECEIVED/i, 'P'],
    [/STATEMENT OFFSET|REBATE|CASH ?BACK|REWARDS REDEMPTION/i, 'C'],
    [/ANNUAL FEE|FINANCE CHARGE|LATE CHARGE|LATE PAYMENT|INTEREST CHARGE/i, 'F'],
  ];
  // MCC → 类别（对照表里没有的商户用）
  const MCC_RANGES = [
    [5812, 5813, 'D'], [5814, 5814, 'E'], [5462, 5462, 'E'],
    [4111, 4131, 'T'], [4784, 4784, 'T'], [5541, 5542, 'T'], [7523, 7523, 'T'], [4121, 4121, 'T'], [5983, 5983, 'T'], [4011, 4011, 'V'],
    [3000, 3999, 'V'], [4411, 4411, 'V'], [4511, 4511, 'V'], [4582, 4582, 'V'], [4722, 4722, 'V'], [7011, 7011, 'V'], [7012, 7012, 'V'],
    [5411, 5411, 'M'], [5300, 5300, 'M'], [5422, 5422, 'G'], [5441, 5451, 'G'], [5499, 5499, 'G'], [5331, 5331, 'G'],
    [5964, 5969, 'S'], [5311, 5311, 'R'], [5611, 5699, 'R'], [5732, 5734, 'R'], [5912, 5912, 'R'], [5940, 5949, 'R'], [5977, 5977, 'R'], [5200, 5299, 'R'], [5944, 5944, 'R'],
    [5815, 5818, 'N'], [7832, 7832, 'N'], [7922, 7922, 'N'], [7929, 7929, 'N'], [7941, 7941, 'N'], [7991, 7999, 'N'],
    [4812, 4816, 'B'], [4899, 4900, 'B'], [6300, 6399, 'B'], [8211, 8299, 'B'], [9211, 9399, 'B'],
    [6555, 6555, 'C'],
  ];
  const mccCat = (m) => { const n = Number(m); if (!n) return null; for (const [a, b, c] of MCC_RANGES) if (n >= a && n <= b) return c; return null; };
  const PREFIX = /^(APPLE ?PAY|SAMSUNG ?PAY|GOOGLE ?PAY|ANDROID ?PAY|SALES:|RETURN:|REFUND:|PURCHASE:)\s*/i;
  const norm = (s) => String(s || '').replace(/\(\d+\)|\d{3,}/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  function merchantKeys(desc, rt) {
    let first = String(desc || '').split(/\s{2,}/)[0] || '';
    for (let i = 0; i < 3 && PREFIX.test(first); i++) first = first.replace(PREFIX, '');
    const keys = [];
    if (rt?.merchantName) keys.push(norm(rt.merchantName));
    keys.push(norm(first));
    return keys.filter(Boolean);
  }
  function classify(desc, rt, mcc) {
    for (const [rx, c] of RULES) if (rx.test(desc)) return { code: c, by: 'rule' };
    for (const k of merchantKeys(desc, rt)) if (MAP[k]) return { code: MAP[k], by: 'map' };
    const m = mccCat(mcc);
    if (m) return { code: m, by: 'mcc' };
    return { code: 'U', by: 'none' };
  }

  // ---------------------------------------------------------------- 截获请求头和账户列表
  let headers = null;        // 页面最近一次请求 /api/mmf- 用的请求头
  let accountList = null;    // 页面加载的账户列表
  const XO = W.XMLHttpRequest.prototype;
  const xOpen = XO.open, xSend = XO.send, xSet = XO.setRequestHeader;
  XO.open = function (m, u) { this.__ledgerUrl = String(u); this.__ledgerH = {}; return xOpen.apply(this, arguments); };
  XO.setRequestHeader = function (k, v) { try { if (this.__ledgerH) this.__ledgerH[k] = v; } catch { /* 忽略 */ } return xSet.apply(this, arguments); };
  XO.send = function () {
    const x = this;
    if (/\/api\/mmf-/.test(x.__ledgerUrl || '') && x.__ledgerH && x.__ledgerH['X-HSBC-Client-Id'] && !x.__ledgerOwn) {
      headers = { ...x.__ledgerH }; delete headers.ADRUM;
      if (x.__ledgerUrl.includes(API_ACCOUNTS)) {
        x.addEventListener('load', () => { try { if (x.status === 200) accountList = JSON.parse(x.responseText).accountList || accountList; } catch { /* 忽略 */ } });
      }
      onReady();
    }
    return xSend.apply(this, arguments);
  };

  // 用页面的请求头发 GET（同源，带页面的 cookie）
  function hsbcGet(path) {
    return new Promise((resolve, reject) => {
      if (!headers) return reject(new Error('还没截到网银的请求头，请刷新页面'));
      const x = new W.XMLHttpRequest();
      x.__ledgerOwn = true;
      xOpen.call(x, 'GET', path);
      for (const [k, v] of Object.entries(headers)) xSet.call(x, k, v);
      x.withCredentials = true;
      x.onload = () => {
        if (x.status !== 200) return reject(new Error(`汇丰接口 ${x.status}`));
        try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); }
      };
      x.onerror = () => reject(new Error('汇丰接口请求失败'));
      xSend.call(x);
    });
  }

  // ---------------------------------------------------------------- 记账本
  function ledger(path, body) {
    return new Promise((resolve, reject) => {
      if (!cfg.token) return reject(new Error('还没设置写入令牌（Tampermonkey 菜单 → 记账本：设置写入令牌）'));
      GM_xmlhttpRequest({
        method: 'POST', url: cfg.url + path, timeout: 60000,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        data: JSON.stringify(body),
        onload: (r) => { let d = {}; try { d = JSON.parse(r.responseText); } catch { /* 非 JSON */ } r.status === 200 ? resolve(d) : reject(new Error(`记账本 ${r.status}：${d.error || r.statusText}`)); },
        onerror: () => reject(new Error('连不上记账本 Worker')),
        ontimeout: () => reject(new Error('记账本请求超时')),
      });
    });
  }

  // ---------------------------------------------------------------- 日期
  const pad = (n) => String(n).padStart(2, '0');
  const hkToday = () => { const d = new Date(Date.now() + 8 * 3600e3); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const maxDate = (a, b) => (a > b ? a : b);
  const minDate = (a, b) => (a < b ? a : b);

  // ---------------------------------------------------------------- 转换
  function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  function convert(list, acctId, currency) {
    const seq = {};
    const out = [];
    // 按日期、描述排序，保证「当天第几笔」每次都一样
    const posted = list.filter((x) => x.transactionStatus === 'HISTORIC')
      .sort((a, b) => (a.transactionDate + (a.transactionDescriptions || []).join() + a.transactionAmount?.amount).localeCompare(b.transactionDate + (b.transactionDescriptions || []).join() + b.transactionAmount?.amount));
    for (const x of posted) {
      const cur = x.transactionAmount?.currencyCode;
      const abs = Number(x.transactionAmount?.amount);
      if (!x.transactionDate || !Number.isFinite(abs)) continue;
      if (cur && cur !== currency) {
        if (acctId === 'hsbc_pulse_cny') throw new Error('Pulse 人民币交易币种不符，请核对后重试');
        console.warn('[记账本] 币种和账户不一致，跳过', x); continue;
      }
      const credit = /CREDIT/i.test(x.transactionCreditDebitCode || '');
      const amount = Math.round((credit ? -abs : abs) * 100) / 100;
      const desc = (x.transactionDescriptions || []).join('  ');
      const rt = x.realTimeTransactionDetails || {};
      const { code, by } = classify(desc, rt, x.merchantCategoryCode);
      const [label, primary, detailed] = CAT[code];
      const base = `${acctId}:${x.transactionDate}:${Math.round(amount * 100)}:${hash(clean(desc))}`;
      seq[base] = (seq[base] || 0) + 1;
      const fields = desc.split(/\s{2,}/).map(clean).filter(Boolean);
      const mcc = /^\d{4}$/.test(x.merchantCategoryCode || '') && x.merchantCategoryCode !== '0000' ? x.merchantCategoryCode : null;
      out.push({
        id: `hsbcw:${base}:${seq[base]}`,
        account_id: acctId,
        date: x.transactionDate,
        authorized_date: x.transactionDate,
        name: clean(fields[0] || desc).replace(PREFIX, ''),
        merchant: rt.merchantName ? clean(rt.merchantName) : null,
        amount, currency,
        category: primary, category_detail: detailed,
        mcc,
        channel: code === 'S' ? 'online' : null,
        pending: false,
        source: 'hsbc_hk_web',
        detail: Object.fromEntries(Object.entries({
          original_description: clean(desc),
          hsbc_category: label,
          category_by: by,
          personal_finance_category: primary ? { primary, detailed } : null,
          location: (rt.merchantCity || rt.merchantCountryCode) ? { city: rt.merchantCity || null, country: rt.merchantCountryCode || null } : null,
          card_last4: String(x.cardNumberDisplay || x.cardNumber || '').slice(-4) || null,
          post_date: x.transactionPostingDate || null,
          hsbc_type: x.transactionType || null,
          secondary_card: x.secondaryCardTransactionIndicator || null,
        }).filter(([, v]) => v !== null && v !== undefined)),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- 账户信息（余额 / 额度 / 账单）
  const amt = (m, cur) => {
    const v = Number(m?.amount);
    if (!m || !Number.isFinite(v)) return null;
    if (m.currencyCode && cur && m.currencyCode !== cur) return null;   // 币种对不上就不用
    return Math.round(v * 100) / 100;
  };
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  // 卡片详情 → 记账本的 balances / liabilities。lastPayDate：网银交易里最近一笔同金额还款的日期（接口只给金额）
  function accountInfo(d, cur, payments) {
    const asOf = new Date().toISOString();
    const bal = {
      balance_current: amt(d.ledgerBalance, cur),
      balance_available: amt(d.availableCredit, cur),
      limit: amt(d.creditLimit, cur),
      as_of: asOf,
    };
    if (bal.balance_current == null) return null;
    const st = d.lastStatementCycle || {};
    const lastPay = amt(d.lastPaymentAmount, cur);
    const payTxn = lastPay != null ? payments.find((t) => Math.abs(-t.amount - lastPay) < 0.005) : null;
    const L = { as_of: asOf, source: 'hsbc_hk_web' };
    if (isDate(st.statementDate)) { L.last_statement_issue_date = st.statementDate; L.statement_day = Number(st.statementDate.slice(8, 10)); }
    const sb = amt(st.statementBalance, cur); if (sb != null) L.last_statement_balance = sb;
    const sm = amt(st.statementMinimumPaymentDue, cur); if (sm != null) L.minimum_payment_amount = sm;
    if (isDate(d.nextPaymentDueDate)) L.next_payment_due_date = d.nextPaymentDueDate;
    if (lastPay != null) { L.last_payment_amount = lastPay; L.last_payment_date = payTxn ? payTxn.date : null; }
    const od = amt(d.overdueBalance, cur); if (od != null) L.is_overdue = od > 0;
    return { bal, L };
  }

  // ---------------------------------------------------------------- 主流程
  let running = false;
  async function sync({ manual = false } = {}) {
    if (running) return;
    running = true;
    try {
      if (!headers) throw new Error('还没截到网银的请求头，请刷新页面后再试');
      if (!accountList) accountList = (await hsbcGet(API_ACCOUNTS)).accountList || [];
      const cards = accountList
        .filter((a) => a.accountIdentifier?.normalisedProductCategoryCode === 'CC' && a.accountHistoryApplicable !== false)
        .map((a) => ({
          a, id: PRODUCTS[a.accountIdentifier.productCategoryCode] || LAST4[String(a.accountDisplay || '').replace(/\D/g, '').slice(-4)],
          currency: a.ledgerBalance?.currency,
        }))
        .filter((c) => c.id);
      for (const c of cards) {
        if (c.id === 'hsbc_pulse_cny' && c.currency && c.currency !== 'CNY')
          throw new Error('Pulse 人民币账户币种不符，请核对账户后重试');
        c.currency ||= c.id === 'hsbc_pulse_cny' ? 'CNY' : 'HKD';
      }
      if (!cards.length) throw new Error('账户列表里没找到要同步的信用卡');

      // 同步起点：Tampermonkey 存储 → 记账本里最后一笔交易 → 2021-01-01
      const wm = getWM();
      const hasPulse = cards.some(c => c.id === 'hsbc_pulse_cny');
      if (hasPulse || cards.some(c => !wm[c.id])) {
        const st = await ledger('/api/manual/state', { item_id: ITEM_ID });
        if (hasPulse && !st.pulse_cny_fx) throw new Error('请先部署支持 Pulse 人民币汇率的记账本 Worker');
        for (const c of cards) if (!wm[c.id]) wm[c.id] = st.accounts?.[c.id]?.last_date || FIRST_DATE;
        setWM(wm);
      }

      const today = hkToday();
      const all = [], plan = {}, balances = {}, liabilities = {}, infoFail = [];
      for (const c of cards) {
        const start = wm[c.id];
        let from = maxDate(start, addDays(today, -LOOKBACK_DAYS));
        const got = [];
        while (from <= today) {
          const to = minDate(addDays(from, CHUNK_DAYS - 1), today);
          const q = new URLSearchParams({ transactionCategory: 'ALL', identifierType: 'CARD', debitCreditType: 'CREDIT', transactionStartDate: from, transactionEndDate: to, identifier: c.a.accountIdentifier.accountNumber });
          const r = await hsbcGet(`${API_TXNS}?${q}`);
          if (r.pagination?.moreRecord === 'Y') console.warn(`[记账本] ${NAMES[c.id]} ${from}~${to} 还有更多记录，可能没取全`);
          got.push(...(r.transactions || []));
          from = addDays(to, 1);
        }
        // 去掉重复的日期区间边界（同一笔可能出现在两段里）：按汇丰的唯一标识去重
        const seen = new Set();
        const uniq = got.filter((x) => { const k = x.uniqueTransactionIdentifier || JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; })
          .filter((x) => x.transactionDate >= start);
        const txns = convert(uniq, c.id, c.currency);
        const pend = uniq.filter((x) => x.transactionStatus === 'PENDING').map((x) => x.transactionDate).sort();
        const lastPosted = txns.reduce((m, t) => maxDate(m, t.date), '');
        // 下次起点：最后一笔已入账的日期；若有更早的待入账，用最早那笔待入账的日期；都没有就保持原来的起点
        let next = lastPosted || start;
        if (pend.length) next = minDate(next, pend[0]);
        next = maxDate(next, start);   // 起点只往后推，不往前退
        plan[c.id] = { start, next, n: txns.length, pending: pend.length };
        all.push(...txns);

        // 账户信息：失败只跳过这张卡，交易照常推
        try {
          const r = await hsbcGet(API_CARD + `${c.a.accountIdentifier.productCategoryCode}-${c.a.accountIdentifier.accountNumber}`);
          // 还款记录：这次读到的网银交易（含起点之前的，只用来找上次还款日期）
          const payments = convert(got.filter((x) => x.transactionStatus === 'HISTORIC'), c.id, c.currency)
            .filter((t) => t.amount < 0 && t.category === 'LOAN_PAYMENTS').sort((a, b) => (a.date < b.date ? 1 : -1));
          const info = r?.creditCardAccountDetail ? accountInfo(r.creditCardAccountDetail, c.currency, payments) : null;
          if (!info) throw new Error('卡片详情里没有余额');
          balances[c.id] = info.bal;
          liabilities[c.id] = info.L;
          plan[c.id].balance = info.bal.balance_current;
        } catch (e) {
          console.warn(`[记账本] ${NAMES[c.id]} 账户信息读取失败`, e);
          infoFail.push(NAMES[c.id]);
        }
      }

      const d = await ledger('/api/manual/import', {
        item_id: ITEM_ID, item: { institution: 'HSBC HK', region: 'HK' },
        transactions: all, dedupe: 'date_amount',
        balances, liabilities,
      });
      if (d.rejected?.length) throw new Error(`${d.rejected.length} 笔交易被拒，同步起点已保留：${d.rejected[0].reason}`);
      const wm2 = getWM();
      for (const [id, p] of Object.entries(plan)) wm2[id] = p.next;
      setWM(wm2);
      GM_setValue(KEY + 'last', { at: Date.now(), plan, result: { added: d.added, skipped: d.skipped, rejected: d.rejected?.length || 0, total: d.total } });

      const per = Object.entries(plan).filter(([, p]) => p.n || p.pending).map(([id, p]) => `${NAMES[id]} ${p.n}${p.pending ? `（另有 ${p.pending} 笔待入账未推）` : ''}`).join('、');
      const info = `更新了 ${Object.keys(balances).length} 张卡的余额和账单信息${infoFail.length ? `（${infoFail.join('、')} 读取失败）` : ''}`;
      if (d.added) toast(`记账本：新增 ${d.added} 笔，已存在跳过 ${d.skipped} 笔；${info}。${per ? `读取：${per}` : ''}`, infoFail.length ? 'warn' : 'good', 8000);
      else toast(`记账本：没有新交易（读取 ${all.length} 笔都已存在）；${info}`, infoFail.length ? 'warn' : 'quiet', 6000);
    } catch (e) {
      console.error('[记账本]', e);
      toast(`记账本同步失败：${e.message}`, 'error', 8000);
    } finally {
      running = false;
    }
  }

  // 截到请求头后，在首页 / 账户页自动同步一次（每次打开网银一次）
  let autoDone = false;
  function onReady() {
    if (autoDone) return;
    autoDone = true;
    setTimeout(() => { if (cfg.token) sync(); else toast('记账本：还没设置写入令牌（Tampermonkey 菜单 → 记账本：设置写入令牌）', 'warn', 8000); }, 4000);
  }

  // ---------------------------------------------------------------- 菜单
  GM_registerMenuCommand('记账本：立即同步汇丰信用卡', () => sync({ manual: true }));
  GM_registerMenuCommand('记账本：设置写入令牌', () => {
    const v = W.prompt('Worker 的 INGEST_TOKEN（只用于写入记账本）', cfg.token ? '（已设置，留空不变）' : '');
    if (v && !v.startsWith('（')) { GM_setValue(KEY + 'token', v.trim()); toast('记账本：写入令牌已保存', 'good'); }
  });
  GM_registerMenuCommand('记账本：查看各卡同步起点', () => {
    const wm = getWM(); const l = GM_getValue(KEY + 'last', null);
    toast(`${Object.entries(wm).map(([k, v]) => `${NAMES[k] || k}：${v}`).join('；') || '还没有记录'}${l ? `。上次 ${new Date(l.at).toLocaleString()}：新增 ${l.result.added}，跳过 ${l.result.skipped}` : ''}`, 'quiet', 10000);
  });
  GM_registerMenuCommand('记账本：重置同步起点', () => {
    if (W.confirm('清空各卡的同步起点？下次会重新向记账本查询每张卡最后一笔交易的日期。')) { setWM({}); toast('记账本：已清空同步起点', 'quiet'); }
  });
  GM_registerMenuCommand('记账本：设置 Worker 地址', () => {
    const v = W.prompt('记账本 Worker 地址', cfg.url);
    if (v) { GM_setValue(KEY + 'url', v.trim()); toast(`记账本：地址改为 ${v.trim()}（需同时在脚本头部 @connect 里加上这个域名）`, 'warn'); }
  });

  // ---------------------------------------------------------------- 提示条（和 Amex 脚本同款）
  let host = null;
  function toast(text, level = 'good', ms = 4500) {
    const doc = W.document;
    if (!doc.body) { doc.addEventListener('DOMContentLoaded', () => toast(text, level, ms), { once: true }); return; }
    if (!host) {
      host = doc.createElement('div');
      host.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:2147483646;';
      host.attachShadow({ mode: 'open' }).innerHTML = `<style>
        .t{font:500 13.5px/1.5 "Noto Serif SC","Songti SC",serif;color:#3a0b0b;max-width:min(440px,calc(100vw - 40px));
          padding:10px 14px;margin-top:8px;border-radius:16px;background:rgba(253,240,240,.78);
          backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);
          box-shadow:0 14px 40px -14px rgba(84,6,6,.45),inset 0 1px 0 rgba(255,255,255,.9);
          transition:opacity .4s ease,transform .5s cubic-bezier(.32,1.28,.52,1)}
        .t.good{border-left:4px solid #18a06e}.t.warn{border-left:4px solid #e2a400}.t.error{border-left:4px solid #db0011}.t.quiet{opacity:.85}
        .t.out{opacity:0;transform:translateY(8px)}</style><div class="box"></div>`;
      doc.body.append(host);
    }
    const box = host.shadowRoot.querySelector('.box');
    const el = doc.createElement('div');
    el.className = `t ${level}`; el.textContent = text;
    box.append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, ms);
  }
})();
