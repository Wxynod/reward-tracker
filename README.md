# 记账本 · Reward Tracker

A private, single-user bookkeeping and credit-card rewards dashboard. It pulls transactions, balances and statements from US banks through **Plaid**, estimates the points every purchase earns on each card, and turns it all into a billing calendar, benefit trackers and spending analytics. The interface is available in **English and Chinese**.

- **Frontend**: static vanilla JS on GitHub Pages: <https://wxynod.github.io/reward-tracker/>
- **Backend**: a Cloudflare Worker with Workers KV that proxies Plaid and stores the data
- **No framework, no build step, no database server**: the charts are hand-drawn SVG and the whole UI is one page

> The screenshots are taken from my own live account. Account numbers, Plaid IDs, Zelle counterparties and reference numbers are masked as `****`. Card images are replaced by the app's built-in generated card faces, because the real card art stays out of this public repo.

![Points overview](docs/screenshots/01-points-overview.png)

**Contents:** [Points](#points) · [Transactions](#transactions) · [Accounts](#accounts) · [Billing calendar](#billing-calendar) · [Benefits](#benefits) · [Analytics](#analytics) · [Language](#language) · [Mobile](#mobile) · [Points engine](#how-points-are-estimated) · [Architecture](#architecture) · [Setup](#setup)

---

## What it does

### Points

- **One card per loyalty program**: Chase Ultimate Rewards, Citi ThankYou, Amex Membership Rewards, Marriott Bonvoy, Barclays cash back and Apple Daily Cash. Programs with no linked card are hidden.
- **Balance + Pending.** You record the balance shown by the bank. Points earned since the last statement closing date show as *Pending* and roll into the balance automatically once the closing date passes.
- **Points ledger.** Each program's points for today, this week, month, quarter and year.

The **points trend** chart drills down from all time → year → quarter → month → day. Double-click a bar to go down, use the breadcrumb to come back up, or jump to any period with *Pick period*.

![Points trend](docs/screenshots/02-points-trend.png)

**This month by card** shows each card's points, spend, average multiplier and the categories that earned them.

![This month by card](docs/screenshots/03-points-by-card.png)

### Transactions

- Monthly list grouped by day, with card, month and text filters, plus a clickable category bar.
- Each row shows the merchant logo (Brandfetch, with category icons as fallback), **Pending** and **payment-channel** (in store / online) tags, and the estimated points with the multiplier used.
- **Benefit credits** (e.g. the Brilliant $25 dining credit) and **annual fees** are recognised and earn no points.

![Transactions](docs/screenshots/04-transactions.png)

Tap a row to open the **transaction detail sheet**. It shows authorised vs posted time, MCC, the app category and Plaid's category with its confidence, the original bank description, the merchant website and counterparties. At the bottom it explains the points: which rule matched, the multiplier, and the key used to remember manual changes.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/05-transaction-detail-1.png" alt="Transaction detail, top"></td>
<td width="50%"><img src="docs/screenshots/05-transaction-detail-2.png" alt="Transaction detail, points section"></td>
</tr>
<tr>
<td align="center"><sub>Status, merchant and category</sub></td>
<td align="center"><sub>Counterparties and how the points were calculated</sub></td>
</tr>
</table>

### Accounts

- Every linked bank and account, with a card face, balance, credit limit and a utilisation bar.
- A chip on each card shows the next **payment due date**: date, days left and minimum payment.
- Card faces come from a built-in style library. Private card images can also be loaded from KV, or uploaded as a photo, which is rotated, cropped and compressed in the browser.

![Accounts](docs/screenshots/06-accounts.png)

The **account detail sheet** combines Plaid **Liabilities** data with the app's own calculations:

<table>
<tr>
<td width="50%"><img src="docs/screenshots/07-account-detail-1.png" alt="Account detail, balances and statement"></td>
<td width="50%"><img src="docs/screenshots/07-account-detail-2.png" alt="Account detail, billing cycle and earn rules"></td>
</tr>
<tr>
<td align="center"><sub>Balances, last statement, minimum payment, due date and APRs</sub></td>
<td align="center"><sub>Billing-cycle progress, closing day, earn rules and annual fee</sub></td>
</tr>
</table>

### Billing calendar

- Shows statement **closing days**, **payment due dates** and **annual-fee dates** for every card, each marked with a small card face.
- Annual fees are found by searching past transactions for "annual / membership fee"; the next one is projected a year later. Future due dates are estimated from the closing day.
- Hovering an agenda item highlights its day, and hovering a day highlights its events. From an event you can open the account sheet on top of the calendar; closing it returns to the calendar.

![Billing calendar](docs/screenshots/08-billing-calendar.png)

### Benefits

- The **Bonvoy Brilliant monthly $25 dining credit** is tracked automatically, with the matching purchases listed.
- So is the **Freedom Flex quarterly 5% rotation**, with progress towards the $1,500 cap and the activation deadline.
- You can add custom tasks: a card, a date range, optional merchant keywords, and a spend amount or purchase-count target.

![Benefits](docs/screenshots/09-benefits.png)

### Analytics

- **KPIs**: month to date, month-end projection, 30-day daily average and average ticket.
- **Spending trend** by card or by category, with the same drill-down as the points chart.
- **Category × time** heat-matrix, with automatic notes on unusual changes.

![Analytics: KPIs, trend and category matrix](docs/screenshots/10-analytics-1.png)

- **By card / by category**: spend share, points and average multiplier. **Single card**: 12-month trend, multiplier mix, category mix, top merchants and how much spend earned a bonus.
- **Weekday pattern**, **top merchants**, a GitHub-style **spending calendar** and the **largest purchases**.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/10-analytics-2.png" alt="Analytics: by card, by category, single card"></td>
<td width="50%"><img src="docs/screenshots/10-analytics-3.png" alt="Analytics: weekday, merchants, calendar, largest"></td>
</tr>
</table>

### Language

The language switch sits at the top of the settings panel (⚙). The choice is saved in the browser, and every page, sheet, chart label, tooltip and message follows it.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/11-language-en.png" alt="Settings in English"></td>
<td width="50%"><img src="docs/screenshots/11-language-zh.png" alt="Settings in Chinese"></td>
</tr>
<tr>
<td align="center"><sub>English</sub></td>
<td align="center"><sub>中文</sub></td>
</tr>
</table>

### Mobile

On small screens the layout becomes a phone layout: sheets open as bottom sheets, the calendar goes full screen, and tables collapse into labelled rows. The app can be saved to the home screen through its web-app manifest and icons.

![Mobile](docs/screenshots/12-mobile.png)

---

## How points are estimated

The rewards engine is `front/rewards.js`.

1. Each account is mapped to a **card product**. Mapping is automatic from the account name, or you choose it in Settings. Generic names such as "CREDIT CARD" get a picker.
2. Each transaction is classified by **MCC**. When Plaid has no MCC, the app uses Plaid's `personal_finance_category`, and then any merchant rules you have taught it.
3. The product's rules give the multiplier. Supported rule types:
   - bonus categories with a fallback base rate
   - **caps**, e.g. Freedom Flex 5% up to $1,500 per quarter, then 1x
   - **date-bounded rules** with `from`/`to`, which is how quarterly rotations are added
   - **stacked rates** ("7x = 1 base + 4 + 2 everyday dining")
   - "top category of the month" logic for Custom Cash
4. Refunds give points back. Payments, transfers, benefit credits and annual fees earn **0**.
5. In edit mode (gear → *Update*) you can override the multiplier on any transaction. The override is remembered per MCC or per merchant.

**Built-in products**

| Issuer | Cards |
|---|---|
| Chase | Sapphire Reserve, Sapphire Preferred, Freedom Unlimited, Freedom Flex |
| Citi | Strata Elite, Strata Premier, Strata, Double Cash, Custom Cash |
| American Express | Platinum, Gold, Green, Blue Business Plus, Blue Cash Everyday/Preferred, EveryDay, Marriott Bonvoy Brilliant |
| Barclays | Samsung Galaxy Card, View, AARP Travel/Essential |
| Apple | Apple Card |

Each issuer also has an "other" product. Points are **estimates**; the bank statement is always the source of truth.

---

## Architecture

```
 Browser (GitHub Pages)                 Cloudflare Worker                     Plaid
┌──────────────────────┐   HTTPS +    ┌──────────────────────────┐   API    ┌──────────────┐
│ index.html + *.js    │ ───────────▶ │ /api/*  (CORS-locked)    │ ───────▶ │ Transactions │
│ vanilla JS, SVG      │  Bearer      │ HMAC session tokens      │          │ Liabilities  │
│ Plaid Link (iframe)  │  token       │ Plaid secret lives here  │          │ Institutions │
└──────────────────────┘              └────────────┬─────────────┘          └──────────────┘
                                                   │
                                            Workers KV (DB)
                               items, access tokens, transactions,
                         sync cursors, liabilities, rewards settings,
                             benefits, card-face library, logos
```

### Plaid usage
| Endpoint | Purpose |
|---|---|
| `/link/token/create` | New links request `transactions` with `optional_products: ["liabilities"]`. Update mode with `additional_consented_products` adds Liabilities to existing links without using up a new connection. |
| `/item/public_token/exchange` | Stores the access token in KV (server side only). |
| `/transactions/sync` | Incremental sync with stored cursors and `include_original_description`. A full re-sync is non-destructive: previous accounts are kept if Plaid temporarily returns none. |
| `/transactions/refresh` | "Refresh from bank now" button. |
| `/accounts/get`, `/liabilities/get` | Balances, limits, statement balance, minimum payment, due date and APRs. These also feed auto-detection of the closing day. |
| `/institutions/get_by_id` | Bank logos and brand colours, cached in KV. |

Each transaction is slimmed before storage. It keeps the amount, dates, merchant, MCC, PFC category, payment channel, pending flag and website, plus a compact `detail` object used by the detail sheet.

### Worker API

Every route except `/api/login` requires `Authorization: Bearer <session token>`.

| Method | Path | Description |
|---|---|---|
| POST | `/api/login` | `{username, password}` → `{token, exp}` |
| POST | `/api/link-token` | Creates a Link token. With `item_id` it opens update mode; `add_liabilities` requests Liabilities consent. |
| POST | `/api/exchange` | Exchanges `public_token` and stores the item |
| POST | `/api/sync` | Incremental `/transactions/sync` for all items, plus balances and liabilities |
| POST | `/api/refresh` | Asks Plaid to refresh from the bank |
| POST | `/api/resync` | Resets cursors and re-pulls full history (non-destructive) |
| GET | `/api/data` | Items, accounts (with liabilities), transactions, benefits, rewards settings |
| POST | `/api/items/remove` | Disconnects a bank and deletes its data |
| PUT | `/api/rewards` | Card mapping, learned rules, balances, closing days, card faces |
| PUT | `/api/benefits` | Benefit and task list |
| GET | `/api/logos` | Institution logos (KV cache) |
| GET | `/api/cardlib` | Private card-art library (KV only, never in the repo) |
| GET / PUT | `/api/cardimgs`, `/api/cardimg` | User-uploaded card photos |

### Frontend files (`front/`)
| File | Role |
|---|---|
| `index.html`, `style.css` | Shell, tabs, sheets; warm "paper" theme in Noto Serif SC; responsive below 560 px |
| `i18n.js` | English / Chinese switch. The UI is written in Chinese; in English mode a `MutationObserver` translates text nodes and `placeholder` / `title` / `aria-label` before paint, using exact phrases, regex rules (dates, amounts, counts) and phrase fragments. Untranslated strings are collected in `RT_I18N.missing`. |
| `config.js` | Worker URL and Brandfetch client ID (public by design) |
| `app.js` | State, API client, login, Plaid Link, Points / Transactions / Accounts tabs, edit mode |
| `rewards.js` | Programs, card products, earn rules, points engine |
| `icons.js` | 35+ category icons and MCC/PFC → category mapping |
| `brands.js` | Merchant → domain mapping and Brandfetch logo/search |
| `cards.js` | Card-face styles, art library, face chooser, photo processing, custom card selects |
| `drill.js` | Reusable drill-down bar chart with breadcrumbs and period picker |
| `analytics.js` | Analytics tab |
| `detail.js` | Transaction detail sheet |
| `acct.js` | Account detail sheet |
| `calendar.js` | Billing calendar |

All script and style tags carry a `?v=YYYYMMDDx` query for cache busting (currently `20261109b`). Bump it on every frontend change.

---

## Setup

### 1. Backend (Cloudflare Worker)

```bash
cd back
npm install
npx wrangler login

# KV namespace → put the returned id into wrangler.toml ([[kv_namespaces]] id)
npx wrangler kv namespace create DB

# Secrets (prompted, never committed)
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put APP_USERNAME
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_SECRET   # node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

npx wrangler deploy
```

`wrangler.toml` vars:

| Var | Meaning |
|---|---|
| `PLAID_ENV` | `sandbox` (test with `user_good` / `pass_good`) or `production` |
| `ALLOWED_ORIGINS` | Comma-separated frontend origins allowed by CORS |
| `PLAID_REDIRECT_URI` | Needed for OAuth banks (Chase etc.). Must match **Allowed redirect URIs** in the Plaid Dashboard. |

Switching from Sandbox to Production needs the production secret. Banks must also be re-linked, because access tokens are environment-specific.

**Optional private card art.** Card images are kept locally (`cards/`, `cardlib_build/`, which are git-ignored) and uploaded straight to KV:

```bash
npx wrangler kv bulk put cardlib.json --binding DB --remote
```

### 2. Frontend (GitHub Pages)

1. Repo **Settings → Pages → Source: GitHub Actions**. This is a one-time step.
2. Set `workerUrl` in `front/config.js`.
3. Push. `.github/workflows/pages.yml` publishes `front/` on every change.

Local preview: `cd front && python -m http.server 8000`, then open <http://localhost:8000>. `localhost:8000` is already in `ALLOWED_ORIGINS`.

---

## Security notes

- The Plaid secret and access tokens exist **only in the Worker and KV**. They are never in the browser or the repo.
- Login is checked against Worker secrets with a constant-time comparison. A successful login returns a **14-day HMAC-signed session token**. Rotating `SESSION_SECRET` signs out every device.
- **5 failed logins from one IP lock that IP out for 15 minutes.**
- CORS only allows the configured origins. Every data route requires a valid session.
- `.gitignore` excludes `Credentials*`, `back/.dev.vars`, `.wrangler/`, and the private card art and its KV import file.

## Notes

- Plaid amounts are positive for spending and negative for refunds and payments. Benefit-progress amounts are net of refunds.
- Points and benefit progress are estimates for personal tracking only.
