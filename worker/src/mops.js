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

/* ---------------- 類型分類 ---------------- */

// 規則改版時把這個數字 +1，排程會分批把舊資料重新分類、重算備註
export const RULES_VER = 2;

// 不論條款或關鍵字，一律歸「其他」的公告
const FORCE_OTHER = /簡易合併|債權人|全面換發|更名|公司名稱變更/;

// 取得處分投資：只收設備、廠務工程、資產、不動產、使用權資產、辦公室、增加投資、新建蓋廠
const ACQUIRE =
  /(取得|購置|購買|購入|添購|承租|租賃|處分|出售|出租|收購).{0,40}?(設備|機器|機台|廠務|工程|資產|不動產|土地|廠房|房地|建物|大樓|辦公室|使用權|股權|股份|普通股|特別股|貨櫃|船舶|新船|飛機)|增加投資|追加投資|(現金)?增資.{0,12}子公司|子公司.{0,12}(現金)?增資|設立.{0,10}子公司|投資(興建|設立|設廠|成立)|新建|興建|增建|擴建|建廠|蓋廠|擴廠|設廠|資本支出|使用權資產|工程(合約|承攬|案)/;
// 第 20 款裡的理財交易（基金、債券、票券）不算取得處分投資
const TREASURY = /基金|債券|公司債|票券|貨幣市場|附買回|理財|定存|結構型/;

const MATERIAL_RULES = [
  ["澄清報導", /澄清|媒體報導|新聞報導/],
  ["股利", /股利|配息|配股|除權|除息|盈餘分配|盈餘轉增資/],
  ["財報營收", /財務報告|財務報表|財報|自結|營業收入|營收|損益|每股盈餘|財務資訊|季報/],
  ["庫藏股", /庫藏股|買回本公司股份|買回股份/],
  ["股東會", /股東常會|股東臨時會|股東會/],
  ["法說會", /法人說明會|法說會|投資人說明會|業績發表|投資論壇|論壇|Access Day|Conference|Summit|Forum/i],
  ["取得處分投資", ACQUIRE],
  ["增減資籌資", /增資|減資|私募|公司債|轉換債|發行新股|籌資|融資額度|銀行借款/],
  ["資金貸與背書保證", /資金貸與|背書保證|背書|為他人保證/],
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

/** 依「符合條款」判斷（只有抓到內文後才有條款）；判斷不了回傳 null */
function byClause(clause, subject) {
  switch (String(clause || "")) {
    case "12": return "法說會";
    case "31": return "財報營收";
    case "14": return "股利";
    case "17": return "股東會";
    case "19":
    case "23": return "資金貸與背書保證";
    case "6": return "人事異動";
    case "15": return "取得處分投資";
    case "20": return TREASURY.test(subject) ? "其他" : "取得處分投資";
    case "11":
      if (/增資|減資|轉換|發行新股|私募/.test(subject)) return "增減資籌資";
      if (/收購|股份受讓|取得/.test(subject)) return "取得處分投資";
      return "其他";
    default: return null;
  }
}

export function classify(kind, subject, clause) {
  const s = String(subject || "");
  const rules = kind === "latest" ? LATEST_RULES : MATERIAL_RULES;
  if (kind !== "latest") {
    if (FORCE_OTHER.test(s)) return "其他";
    const c = byClause(clause, s);
    if (c) return c;
  }
  for (const [name, re] of rules) if (re.test(s)) return name;
  return "其他";
}

/* ---------------- 備註：從內文抽出重點 ---------------- */

const CURRENCIES = [
  ["NTD", /^(新台幣|新臺幣|台幣|臺幣|NTD|NT\$|NT|TWD)$/i, "新台幣"],
  ["USD", /^(美金|美元|USD|US\$)$/i, "美金"],
  ["CNY", /^(人民幣|RMB|CNY)$/i, "人民幣"],
  ["JPY", /^(日圓|日幣|日元|JPY)$/i, "日圓"],
  ["EUR", /^(歐元|EUR)$/i, "歐元"],
  ["THB", /^(泰銖|泰幣|THB)$/i, "泰銖"],
  ["HKD", /^(港幣|港元|HKD)$/i, "港幣"],
  ["VND", /^(越南盾|越幣|VND)$/i, "越南盾"],
  ["SGD", /^(新加坡幣|新幣|SGD)$/i, "新加坡幣"],
  ["MYR", /^(馬幣|令吉|MYR)$/i, "馬幣"],
  ["IDR", /^(印尼盾|IDR)$/i, "印尼盾"],
  ["INR", /^(印度盧比|盧比|INR)$/i, "印度盧比"],
  ["GBP", /^(英鎊|GBP)$/i, "英鎊"],
  ["AUD", /^(澳幣|澳元|AUD)$/i, "澳幣"],
  ["KRW", /^(韓元|韓圜|KRW)$/i, "韓元"],
  ["CAD", /^(加幣|加元|CAD)$/i, "加幣"],
  ["MXN", /^(墨西哥披索|披索|MXN)$/i, "墨西哥披索"],
  ["PHP", /^(菲律賓比索|比索|PHP)$/i, "菲律賓比索"],
];
const CUR_WORDS = "新台幣|新臺幣|台幣|臺幣|NTD|NT\\$|TWD|美金|美元|USD|US\\$|人民幣|RMB|CNY|日圓|日幣|日元|JPY|歐元|EUR|泰銖|泰幣|THB|港幣|港元|HKD|越南盾|越幣|VND|新加坡幣|新幣|SGD|馬幣|令吉|MYR|印尼盾|IDR|印度盧比|盧比|INR|英鎊|GBP|澳幣|澳元|AUD|韓元|韓圜|KRW|加幣|加元|CAD|墨西哥披索|菲律賓比索|披索|比索|MXN|PHP";
// 幣別（可省略）＋數字＋單位（億／萬／仟／千／百萬，可省略）＋「元」（可省略）
const MONEY_RE = new RegExp(`(${CUR_WORDS})?\\s*(?:約)?\\s*(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*(百萬|千萬|億|萬|仟|千)?\\s*(元|圓)?`, "gi");
const UNIT = { 百萬: 1e6, 千萬: 1e7, 億: 1e8, 萬: 1e4, 仟: 1e3, 千: 1e3 };

function curInfo(word) {
  if (!word) return null;
  const w = word.replace(/\s/g, "");
  for (const [code, re, label] of CURRENCIES) if (re.test(w)) return { code, label };
  return null;
}

/** 從一段文字抓出金額：[{ code, label, value }]，沒有幣別、單位、元的純數字不算 */
export function moneyTokens(text) {
  const out = [];
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(text))) {
    if (!m[2]) continue;
    const cur = curInfo(m[1]);
    if (!cur && !m[3] && !m[4]) continue; // 「381.22坪」「24,200只」這種不是金額
    const n = parseFloat(m[2].replace(/,/g, ""));
    if (!Number.isFinite(n) || n === 0) continue;
    // 單位緊接著的字如果是「股」「坪」等，代表不是金額（例：3,000仟股）
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (!m[4] && /[股坪只台件%％]/.test(after)) continue;
    out.push({ code: cur ? cur.code : "NTD", label: cur ? cur.label : "新台幣", value: n * (UNIT[m[3]] || 1), explicit: !!cur });
  }
  return out;
}

function wan(v) {
  const x = v / 1e4;
  if (Math.abs(x) >= 100) return Math.round(x).toLocaleString("en-US");
  if (Math.abs(x) >= 1) return (Math.round(x * 10) / 10).toLocaleString("en-US");
  return (Math.round(x * 100) / 100).toString();
}

// 依序找的「金額關鍵字」，越前面越優先
const AMOUNT_KEYS = ["交易總金額", "總租金", "契約總金額", "合約總金額", "預計投資金額", "投資總額", "預計總金額", "總金額", "總價款", "總價", "投資金額", "處分金額", "金額"];

/** 取得處分投資：交易總金額 → 「2,000 萬（泰銖 3,000 萬）」 */
export function amountNote(detail) {
  const lines = String(detail || "").split(/\r?\n/);
  let tokens = null;
  for (const key of AMOUNT_KEYS) {
    for (const line of lines) {
      const i = line.indexOf(key);
      if (i < 0) continue;
      const t = moneyTokens(line.slice(i + key.length));
      if (t.length) { tokens = t; break; }
    }
    if (tokens) break;
  }
  if (!tokens) {
    // 沒有關鍵字時，取全文第一個有標幣別的金額
    const t = moneyTokens(String(detail || "")).filter((x) => x.explicit);
    if (t.length) tokens = [t[0]];
  }
  if (!tokens) return "";
  const nt = tokens.find((t) => t.code === "NTD");
  const fx = tokens.find((t) => t.code !== "NTD");
  if (nt && fx) return `${wan(nt.value)} 萬（${fx.label} ${wan(fx.value)} 萬）`;
  if (nt) return `${wan(nt.value)} 萬`;
  return `${fx.label} ${wan(fx.value)} 萬`;
}

const CITIES = "台北市|臺北市|新北市|桃園市|台中市|臺中市|台南市|臺南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|臺東縣|澎湖縣|金門縣|連江縣";
const CITY_RE = new RegExp(`(${CITIES})\\s*([^\\s\\d市縣,，、(（)）]{1,3}?[區鄉鎮市])?`);
const CITY_SHORT = /(台北|臺北|新北|桃園|台中|臺中|台南|臺南|高雄|新竹|基隆|嘉義)/;
const FOREIGN = /(新加坡|香港|澳門|東京|大阪|上海|北京|深圳|蘇州|紐約|舊金山|洛杉磯|倫敦|首爾|曼谷|吉隆坡|雅加達|胡志明市|河內|馬尼拉|孟買|杜拜|巴黎|法蘭克福|Singapore|Hong Kong|Tokyo|Shanghai|New York|San Francisco|London|Seoul|Bangkok)/i;
const FOREIGN_ZH = { singapore: "新加坡", "hong kong": "香港", tokyo: "東京", shanghai: "上海", "new york": "紐約", "san francisco": "舊金山", london: "倫敦", seoul: "首爾", bangkok: "曼谷" };
const ONLINE = /線上|視訊|網路|網際網路|Webex|Teams|Zoom|webcast|online|virtual|電話會議|conference call|直播|YouTube/i;

/** 法說會：「11/13 14:30 線上」「11/26 14:00 台北市中山區」 */
export function conferenceNote(detail) {
  const t = String(detail || "");
  const parts = [];
  const d = t.match(/說明會之日期[:：]\s*(\d{2,3})\/(\d{1,2})\/(\d{1,2})(?:\s*[~～至-]\s*(\d{2,3})\/(\d{1,2})\/(\d{1,2}))?/);
  if (d) parts.push(`${+d[2]}/${+d[3]}` + (d[4] ? `~${+d[5]}/${+d[6]}` : ""));
  const tm = t.match(/說明會之時間[:：]\s*(?:(上午|下午)\s*)?(\d{1,2})\s*(?:時|:|：|點)\s*(\d{1,2})?/);
  if (tm) {
    let h = +tm[2];
    if (tm[1] === "下午" && h < 12) h += 12;
    parts.push(`${String(h).padStart(2, "0")}:${String(+(tm[3] || 0)).padStart(2, "0")}`);
  }
  const lm = t.match(/說明會之地點[:：]\s*([^\n]+)/);
  if (lm) {
    const loc = lm[1].trim();
    const city = loc.match(CITY_RE);
    let place = "";
    const foreign = loc.match(FOREIGN);
    if (city) place = (city[1] + (city[2] || "")).replace(/臺/g, "台");
    else if (/101大樓|台北101|臺北101/.test(loc)) place = "台北市信義區";
    else if (foreign) place = FOREIGN_ZH[foreign[1].toLowerCase()] || foreign[1];
    else if (CITY_SHORT.test(loc)) place = loc.match(CITY_SHORT)[1].replace(/臺/g, "台") + "市";
    const online = ONLINE.test(loc);
    if (place && online) parts.push(place + "＋線上");
    else if (place) parts.push(place);
    else if (online) parts.push("線上");
    else parts.push(loc.replace(/[（(].*$/, "").slice(0, 14));
  }
  return parts.join(" ");
}

/** 財報：1 月 1 日累計至本期止基本每股盈餘 */
export function epsNote(detail) {
  const m = String(detail || "").match(/累計至本期止基本每股盈餘[^\n:：]*[:：]\s*(\(?\s*-?\s*[\d,]*\.?\d+\s*\)?)/);
  if (!m) return "";
  let v = m[1].replace(/[\s,]/g, "");
  if (/^\(.*\)$/.test(v)) v = "-" + v.slice(1, -1);
  return `EPS ${v}`;
}

/** 財報的報導期間與累計 EPS：{ year: 115, q: 3, eps: 1.23 }；不是 1 月起算（非曆年制）就回 null */
export function epsInfo(detail) {
  const t = String(detail || "");
  const p = t.match(/(\d{3})\/(\d{1,2})\/\d{1,2}\s*[~～至-]\s*(\d{3})\/(\d{1,2})\/\d{1,2}/);
  const e = epsNote(t);
  if (!p || !e) return null;
  const startM = +p[2], endY = +p[3], endM = +p[4];
  if (startM !== 1 || +p[1] !== endY || endM % 3 !== 0) return null;
  return { year: endY, q: endM / 3, eps: +e.slice(4) };
}

/** 用各季累計 EPS 算單季：Q1、Q2、Q3… 缺資料的那季顯示「—」 */
export function quarterlyNote(q, cums) {
  const has = (k) => typeof cums[k] === "number" && !Number.isNaN(cums[k]);
  const out = [];
  for (let k = 1; k <= q; k++) {
    if (!has(k) || (k > 1 && !has(k - 1))) out.push("—");
    else out.push((Math.round(((k > 1 ? cums[k] - cums[k - 1] : cums[k]) + 1e-9) * 100) / 100).toFixed(2));
  }
  // 一季都算不出來（之前各季都還沒資料）就先顯示累計數，等回補後再重算
  if (out.every((x) => x === "—")) return typeof cums[q] === "number" ? `累計 EPS ${cums[q]}` : "";
  return out.join("、");
}

/**
 * 財報備註要用到之前各季的累計 EPS。
 * items: [{ company_id, category, detail, note }]，會把 note 換成單季 EPS，
 * 並回傳要寫進 eps_cum 的語句（和其他更新一起 batch 執行）。
 */
export async function applyEpsNotes(DB, items) {
  const targets = items.map((it) => ({ it, info: it.category === "財報營收" ? epsInfo(it.detail) : null })).filter((x) => x.info);
  if (!targets.length) return [];
  const ids = [...new Set(targets.map((x) => x.it.company_id))];
  const years = [...new Set(targets.map((x) => x.info.year))];
  const { results } = await DB.prepare(
    `SELECT company_id, year, quarter, eps FROM eps_cum WHERE company_id IN (${ids.map(() => "?").join(",")}) AND year IN (${years.map(() => "?").join(",")})`
  ).bind(...ids, ...years).all();
  const map = {};
  const key = (c, y) => c + "|" + y;
  for (const r of results) (map[key(r.company_id, r.year)] ||= {})[r.quarter] = r.eps;
  for (const { it, info } of targets) (map[key(it.company_id, info.year)] ||= {})[info.q] = info.eps;
  const now = new Date().toISOString();
  const stmt = DB.prepare(
    "INSERT INTO eps_cum (company_id, year, quarter, eps, source, updated_at) VALUES (?, ?, ?, ?, 'ann', ?) ON CONFLICT(company_id, year, quarter) DO UPDATE SET eps=excluded.eps, source=excluded.source, updated_at=excluded.updated_at"
  );
  return targets.map(({ it, info }) => {
    it.note = quarterlyNote(info.q, map[key(it.company_id, info.year)]);
    return stmt.bind(it.company_id, info.year, info.q, info.eps, now);
  });
}

/** 回補檔：年度,季別,股號,累計EPS（一行一筆）；格式不對的行略過 */
export function parseEpsCsv(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.trim().match(/^(\d{3}),([1-4]),([0-9A-Z]{4,6}),(-?\d+(?:\.\d+)?)$/);
    if (m) out.push({ year: +m[1], q: +m[2], code: m[3], eps: +m[4] });
  }
  return out;
}

/** 依類型產生備註；其他類型留空 */
export function makeNote(category, detail) {
  if (!detail) return "";
  if (category === "取得處分投資") return amountNote(detail);
  if (category === "法說會") return conferenceNote(detail);
  if (category === "財報營收") return epsNote(detail);
  return "";
}

/* ---------------- 資料表欄位補齊（舊資料庫升級用） ---------------- */

const EXTRA_COLUMNS = { announcements: { note: "TEXT", cat_ver: "INTEGER", detail_tries: "INTEGER" } };
export async function migrate(DB) {
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  for (const [table, cols] of Object.entries(EXTRA_COLUMNS)) {
    const { results } = await DB.prepare(`PRAGMA table_info(${table})`).all();
    const have = new Set(results.map((r) => r.name));
    for (const [col, type] of Object.entries(cols)) {
      if (!have.has(col)) await DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
    }
  }
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

/** 持股分頁的 CSV 網址：沿用觀察名單發佈的網址，只換 gid（分頁編號） */
export const HOLDINGS_GID = "1672521628"; // 「投資系統_觀察名單」裡「持股」分頁的編號
export function holdingsCsvUrl(env) {
  if (env.HOLDINGS_CSV_URL) return env.HOLDINGS_CSV_URL;
  if (!env.WATCHLIST_CSV_URL) return "";
  const u = new URL(env.WATCHLIST_CSV_URL);
  u.searchParams.set("gid", env.HOLDINGS_GID || HOLDINGS_GID);
  u.searchParams.set("single", "true");
  u.searchParams.set("output", "csv");
  return u.toString();
}

/** 觀察名單／持股：Google Sheet「發佈到網路」的 CSV，取第一欄的股號 */
export async function fetchWatchlist(csvUrl) {
  const r = await fetch(csvUrl, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("名單 CSV HTTP " + r.status);
  // 分頁沒有發佈時 Google 會回一個網頁而不是 CSV，不能當成空名單
  if (/text\/html/i.test(r.headers.get("Content-Type") || "")) throw new Error("讀到的是網頁不是 CSV，請確認這個分頁有「發佈到網路」");
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
  `CREATE TABLE IF NOT EXISTS holdings (company_id TEXT PRIMARY KEY, name TEXT, note TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  // 關鍵指標：月營收、公司名稱、資產負債表（存貨、合約負債）與抓取紀錄，不受 180 天清除影響
  `CREATE TABLE IF NOT EXISTS revenue_monthly (company_id TEXT, ym TEXT, revenue INTEGER, PRIMARY KEY (company_id, ym))`,
  `CREATE TABLE IF NOT EXISTS company_names (company_id TEXT PRIMARY KEY, name TEXT, market TEXT, updated_at TEXT)`,
  // src：這筆數字來自哪一季的報表；較新的報表（可能重編）會覆蓋較舊的
  `CREATE TABLE IF NOT EXISTS bs_quarterly (company_id TEXT, period TEXT, inventory INTEGER, cl_cur INTEGER, cl_noncur INTEGER, src TEXT, updated_at TEXT,
    PRIMARY KEY (company_id, period))`,
  // 抓過哪幾季的報表；final=1 代表不用再抓（抓到了、或過了申報期限仍查無資料、或失敗 3 次）
  `CREATE TABLE IF NOT EXISTS bs_requests (company_id TEXT, report TEXT, status TEXT, tries INTEGER, final INTEGER, fetched_at TEXT,
    PRIMARY KEY (company_id, report))`,
  // 各季累計 EPS（算單季用），不受 180 天清除影響
  `CREATE TABLE IF NOT EXISTS eps_cum (company_id TEXT, year INTEGER, quarter INTEGER, eps REAL, source TEXT, updated_at TEXT,
    PRIMARY KEY (company_id, year, quarter))`,
];
