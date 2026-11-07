# Reward Tracker 记账本

```
front/   静态前端 → GitHub Pages（Noto Serif SC）
back/    Cloudflare Worker → 代理 Plaid、存数据到 KV
```

Plaid secret 只存在 Worker 里（`wrangler secret`），前端和 GitHub 仓库里都没有。
`Credentials.txt` 已写进 `.gitignore`，**不要提交**。

前端有登录页：账号密码由 Worker 校验（存成 Cloudflare secret），登录后发 14 天有效的签名令牌；同一 IP 连续输错 5 次锁 15 分钟。没登录读不到任何数据。

## 一、部署后端（Cloudflare Worker）

在 `back/` 目录下运行：

```bash
npm install
npx wrangler login

# 1. 建 KV，把输出里的 id 填进 wrangler.toml 的 REPLACE_WITH_KV_NAMESPACE_ID
npx wrangler kv namespace create DB

# 2. 设置机密（会提示你粘贴值）
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET     # 先用 Sandbox secret
npx wrangler secret put APP_USERNAME     # 登录账号（Credentials.txt 里的）
npx wrangler secret put APP_PASSWORD     # 登录密码（Credentials.txt 里的）
npx wrangler secret put SESSION_SECRET   # 一串长随机字符串，用来签登录令牌

# 3. 部署（ALLOWED_ORIGINS 已设为 https://wxynod.github.io）
npx wrangler deploy
```

部署成功后会得到一个类似 `https://reward-tracker.<你的子域>.workers.dev` 的地址。

生成 SESSION_SECRET 可以用：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

## 二、部署前端（GitHub Pages）

仓库：https://github.com/Wxynod/reward-tracker　页面：https://wxynod.github.io/reward-tracker/

1. 仓库 Settings → Pages → Source 选 **GitHub Actions**（只需设置一次）
2. 把 `front/config.js` 里的 `workerUrl` 改成上一步得到的 Worker 地址，push
3. 之后每次 push 改动 `front/`，`.github/workflows/pages.yml` 会自动重新发布

本地预览：`cd front && python -m http.server 8000`，然后打开 http://localhost:8000

## 三、从 Sandbox 切到真实卡片

1. Sandbox 下连接银行，用户名 `user_good`、密码 `pass_good`，先确认流程正常
2. `wrangler.toml` 里把 `PLAID_ENV` 改成 `production`，`wrangler secret put PLAID_SECRET` 换成 Production secret，再 `wrangler deploy`
3. 重新连接银行（Sandbox 的连接在 Production 下无效，可以先在「账户」里断开）
4. 走 OAuth 的银行（Chase、Capital One 等）：在 Plaid Dashboard 的 Allowed redirect URIs 里加上 `https://wxynod.github.io/reward-tracker/`，并填到 `PLAID_REDIRECT_URI`

## 四、Apple Card（iOS 快捷指令推送）

Apple Card 由 Goldman Sachs 发卡，Plaid 连不上；Apple 的 FinanceKit 只批给 App Store 上架的公司级 App。
所以改用 iOS 快捷指令：每次用 Apple Pay 付款，手机自动把商户、金额、时间 POST 给 Worker。
只能拿到这三项，**没有 MCC、余额，也抓不到实体卡 / 卡号消费**。积分按 Apple Card 的 Apple Pay 2%（Apple 3% 商户按商户名识别）估算。

**1. Worker 加一个密钥并重新部署**（在 `back/` 下）

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # 生成一串，记下来
npx wrangler secret put APPLE_INGEST_TOKEN   # 粘贴上面那串
npx wrangler deploy
```

先用 curl 试一下（应返回 `{"ok":true,...}`，网页上会出现 Apple Card 账户和这笔测试交易，看到后在交易明细里点「删除这笔交易」）：

```bash
curl -X POST https://reward-tracker.tom-rt.workers.dev/api/ingest/apple-card \
  -H "Authorization: Bearer <APPLE_INGEST_TOKEN>" -H "Content-Type: application/json" \
  -d '{"merchant":"Test","amount":"$1.23","date":"2026-11-08T10:00:00+08:00"}'
```

**2. iPhone 上建自动化**（快捷指令 App；不同 iOS 版本的按钮名称可能略有出入）

1. 「自动化」→ 右上角「+」→ 选「钱包 / Wallet」
2. 卡片勾选 **Apple Card**，类别全选 →「立即运行」（关掉「运行前询问」）→ 下一步 →「新建空白快捷指令」
3. 添加操作 **「获取 URL 内容」**：
   - URL：`https://reward-tracker.tom-rt.workers.dev/api/ingest/apple-card`
   - 展开 → 方法 **POST**
   - 头部：`Authorization` = `Bearer <APPLE_INGEST_TOKEN>`（Bearer 后面有一个空格）
   - 请求体选 **JSON**，加 4 个文本字段：

     | 键 | 值（点变量选择） |
     |---|---|
     | `merchant` | 快捷指令输入 → **商户** |
     | `amount` | 快捷指令输入 → **金额** |
     | `card` | 快捷指令输入 → **名称**（卡名，可不加） |
     | `date` | **当前日期** → 点它把日期格式改成 **ISO 8601**，并打开「包括时间」 |

   `date` 一定要传：不传的话 Worker 按 UTC 记日期，北京时间早上 8 点前的消费会被记到前一天。
4. （调试用，可选）再加一个「显示通知」，内容选上一步的「URL 的内容」，确认能看到 `"ok":true` 后删掉

**说明**
- 同一分钟、同金额、同商户的重复推送会自动合并
- 退款、还款、实体卡消费不会推送；推错的交易在网页交易明细底部「删除这笔交易」
- 账户页 Apple Card 的「清空」会删掉所有推送记录（不影响以后继续推送）
- 密钥泄露了就 `wrangler secret put APPLE_INGEST_TOKEN` 换一个，再更新快捷指令

## API

除 `/api/login` 外都需要带 `Authorization: Bearer <登录令牌>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/login | `{username, password}` → `{token, exp}` |
| POST | /api/link-token | 创建 Link token；带 `item_id` 时用于重新登录 |
| POST | /api/exchange | 用 public_token 换 access_token 并存储 |
| POST | /api/sync | 用 /transactions/sync 增量同步所有连接 |
| GET | /api/data | 返回连接、账户、交易、权益任务 |
| PUT | /api/benefits | 保存权益任务列表 |
| POST | /api/items/remove | 断开一个银行连接 |
| POST | /api/resync | 清空 cursor，重新拉取全部交易（补齐 MCC 等新字段） |
| PUT | /api/rewards | 保存积分设置：卡片对应、记住的倍数、各计划余额 |
| GET | /api/logos | 各银行 logo（Plaid 机构信息，KV 缓存 30 天） |
| POST | /api/ingest/apple-card | **iOS 快捷指令用**，带 `Authorization: Bearer <APPLE_INGEST_TOKEN>`（不是登录令牌） |
| POST | /api/manual/delete | `{id}` 删除一笔快捷指令推送的交易 |

## 积分估算

- 卡片目录和倍数在 `front/rewards.js`（`PRODUCTS`），按 MCC 分类，没有 MCC 时用 Plaid 的 personal_finance_category
- 支持 cap（如 Amex Gold 餐饮 $50k/年）、季度轮换（Freedom Flex，新季度在 `quarters` 里加一行）、Custom Cash 月度最高类别
- 页面右上角设置 →「更新」进入编辑：逐笔改倍数（按 MCC 或商户名记住）、录入各计划余额，再点保存
- 积分为估算值，以银行账单为准

## 权益任务的计算方式

- 按 卡片 + 日期区间 + 商户关键词（可选）筛选交易
- 「消费金额」按净额计算，退款会抵扣；「消费笔数」只统计支出笔数
- Plaid 的金额正数表示支出，负数表示退款或还款
