// ==UserScript==
// @name         HSBC HK → 记账本 · 信用卡交易推送
// @namespace    local.hsbc-hk-ledger-push
// @version      1.3.0
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
//
// 界面（1.3.0 起）：登录网银后右下角出现汇丰红的液态玻璃球体。点开是菜单（立即同步、各卡状态、自动同步开关、
// 写入令牌、重置同步起点、Worker 地址、打开记账本）；每次同步（自动或手动）先唤醒球体，再从球体里长出进度卡片：
// 进度条 + 百分比 + 当前步骤，完成后显示结果并收回球体。原来 Tampermonkey 菜单里的选项都搬进了球体。
// 首次使用：点球体 →「设置写入令牌」，填 Worker 的 INGEST_TOKEN。

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
      if (!cfg.token) return reject(new Error('还没设置写入令牌（点右下角球体 → 设置写入令牌）'));
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
    if (running) { if (manual) ui().open(); return; }
    running = true;
    const k = ui();
    k.setPrimary({ label: '同步中…', disabled: true, onClick: () => {} });
    k.status('正在同步…', 'run');
    const t = k.task('hsbc-sync', '同步汇丰信用卡');
    try {
      if (!headers) throw new Error('还没截到网银的请求头，请刷新页面后再试');
      t.step('读取账户列表', 3);
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
        t.step('向记账本查询各卡同步起点', 7);
        const st = await ledger('/api/manual/state', { item_id: ITEM_ID });
        if (hasPulse && !st.pulse_cny_fx) throw new Error('请先部署支持 Pulse 人民币汇率的记账本 Worker');
        for (const c of cards) if (!wm[c.id]) wm[c.id] = st.accounts?.[c.id]?.last_date || FIRST_DATE;
        setWM(wm);
      }

      // 进度：10% → 86% 平均分给每张卡；每张卡里「读交易」占 80%，「读余额」占 20%
      const today = hkToday();
      const all = [], plan = {}, balances = {}, liabilities = {}, infoFail = [];
      const span = 76 / cards.length;
      for (const [ci, c] of cards.entries()) {
        const base = 10 + span * ci;
        const label = `${NAMES[c.id]}（${ci + 1}/${cards.length}）`;
        const start = wm[c.id];
        let from = maxDate(start, addDays(today, -LOOKBACK_DAYS));
        const chunks = Math.max(1, Math.ceil((Date.parse(today) - Date.parse(from)) / 864e5 / CHUNK_DAYS + 1e-9));
        const got = [];
        let ck = 0;
        t.step(`读取 ${label} 交易 · ${start < addDays(today, -LOOKBACK_DAYS) ? '最近 4 个月' : start.slice(5).replace('-', '/') + ' 起'}`, base);
        while (from <= today) {
          const to = minDate(addDays(from, CHUNK_DAYS - 1), today);
          const q = new URLSearchParams({ transactionCategory: 'ALL', identifierType: 'CARD', debitCreditType: 'CREDIT', transactionStartDate: from, transactionEndDate: to, identifier: c.a.accountIdentifier.accountNumber });
          const r = await hsbcGet(`${API_TXNS}?${q}`);
          if (r.pagination?.moreRecord === 'Y') console.warn(`[记账本] ${NAMES[c.id]} ${from}~${to} 还有更多记录，可能没取全`);
          got.push(...(r.transactions || []));
          from = addDays(to, 1);
          t.step(null, base + span * 0.8 * Math.min(1, ++ck / chunks));
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
        plan[c.id] = { start, next, n: txns.length, pending: pend.length, currency: c.currency };
        all.push(...txns);

        // 账户信息：失败只跳过这张卡，交易照常推
        t.step(`读取 ${label} 余额和账单`, base + span * 0.85);
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
          plan[c.id].due = info.L.next_payment_due_date || null;
        } catch (e) {
          console.warn(`[记账本] ${NAMES[c.id]} 账户信息读取失败`, e);
          infoFail.push(NAMES[c.id]);
        }
      }

      t.step(all.length ? `推送 ${all.length} 笔交易和 ${Object.keys(balances).length} 张卡的余额到记账本` : `推送 ${Object.keys(balances).length} 张卡的余额到记账本`, 88).trickle(98, 3500);
      const d = await ledger('/api/manual/import', {
        item_id: ITEM_ID, item: { institution: 'HSBC HK', region: 'HK' },
        transactions: all, dedupe: 'date_amount',
        balances, liabilities,
      });
      if (d.rejected?.length) throw new Error(`${d.rejected.length} 笔交易被拒，同步起点已保留：${d.rejected[0].reason}`);
      const wm2 = getWM();
      for (const [id, p] of Object.entries(plan)) wm2[id] = p.next;
      setWM(wm2);
      const pendingAll = Object.values(plan).reduce((n, p) => n + p.pending, 0);
      GM_setValue(KEY + 'last', { at: Date.now(), plan, result: { added: d.added, skipped: d.skipped, rejected: d.rejected?.length || 0, total: d.total }, infoFail });

      const nb = Object.keys(balances).length;
      const parts = [d.added ? `新增 ${d.added} 笔` : '没有新交易', d.skipped ? `跳过 ${d.skipped} 笔已存在` : '', `更新 ${nb} 张卡余额`, pendingAll ? `${pendingAll} 笔待入账未推` : ''].filter(Boolean);
      const warn = infoFail.length ? `；${infoFail.join('、')} 的账户信息读取失败` : '';
      t.done(parts.join(' · ') + warn, infoFail.length ? 'warn' : d.added ? 'good' : 'quiet', infoFail.length ? 9000 : 5200);
      if (d.added) k.badge(d.added);
    } catch (e) {
      console.error('[记账本]', e);
      GM_setValue(KEY + 'lastError', { at: Date.now(), message: e.message });
      t.fail(e.message, { title: '同步失败', retry: () => sync({ manual: true }) });
    } finally {
      running = false;
      k.setPrimary({ label: '立即同步', onClick: () => sync({ manual: true }) });
      refreshMenu();
    }
  }

  // 截到请求头后（= 已登录网银），出现球体；打开了「自动同步」就在 4 秒后同步一次（每次打开网银一次）
  let autoDone = false;
  function onReady() {
    if (autoDone) return;
    autoDone = true;
    const go = () => {
      ui();
      setTimeout(() => {
        if (!GM_getValue(KEY + 'auto', true)) return;
        if (cfg.token) sync();
        else ui().toast('还没设置写入令牌：点球体 →「设置写入令牌」，填 Worker 的 INGEST_TOKEN。', 'warn', 9000, '记账本未连接');
      }, 4000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
  }

  // ---------------------------------------------------------------- 球体菜单
  const money = (v, cur) => (v == null ? '—' : `${cur === 'CNY' ? '¥' : 'HK$'}${Number(v).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  function ago(at) {
    const m = Math.round((Date.now() - at) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    if (m < 60 * 24) return `${Math.round(m / 60)} 小时前`;
    return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  function refreshMenu() {
    const k = ui();
    const last = GM_getValue(KEY + 'last', null), err = GM_getValue(KEY + 'lastError', null);
    if (err && (!last || err.at > last.at)) k.status(`${ago(err.at)}同步失败 · ${err.message}`, 'error');
    else if (last) k.status(`上次同步 ${ago(last.at)} · ${last.result.added ? `新增 ${last.result.added} 笔` : '没有新交易'}`, last.infoFail?.length ? 'warn' : 'good');
    else k.status(cfg.token ? '还没同步过' : '未设置写入令牌', cfg.token ? 'quiet' : 'warn');
    const wm = getWM(), plan = last?.plan || {};
    const ids = Object.keys(NAMES).filter((id) => wm[id] || plan[id]);
    k.section('cards', {
      title: '各卡状态', order: 1,
      items: [{ rows: ids.map((id) => {
        const p = plan[id] || {}, w = wm[id];
        const sub = [w && w !== FIRST_DATE ? `起点 ${w.slice(5)}` : '暂无交易', p.n ? `新读 ${p.n} 笔` : '', p.pending ? `${p.pending} 笔待入账` : '', p.due ? `到期 ${p.due.slice(5)}` : ''].filter(Boolean).join(' · ');
        return [NAMES[id], money(p.balance, p.currency || (id === 'hsbc_pulse_cny' ? 'CNY' : 'HKD')), sub];
      }),
        empty: '同步一次后显示各卡余额和同步起点' }],
    });
    k.section('settings', {
      title: '设置', order: 2,
      items: [
        { label: '打开网银时自动同步', icon: 'bolt', toggle: GM_getValue(KEY + 'auto', true), onClick: (on) => GM_setValue(KEY + 'auto', on) },
        { label: '设置写入令牌', icon: 'key', value: cfg.token ? '已设置' : '未设置', keepOpen: true, onClick: setToken },
        { label: '重置同步起点', icon: 'reset', hint: '下次重新向记账本查询每张卡的最后日期', danger: true, keepOpen: true, onClick: resetWM },
        { label: '设置 Worker 地址', icon: 'server', hint: cfg.url.replace(/^https?:\/\//, ''), keepOpen: true, onClick: setUrl },
      ],
    });
  }
  async function setToken() {
    const k = ui();
    const v = await k.dialog({ title: '写入令牌', message: 'Worker 的 INGEST_TOKEN，只用于写入记账本，不能读数据。' + (cfg.token ? '已设置；留空保持不变。' : ''),
      fields: [{ name: 'token', label: 'INGEST_TOKEN', type: 'password', placeholder: cfg.token ? '••••••••（不变）' : '粘贴令牌' }], ok: '保存' });
    if (v?.token?.trim()) { GM_setValue(KEY + 'token', v.token.trim()); k.toast('写入令牌已保存', 'good'); refreshMenu(); }
  }
  async function resetWM() {
    const k = ui();
    if (await k.confirm('重置同步起点', '清空各卡的同步起点？下次同步会重新向记账本查询每张卡最后一笔交易的日期。', '清空', true)) {
      setWM({}); k.toast('已清空各卡同步起点', 'quiet'); refreshMenu();
    }
  }
  async function setUrl() {
    const k = ui();
    const v = await k.dialog({ title: 'Worker 地址', message: '改成别的域名时，还要在脚本头部的 @connect 里加上这个域名。', fields: [{ name: 'url', label: '地址', value: cfg.url }], ok: '保存' });
    if (v?.url?.trim()) { GM_setValue(KEY + 'url', v.url.trim()); k.toast(`地址改为 ${v.url.trim()}`, 'warn', 6000, 'Worker 地址'); refreshMenu(); }
  }

  let kit = null;
  function ui() {
    if (kit) return kit;
    kit = glassOrb({
      brand: 'hsbc', title: '汇丰 HK · 记账本', short: '记账本',
      rgb: '219,0,17', deep: '122,0,12', alpha: 0.5, ink: '#3a0508',
      logo: HSBC_LOGO, logoBox: ['50%', '50%', '64%'],
      ledgerUrl: 'https://wxynod.github.io/reward-tracker/',
    });
    kit.setPrimary({ label: '立即同步', onClick: () => sync({ manual: true }) });
    kit.onOpen(() => { kit.badge(0); refreshMenu(); });
    refreshMenu();
    return kit;
  }
  // Tampermonkey 菜单只留一个入口：球体被隐藏或还没出现时用
  GM_registerMenuCommand('记账本：显示球体 / 立即同步', () => { const k = ui(); k.show(); sync({ manual: true }); });

  const HSBC_LOGO = 'data:image/png;base64,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';

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
