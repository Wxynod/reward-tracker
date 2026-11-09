#!/usr/bin/env python3
"""把汇丰香港信用卡的月结单（PDF）推到记账本 Worker（不走 Plaid）。

用法（在仓库根目录）：
  python scripts/import_hsbc_hk.py --dry-run     只解析、核对、预览，不上传
  python scripts/import_hsbc_hk.py               登录后上传交易、账户、账单信息，并写入卡面
  python scripts/import_hsbc_hk.py --no-faces    不写卡面（只用 RT_INGEST_TOKEN 时自动跳过）
  python scripts/import_hsbc_hk.py --overwrite   已导入过的交易也用结单内容覆盖

数据来源（都在 hsbc_hk_statements/，整个文件夹已被 .gitignore 忽略）：
  <卡片文件夹>/yyyy-mm-dd_Statement.pdf   月结单；缺的月份 = 没有交易、没有结余
  merchant_categories.csv                 商户 → 类别对照表（可以在 Excel 里改「类别」列）
  _parsed_cache.json                      PDF 解析缓存：按文件内容的 SHA-1 缓存，已解析的结单不再需要 pdftotext
  _cardfaces.json                         卡面图片（已裁成 856×540 的 JPEG data URL）

新结单需要 pdftotext（Poppler 自带）。没有的话脚本会提示，已缓存的结单不受影响。
登录：环境变量 RT_INGEST_TOKEN 优先（只能写交易，不能写卡面）；否则用 RT_USER / RT_PASS，没有就在终端里问。
Worker 地址：--url <地址>，默认读 front/config.js 里的 workerUrl。

核对：每份结单、每个币种都检查「上期结余 + 本期交易 = 本期结余」，前后两期结余也要衔接；不通过就停下，不上传。
交易 id：hsbc:<账户>:<结单日>:<序号>（结单没有参考号；同一份结单解析结果固定，重复导入会被 Worker 跳过）。
"""
import argparse, csv, getpass, glob, hashlib, json, os, re, shutil, subprocess, sys, urllib.request, urllib.error

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DIR = os.path.join(ROOT, "hsbc_hk_statements")
ITEM_ID = "manual:hsbc_hk"
CACHE = os.path.join(DIR, "_parsed_cache.json")
FACES = os.path.join(DIR, "_cardfaces.json")
PARSER_VERSION = 2

# 文件夹 → 账户。Pulse 是双币卡：港币、人民币两个子账户分开出账、分开还款，所以拆成两个账户
CARDS = {
    "everymile": {"HKD": ("hsbc_everymile", "HSBC EveryMile")},
    "gold":      {"HKD": ("hsbc_gold", "HSBC Gold")},
    "pulse":     {"HKD": ("hsbc_pulse_hkd", "HSBC Pulse · HKD"), "CNY": ("hsbc_pulse_cny", "HSBC Pulse · RMB")},
    "red":       {"HKD": ("hsbc_red", "HSBC Red")},
    "signature": {"HKD": ("hsbc_signature", "HSBC Visa Signature")},
    "easy":      {"HKD": ("hsbc_easy", "HSBC Easy")},
}
FACE_OF = {"hsbc_everymile": "hsbc_everymile", "hsbc_gold": "hsbc_gold", "hsbc_pulse_hkd": "hsbc_pulse", "hsbc_pulse_cny": "hsbc_pulse",
           "hsbc_red": "hsbc_red", "hsbc_signature": "hsbc_visa_signature", "hsbc_easy": "hsbc_easy"}

# 汇丰类别 → 记账本用的 Plaid 风格类别（前端靠它显示图标、做分析）。原类别另存在 detail.hsbc_category
CAT_MAP = {
    "Dining": ("FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"),
    "Eating out": ("FOOD_AND_DRINK", "FOOD_AND_DRINK_FAST_FOOD"),
    "Transport and automotive": ("TRANSPORTATION", "TRANSPORTATION_PUBLIC_TRANSIT"),
    "Travel": ("TRAVEL", "TRAVEL_OTHER_TRAVEL"),
    "Shopping": ("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES"),
    "Retail": ("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_DEPARTMENT_STORES"),
    "Groceries": ("FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"),
    "Supermarket": ("FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES"),
    "Entertainment and leisure": ("ENTERTAINMENT", "ENTERTAINMENT_OTHER_ENTERTAINMENT"),
    "Bills and Utilities": ("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_OTHER_UTILITIES"),
    "Others": (None, None),
    "Unclassified": (None, None),
    "还款": ("LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"),
    "银行费用": ("BANK_FEES", "BANK_FEES_OTHER_BANK_FEES"),
    "返现 / 抵扣 / 调整": ("INCOME", "INCOME_OTHER_INCOME"),
}
# 规则类（不看对照表）
RULES = [
    (re.compile(r"PAYMENT - THANK YOU|PAID BY AUTOPAY", re.I), "还款"),
    (re.compile(r"STATEMENT OFFSET", re.I), "返现 / 抵扣 / 调整"),
    (re.compile(r"ANNUAL FEE|FINANCE CHARGE|LATE CHARGE|LATE PAYMENT|INTEREST", re.I), "银行费用"),
]

# ---------------------------------------------------------------- PDF 解析（依赖 pdftotext -layout 的版面）
MON = {m: i + 1 for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split())}
AMT = r"([\d,]+\.\d{2})(CR)?"
TX = re.compile(r"^\s*(\d{2})([A-Z]{3})\s+(\d{2})([A-Z]{3})\s+(.*?)\s+" + AMT + r"\s*$")
HOLDER = re.compile(r"^\s+(\d{4} \d{4} \d{4} \d{4})\s+([A-Z][A-Z .'-]+?)\s*$")
CURHDR = re.compile(r"Amount\s+\((HKD|CNY|USD)\)")
BAL = re.compile(r"^\s+(PREVIOUS BALANCE|STATEMENT BALANCE)\s+" + AMT + r"\s*$")
DATE_TXT = re.compile(r"(\d{1,2}) ([A-Z]{3}) (\d{4})")


def num(s, cr=None):
    v = float(s.replace(",", ""))
    return -v if cr else v


def pdftotext(path):
    exe = shutil.which("pdftotext")
    if not exe:
        sys.exit(f"需要 pdftotext 才能解析新结单：{os.path.relpath(path, ROOT)}\n"
                 "请安装 Poppler（含 pdftotext）并加入 PATH，或者把新结单交给 Claude 解析后更新缓存。")
    return subprocess.run([exe, "-layout", path, "-"], capture_output=True, text=True, encoding="utf-8").stdout


def min_due_blocks(lines):
    """每个币种的「Minimum payment summary」：最低还款、还款日。"""
    out = {}
    for i, ln in enumerate(lines):
        m = re.search(r"Minimum payment summary\s+(HKD|CNY)\s*$", ln)
        if not m:
            continue
        cur, amt, due = m.group(1), None, None
        win = lines[i + 1:i + 10]
        for j, w in enumerate(win):
            if "Current minimum payment due" in w:
                a = re.search(r"([\d,]+\.\d{2})\s*$", w)
                if a:
                    amt = num(a.group(1))
                else:  # 金额印在上一两行
                    for w2 in reversed(win[:j]):
                        a = re.search(r"([\d,]+\.\d{2})\s*$", w2)
                        if a:
                            amt = num(a.group(1)); break
            if "Please pay by" in w:
                d = DATE_TXT.search(w[w.index("Please pay by"):]) or (DATE_TXT.search(win[j + 1]) if j + 1 < len(win) else None)
                if d:
                    due = f"{d.group(3)}-{MON[d.group(2)]:02d}-{int(d.group(1)):02d}"
        out.setdefault(cur, {"min_due": amt, "due": due})
    return out


def parse_pdf(path):
    txt = pdftotext(path)
    lines = txt.split("\n")
    stmt = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(path)).group(1)
    sy, sm = int(stmt[:4]), int(stmt[5:7])
    info = {"stmt": stmt, "type": None, "limit": {}, "apr": {}, "sections": {}, "due": min_due_blocks(lines)}
    m = re.search(r"Statement of (HSBC [^\n]+?)\s{2,}", txt)
    info["type"] = m.group(1).strip() if m else None
    for c, v in re.findall(r"(HKD|CNY)([\d,]+\.\d{2})\*?\s*$", txt[:3000], re.M):
        info["limit"].setdefault(c, num(v))
    m = re.search(r"PURCHASE\s+([\d.]+)%", txt); info["apr"]["purchase"] = float(m.group(1)) if m else None
    m = re.search(r"CASH ADVANCE\s+([\d.]+)%", txt); info["apr"]["cash"] = float(m.group(1)) if m else None
    cur, holder, txns, last = "HKD", None, [], None
    for ln in lines:
        h = CURHDR.search(ln)
        if h:
            cur = h.group(1); continue
        mh = HOLDER.match(ln)
        if mh and not TX.match(ln):
            holder = mh.group(1)[-4:]; continue
        mb = BAL.match(ln)
        if mb:
            info["sections"].setdefault(cur, {})[mb.group(1)] = num(mb.group(2), mb.group(3)); continue
        mt = TX.match(ln)
        if mt:
            pd, pm, td, tm, rest, a, cr = mt.groups()
            if pm not in MON or tm not in MON:
                continue
            y = sy - 1 if MON[tm] > sm else sy
            py = sy - 1 if MON[pm] > sm else sy
            t = {"cur": cur, "date": f"{y}-{MON[tm]:02d}-{int(td):02d}", "post": f"{py}-{MON[pm]:02d}-{int(pd):02d}",
                 "rest": re.sub(r"\s+", " ", rest).strip(), "fields": [f for f in re.split(r"\s{2,}", rest.strip()) if f],
                 "amount": num(a, cr), "card4": holder, "extra": []}
            txns.append(t); last = t; continue
        s = ln.strip()
        if last is not None and s and re.match(r"^\s{10,}\S", ln) and len(s) < 80 and \
                re.match(r"^\*EXCHANGE RATE|PAY-MOBILE|UNIONPAY QR|^[A-Z]{3} [\d,.]+$", s):
            last["extra"].append(s)
        if not s:
            last = None
    info["txns"] = txns
    for c, sec in info["sections"].items():
        sec["sum"] = round(sum(t["amount"] for t in txns if t["cur"] == c), 2)
    return info


def load_statements():
    cache = {}
    if os.path.exists(CACHE):
        c = json.load(open(CACHE, encoding="utf-8"))
        if c.get("version") == PARSER_VERSION:
            cache = c["files"]
    out, new = {}, 0
    for folder in CARDS:
        out[folder] = []
        for f in sorted(glob.glob(os.path.join(DIR, folder, "*_Statement.pdf"))):
            sha = hashlib.sha1(open(f, "rb").read()).hexdigest()
            if sha not in cache:
                cache[sha] = parse_pdf(f); new += 1
            out[folder].append(cache[sha])
    if new:
        json.dump({"version": PARSER_VERSION, "files": cache}, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    return out, new


def check(statements):
    errs = []
    for folder, sts in statements.items():
        for s in sts:
            for c, sec in s["sections"].items():
                if "PREVIOUS BALANCE" not in sec or "STATEMENT BALANCE" not in sec:
                    errs.append(f"{folder} {s['stmt']} {c}：没找到上期 / 本期结余")
                elif abs(sec["PREVIOUS BALANCE"] + sec["sum"] - sec["STATEMENT BALANCE"]) > 0.005:
                    errs.append(f"{folder} {s['stmt']} {c}：上期 {sec['PREVIOUS BALANCE']} + 交易 {sec['sum']} ≠ 本期 {sec['STATEMENT BALANCE']}")
        for a, b in zip(sts, sts[1:]):
            for c, sec in b["sections"].items():
                prev = a["sections"].get(c, {}).get("STATEMENT BALANCE", 0.0)
                if abs(sec.get("PREVIOUS BALANCE", 0) - prev) > 0.005:
                    errs.append(f"{folder} {a['stmt']} → {b['stmt']} {c}：结余没有衔接（{prev} → {sec.get('PREVIOUS BALANCE')}）")
    return errs


# ---------------------------------------------------------------- 分类
def merchant_key(t):
    f0 = t["fields"][0] if t["fields"] else t["rest"]
    return re.sub(r"\s+", " ", re.sub(r"\(\d+\)|\d{3,}", " ", f0)).strip().upper() or f0


def load_categories():
    path = os.path.join(DIR, "merchant_categories.csv")
    out = {}
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            cat = (r.get("类别") or "").strip()
            if cat not in CAT_MAP:
                sys.exit(f"merchant_categories.csv 里「{r.get('商户')}」的类别「{cat}」不认识。可用：{', '.join(CAT_MAP)}")
            out[(r.get("商户") or "").strip().upper()] = cat
    return out


def classify(t, cats, unknown):
    for rx, cat in RULES:
        if rx.search(t["rest"]):
            return cat
    k = merchant_key(t)
    if k in cats:
        return cats[k]
    unknown[k] = unknown.get(k, 0) + 1
    return "Unclassified"


# ---------------------------------------------------------------- 组装
def clean(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def build(statements, cats):
    accounts, liabilities, transactions, report, unknown = [], {}, [], [], {}
    for folder, curs in CARDS.items():
        sts = statements.get(folder, [])
        for cur, (acct_id, name) in curs.items():
            mine = [s for s in sts if cur in s["sections"] or any(t["cur"] == cur for t in s["txns"])]
            last = mine[-1] if mine else None
            opening = mine[0]["sections"].get(cur, {}).get("PREVIOUS BALANCE", 0.0) if mine else 0.0
            masks = [t["card4"] for s in mine for t in s["txns"] if t["cur"] == cur and t["card4"]]
            last_pay, n = None, 0
            for s in mine:
                seq = 0
                for t in s["txns"]:
                    if t["cur"] != cur:
                        continue
                    seq += 1; n += 1
                    cat = classify(t, cats, unknown)
                    primary, detailed = CAT_MAP[cat]
                    if cat == "还款" and t["amount"] < 0 and (not last_pay or t["date"] >= last_pay["date"]):
                        last_pay = {"date": t["date"], "amount": -t["amount"]}
                    f = t["fields"]
                    fx = re.search(r"\b([A-Z]{3})\s+([\d,]+\.\d{2})$", t["rest"])
                    rate = next((float(x.split(":")[1]) for x in t["extra"] if x.startswith("*EXCHANGE RATE")), None)
                    loc_country = f[-1] if len(f) >= 2 and re.fullmatch(r"[A-Z]{2}", f[-1]) else (f[-3] if fx and len(f) >= 3 and re.fullmatch(r"[A-Z]{2}", f[-3]) else None)
                    city = f[1] if len(f) >= 3 and not re.fullmatch(r"[A-Z]{2,3}|[\d,.]+", f[1]) else None
                    wallet = next((x for x in t["extra"] if "PAY-MOBILE" in x or "UNIONPAY QR" in x), None)
                    transactions.append({
                        "id": f"hsbc:{acct_id}:{s['stmt']}:{seq:03d}",
                        "account_id": acct_id, "date": t["date"], "authorized_date": t["date"],
                        "name": clean(f[0] if f else t["rest"]), "merchant": None,
                        "amount": t["amount"], "currency": cur,
                        "category": primary, "category_detail": detailed,
                        "channel": "online" if cat == "Shopping" else None,
                        "pending": False, "source": "hsbc_hk_statement",
                        "detail": {k: v for k, v in {
                            "original_description": t["rest"],
                            "hsbc_category": cat,
                            "personal_finance_category": {"primary": primary, "detailed": detailed} if primary else None,
                            "location": {"city": city, "country": loc_country} if (city or loc_country) else None,
                            "foreign": {"amount": num(fx.group(2)), "currency": fx.group(1), "rate": rate} if fx and fx.group(1) != cur else None,
                            "wallet": wallet,
                            "card_last4": t["card4"],
                            "post_date": t["post"],
                            "statement_date": s["stmt"],
                        }.items() if v is not None},
                    })
            limit = last["limit"].get(cur) if last else None
            accounts.append({
                "id": acct_id, "name": name,
                "official_name": (last or {}).get("type") or name,
                "mask": masks[-1] if masks else None,
                "type": "credit", "subtype": "credit card",
                "limit": limit, "currency": cur,
                "balance_from_txns": True,
                "opening_balance": opening,   # 第一份结单之前的结余（EveryMile 的早期结单不在文件夹里）
            })
            if last:
                sec = last["sections"].get(cur, {})
                due = last["due"].get(cur, {})
                apr = last["apr"]
                liabilities[acct_id] = {
                    "last_statement_balance": sec.get("STATEMENT BALANCE", 0.0),
                    "last_statement_issue_date": last["stmt"],
                    "minimum_payment_amount": due.get("min_due"),
                    "next_payment_due_date": due.get("due"),
                    "last_payment_amount": last_pay["amount"] if last_pay else None,
                    "last_payment_date": last_pay["date"] if last_pay else None,
                    "aprs": [x for x in [{"type": "purchase_apr", "pct": apr.get("purchase")}, {"type": "cash_apr", "pct": apr.get("cash")}] if x["pct"] is not None],
                    "statement_day": int(last["stmt"][8:10]),
                    "source": "hsbc_hk_statement",
                }
            report.append({"id": acct_id, "name": name, "cur": cur, "stmts": len(mine), "txns": n,
                           "first": mine[0]["stmt"] if mine else None, "last": last["stmt"] if last else None,
                           "opening": opening, "balance": round(opening + sum(t["amount"] for t in transactions if t["account_id"] == acct_id), 2),
                           "stmt_balance": last["sections"].get(cur, {}).get("STATEMENT BALANCE") if last else None,
                           "limit": limit, "liab": liabilities.get(acct_id)})
    return accounts, liabilities, transactions, report, unknown


# ---------------------------------------------------------------- 上传
def worker_url(arg):
    if arg:
        return arg.rstrip("/")
    cfg = open(os.path.join(ROOT, "front", "config.js"), encoding="utf-8").read()
    m = re.search(r"workerUrl:\s*[\"']([^\"']+)[\"']", cfg)
    if not m:
        sys.exit("front/config.js 里没有 workerUrl，请用 --url 指定")
    return m.group(1).rstrip("/")


def call(url, path, token=None, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url + path, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Content-Type": "application/json", "User-Agent": "reward-tracker-import",
                                          **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error")
        except Exception:
            msg = e.reason
        sys.exit(f"{path} 失败（{e.code}）：{msg}")


def login(url):
    if os.environ.get("RT_INGEST_TOKEN"):
        return os.environ["RT_INGEST_TOKEN"], False
    user = os.environ.get("RT_USER") or input("记账本账号：")
    pw = os.environ.get("RT_PASS") or getpass.getpass("记账本密码：")
    return call(url, "/api/login", body={"username": user, "password": pw})["token"], True


def upload_faces(url, token, accounts):
    if not os.path.exists(FACES):
        print("没有 _cardfaces.json，跳过卡面"); return
    faces = json.load(open(FACES, encoding="utf-8"))
    rewards = call(url, "/api/data", token).get("rewards") or {}
    rewards.setdefault("cardface", {})
    done = []
    for a in accounts:
        img = faces.get(FACE_OF.get(a["id"], ""))
        if not img:
            continue
        call(url, "/api/cardimg", token, {"account_id": a["id"], "data": img}, method="PUT")
        rewards["cardface"][a["id"]] = "upload"   # 让前端用这张上传的卡面
        done.append(a["name"])
    clean_rewards = {k: rewards.get(k) or {} for k in ("cards", "rules", "balances", "closing", "cardface")}
    call(url, "/api/rewards", token, {"rewards": clean_rewards}, method="PUT")
    print(f"卡面已写入：{'、'.join(done)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--no-faces", action="store_true")
    ap.add_argument("--url")
    args = ap.parse_args()

    statements, new = load_statements()
    errs = check(statements)
    if errs:
        print("结单核对没通过，不上传：")
        for e in errs:
            print("  ·", e)
        sys.exit(1)
    cats = load_categories()
    accounts, liabilities, transactions, report, unknown = build(statements, cats)

    fmt = lambda v, c: "—" if v is None else f"{'HK$' if c == 'HKD' else '¥'}{v:,.2f}"
    for r in report:
        L = r["liab"] or {}
        print(f"\n■ {r['name']}（{r['id']}）")
        if not r["stmts"]:
            print("  没有结单：建空账户"); continue
        print(f"  结单 {r['stmts']} 期：{r['first']} → {r['last']}，交易 {r['txns']} 笔，期初 {fmt(r['opening'], r['cur'])}")
        print(f"  当前欠款（期初 + 交易）{fmt(r['balance'], r['cur'])}  ·  最新结单结余 {fmt(r['stmt_balance'], r['cur'])}  ·  额度 {fmt(r['limit'], r['cur'])}")
        print(f"  最低还款 {fmt(L.get('minimum_payment_amount'), r['cur'])}  ·  还款日 {L.get('next_payment_due_date') or '—'}  ·  上次还款 {fmt(L.get('last_payment_amount'), r['cur'])} {L.get('last_payment_date') or ''}")
    print(f"\n共 {len(transactions)} 笔交易、{len(accounts)} 个账户；本次新解析 {new} 份结单，全部结余核对通过。")
    if unknown:
        print(f"⚠ 对照表里没有的商户 {len(unknown)} 个，已归为 Unclassified（可加进 merchant_categories.csv 后重跑 --overwrite）：")
        for k, n in sorted(unknown.items(), key=lambda x: -x[1])[:30]:
            print(f"    {n:3} × {k}")

    if args.dry_run:
        out = os.path.join(DIR, "_preview.json")
        json.dump({"accounts": accounts, "liabilities": liabilities, "sample": transactions[:5]}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"--dry-run：没有上传。预览写在 {os.path.relpath(out, ROOT)}")
        return

    url = worker_url(args.url)
    token, full = login(url)
    d = call(url, "/api/manual/import", token, {
        "item_id": ITEM_ID,
        "item": {"institution": "HSBC HK", "region": "HK", "notice": "月结单 PDF 导入，不经 Plaid"},
        "accounts": accounts, "liabilities": liabilities, "transactions": transactions,
        "overwrite": args.overwrite,
    })
    print(f"\n已上传到 {url}：新增 {d['added']}，跳过（已导入）{d['skipped']}，覆盖 {d['updated']}，现有 {d['total']} 笔。")
    if d.get("rejected"):
        print(f"⚠ {len(d['rejected'])} 笔被拒：", d["rejected"][:10])
    if args.no_faces:
        return
    if not full:
        print("用的是 RT_INGEST_TOKEN，不能写卡面；要写卡面请用账号密码再跑一次（交易会全部跳过）。")
        return
    upload_faces(url, token, accounts)


if __name__ == "__main__":
    main()
