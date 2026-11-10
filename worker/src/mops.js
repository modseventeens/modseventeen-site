/**
 * 公開資訊觀測站／證交所 siis 資料來源：抓取、解析、分類
 * 排程 Worker（worker/src/index.js）和網頁 API（functions/system/api/mops）共用這支。
 */

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
export const MARKETS = ["sii", "otc"]; // 上市、上櫃（興櫃先不收）
export const MARKET_NAME = { sii: "上市", otc: "上櫃" };

/* ---------------- 日期（一律用台灣時間） ---------------- */

export function twNow() {
  return new Date(Date.now() + 8 * 3600e3); // 用 UTC getter 讀出來就是台灣時間
}
export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
export function pad(n) {
  return String(n).padStart(2, "0");
}
/** "115/11/10" → "2026-11-10" */
export function rocToIso(s) {
  const m = String(s || "").match(/(\d{2,3})\/(\d{1,2})\/(\d{1,2})/);
  return m ? `${+m[1] + 1911}-${pad(m[2])}-${pad(m[3])}` : "";
}
/** Date → { y: "115", m: "11", d: "10" } */
export function rocParts(d) {
  return { y: String(d.getUTCFullYear() - 1911), m: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()) };
}
export function addMonths(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/* ---------------- 共用抓取 ---------------- */

export async function mopsPost(api, body) {
  const r = await fetch("https://mops.twse.com.tw/mops/api/" + api, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Origin: "https://mops.twse.com.tw",
      Referer: "https://mops.twse.com.tw/mops/",
      Accept: "application/json, text/plain, */*",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 200) throw new Error(`觀測站 ${api} 回應異常：${j ? j.code + " " + j.message : r.status}`);
  return j.result;
}

export async function fetchBig5(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "User-Agent": UA, Referer: "https://mopsov.twse.com.tw/", ...(init.headers || {}) } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return new TextDecoder("big5").decode(await r.arrayBuffer());
}

/* ---------------- HTML 表格解析（舊式網頁，用正規表示式就夠） ---------------- */

export function tableRows(html) {
  return (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []).map((row) =>
    (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) =>
      c
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim()
    )
  );
}
export function num(s) {
  const n = parseInt(String(s || "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}
/** "1101臺灣水泥股份有限" → { code: "1101", name: "臺灣水泥" } */
export function splitCompany(s) {
  const m = String(s || "").match(/^\s*(\d{4,6}[A-Z]?)\s*(.*)$/);
  if (!m) return null;
  const name = m[2].replace(/(股份有限公司|股份有限|股份有|股份|有限公司|公司)$/, "").trim();
  return { code: m[1], name };
}
const isCode = (s) => /^\d{4,6}[A-Z]?$/.test(String(s || "").trim());

/* ---------------- 類型分類（依主旨關鍵字） ---------------- */

const MATERIAL_RULES = [
  ["澄清報導", /澄清|媒體報導|新聞報導/],
  ["股利", /股利|配息|配股|除權|除息|盈餘分配|盈餘轉增資/],
  ["財報營收", /財務報告|財報|自結|營業收入|營收|損益|每股盈餘|財務資訊/],
  ["庫藏股", /庫藏股|買回本公司股份|買回股份/],
  ["股東會", /股東常會|股東臨時會|股東會/],
  ["法說會", /法人說明會|法說會|投資人說明會|業績發表/],
  ["增減資籌資", /增資|減資|私募|公司債|轉換債|發行新股|籌資|融資額度|銀行借款/],
  ["資金貸與背書保證", /資金貸與|背書保證|背書|為他人保證/],
  ["取得處分投資", /取得|處分|購置|出售|租賃|使用權資產|機器設備|不動產|有價證券|投資|合併|收購|分割|股權/],
  ["人事異動", /異動|辭任|新任|解任|改選|選任|董事長|總經理|發言人|主管|委員/],
  ["董事會決議", /董事會/],
];
const LATEST_RULES = [
  ["產品營收統計", /產品業務營收|產品別|產品營收/],
  ["營收", /營業收入|營收/],
  ["財報", /IFRS|財務報告|財報|會計師|資產負債|損益|現金流量|權益變動/],
  ["股東會", /股東會|議事錄|年報|議事手冊/],
  ["股利", /股利|除權|除息/],
  ["資金貸與背書保證", /背書|資金貸與/],
  ["衍生性商品", /衍生性/],
];
export function classify(kind, subject) {
  const rules = kind === "latest" ? LATEST_RULES : MATERIAL_RULES;
  const s = String(subject || "");
  for (const [name, re] of rules) if (re.test(s)) return name;
  return "其他";
}

function normSubject(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
export function annKey(kind, market, code, date, time, subject) {
  return [kind, market, code, date, String(time || "").slice(0, 5), normSubject(subject).slice(0, 60)].join("|");
}

/* ---------------- 各資料來源 ---------------- */

/** 即時重大訊息（當天） */
export async function fetchRealtime(market) {
  const res = await mopsPost("home_page/t05sr01_1", { count: "0", marketKind: market });
  return (res.data || []).map((x) => {
    const date = rocToIso(x.date);
    return {
      id: annKey("material", market, x.companyId, date, x.time, x.subject),
      kind: "material",
      market,
      company_id: x.companyId,
      company_name: x.companyAbbreviation,
      date,
      time: x.time,
      subject: normSubject(x.subject),
      detail_api: x.url?.apiName || "",
      detail_params: JSON.stringify(x.url?.parameters || {}),
      url: "",
    };
  });
}

/** 當日重大訊息（指定日期，一次回全部市場） */
export async function fetchDaily(dateObj) {
  const p = rocParts(dateObj);
  const res = await mopsPost("t05st02", { year: p.y, month: p.m, day: p.d });
  const out = [];
  for (const x of res.data || []) {
    const link = x[5] || {};
    const market = link.parameters?.marketKind;
    if (!MARKETS.includes(market)) continue;
    const date = rocToIso(x[0]);
    out.push({
      id: annKey("material", market, x[2], date, x[1], x[4]),
      kind: "material",
      market,
      company_id: x[2],
      company_name: String(x[3] || "").replace(/\*$/, ""),
      date,
      time: String(x[1] || "").slice(0, 5),
      subject: normSubject(x[4]),
      detail_api: link.apiName || "",
      detail_params: JSON.stringify(link.parameters || {}),
      url: "",
    });
  }
  return out;
}

/** 最新公告（當天，各公司所有申報） */
export async function fetchLatest(market) {
  const res = await mopsPost("home_page/t51sb10", { count: "0", marketKind: market });
  const date = isoDate(twNow());
  return (res.data || []).map((x) => ({
    id: annKey("latest", market, x.companyId, date, x.time, x.subject),
    kind: "latest",
    market,
    company_id: x.companyId,
    company_name: x.companyAbbreviation,
    date,
    time: x.time,
    subject: normSubject(x.subject),
    detail_api: "",
    detail_params: "",
    url: typeof x.url === "string" ? x.url : "",
  }));
}

/** 重大訊息內文 */
export async function fetchDetail(api, params) {
  if (!/^t05s[rt]\d+[_\w]*_detail$/.test(api || "")) throw new Error("沒有內文參數");
  const res = await mopsPost(api, typeof params === "string" ? JSON.parse(params) : params);
  const row = res.data?.[0];
  if (!row) throw new Error("觀測站沒有回傳內文");
  // 欄位：序號、發言日期、發言時間、發言人、職稱、電話、主旨、符合條款、事實發生日、說明
  return {
    speaker: [row[3], row[4]].map((s) => String(s || "").trim()).filter(Boolean).join("／"),
    clause: String(row[7] || "").replace(/[^\d]/g, ""),
    fact_date: rocToIso(row[8]),
    detail: String(row[9] || "").trim(),
  };
}

/** 內部人設質解質（逐筆，全市場，指定月份） */
export async function fetchPledges(market, monthDate) {
  const p = rocParts(monthDate);
  const html = await fetchBig5(
    `https://siis.twse.com.tw/server-java/STAMAK03?colorchg=1&step=1&order=1&TYPEK=${market}&year=${p.y}&smonth=${p.m}&emonth=${p.m}`
  );
  if (!html) return [];
  const out = [];
  for (const c of tableRows(html)) {
    if (c.length < 11 || !isCode(c[0])) continue;
    const row = {
      market,
      company_id: c[0],
      company_name: c[1],
      role: c[2].replace(/^[A-Z]\d+/, "").trim(),
      holder: c[3],
      event_date: rocToIso(c[4]),
      pledged: num(c[5]),
      released: num(c[6]),
      accumulated: num(c[7]),
      pledgee: c[8],
      note: c[9],
      report_date: rocToIso(c[10]),
    };
    row.id = [market, row.company_id, row.holder, row.event_date, row.pledged, row.released, row.accumulated, row.report_date].join("|");
    out.push(row);
  }
  return out;
}

/** 內部人持股轉讓事前申報（全市場，指定月份） */
export async function fetchPretransfer(market, monthDate) {
  const p = rocParts(monthDate);
  const body = new URLSearchParams({
    encodeURIComponent: "1", run: "", step: "1", TYPEK: market, co_id: "",
    year: p.y, smonth: p.m, emonth: p.m, isnew: "true", sstep: "1", firstin: "true",
  });
  const r = await fetch("https://mopsov.twse.com.tw/mops/web/ajax_t56sb21", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, Referer: "https://mopsov.twse.com.tw/mops/web/t56sb21_q1" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error("事前申報 HTTP " + r.status);
  const html = await r.text();
  const out = [];
  // 欄位：異動情形、申報日期、代號、名稱、身分、姓名、轉讓方式、轉讓股數、盤中最大、受讓人、
  //       目前持有(自有/信託)、預定轉讓總股數(自有/信託)、轉讓後持股(自有/信託)、有效期間、未完成轉讓
  for (const c of tableRows(html)) {
    if (c.length < 17 || !isCode(c[2])) continue;
    const row = {
      market,
      status: c[0],
      report_date: rocToIso(c[1]),
      company_id: c[2],
      company_name: c[3],
      role: c[4],
      holder: c[5],
      method: c[6],
      shares: num(c[12]) + num(c[13]) || num(c[7]),
      holding: num(c[10]) + num(c[11]),
      after: num(c[14]) + num(c[15]),
      transferee: c[9],
      period: c[16],
    };
    row.id = [market, row.company_id, row.holder, row.report_date, row.method, row.shares, row.period].join("|");
    out.push(row);
  }
  return out;
}

/** siis 月報網址：民國年 + 報表 + 月份 */
function irbUrl(market, report, monthDate) {
  const p = rocParts(monthDate);
  return `https://siis.twse.com.tw/publish/${market}/${p.y}${report}_${p.m}.HTM`;
}
export function ymOf(monthDate) {
  return `${monthDate.getUTCFullYear()}-${pad(monthDate.getUTCMonth() + 1)}`;
}

/** IRB110 董監經理人大股東股權異動彙總（每家公司一列）；還沒公布會回 null */
export async function fetchIRB110(market, monthDate) {
  const html = await fetchBig5(irbUrl(market, "IRB110", monthDate));
  if (!html) return null;
  const ym = ymOf(monthDate);
  const out = [];
  for (const c of tableRows(html)) {
    const co = splitCompany(c[0]);
    if (!co || c.length < 8) continue;
    out.push({
      id: [ym, market, co.code].join("|"),
      ym, market,
      company_id: co.code,
      company_name: co.name,
      issued: num(c[1]),
      ds_increase: num(c[2]),
      ds_decrease: num(c[3]),
      ds_holding: num(c[4]),
      ds_pct: parseFloat(String(c[5]).replace(/[^\d.]/g, "")) || 0,
      mgr_holding: num(c[6]),
      major_holding: num(c[7]),
    });
  }
  return out;
}

/** IRB150 取得／IRB140 轉讓 達 100 萬股以上（逐人） */
export async function fetchIRBLarge(market, monthDate, report) {
  const html = await fetchBig5(irbUrl(market, report, monthDate));
  if (!html) return null;
  const ym = ymOf(monthDate);
  const direction = report === "IRB150" ? "acquire" : "transfer";
  const out = [];
  let last = null;
  for (const c of tableRows(html)) {
    let co = splitCompany(c[0]);
    let rest = c.slice(1);
    if (!co && last && c.length === 3 && /\d/.test(c[2])) {
      co = last; // 同一家公司的第二列（合併儲存格）
      rest = c;
    }
    if (!co || rest.length < 3) continue;
    last = co;
    const shares = num(rest[2]);
    if (!shares) continue;
    out.push({
      id: [ym, market, direction, co.code, rest[1], shares].join("|"),
      ym, market, direction,
      company_id: co.code,
      company_name: co.name,
      role: rest[0],
      holder: rest[1],
      shares,
    });
  }
  return out;
}

/** IRB180 董監質權設定占實際持有股數（只列有設質的公司） */
export async function fetchIRB180(market, monthDate) {
  const html = await fetchBig5(irbUrl(market, "IRB180", monthDate));
  if (!html) return null;
  const ym = ymOf(monthDate);
  const out = [];
  const seen = new Set();
  for (const row of tableRows(html)) {
    for (const cell of row) {
      const m = cell.match(/^(\d{4,6}[A-Z]?)\s+(.+?)\s+(\d{1,3}\.\d{1,2})$/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const ratio = parseFloat(m[3]);
      if (ratio > 0) out.push({ id: [ym, market, m[1]].join("|"), ym, market, company_id: m[1], company_name: m[2], ratio });
    }
  }
  return out;
}

/** 觀察名單：Google Sheet「發佈到網路」的 CSV，取第一欄的股號 */
export async function fetchWatchlist(csvUrl) {
  const r = await fetch(csvUrl, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("名單 CSV HTTP " + r.status);
  const text = await r.text();
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const cols = parseCsvLine(line);
    const code = String(cols[0] || "").replace(/^'/, "").trim().toUpperCase();
    if (isCode(code)) out.set(code, { company_id: code, name: (cols[1] || "").trim(), note: (cols[2] || "").trim() });
  }
  return [...out.values()];
}
function parseCsvLine(line) {
  const cols = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { cols.push(cur); cur = ""; }
    else cur += ch;
  }
  cols.push(cur);
  return cols;
}

/* ---------------- 資料表 ---------------- */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, market TEXT, company_id TEXT, company_name TEXT,
    date TEXT, time TEXT, subject TEXT, category TEXT,
    detail_api TEXT, detail_params TEXT, url TEXT,
    speaker TEXT, clause TEXT, fact_date TEXT, detail TEXT, detail_at TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_ann_day ON announcements(kind, date, time)`,
  `CREATE INDEX IF NOT EXISTS idx_ann_company ON announcements(company_id, date)`,
  `CREATE TABLE IF NOT EXISTS pledges (
    id TEXT PRIMARY KEY, market TEXT, company_id TEXT, company_name TEXT, role TEXT, holder TEXT,
    event_date TEXT, pledged INTEGER, released INTEGER, accumulated INTEGER, pledgee TEXT, note TEXT,
    report_date TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_pledge_date ON pledges(report_date)`,
  `CREATE TABLE IF NOT EXISTS pretransfers (
    id TEXT PRIMARY KEY, market TEXT, status TEXT, report_date TEXT, company_id TEXT, company_name TEXT,
    role TEXT, holder TEXT, method TEXT, shares INTEGER, holding INTEGER, after INTEGER, transferee TEXT,
    period TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_pre_date ON pretransfers(report_date)`,
  `CREATE TABLE IF NOT EXISTS insider_monthly (
    id TEXT PRIMARY KEY, ym TEXT, market TEXT, company_id TEXT, company_name TEXT, issued INTEGER,
    ds_increase INTEGER, ds_decrease INTEGER, ds_holding INTEGER, ds_pct REAL, mgr_holding INTEGER, major_holding INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_im_ym ON insider_monthly(ym)`,
  `CREATE TABLE IF NOT EXISTS insider_large (
    id TEXT PRIMARY KEY, ym TEXT, market TEXT, direction TEXT, company_id TEXT, company_name TEXT,
    role TEXT, holder TEXT, shares INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_il_ym ON insider_large(ym)`,
  `CREATE TABLE IF NOT EXISTS pledge_ratio (
    id TEXT PRIMARY KEY, ym TEXT, market TEXT, company_id TEXT, company_name TEXT, ratio REAL)`,
  `CREATE INDEX IF NOT EXISTS idx_pr_ym ON pledge_ratio(ym)`,
  `CREATE TABLE IF NOT EXISTS watchlist (company_id TEXT PRIMARY KEY, name TEXT, note TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
];
