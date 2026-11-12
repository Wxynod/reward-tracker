// Reward Tracker — 中英文切换。
// 界面文案在各模块里都是中文；选英文时，这个脚本在 DOM 渲染后（MutationObserver，绘制前）把中文文本节点和
// placeholder / title / aria-label 换成英文：先整句查表，再按正则规则，再按「 · 」拆段，最后按词组替换。
// 新增中文文案时，在下面的 DICT / RULES / FRAG 里补一条即可；漏翻的会记在 RT_I18N.missing 里。
(function () {
  const KEY = "rt_lang";
  let lang = "zh";
  try { lang = localStorage.getItem(KEY) === "en" ? "en" : "zh"; } catch { /* 隐私模式 */ }
  const EN = lang === "en";
  const CJK = /[㐀-鿿（），：？、「」]/;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WK = { 一: "Mon", 二: "Tue", 三: "Wed", 四: "Thu", 五: "Fri", 六: "Sat", 日: "Sun", 天: "Sun" };
  const UNIT = { 天: "day", 日: "day", 周: "week", 月: "month", 季: "quarter", 年: "year" };
  const plural = (n, w) => `${n} ${w}${Number(String(n).replace(/,/g, "")) === 1 ? "" : "s"}`;
  const m = (x) => MON[Number(x) - 1] || x;

  // ---------------------------------------------------------------- 整句
  const DICT = {
    "估算汇率": "Estimated rate",
    "部分人民币日期缺少近期报价，美元汇总含估算值。": "Recent quotes are unavailable for some CNY dates. USD totals include estimates.",
    "消费按交易日参考汇率折算，未偿欠款按加权成本折算，余额快照按快照日折算。": "Spending uses transaction-date reference rates, outstanding debt uses weighted average cost, and balance snapshots use their dated rate.",
    // 顶栏 / 标签页 / 登录
    "记账本": "Reward Tracker", "记账本 · Reward Tracker": "Reward Tracker",
    "同步": "Sync", "连接银行": "Link bank", "退出": "Sign out", "设置": "Settings",
    "积分": "Points", "交易": "Transaction", "权益任务": "Benefits", "账户": "Accounts", "分析": "Analytics",
    "账号": "Username", "密码": "Password", "登录": "Sign in", "登录中…": "Signing in…",
    // 设置面板
    "积分与余额": "Points & balances",
    "点「更新」进入编辑：每笔交易的倍数、各计划余额都可以直接改；再点一次保存。改过的倍数会按 MCC（没有 MCC 时按商户名）记住，同一张卡的同类交易一起更新。":
      "Tap “Update” to enter edit mode: change the multiplier of any transaction or the balance of any program, then tap again to save. Changed multipliers are remembered by MCC (or merchant name when there is no MCC) and applied to the same kind of purchase on that card.",
    "更新": "Update", "保存": "Save", "取消": "Cancel", "编辑中": "Editing",
    "卡片对应 · 账单日": "Card mapping · closing day",
    "卡型决定用哪套倍数（已按账户名自动识别）。账单日（Statement closing date）决定什么时候把 Pending 积分加进 Balance，不填按月底算。":
      "The card product decides which multipliers apply (auto-detected from the account name). The statement closing day decides when Pending points move into the Balance; empty means month-end.",
    "卡片对应": "Card mapping",
    "卡型决定用哪套倍数（已按账户名自动识别）。账单日在「账户」里点开对应的卡修改。": "The card product decides which multipliers apply (auto-detected from the account name). To change a statement closing day, open the card under Accounts.",
    "已记住的倍数": "Remembered multipliers",
    "还没有。编辑模式下改过的倍数会出现在这里。": "None yet. Multipliers you change in edit mode show up here.",
    "数据": "Data",
    "「同步」只拿 Plaid 已经缓存的数据，Plaid 一般每天去银行抓几次。刚刷的卡（Pending）没出现时，可以让 Plaid 立刻去银行抓一次。":
      "“Sync” only reads what Plaid has cached; Plaid polls banks a few times a day. If a fresh (Pending) purchase is missing, ask Plaid to fetch from the bank right now.",
    "立刻从银行刷新": "Refresh from bank now",
    "旧交易没有存 MCC。重新拉取一次全部交易即可补齐（不额外计费）。": "Older transactions were stored without MCC. Re-pulling the full history fills it in (no extra cost).",
    "重新拉取全部交易": "Re-pull all transactions",
    "· 改交易倍数或积分余额，完成后保存": "· edit multipliers or balances, then save",
    // 积分页
    "积分总览": "Points overview",
    "Pending = 本期账单（上次账单日之后）的估算积分，过了账单日自动加进 Balance · 以银行账单为准":
      "Pending = estimated points on the current statement (since the last closing date); they roll into the Balance after closing · the bank statement is authoritative",
    "Balance · 总积分": "Balance · total", "Pending 积分": "Pending points",
    "保存后记为今天的余额（填银行显示的已入账积分）": "Saved as today’s balance (enter the posted points shown by the bank)",
    "Amex HK 加赏进度": "Amex HK bonus progress", "来自 Amex HK Tracker 脚本": "from the Amex HK Tracker script", "不是本季度": "not the current quarter",
    "本月加赏": "Bonus this month", "本季加赏": "Bonus this quarter", "分": "pts", "按月": "monthly", "已满": "Cap reached", "无上限资料": "No cap data", "有未识别记录": "unrecognised rows",
    "本地日常": "Local everyday", "外币签账": "Foreign currency", "指定旅游": "Designated travel", "指定商户 5X": "Designated merchants 5X",
    "自定义上限": "Custom cap", "自定义限额": "Custom limit",
    "此月份不在已核实的白金条款有效期（2026-07至2027-12）内": "This month is outside the verified Platinum offer period (2026-07 to 2027-12)",
    "此月份不在本地签账赏优惠期（2026-07-02至12-31）内": "This month is outside the local spend offer period (2026-07-02 to 12-31)",
    "此月份的外币签账赏规则未核实": "Foreign-currency offer rules for this month are unverified",
    "此月份不在指定商户5X优惠期（2026全年）内": "This month is outside the designated-merchant 5X offer period (2026)",
    // Apple Card · CSV 导入
    "上传 CSV": "Upload CSV", "交易记录": "Transactions", "CSV 导入": "CSV import", "交易记录更新到": "Transactions up to date through", "还没有导入过交易": "Nothing imported yet",
    "选择 CSV 文件": "Choose a CSV file", "或把文件拖到这里": "or drop it here", "怎么导出 CSV？": "How do I export the CSV?",
    "日期范围可以和以前的重叠，已经记过的交易会自动跳过，不会重复。": "Date ranges may overlap earlier uploads: transactions already recorded are skipped, never duplicated.",
    "iPhone 打开「钱包」，点 Apple Card，再点「卡余额」。": "On iPhone open Wallet, tap Apple Card, then Card Balance.",
    "选一期结单，点「导出交易」，格式选 CSV。": "Pick a statement, tap Export Transactions and choose CSV.",
    "把文件存到「文件」或隔空投送到电脑，回到这里上传。": "Save it to Files or AirDrop it to your computer, then upload it here.",
    "拿不准从哪天开始，就多选几个月，重复的部分不会重复记账。": "Not sure where you left off? Export a few extra months: the overlap is not recorded twice.",
    "文件里": "In file", "将新增": "New", "已存在": "Recorded", "跳过": "skipped", "日期范围": "Date range",
    "这份 CSV 里的交易都已经在记账本里了，不需要导入。": "Every transaction in this CSV is already recorded. Nothing to import.",
    "导入中…": "Importing…", "没有新交易": "Nothing new",
    "Apple Card 连不上 Plaid。上传一份从「钱包」导出的交易 CSV，就能把它记进来：之后每次上传新的 CSV 接着记。": "Apple Card can’t be linked through Plaid. Upload a transaction CSV exported from Wallet to add it, then upload a newer CSV whenever you want to catch up.",
    "Apple Card 由 Goldman Sachs 发行，Plaid 连不上：交易来自你上传的 CSV。这样会有以下影响：": "Apple Card is issued by Goldman Sachs and Plaid can’t connect to it: transactions come from the CSV files you upload. What this means:",
    "「同步」「立刻从银行刷新」对它没有作用；上传新的 CSV 才会更新。": " “Sync” and “Refresh from bank now” don’t affect it; it only updates when you upload a newer CSV.",
    "是已导入交易的累计，截至最后一笔交易那天；之后的消费要等下次上传。": " is the running total of imported transactions, as of the last transaction; later purchases appear after the next upload.",
    "账单日和还款日": "Closing and due dates", "按固定规则推算：每月最后一天出账，次月倒数第 5 天还款。最低还款 CSV 里没有。": " follow a fixed rule: the statement closes on the last day of the month and is due on the fifth-to-last day of the next month. The CSV has no minimum payment.",
    "按 Apple Pay 2% 估算，Apple 和 Uber 按 3%；个别不对的，在设置的「更新」里逐笔改。": " is estimated at 2% (Apple Pay), 3% at Apple and Uber; fix individual ones under “Update” in settings.",
    "没有 MCC，": "No MCC,", "类别取自 Apple 的分类；地址取自交易描述，支付平台（Alipay、WeChat Pay）和 Uber 的不显示。": " so categories follow Apple’s; addresses come from the description, hidden for payment platforms (Alipay, WeChat Pay) and Uber.",
    "按交易记录推算：每月最后一天出账，次月倒数第 5 天还款；最低还款 CSV 里没有。": "Derived from transactions: closes on the last day of the month, due on the fifth-to-last day of the next month; the CSV has no minimum payment.",
    "交易性质": "Nature", "入账日期": "Posted", "Apple 类别": "Apple category", "经由": "Via", "退款": "Refund", "调整": "Adjustment", "Daily Cash 扣回": "Daily Cash reversal",
    "描述里是支付平台的地址，不是商户的，没有显示": "The description holds the payment platform’s address, not the merchant’s, so it isn’t shown",
    "CSV 上传（不经 Plaid）": "CSV upload (not via Plaid)", "没有通过 Plaid 连接，交易由脚本或 CSV 导入": "Not linked via Plaid; transactions are imported by script or CSV",
    "文件是空的": "The file is empty", "文件里没有交易": "No transactions in the file", "文件超过 5 MB，不像是交易 CSV": "File is over 5 MB and doesn’t look like a transaction CSV",
    "积分进账": "Points earned", "今日": "Today", "本周": "This week", "本月": "This month", "本季": "This quarter", "本年": "This year",
    "按交易日期统计的估算积分（含 Pending），以银行账单为准": "Estimated points by transaction date (incl. Pending); the bank statement is authoritative",
    "积分走势": "Points trend", "本月各卡": "This month by card", "本月暂无消费": "No spending this month",
    "未识别卡型": "Unknown card", "连接信用卡后，这里会按积分计划汇总。": "Link a credit card to see points by program.",
    "还没有信用卡账户": "No credit card accounts yet", "不计积分": "No points",
    // 交易页
    "支出": "Spent", "退款 / 还款": "Refunds / payments", "笔数": "Count", "全部卡片": "All cards", "任意卡片": "Any card",
    "没有符合条件的交易": "No matching transactions", "未知账户": "Unknown account",
    "还没有连接银行。点击右上角「连接银行」开始。": "No banks linked yet. Click “Link bank” at the top right to start.",
    "待入账": "Pending", "线下": "In store", "线上": "Online",
    "In store：在实体店刷卡 / 拍卡": "In store: card swiped or tapped at a shop",
    "Online：网购、App 或订阅扣款": "Online: web, app or subscription charge",
    "Other：无法判断渠道，常见于还款、转账、费用": "Other: channel unknown, typical for payments, transfers and fees",
    "Pending：银行已授权、尚未入账，金额和商户名可能还会变": "Pending: authorized but not posted yet; amount and merchant may still change",
    // 权益任务
    "已完成": "Done", "已过期": "Expired", "删除": "Delete", "自动": "Auto",
    "还没有自定义权益任务。例如开卡奖励的消费门槛、每月 Uber / 餐饮 credit。": "No custom tasks yet — e.g. a sign-up bonus spend target or a monthly Uber / dining credit.",
    "＋ 新增权益任务": "＋ Add a benefit task", "＋": "＋",
    "名称": "Name", "卡片": "Card", "开始": "Start", "截止": "End", "目标": "Target", "商户关键词": "Merchant keywords", "备注": "Notes",
    "消费金额": "Spend amount", "消费笔数": "Purchase count", "可选": "Optional",
    "例：Amex Gold Uber Cash / 开卡消费 $4,000": "e.g. Amex Gold Uber Cash / $4,000 sign-up spend",
    "可选，逗号分隔，例：uber, lyft": "Optional, comma-separated, e.g. uber, lyft",
    "已刷满，等待报销入账（通常几天内）": "Fully used — waiting for the credit to post (usually a few days)",
    "额度已用满": "Credit fully used",
    "权益返现": "Benefit credit", "权益返现，不扣积分": "Benefit credit, no points deducted",
    "年费，不计积分": "Annual fee, no points", "年费退回，不扣积分": "Annual fee refund, no points deducted",
    // 账户页
    "断开": "Unlink", "账单日历": "Billing calendar", "出账日 · 还款日": "Closing · due dates",
    "下个出账": "Next closing", "下个还款": "Next due", "下个年费": "Next annual fee",
    "授权账单信息": "Authorize statement data", "还没有连接银行": "No banks linked yet",
    "授权后可自动获取账单日、还款日、最低还款和 APR": "Authorize to get closing day, due date, minimum payment and APR automatically",
    "这张卡没有固定额度（签账卡）或银行没有提供额度。": "This card has no preset limit (charge card) or the bank didn’t provide one.",
    "已还清": "Paid in full", "已还最低": "Minimum paid", "处理中": "processing",
    "本期无需还款": "Nothing due", "本期已还": "Paid this cycle", "已过还款日": "Past due date", "已逾期": "Overdue",
    // 账户详情
    "当前欠款": "Current balance", "信用额度": "Credit limit", "可用额度": "Available credit", "可用余额": "Available", "当前余额": "Current balance",
    "账单与还款": "Statement & payment", "还款日": "Due date", "上期账单": "Last statement", "最低还款": "Minimum payment",
    "上次还款": "Last payment", "逾期": "Overdue", "否": "No", "是": "Yes",
    "年利率": "Rate", "计息余额": "Balance subject to APR", "本期利息": "Interest this cycle", "取现": "Cash advance", "余额转移": "Balance transfer", "优惠": "Promo",
    "本期账单周期": "Current billing cycle", "本期消费": "Cycle spend", "本期 Pending 积分": "Pending points this cycle", "平均倍数": "Avg multiplier",
    "账单日": "Closing day", "号": "", "卡型与积分": "Card product & earning", "卡型": "Product",
    "选择卡型后按对应倍数估算积分": "Pick a product to estimate points with its multipliers",
    "手动设置 · 清空后恢复自动": "Set manually · clear to go back to auto", "未知 · 暂按月底计算": "Unknown · using month-end for now",
    "交易记录里没找到年费（可能没有年费，或扣费早于 Plaid 能拿到的 24 个月）": "No annual fee found in the history (none charged, or older than the 24 months Plaid provides)",
    "账户信息": "Account info", "银行": "Bank", "类型": "Type", "币种": "Currency", "上次同步": "Last synced",
    "信用卡": "credit card", "支票账户": "checking", "储蓄账户": "savings", "货币市场": "money market", "定期存单": "CD",
    "更换卡面": "Change card face", "收起卡面选择": "Hide card faces", "选择卡面": "Choose a card face", "官方卡面": "Official art",
    "上传卡面照片": "Upload a card photo", "你的卡片照片": "Your card photo", "竖版会自动转成横版": "Portrait photos are rotated to landscape",
    "本站设计 · 推荐": "Built-in designs · recommended", "本站设计 · 更多": "Built-in designs · more",
    "读不了这张图片": "Can’t read this image", "卡面已更新": "Card face updated", "已删除照片": "Photo deleted", "正在处理照片…": "Processing photo…",
    // 账单日历
    "出账日": "Closing", "还款日 · 预计": "Due · estimated", "年费日": "Annual fee", "预计（按间隔推算）": "Estimated (from interval)",
    "今天": "Today", "明天": "Tomorrow", "接下来 45 天": "Next 45 days", "这天没有出账或还款": "No closing or due date on this day",
    "近期没有出账或还款": "No upcoming closing or due dates", "本期已刷": "Spent this cycle", "账单金额": "Statement balance",
    "按上期账单的间隔推算，以银行账单为准": "Estimated from the last statement interval; the bank statement is authoritative",
    "账户详情 ›": "Account details ›", "账单日来自上期出账日": "Closing day taken from the last statement",
    "账": "C", "还": "D", "年": "Y",
    // 交易详情
    "授权": "Authorized", "等待入账": "Awaiting posting", "已入账": "Posted", "银行处理中，金额可能还会变": "Bank still processing; the amount may change",
    "日期": "Date", "授权日期": "Authorized", "状态": "Status", "待入账（Pending）": "Pending", "已入账（Posted）": "Posted", "由待入账转来": "From pending",
    "交易类型": "Transaction type", "交易代码": "Transaction code", "支票号": "Check number", "非官方": "Unofficial", "持卡人": "Cardholder",
    "商户": "Merchant", "商户名": "Merchant name", "Plaid 未识别": "Not identified by Plaid", "银行原始描述": "Original bank description",
    "网站": "Website", "地址": "Address", "在地图中查看 ↗": "View on map ↗", "正在定位…": "Locating…", "找不到这个地址的位置": "Couldn’t locate this address",
    "暂时连不上地图服务": "Map service unavailable right now", "地图加载失败": "Map failed to load", "大致位置": "Approximate", "Plaid 商户 ID": "Plaid merchant ID",
    "分类": "Category", "银行没有提供（Plaid 的 MCC 仍是 beta 字段）": "Not provided by the bank (MCC is still a beta field in Plaid)",
    "本站类别": "App category", "Plaid 大类": "Plaid category", "Plaid 细类": "Plaid subcategory", "分类可信度": "Category confidence",
    "付款方式": "Payment method", "处理方": "Processor", "收款人": "Payee", "付款人": "Payer", "代表": "On behalf of", "参考号": "Reference", "原因": "Reason",
    "支付": "Payment", "渠道": "Channel", "交易对手": "Counterparties", "积分计算": "Points", "积分计划": "Program", "命中规则": "Matched rule",
    "倍数": "Multiplier", "记忆键": "Memory key", "在「更新」模式改倍数时按这个记住": "Multipliers changed in “Update” mode are remembered by this key",
    "技术信息 · 原始数据": "Technical · raw data", "复制": "Copy", "已复制": "Copied",
    "实体消费": "In-store purchase", "线上 / 数字": "Online / digital", "特殊交易": "Special", "未识别": "Unidentified", "非信用卡消费": "Not a card purchase",
    "非常高": "very high", "高": "high", "中": "medium", "低": "low", "未知": "unknown",
    // 分析
    "当前范围：": "Range: ", "· 下面所有图表都按这个范围统计，在「消费趋势」里下钻或「选择时间」切换": "· every chart below uses this range; drill into “Spending trend” or use “Pick period” to change it",
    "本月至今": "Month to date", "本月预计": "Month projection", "近 30 天日均": "30-day daily avg", "近 30 天客单价": "30-day avg ticket",
    "上月同期无数据": "No data for last month", "消费趋势": "Spending trend", "按卡": "By card", "按类别": "By category",
    "没有消费": "No spending", "合计": "Total", "按 MCC 分类 · 退款已冲减": "Grouped by MCC · net of refunds",
    "星期规律": "Weekday pattern", "常去商户": "Top merchants", "按消费额排序的前 8 名": "Top 8 by spend",
    "消费日历": "Spending calendar", "大额消费": "Largest purchases", "所选时间内金额最大的 6 笔": "The 6 largest purchases in the period",
    "分类 × 时间": "Category × time", "单卡分析": "Single card", "估算积分": "Est. points", "基础": "Base",
    "吃到加成的消费": "Spend earning a bonus", "近 12 个月": "Last 12 months", "近 12 个月消费": "Spend, last 12 months", "倍数分布": "Multiplier mix", "类别构成": "Category mix",
    "连接信用卡后，这里会出现消费分析。": "Link a credit card to see spending analytics.", "分组": "Group", "加成": "bonus",
    "少": "Less", "多": "More", "看全部": "Show all",
    // 图表 / 选择时间
    "全部": "All", "选择时间": "Pick period", "返回上一级": "Back up one level", "季度": "Quarter", "周": "Week", "月": "Month", "那周": "that week",
    "双击柱子进入下一级 · 左上角 ↰ 返回上一级 · 「选择时间」可直接跳到任一年、季度、月或周":
      "Double-click a bar to drill down · ↰ at top left goes back up · “Pick period” jumps to any year, quarter, month or week",
    "左上角 ↰ 返回上一级 · 「选择时间」可直接跳到任一年、季度、月或周": "↰ at top left goes back up · “Pick period” jumps to any year, quarter, month or week",
    "「选择时间」可直接跳到任一年、季度、月或周": "“Pick period” jumps to any year, quarter, month or week",
    // 导航 / 无障碍
    "上一笔": "Previous", "下一笔": "Next", "上一笔（←）": "Previous (←)", "下一笔（→）": "Next (→)", "上一个账户": "Previous account", "下一个账户": "Next account",
    "搜索商户 / 描述": "Search merchant / description", "消费": "Spend", "输入总积分": "Total points",
    "Statement closing date：每月几号出账单": "Statement closing date: the day of the month the statement is cut",
    "上个月": "Previous month", "下个月": "Next month", "关闭": "Close", "关闭（Esc）": "Close (Esc)", "向左滚动": "Scroll left", "向右滚动": "Scroll right",
    "收起": "Less", "更多": "More", "查看": "View", "点": "pts", "笔": "txns",
    // 提示
    "请先登录": "Please sign in", "登录已过期，请重新登录": "Session expired, please sign in again", "同步中…": "Syncing…", "已同步": "Synced",
    "连接成功，正在保存…": "Linked, saving…", "连接成功。新连接的交易可能要几分钟后才能同步到": "Linked. Transactions from a new link may take a few minutes to arrive",
    "已退出": "Cancelled", "已断开": "Unlinked", "没有改动": "No changes", "已请求银行刷新…": "Refresh requested…",
    "已请求刷新，约 1 分钟后自动同步": "Refresh requested; syncing automatically in about a minute",
    "重新拉取所有银行的全部交易？需要一点时间。": "Re-pull the full history from every bank? This takes a moment.",
    "拉取中…": "Pulling…", "已重新拉取全部交易": "Full history re-pulled",
    "日历脚本没加载到，请下拉刷新或清一下浏览器缓存": "The calendar script didn’t load — pull to refresh or clear the browser cache",
    "账单日填 1–31": "Closing day must be 1–31", "已清除账单日（按月底结算）": "Closing day cleared (using month-end)",
    "卡片对应已更新": "Card mapping updated", "已删除，恢复按卡片默认倍数": "Deleted — back to the card’s default multiplier",
    "截止日期早于开始日期": "End date is before start date", "删除这个任务？": "Delete this task?",
    "config.js 里还没有填 Worker 地址": "Worker URL is missing in config.js",
    "连不上 Worker，请检查 config.js 和 ALLOWED_ORIGINS": "Can’t reach the Worker — check config.js and ALLOWED_ORIGINS",
    "账号或密码错误": "Wrong username or password", "尝试次数过多，请 15 分钟后再试": "Too many attempts — try again in 15 minutes",
    "Worker 未配置登录信息": "Login is not configured on the Worker",
    // 卡面样式
    "午夜": "Midnight", "石板": "Slate", "墨蓝": "Ink blue", "晴空": "Sky", "湖蓝": "Lake", "藏青": "Navy", "石墨": "Graphite", "青碧": "Teal",
    "薄荷": "Mint", "晚霞": "Sunset", "铂银": "Platinum", "拉丝": "Brushed metal", "金": "Gold", "玫瑰金": "Rose gold", "森林": "Forest",
    "鼠尾草": "Sage", "黑曜": "Obsidian", "酒红": "Burgundy", "星河": "Galaxy", "珍珠白": "Pearl", "钛": "Titanium", "珊瑚": "Coral",
    "Schwab Bank 借记卡": "Schwab Bank debit", "Schwab One Brokerage 借记卡": "Schwab One Brokerage debit",
    // 星期
    "一": "M", "二": "T", "三": "W", "四": "T", "五": "F", "六": "S", "日": "S",
    "周一": "Mon", "周二": "Tue", "周三": "Wed", "周四": "Thu", "周五": "Fri", "周六": "Sat", "周日": "Sun",
    // 非 Plaid 账户（香港 Amex）
    "非 Plaid": "Not via Plaid", "没有通过 Plaid 连接，交易由脚本导入": "Not linked via Plaid; transactions are imported by a script",
    "香港": "Hong Kong", "香港发行": "Issued in Hong Kong", "没有": "None", "上次导入": "Last imported",
    "没有通过 Plaid 连接。": "Not linked via Plaid.", "没有通过 Plaid 连接": "Not linked via Plaid",
    "历史交易来自月结单，新交易在你打开 Amex 网银时由脚本推送；金额以港币显示，美元小字按 1 USD = 7.8 HKD 换算；没有 MCC，本站不估算积分。点开卡片看详情。":
      "History comes from monthly statements; new transactions are pushed by a script when you open Amex online banking. Amounts are shown in HKD, with USD in small print at a fixed 1 USD = 7.8 HKD. No MCC, so points are not estimated here. Open a card for details.",
    "这张卡在香港发行，Plaid 连不上：历史交易来自 Amex 月结单（CSV），新交易在你打开 Amex 网银时由 Tampermonkey 脚本推送。这样会有以下影响：":
      "This card is issued in Hong Kong and Plaid can’t connect to it: history comes from Amex monthly statements (CSV), and new transactions are pushed by a Tampermonkey script when you open Amex online banking. What this means:",
    "不会自动同步。": "No automatic sync.",
    "「同步」「立刻从银行刷新」对它没有作用；只有打开 Amex 网银的交易页面时才会更新。":
      " “Sync” and “Refresh from bank now” don’t affect it; it only updates when you open the Amex online banking activity page.",
    "当前欠款": "Current balance", "当前欠款、可用额度、还款日、最低还款": "Current balance, available credit, due date and minimum payment",
    "金额以港币显示。": "Amounts are shown in HKD.",
    "美元小字和各种汇总按固定汇率 1 USD = 7.8 HKD 换算，和 Amex 实际入账汇率无关。":
      " USD figures and totals use a fixed 1 USD = 7.8 HKD, independent of Amex’s actual rates.",
    "没有 MCC 和 Plaid 商户分类，": "No MCC or Plaid merchant categories, ",
    "分类统计里大多归入「其他」；本站不估算这张卡的积分，季度加赏看 Amex HK Tracker。":
      "so most spending falls under “Other”; points for this card are not estimated here — see Amex HK Tracker for quarterly bonuses.",
    "账单信息": "Statement details", "由结单算出或来自问卷，问卷填 N/A 的项目显示「没有」。": " are computed from statements or taken from the questionnaire; items answered N/A show “None”.",
    "还没有账单信息。运行导入脚本（scripts/import_amex_hk.mjs）后会显示。": "No statement details yet. They appear after running the import script (scripts/import_amex_hk.mjs).",
    "APR：没有": "APR: None", "数据来源": "Data source", "月结单导入（不经 Plaid）": "Imported statements (not via Plaid)",
    "香港卡：本站不估算积分，季度加赏看 Amex HK Tracker": "Hong Kong card: points not estimated here — see Amex HK Tracker for quarterly bonuses",
    "外币原始金额": "Original foreign amount", "优惠": "Offer", "所属结单": "Statement", "Amex 参考号": "Amex reference",
    "结单不提供": "Not in statement", "近期没有": "None soon",
    "这张卡在香港发行，Plaid 连不上：账户信息和新交易在你打开汇丰网银时由 Tampermonkey 脚本推送，更早的交易来自月结单（PDF）导入。这样会有以下影响：":
      "This card is issued in Hong Kong and Plaid can’t connect to it: account details and new transactions are pushed by a Tampermonkey script when you open HSBC online banking; older transactions come from monthly statements (PDF). What this means:",
    "「同步」「立刻从银行刷新」对它没有作用；只有打开汇丰网银时才会更新。": " “Sync” and “Refresh from bank now” don’t affect it; it only updates when you open HSBC online banking.",
    "（上期结欠、还款日、最低还款）取自汇丰网银；APR 网银不提供，取自最近一期结单。": " (last statement balance, due date, minimum payment) come from HSBC online banking; APR isn’t shown there, so it comes from the latest statement.",
    "「同步」「立刻从银行刷新」对它没有作用；新结单出来后，用导入脚本（scripts/import_hsbc_hk.py）再导入一次。":
      " “Sync” and “Refresh from bank now” don’t affect it; when a new statement arrives, run the import script (scripts/import_hsbc_hk.py) again.",
    "是期初结余加上已导入的全部交易，截至最近一期结单；之后的新消费不在里面。":
      " is the opening balance plus all imported transactions, as of the latest statement; newer purchases are not included.",
    "金额以人民币显示。": "Amounts are shown in RMB.",
    "Pulse 是双币卡：": "Pulse is a dual-currency card:",
    "港币、人民币两个子账户分开出账、分开还款，所以这里是两个账户。": " its HKD and RMB sub-accounts are billed and repaid separately, so they appear as two accounts.",
    "结单没有 MCC，": "Statements have no MCC,",
    "类别按商户名归入汇丰的日常交易分类；本站不估算汇丰积分（RewardCash / 里数）。": " so categories follow HSBC’s everyday spending categories by merchant name; HSBC rewards (RewardCash / miles) are not estimated here.",
    "（还款日、最低还款、APR）取自最近一期结单。": " (due date, minimum payment, APR) come from the latest statement.",
    "汇丰卡 · 本站不估算": "HSBC card · not estimated here", "汇丰类别": "HSBC category", "最低": "min", "约": "approx.", "香港卡 · 见 Amex HK Tracker": "HK card · see Amex HK Tracker", "不估算积分": "Points not estimated", "香港结单不提供 MCC": "Hong Kong statements don’t include MCC", "经典": "classic",
  };

  // ---------------------------------------------------------------- 词组（拆段后仍有中文时按最长优先替换）
  const FRAG = {
    // 本站类别（icons.js）
    "出行住宿": "Travel & lodging", "餐饮": "Dining", "超市": "Groceries", "交通加油": "Transport & gas", "购物": "Shopping",
    "健康个护": "Health & care", "订阅通讯": "Subscriptions & telecom", "其他": "Other",
    "机票": "Flights", "酒店": "Hotels", "打车": "Rideshare", "公共交通": "Transit", "停车 / 过路费": "Parking / tolls", "餐厅": "Restaurants",
    "快餐": "Fast food", "咖啡": "Coffee", "酒吧 / 酒水": "Bars / alcohol", "加油": "Gas", "充电": "EV charging",
    "流媒体 / 数字内容": "Streaming / digital", "通讯 / 网络": "Phone / internet", "数码": "Electronics", "服饰": "Apparel",
    "家居 / 家装": "Home", "健身": "Fitness", "美容 / 个护": "Beauty / care", "医疗": "Medical", "教育 / 书籍": "Education / books",
    "宠物": "Pets", "娱乐": "Entertainment", "礼品 / 捐赠": "Gifts / donations", "保险": "Insurance", "政府 / 税费": "Government / taxes",
    "还款 / 转账": "Payments / transfers", "费用 / 利息": "Fees / interest", "收入 / 返现": "Income / cash back", "年费": "Annual fee",
    "线上超市": "Online groceries", "加油 / 充电": "Gas / EV charging", "其他旅行": "Other travel", "公共交通 / 打车": "Transit / rideshare",
    "流媒体": "Streaming", "家装": "Home improvement", "现场娱乐": "Live entertainment", "银行旅行平台": "Issuer travel portal",
    "Apple 3% 商户": "Apple 3% merchants", "万豪旗下酒店": "Marriott hotels", "直接向航司 / 酒店订": "booked direct with airline / hotel",
    "加油站和电动车充电": "Gas stations & EV charging", "部分现场娱乐": "Select live entertainment", "美国超市": "US supermarkets",
    "各类别各 $6,000": "$6,000 per category", "本月最高类别": "Top category this month", "基础倍数": "Base rate",
    "Amex Travel 预付酒店": "Prepaid hotels via Amex Travel", "Citi Travel 酒店 / 租车（机票为 6x）": "Citi Travel hotels / car rental (flights 6x)",
    "周五、周六 18:00–6:00 ET 为 6x，可手动改": "6x Fri–Sat 6pm–6am ET; adjust manually",
    "默认按 Apple Pay 2% 估算；实体卡消费 1%，可手动改": "Estimated at 2% Apple Pay; 1% with the physical card — adjust manually",
    "餐厅（含外卖），合计 7x = 1 + 4 + 日常餐饮 2": "Restaurants (incl. delivery), 7x total = 1 + 4 + everyday dining 2",
    "超市（不含 Walmart、Target），5x": "Grocery stores (excl. Walmart, Target), 5x", "American Red Cross 捐款，5x": "American Red Cross donations, 5x",
    "United Way 捐款": "United Way donations", "轮换": "rotation", "5% 轮换": "5% rotation",
    "Chase 其他卡": "Other Chase card", "Citi 其他卡": "Other Citi card", "Amex 其他卡": "Other Amex card", "Barclays 其他卡": "Other Barclays card",
    // MCC 组（detail.js）
    "航空公司": "Airline", "租车公司": "Car rental", "通勤交通": "Commuter transport", "铁路客运": "Passenger rail", "出租车 / 网约车": "Taxi / rideshare",
    "长途巴士": "Bus lines", "邮轮": "Cruise", "机场服务": "Airport services", "旅行社": "Travel agency", "过路费": "Tolls", "交通服务": "Transport services",
    "电信设备": "Telecom equipment", "电信服务": "Telecom services", "网络服务": "Internet services", "有线电视 / 流媒体": "Cable / streaming",
    "水电煤": "Utilities", "电脑设备": "Computers", "家装建材": "Home supplies", "建材": "Building materials", "五金店": "Hardware store",
    "仓储会员店": "Warehouse club", "折扣店": "Discount store", "百货商店": "Department store", "杂货店": "Grocery store", "综合零售": "General retail",
    "肉类": "Meat", "糖果甜品": "Candy", "乳制品": "Dairy", "面包店": "Bakery", "食品专卖": "Specialty food", "加油站": "Gas station",
    "自助加油": "Automated fuel", "电动车充电": "EV charging", "男装": "Men’s apparel", "女装": "Women’s apparel", "服装": "Clothing",
    "运动服饰": "Sportswear", "鞋店": "Shoes", "家具": "Furniture", "家电": "Appliances", "电子产品": "Electronics", "软件": "Software",
    "酒吧": "Bar", "数字内容": "Digital content", "游戏": "Games", "App / 软件": "Apps / software", "数字商品": "Digital goods", "药店": "Pharmacy",
    "酒类": "Liquor", "自行车": "Bicycles", "体育用品": "Sporting goods", "书店": "Bookstore", "珠宝": "Jewelry", "玩具": "Toys", "相机": "Cameras",
    "礼品": "Gifts", "邮购": "Mail order", "化妆品": "Cosmetics", "花店": "Florist", "宠物用品": "Pet supplies", "其他零售": "Other retail",
    "美发美容": "Salon", "水疗": "Spa", "租车": "Car rental", "停车": "Parking", "电影院": "Cinema", "演出": "Shows", "健身俱乐部": "Gym",
    "医生": "Doctor", "牙医": "Dentist", "医院": "Hospital", "医疗服务": "Medical services", "慈善捐款": "Charity", "专业服务": "Professional services",
    "税费": "Taxes", "政府服务": "Government services", "政府 / 公益": "Government / nonprofit", "政府/公益": "Government / nonprofit",
    "旅行": "Travel", "交通": "Transport", "服务": "Services", "个人护理": "Personal care", "房租水电": "Rent & utilities", "家居": "Home",
    "还款日": "Due date", "出账日": "Closing date", "还款": "Payment", "转入": "Transfer in", "转出": "Transfer out", "银行费用": "Bank fees", "收入": "Income",
    // 卡面
    "新款": "new", "旧款": "classic", "圆角": "rounded", "黑武士": "Darth Vader", "城堡": "Castle",
    // 积分计划描述
    "机票、酒店、租车、其他旅行": "flights, hotels, car rental, other travel", "机票、酒店、餐饮、超市": "flights, hotels, dining, groceries",
    "餐饮、线上超市、流媒体": "dining, online groceries, streaming", "餐饮、机票、酒店、租车": "dining, flights, hotels, car rental",
    "机票、酒店": "flights, hotels", "超市、餐饮": "groceries, dining", "餐饮、机票": "dining, flights", "餐饮、药店": "dining, drugstores",
    // 杂项
    "可信度": "confidence", "已记住": "Remembered", "未设置（按月底）": "not set (month-end)", "时间范围跟随上方筛选": "range follows the filter above",
    "图库里的其他卡面": "Other faces in library", "上次同步": "Last synced", "额度": "Limit", "可用": "Available", "已用": "Used",
  };
  const FRAG_KEYS = Object.keys(FRAG).sort((a, b) => b.length - a.length);
  const trFrag = (s) => {
    for (const k of FRAG_KEYS) if (s.includes(k)) s = s.split(k).join(FRAG[k]);
    return s.replace(/（/g, " (").replace(/）/g, ")").replace(/，/g, ", ").replace(/：/g, ": ").replace(/、/g, ", ").replace(/「|」/g, "\"").replace(/？/g, "?");
  };

  // ---------------------------------------------------------------- 规则（整段匹配；$ 金额、数字原样保留）
  const N = "([\\d,.]+)", AMT = "([−\\-+]?(?:HK)?\\$?[\\d,.]+%?)";
  const R = (src, f) => [new RegExp("^" + src + "$"), f];
  const RULES = [
    // 日期
    R("(\\d{4}) 年 (\\d+) 月 (\\d+) 日 · 周(.)", (_, y, mo, d, w) => `${WK[w]}, ${m(mo)} ${d}, ${y}`),
    R("(\\d{4}) 年 (\\d+) 月 (\\d+) 日", (_, y, mo, d) => `${m(mo)} ${d}, ${y}`),
    R("(\\d+)月(\\d+)日 · 周(.)", (_, mo, d, w) => `${WK[w]}, ${m(mo)} ${d}`),
    R("(\\d+)月(\\d+)日，(\\d+) 个事项", (_, mo, d, n) => `${m(mo)} ${d}, ${plural(n, "event")}`),
    R("(\\d+)月(\\d+)日", (_, mo, d) => `${m(mo)} ${d}`),
    R("(\\d+) 月 (\\d+) 日", (_, mo, d) => `${m(mo)} ${d}`),
    R("(\\d{4}) 年 (\\d+) 月（双击进入）", (_, y, mo) => `${m(mo)} ${y} (double-click to open)`),
    R("(\\d{4}) 年 Q(\\d)（双击进入）", (_, y, q) => `Q${q} ${y} (double-click to open)`),
    R("(\\d{4}) 年（双击进入）", (_, y) => `${y} (double-click to open)`),
    R("(.+)（双击进入）", (_, x) => `${tr(x)} (double-click to open)`),
    R("(\\d{4}) 年 (\\d+) 月", (_, y, mo) => `${m(mo)} ${y}`),
    R("(\\d{4}) 年 Q(\\d)", (_, y, q) => `Q${q} ${y}`),
    R("(\\d{4}) 年", (_, y) => y),
    R("(\\d+) ?月", (_, mo) => m(mo)),
    R("(\\d+) 日 周(.)", (_, d, w) => `${WK[w]} ${d}`),
    R("(\\S+) 起的一周", (_, d) => `Week of ${d}`),
    R("(\\S+) 起", (_, d) => `from ${d}`),
    R("(\\S+) 至 (\\S+)", (_, a, b) => `${a} – ${b}`),
    R("(\\S+) 出账", (_, d) => `Closes ${d}`),
    R("(\\S+) 还款", (_, d) => `Due ${d}`),
    R("(\\S+) 结算", (_, d) => `settles ${d}`),
    R("(\\d+) 天后", (_, n) => `in ${plural(n, "day")}`),
    R("(\\d+) 天前", (_, n) => `${plural(n, "day")} ago`),
    R("（还有 (\\d+) 天）", (_, n) => ` (in ${plural(n, "day")})`),
    R("还有 (\\d+) 天", (_, n) => `in ${plural(n, "day")}`),
    R("剩 (\\d+) 天", (_, n) => `${n} ${n === "1" ? "day" : "days"} left`),
    R("本月剩 (\\d+) 天", (_, n) => `${n} days left this month`),
    R("已过 (\\d+) 天", (_, n) => `${plural(n, "day")} overdue`),
    R("最低 " + AMT, (_, a) => `min ${a}`),
    R("最近 (\\S+)", (_, d) => `last ${d}`),
    R("上次 (\\S+) 扣费", (_, d) => `last charged ${d}`),
    R("下次约", () => "next ≈"),
    R("交易来自你上传的 Apple Card CSV(?:，已更新到 (\\d+) 月 (\\d+) 日)?；Daily Cash 按 Apple Pay 2%、Apple 和 Uber 3% 估算。点开卡片上传新的 CSV、看详情。",
      (_, mo, d) => `Transactions come from the Apple Card CSV files you upload${mo ? `, up to date through ${m(mo)} ${d}` : ""}. Daily Cash is estimated at 2% (Apple Pay), 3% at Apple and Uber. Open the card to upload a newer CSV or see details.`),
    R("之后已结算 ([+−\\-]?\\$[\\d,.]+)", (_, a) => `${a} settled since`),
    R("共 (\\d+) 笔", (_, n) => `${n} in total`),
    R("最早 (.+)", (_, d) => `earliest ${tr(d)}`),
    R("上次导入 (.+)", (_, d) => `last import ${d}`),
    R("(消费|还款|退款|调整|Daily Cash 扣回) (\\d+)", (_, k, n) => `${tr(k)} ${n}`),
    R("另有 (\\d+) 笔", (_, n) => `${n} more`),
    R("导入 (\\d+) 笔", (_, n) => `Import ${n}`),
    R("第 (.+) 行读不出日期或金额，已跳过", (_, x) => `Rows ${x.replace(/、/g, ", ")} have no readable date or amount and were skipped`),
    R("Apple Card：新增 (\\d+) 笔，已存在跳过 (\\d+) 笔", (_, a, b) => `Apple Card: ${a} added, ${b} already recorded`),
    R("Apple Card：没有新交易（(\\d+) 笔都已存在）", (_, n) => `Apple Card: nothing new (all ${n} already recorded)`),
    R("不是 Apple Card 的交易 CSV：缺少「(.+)」列", (_, c) => `Not an Apple Card transaction CSV: missing column(s) ${c.replace(/、/g, ", ")}`),
    R("(\\d+) 笔被拒：(.*)", (_, n, r) => `${n} rejected: ${r}`),
    R("更新于 (.+)", (_, d) => `updated ${d}`),
    R("尚余 (HK\\$[\\d,]+)", (_, a) => `${a} left`),
    R("([\\d,]+) 分", (_, n) => `${n} pts`),
    R("(.+)还没扫描，数字可能不全", (_, ms) => `${ms.split("、").map((x) => m(parseInt(x, 10))).join(", ")} not scanned yet; figures may be incomplete`),
    R("已还清 " + AMT, (_, a) => `Paid ${a} in full`),
    R("余 " + AMT, (_, a) => `${a} left`),
    R("(\\d+/\\d+) 前", (_, d) => `by ${d}`),
    R("还款日 (\\S+) 已过", (_, d) => `Due date ${d} has passed`),
    R("下次 (\\S+)", (_, d) => `next ${d}`),
    R("记得在 (\\S+) 前激活", (_, d) => `activate by ${d}`),
    R("上次同步：(.+)", (_, d) => `Last synced: ${d}`),
    R("上次导入：(.+)", (_, d) => `Last imported: ${d}`),
    R("余额、额度和账单信息取自汇丰网银，交易来自网银和月结单（PDF），都在你打开汇丰网银时由脚本推送；金额以原币显示，美元小字按 (.+) 换算；结单没有 MCC，本站不估算汇丰积分。点开卡片看详情。",
      (_, r) => `Balances, limits and statement details come from HSBC online banking; transactions come from online banking and monthly statements (PDF). A script pushes them whenever you open HSBC online banking. Amounts are in their original currency, with USD in small print at ${r.replace(/、/g, ", ")}. No MCC, and HSBC rewards are not estimated. Open a card for details.`),
    R("取自汇丰网银（戶口結餘 / 可用信用額），最近一次是 (.+)。戶口結餘不含待处理交易，负数表示有溢缴。", (_, d) => ` come from HSBC online banking (account balance / available credit); last updated ${d}. The account balance excludes pending transactions; a negative balance means a credit.`),
    R("取自汇丰网银（戶口結餘 / 可用信用額），还没抓到过，暂时按期初结余加已导入交易累计。戶口結餘不含待处理交易，负数表示有溢缴。", () => " come from HSBC online banking (account balance / available credit); not captured yet, so for now it is the opening balance plus imported transactions. The account balance excludes pending transactions; a negative balance means a credit."),
    R("美元小字和各种汇总按固定汇率 (1 USD = [\\d.]+ \\w+) 换算，和汇丰实际入账汇率无关。", (_, r) => ` USD figures and totals use a fixed ${r}, independent of HSBC’s actual rates.`),
    R("取自 Amex 网银首页（總結欠 / 可用信用額），打开网银时更新，最近一次是 (.+)。", (_, d) => ` come from the Amex online banking home page (total balance / available credit) and update when you open it; last updated ${d}.`),
    R("取自 Amex 网银首页（總結欠 / 可用信用額），打开网银时更新；还没抓到过时，欠款按已导入交易累计。", () => " come from the Amex online banking home page and update when you open it; until then the balance is the running total of imported transactions."),
    R("账单数据来自 Amex 网银 · (.+)", (_, d) => `Statement data from Amex online banking · ${d}`),
    R("按 1 USD = ([\\d.]+) (\\w+) 换算成美元显示", (_, r, c) => `shown in USD at 1 USD = ${r} ${c}`),
    R("汇率 ([\\d.]+)", (_, r) => `rate ${r}`),
    R("自动 · 来自上期出账日 (\\S+)", (_, d) => `Auto · from last closing ${d}`),
    R("留空 = 自动（来自上期出账日 (\\S+)）", (_, d) => `Empty = auto (from last closing ${d})`),
    R("留空 = 月底", () => "Empty = month-end"),
    R("账单日已设为每月 (\\d+) 号", (_, d) => `Closing day set to the ${d}${["th", "st", "nd", "rd"][(d % 100 > 10 && d % 100 < 14) ? 0 : Math.min(d % 10, 4) % 4] || "th"}`),
    // 金额 / 计数
    R(AMT + " ?点", (_, a) => `${a} pts`),
    R("(\\S+) 录入 " + AMT + " ?点?", (_, d, a) => `${a}${/\$/.test(a) ? "" : " pts"} recorded ${d}`),
    R("之后已结算 " + AMT + " 点", (_, a) => `${a} pts settled since`),
    R("(\\d+) 笔消费", (_, n) => plural(n, "purchase")),
    R("(\\d+) 笔", (_, n) => plural(n, "txn")),
    R("(\\d+) 次", (_, n) => `${n}×`),
    R("(\\d+) 类", (_, n) => plural(n, "category")),
    R("其他 (\\d+) 类", (_, n) => `${plural(n, "other category").replace("other categorys", "other categories")}`),
    R("更多 (\\d+) 类", (_, n) => `${n} more`),
    R("客单价 " + AMT, (_, a) => `avg ticket ${a}`),
    R("(\\d+) 笔 · 客单价 (\\S+)", (_, n, a) => `${plural(n, "txn")} · avg ticket ${a}`),
    R("(\\d+) 笔 · 占 (\\S+)", (_, n, a) => `${plural(n, "txn")} · ${a} of total`),
    R("占当期 (\\S+)", (_, a) => `${a} of period`),
    R("占 (\\S+)", (_, a) => `${a} of total`),
    R("已用 (\\S+)", (_, a) => `${a} used`),
    R("可用 " + AMT, (_, a) => `Available ${a}`),
    R("额度 " + AMT, (_, a) => `Limit ${a}`),
    R("上限 " + AMT, (_, a) => `Cap ${a}`),
    R("消费 " + AMT, (_, a) => `Spend ${a}`),
    R("平均 (\\S+)", (_, a) => `avg ${a}`),
    R("基础 (\\S+)", (_, a) => `Base ${a}`),
    R("合计 " + AMT, (_, a) => `Total ${a}`),
    R("最大一笔 " + AMT, (_, a) => `Largest ${a}`),
    R("对比上月同期 " + AMT, (_, a) => `vs. same point last month ${a}`),
    R("对比上月同期", () => "vs. same point last month"),
    R("按日均推算", () => "Daily-average projection"),
    R("上月全月 " + AMT, (_, a) => `last month ${a}`),
    R("已报销 " + AMT, (_, a) => `Credited ${a}`),
    R("已到账 " + AMT, (_, a) => `${a} posted`),
    R("还差 " + AMT, (_, a) => `${a} to go`),
    R("报销最多 " + AMT, (_, a) => `up to ${a} back`),
    R("(\\$?[\\d,.]+) 拿到高于基础的倍数", (_, a) => `${a} earned above base`),
    R("(\\d+)/(\\d+) 天有消费", (_, a, b) => `spent on ${a}/${b} days`),
    R("最高 (\\S+) " + AMT, (_, d, a) => `peak ${d} ${a}`),
    R("工作日 " + AMT + "，周末 " + AMT, (_, a, b) => `weekdays ${a}, weekends ${b}`),
    R("(\\d+) 条倍数已记住", (_, n) => `${plural(n, "multiplier")} remembered`),
    R("(\\d+) 个余额已更新", (_, n) => `${plural(n, "balance")} updated`),
    R("已保存：(.+)", (_, x) => `Saved: ${x.split("，").map(tr).join(", ")}`),
    R("(\\d+) 个连接需要处理，见「账户」", (_, n) => `${plural(n, "connection")} need attention — see Accounts`),
    R("断开 (.+)？本地存的该银行交易也会删除。", (_, x) => `Unlink ${x}? Its stored transactions will be deleted too.`),
    R("(.+) 刷新失败：(.*)", (_, x, e) => `${x} refresh failed: ${tr(e)}`),
    R("请求失败 \\((\\d+)\\)", (_, c) => `Request failed (${c})`),
    R("登录失败 \\((\\d+)\\)", (_, c) => `Sign-in failed (${c})`),
    R("日历打不开：(.*)", (_, e) => `Calendar failed to open: ${e}`),
    R("(\\d+) 张卡没认出卡型，暂按 1x 计算。银行给的账户名太笼统时需要手动选一下：", (_, n) => `${plural(n, "card")} couldn’t be identified and use 1x for now. Pick the product when the bank’s account name is too generic:`),
    R("点 ⚙ →「更新」录入", () => "enter via ⚙ → “Update”"),
    R("已记住 · 商户「(.+)」", (_, x) => `Remembered · merchant “${x}”`),
    R("商户「(.+)」", (_, x) => `merchant “${x}”`),
    R("图库里的其他卡面（(\\d+)）", (_, n) => `Other faces in library (${n})`),
    R("(\\d+)% 使用率", (_, n) => `${n}% utilization`),
    // 分析说明
    R("(.+)：本(天|日|周|月|季|年) " + AMT + "，比前 (\\d+) (天|周|月|季|年)平均(多|少)", (_, c, u, a, n, u2, d) =>
      `${tr(c)}: ${a} this ${UNIT[u]}, ${d === "多" ? "above" : "below"} the prior ${n}-${UNIT[u2]} avg by`),
    R("每(天|周|月|季|年)各大类花了多少，颜色越深越多", (_, u) => `Spend per category each ${UNIT[u]}; darker = more`),
    R("跟随「消费趋势」当前所在的层级", () => "follows the current level of “Spending trend”"),
    R("每个星期几的日均消费", () => "Average daily spend by weekday"),
    R("近 (\\d+) 周，颜色越深当天花得越多", (_, n) => `Last ${n} weeks; darker = more spent that day`),
    R("平均倍数 = 估算积分 ÷ 消费", () => "avg multiplier = est. points ÷ spend"),
    R("账单日 (.+)", (_, x) => `closing day ${tr(x)}`),
    R("每月 " + AMT + " 餐饮报销", (_, a) => `${a} monthly dining credit`),
    R("Brilliant 每月 " + AMT + " 餐饮报销", (_, a) => `Brilliant ${a} monthly dining credit`),
    R("每个自然月用这张卡在餐厅消费，报销最多 " + AMT, (_, a) => `use this card at restaurants each calendar month for up to ${a} back`),
    R("(\\d{4} Q\\d) 5% 轮换", (_, q) => `${q} 5% rotation`),
    R("(\\d+) 月", (_, mo) => m(mo)),
    R("查看 (.+) 的明细", (_, x) => `View details for ${x}`),
    R("查看 (.+) 的账户详情", (_, x) => `View account details for ${x}`),
    R("(.+) 卡面", (_, x) => `${x} card face`),
    R("(.+) · 可信度 (.+)", (_, x, c) => `${x} · confidence ${tr(c)}`),
    R("可信度 (.+)", (_, c) => `confidence ${tr(c)}`),
    R("((?:[^·]+) · )?(.+)（预计）", (_, a, x) => `${a ? tr(a.replace(/ · $/, "")) + " · " : ""}${tr(x)} (est.)`),
  ];

  // ---------------------------------------------------------------- 翻译一段文本
  const missing = new Set();
  function tr(s) {
    if (!EN || !s || !CJK.test(s)) return s;
    const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
    const core = s.trim();
    let r = one(core);
    if (r == null && core.includes(" · ")) r = core.split(" · ").map((p) => (CJK.test(p) ? one(p) ?? trFrag(p) : p)).join(" · ");
    if (r == null && /[，；]/.test(core)) r = core.split(/(，|；)/).map((p) => (p === "，" ? ", " : p === "；" ? "; " : CJK.test(p) ? one(p) ?? trFrag(p) : p)).join("");
    if (r == null) r = trFrag(core);
    if (CJK.test(r)) missing.add(core);
    return lead + r + trail;
  }
  function one(p) {
    if (p in DICT) return DICT[p];
    if (p.startsWith("· ")) { const r = one(p.slice(2)); return r == null ? null : "· " + r; }
    for (const [re, f] of RULES) if (re.test(p)) return p.replace(re, f);
    if (p in FRAG) return FRAG[p];
    // 「名称 ··****（官方名）」这类：括号里的照旧，外面翻
    return null;
  }

  // ---------------------------------------------------------------- 套用到 DOM
  const ATTRS = ["placeholder", "title", "aria-label", "data-label"];
  const setAttr = (el, a) => { const v = el.getAttribute(a); if (v && CJK.test(v)) { const t = tr(v); if (t !== v) el.setAttribute(a, t); } };
  const skip = (el) => el && el.closest && el.closest("[data-i18n-skip],script,style,code,pre");
  const TABS = { 交易: "Transactions" };
  function translateNode(n) {
    if (n.nodeType === 3) {
      if (!CJK.test(n.nodeValue) || skip(n.parentElement)) return;
      const k = n.nodeValue.trim();
      const v = k in TABS && n.parentElement?.closest("nav.tabs") ? TABS[k] : tr(n.nodeValue);
      if (v !== n.nodeValue) n.nodeValue = v;
      return;
    }
    if (n.nodeType !== 1 || skip(n)) return;
    for (const a of ATTRS) setAttr(n, a);
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let c;
    while ((c = w.nextNode())) {
      if (c.nodeType === 3) translateNode(c);
      else if (!skip(c)) for (const a of ATTRS) setAttr(c, a);
    }
  }

  function start() {
    document.documentElement.lang = EN ? "en" : "zh-CN";
    document.querySelectorAll("[data-lang]").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-lang]");
      if (!b || b.dataset.lang === lang) return;
      try { localStorage.setItem(KEY, b.dataset.lang); } catch { /* ignore */ }
      location.reload();
    });
    if (!EN) return;
    document.title = "Reward Tracker";
    translateNode(document.body);
    new MutationObserver((ms) => {
      for (const mu of ms) {
        if (mu.type === "characterData") translateNode(mu.target);
        else if (mu.type === "attributes") { if (!skip(mu.target)) setAttr(mu.target, mu.attributeName); }
        else mu.addedNodes.forEach(translateNode);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  if (EN) {
    const c = window.confirm.bind(window), a = window.alert.bind(window);
    window.confirm = (msg) => c(tr(String(msg)));
    window.alert = (msg) => a(tr(String(msg)));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();

  window.RT_I18N = { lang, t: tr, missing };
})();
