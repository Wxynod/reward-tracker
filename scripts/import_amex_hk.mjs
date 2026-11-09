#!/usr/bin/env node
// 把香港 Amex 的月结单 CSV 和账户问卷推到记账本 Worker（不走 Plaid）。
//
// 用法（在仓库根目录）：
//   node scripts/import_amex_hk.mjs --dry-run      只解析、核对、预览，不上传
//   node scripts/import_amex_hk.mjs                登录后上传（已导入过的交易自动跳过）
//   node scripts/import_amex_hk.mjs --overwrite    已导入过的交易也用 CSV 的内容覆盖
//
// 数据来源：
//   amex_hk_statements/<卡片文件夹>/yyyymmdd.csv   月结单（文件名 = 出结单日期）
//   amex_hk_statements/account_info.json           问卷：额度、还款日、最低还款、APR
// 登录：环境变量 RT_INGEST_TOKEN（Worker secret INGEST_TOKEN）优先；否则用 RT_USER / RT_PASS，没有就在终端里问。
// Worker 地址：--url <地址>，默认读 front/config.js 里的 workerUrl。
//
// 交易 id = "amexhk:" + 结单里的「參考」编号（Amex 的交易参考号，全局唯一），以后网页脚本实时读取的交易用同一个 id 去重。

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "amex_hk_statements");
const ITEM_ID = "manual:amex_hk";
const HKD_PER_USD = 7.8;

// 结单文件夹 → 账户
const CARDS = {
  the_platinum_card: { key: "platinum", subtype: "credit card" },
  explorer_credit_card: { key: "explorer", subtype: "credit card" },
};

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const DRY = flag("--dry-run");

// ---------------------------------------------------------------- CSV
// 字段里有带引号的换行（地址），不能按行切
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
// 地址字段里有多余的引号和连续逗号（"8 KWONG YIP STREET,, TOWER 5..."）
const cleanAddr = (s) => clean(String(s || "").replace(/"/g, "")).replace(/\s*,(\s*,)+/g, ",").replace(/^,|,$/g, "").trim();
const usDate = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  if (!m) throw new Error(`日期格式不认识：${s}`);
  return `${m[3]}-${m[1]}-${m[2]}`;
};
const fileDate = (f) => `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`;
const round2 = (n) => Math.round(n * 100) / 100;

// 「其他詳情」：外币消费（原币金额 / 币种 / 汇率）或优惠名称
function extra(s) {
  s = clean(s);
  if (!s) return {};
  const m = /Foreign Spend Amount:\s*([\d,.]+)\s+(.+?)\s+Commission Amount:\s*([\d,.]*)\s*Currency Exchange Rate:\s*([\d.]+)/i.exec(s);
  if (m) {
    return { foreign: { amount: Number(m[1].replace(/,/g, "")), currency: m[2], rate: Number(m[4]), commission: m[3] ? Number(m[3].replace(/,/g, "")) : null } };
  }
  return { offer: s };
}

// 还款 / 利息 / 罚息 → 和 Plaid 一样的大类，这样本站把它们归到「还款」「银行费用」，不算消费
function category(desc) {
  if (/^PAYMENT RECEIVED/i.test(desc)) return ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"];
  if (/FINANCE CHARGE/i.test(desc)) return ["BANK_FEES", "BANK_FEES_INTEREST_CHARGE"];
  if (/LATE PAYMENT CHARGE/i.test(desc)) return ["BANK_FEES", "BANK_FEES_LATE_FEES"];
  return [null, null];
}

// ---------------------------------------------------------------- 问卷
const Q_FIELDS = ["还款日_每月几号", "最新结单最低还款额_HKD", "消费年利率APR_百分比", "取现年利率APR_百分比"];
function readQuestionnaire() {
  const f = path.join(DIR, "account_info.json");
  if (!fs.existsSync(f)) throw new Error(`找不到问卷 ${f}`);
  const q = JSON.parse(fs.readFileSync(f, "utf8"));
  const v = (x) => {
    if (x === null || x === undefined || x === "") return null;
    if (typeof x === "string" && /^n\/?a$/i.test(x.trim())) return "N/A";
    // 接受 "HKD300"、"HK$1,200"、"35.96%"、"16" 这类写法
    const n = typeof x === "number" ? x : Number(String(x).replace(/HKD|HK\$|\$|%|,|\s/gi, ""));
    if (!Number.isFinite(n)) throw new Error(`问卷里的「${x}」不是数字，也不是 N/A`);
    return n;
  };
  const out = {};
  for (const folder of Object.keys(CARDS)) {
    const c = q[folder];
    if (!c) throw new Error(`问卷缺少 ${folder}`);
    if (!/^\d{4,5}$/.test(String(c["卡号末五位"] || ""))) throw new Error(`${folder} 的卡号末五位不对`);
    const due = v(c["还款日_每月几号"]);
    if (typeof due === "number" && (due < 1 || due > 31 || !Number.isInteger(due))) throw new Error(`${folder} 的还款日应为 1–31`);
    out[folder] = {
      name: clean(c["卡片名称"]) || folder,
      mask: String(c["卡号末五位"]),
      limit: v(c["信用额度_HKD"]),
      due_day: due,
      min_pay: v(c["最新结单最低还款额_HKD"]),
      apr_purchase: v(c["消费年利率APR_百分比"]),
      apr_cash: v(c["取现年利率APR_百分比"]),
      missing: Q_FIELDS.filter((k) => c[k] === null || c[k] === undefined || c[k] === ""),
    };
  }
  return out;
}

// 结单日之后第一个「还款日」（小月取月底）
function dueAfter(stmt, day) {
  let y = +stmt.slice(0, 4), m = +stmt.slice(5, 7);
  for (let i = 0; i < 3; i++) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
    if (d > stmt) return d;
    m++; if (m > 12) { m = 1; y++; }
  }
  return null;
}

// ---------------------------------------------------------------- 组装
function build() {
  const q = readQuestionnaire();
  const accounts = [], liabilities = {}, transactions = [], report = [];
  for (const [folder, card] of Object.entries(CARDS)) {
    const info = q[folder];
    const acctId = `amexhk_${card.key}_${info.mask}`;
    const files = fs.readdirSync(path.join(DIR, folder)).filter((f) => /^\d{8}\.csv$/.test(f)).sort();
    if (!files.length) throw new Error(`${folder} 里没有 yyyymmdd.csv`);

    let cum = 0;
    const statements = [];
    const seen = new Set();
    let lastPay = null;
    for (const f of files) {
      const stmtDate = fileDate(f);
      const rows = parseCSV(fs.readFileSync(path.join(DIR, folder, f), "utf8"));
      let sum = 0;
      for (const r of rows) {
        const ref = (r["參考"] || "").replace(/'/g, "").trim();
        if (!ref) throw new Error(`${folder}/${f} 有一行没有參考编号：${r["描述"]}`);
        const id = `amexhk:${ref}`;
        if (seen.has(id)) continue; // 同一笔不会出现在两期结单里；万一出现只算一次
        seen.add(id);
        const amount = Number(String(r["金額"]).replace(/,/g, ""));
        if (!Number.isFinite(amount)) throw new Error(`${folder}/${f} 金额不认识：${r["金額"]}`);
        sum += amount;
        const desc = clean(r["描述"]);
        const date = usDate(r["日期"]);
        const [cat, catDetail] = category(desc);
        if (cat === "LOAN_PAYMENTS" && amount < 0 && (!lastPay || date >= lastPay.date)) lastPay = { date, amount: -amount };
        transactions.push({
          id,
          account_id: acctId,
          date,
          name: desc,
          merchant: null,
          amount,
          currency: "HKD",
          category: cat,
          category_detail: catDetail,
          pending: false,
          source: "amex_hk_statement",
          detail: {
            original_description: clean(r["在您的月結單上顯示為"]) || desc,
            location: (r["地址"] || r["城市"] || r["國家"]) ? {
              address: cleanAddr(r["地址"]) || null, city: cleanAddr(r["城市"]) || null,
              postal_code: clean(r["地區編碼"]) || null, country: clean(r["國家"]) || null,
            } : undefined,
            ...extra(r["其他詳情"]),
            amex_category: clean(r["類別"]) || undefined,
            reference: ref,
            statement_date: stmtDate,
          },
        });
      }
      cum = round2(cum + sum);
      statements.push({ date: stmtDate, rows: rows.length, net: round2(sum), balance: cum });
    }

    const last = statements[statements.length - 1];
    const statementDay = +last.date.slice(8, 10);
    accounts.push({
      id: acctId,
      name: info.name,
      official_name: `American Express ${info.name} (Hong Kong)`,
      mask: info.mask,
      type: "credit",
      subtype: card.subtype,
      limit: typeof info.limit === "number" ? info.limit : null,
      currency: "HKD",
      balance_from_txns: true, // 当前欠款 = 已导入交易累计（开卡时为 0）
    });
    liabilities[acctId] = {
      last_statement_balance: last.balance,
      last_statement_issue_date: last.date,
      minimum_payment_amount: info.min_pay,
      next_payment_due_date: info.due_day === "N/A" ? "N/A" : typeof info.due_day === "number" ? dueAfter(last.date, info.due_day) : null,
      last_payment_amount: lastPay?.amount ?? null,
      last_payment_date: lastPay?.date ?? null,
      is_overdue: null,
      aprs: [info.apr_purchase, info.apr_cash].every((x) => x === "N/A") ? "N/A" : [
        { type: "purchase_apr", pct: info.apr_purchase },
        { type: "cash_apr", pct: info.apr_cash },
      ].filter((x) => x.pct !== null),
      statement_day: statementDay,
      due_day: info.due_day,
      source: "amex_hk_statement",
    };
    report.push({ folder, acctId, info, statements, lastPay });
  }
  return { accounts, liabilities, transactions, report };
}

// ---------------------------------------------------------------- 上传
function workerUrl() {
  const u = opt("--url");
  if (u) return u.replace(/\/+$/, "");
  const cfg = fs.readFileSync(path.join(ROOT, "front", "config.js"), "utf8");
  const m = /workerUrl:\s*["']([^"']+)["']/.exec(cfg);
  if (!m) throw new Error("front/config.js 里没有 workerUrl，请用 --url 指定");
  return m[1].replace(/\/+$/, "");
}

function ask(question, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(question); };
  return new Promise((res) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); res(a); }));
}

async function token(url) {
  if (process.env.RT_INGEST_TOKEN) return process.env.RT_INGEST_TOKEN;
  const username = process.env.RT_USER || (await ask("记账本账号："));
  const password = process.env.RT_PASS || (await ask("记账本密码：", true));
  const res = await fetch(`${url}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`登录失败：${d.error || res.status}`);
  return d.token;
}

// ---------------------------------------------------------------- main
const hk = (n) => `HK$${n.toLocaleString("en-HK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd = (n) => `$${(n / HKD_PER_USD).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const { accounts, liabilities, transactions, report } = build();
for (const r of report) {
  const L = liabilities[r.acctId];
  const s = r.statements;
  console.log(`\n■ ${r.info.name} ··${r.info.mask}  (${r.acctId})`);
  console.log(`  结单 ${s.length} 期：${s[0].date} → ${s[s.length - 1].date}，交易 ${transactions.filter((t) => t.account_id === r.acctId).length} 笔`);
  console.log(`  最新结单余额 ${hk(L.last_statement_balance)}（≈ ${usd(L.last_statement_balance)}），${L.last_statement_issue_date} 出账，每月 ${L.statement_day} 号`);
  console.log(`  上次还款 ${r.lastPay ? `${hk(r.lastPay.amount)} @ ${r.lastPay.date}` : "—"}`);
  console.log(`  额度 ${r.info.limit == null ? "—" : r.info.limit === "N/A" ? "没有" : hk(r.info.limit)}；下次还款日 ${L.next_payment_due_date ?? "—（问卷未填）"}`);
  if (r.info.missing.length) console.log(`  ⚠ 问卷未填：${r.info.missing.join("、")}（会显示为「—」）`);
}
console.log(`\n共 ${transactions.length} 笔交易，${accounts.length} 个账户。`);

if (DRY) {
  const out = path.join(DIR, "_preview.json");
  fs.writeFileSync(out, JSON.stringify({ accounts, liabilities, sample: transactions.slice(0, 5) }, null, 2));
  console.log(`--dry-run：没有上传。预览写在 ${path.relative(ROOT, out)}`);
  process.exit(0);
}

const url = workerUrl();
const bearer = await token(url);
const res = await fetch(`${url}/api/manual/import`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
  body: JSON.stringify({
    item_id: ITEM_ID,
    item: { institution: "American Express HK", region: "HK", notice: "月结单 CSV 导入，不经 Plaid" },
    accounts, liabilities, transactions,
    overwrite: flag("--overwrite"),
  }),
});
const d = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`上传失败：${d.error || res.status}`); process.exit(1); }
console.log(`\n已上传到 ${url}：新增 ${d.added}，跳过（已导入）${d.skipped}，覆盖 ${d.updated}，现有 ${d.total} 笔。`);
if (d.rejected?.length) console.log(`⚠ ${d.rejected.length} 笔被拒：`, d.rejected.slice(0, 10));
