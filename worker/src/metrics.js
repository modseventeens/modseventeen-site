// 關鍵指標：月營收、存貨、合約負債
//   月營收：觀測站「全市場月營收彙總表」（每月一份，上市／上櫃 × 國內／國外公司），全部公司都存
//   存貨、合約負債：單一公司的資產負債表（每季一份，一份同時有當季、去年底、去年同季），
//                  持股＋觀察名單由排程慢慢回補，其他公司第一次查詢時即時抓
import { UA, fetchBig5, tableRows, num, pad } from "./mops.js";


const MOPSOV = "https://mopsov.twse.com.tw";
export const isCode = (s) => /^[0-9A-Z]{4,6}$/.test(String(s || ""));

/* ---------------- 月營收 ---------------- */

/** part 0 = 國內公司、1 = 國外公司（KY） */
export function revenueUrl(market, rocY, m, part) {
  return `${MOPSOV}/nas/t21/${market}/t21sc03_${rocY}_${m}_${part}.html`;
}

/**
 * 欄位：代號、名稱、當月營收、上月營收、去年當月營收、上月比較增減(%)、去年同月增減(%)、
 *       當月累計營收、去年累計營收、前期比較增減(%)、備註（單位：千元）
 */
export function parseRevenue(html) {
  const out = [];
  const rowRe = /<tr[^>]*>\s*<td[^>]*>\s*([0-9A-Z]{4,6})\s*<\/td>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = rowRe.exec(html))) {
    const c = [];
    let x;
    cellRe.lastIndex = 0;
    while ((x = cellRe.exec(m[2]))) c.push(x[1].replace(/<[^>]+>|&nbsp;/g, "").trim());
    if (c.length < 4) continue;
    const n = (v) => (v != null && /\d/.test(v) ? num(v) : null);
    const p = (v) => (v != null && /\d/.test(v) ? parseFloat(v.replace(/,/g, "")) : null);
    const note = (c[9] || "").trim();
    out.push({
      code: m[1], name: c[0], cur: n(c[1]), prev: n(c[2]), last: n(c[3]), mom: p(c[4]), yoy: p(c[5]),
      cum: n(c[6]), cumLast: n(c[7]), cumYoy: p(c[8]), note: note === "-" || note === "－" ? "" : note,
    });
  }
  return out;
}

export async function fetchRevenue(market, rocY, m, part) {
  const html = await fetchBig5(revenueUrl(market, rocY, m, part));
  return html ? parseRevenue(html) : [];
}

export const REV_UPSERT = "ON CONFLICT(company_id, ym) DO UPDATE SET revenue = excluded.revenue WHERE revenue IS NOT excluded.revenue";
export const NAME_UPSERT =
  "ON CONFLICT(company_id) DO UPDATE SET name = excluded.name, market = excluded.market, updated_at = excluded.updated_at WHERE name IS NOT excluded.name OR market IS NOT excluded.market";
export const sqlStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** 把一份月營收彙總表寫進資料庫（當月覆蓋；去年同月只補沒有的） */
export function revenueStatements(DB, rows, market, ym, now) {
  const lastYm = `${+ym.slice(0, 4) - 1}${ym.slice(4)}`;
  const stmts = [];
  for (let i = 0; i < rows.length; i += 300) {
    const part = rows.slice(i, i + 300);
    const cur = part.filter((r) => r.cur != null).map((r) => `(${sqlStr(r.code)},'${ym}',${r.cur})`);
    const last = part.filter((r) => r.last != null).map((r) => `(${sqlStr(r.code)},'${lastYm}',${r.last})`);
    const names = part.map((r) => `(${sqlStr(r.code)},${sqlStr(r.name)},'${market}','${now}')`);
    // 數字沒變就不寫（D1 免費方案每天可寫入的列數有上限）
    if (cur.length) stmts.push(DB.prepare(`INSERT INTO revenue_monthly (company_id, ym, revenue) VALUES ${cur.join(",")} ${REV_UPSERT}`));
    const notes = part.filter((r) => r.cur != null && r.note).map((r) => `(${sqlStr(r.code)},'${ym}',${r.cur},${sqlStr(r.note.slice(0, 300))})`);
    if (notes.length) stmts.push(DB.prepare(
      `INSERT INTO revenue_monthly (company_id, ym, revenue, note) VALUES ${notes.join(",")}
       ON CONFLICT(company_id, ym) DO UPDATE SET note = excluded.note WHERE note IS NOT excluded.note`
    ));
    if (last.length) stmts.push(DB.prepare(`INSERT OR IGNORE INTO revenue_monthly (company_id, ym, revenue) VALUES ${last.join(",")}`));
    stmts.push(DB.prepare(`INSERT INTO company_names (company_id, name, market, updated_at) VALUES ${names.join(",")} ${NAME_UPSERT}`));
  }
  return stmts;
}

const fmtYi = (v) => (v / 1e5).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v) => (v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(1) + "%");

/**
 * 月營收公告：彙總表裡「這次才出現」的公司，轉成一則「營收」類重大訊息
 * （觀測站的月營收不是重大訊息，多數公司不會另發；這裡把它補進重大訊息列表）
 */
export function revenueAnnouncement(r, market, ym, dateIso, timeStr) {
  const mo = +ym.slice(5);
  const detail = [
    `資料年月：${ym}`,
    `本月營收：${fmtYi(r.cur)} 億元（${r.cur.toLocaleString("en-US")} 千元）`,
    r.prev != null ? `上月營收：${fmtYi(r.prev)} 億元，月增 ${fmtPct(r.mom)}` : "",
    r.last != null ? `去年同月：${fmtYi(r.last)} 億元，年增 ${fmtPct(r.yoy)}` : "",
    r.cum != null ? `今年累計：${fmtYi(r.cum)} 億元，累計年增 ${fmtPct(r.cumYoy)}` : "",
    r.note ? `備註：${r.note}` : "",
    "來源：公開資訊觀測站 月營收彙總表（時間為系統偵測到的時間，可能晚於公司申報）",
  ].filter(Boolean).join("\n");
  return {
    id: `rev|${r.code}|${ym}`,
    market, company_id: r.code, company_name: r.name, date: dateIso, time: timeStr,
    subject: `${mo}月營收 ${fmtYi(r.cur)} 億元，月增 ${fmtPct(r.mom)}，年增 ${fmtPct(r.yoy)}`,
    category: "營收",
    url: "https://mops.twse.com.tw/mops/#/web/t05st10_ifrs",
    note: r.note || "",
    detail,
  };
}

/** 回補檔：R,股號,YYYY-MM,營收（千元）／C,股號,市場,名稱 */
export function parseRevenueCsv(text) {
  const rev = [], names = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    let m;
    if ((m = t.match(/^R,([0-9A-Z]{4,6}),(\d{4}-\d{2}),(-?\d+)$/))) rev.push({ code: m[1], ym: m[2], rev: +m[3] });
    else if ((m = t.match(/^C,([0-9A-Z]{4,6}),(sii|otc),(.+)$/))) names.push({ code: m[1], market: m[2], name: m[3].slice(0, 30) });
  }
  return { rev, names };
}

/** 資產負債表回補檔：B,股號,YYYYQn,存貨,合約負債流動,合約負債非流動（千元；存貨空白＝沒有這個科目） */
export function parseBsCsv(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.trim().match(/^B,([0-9A-Z]{4,6}),(\d{4}Q[1-4]),(-?\d*),(-?\d+),(-?\d+)$/);
    if (m) out.push({ code: m[1], period: m[2], inventory: m[3] === "" ? null : +m[3], cl_cur: +m[4], cl_noncur: +m[5] });
  }
  return out;
}

/* ---------------- 資產負債表（存貨、合約負債） ---------------- */

/** 各季申報期限：Q1 5/15、Q2 8/14、Q3 11/14、Q4 隔年 3/31 */
export function deadline(y, q) {
  return q === 1 ? `${y}-05-15` : q === 2 ? `${y}-08-14` : q === 3 ? `${y}-11-14` : `${y + 1}-03-31`;
}
export const periodKey = (y, q) => `${y}Q${q}`;
export function parsePeriod(p) {
  const m = String(p).match(/^(\d{4})Q([1-4])$/);
  return m ? { y: +m[1], q: +m[2] } : null;
}
function prevQ(y, q) {
  return q === 1 ? { y: y - 1, q: 4 } : { y, q: q - 1 };
}
/** 已經過申報期限的最新一季 */
export function latestDue(todayIso) {
  let y = +todayIso.slice(0, 4), q = 4;
  for (let i = 0; i < 12; i++) {
    if (deadline(y, q) < todayIso) return { y, q };
    ({ y, q } = prevQ(y, q));
  }
  return { y, q };
}
/** 已經結束、但還沒過申報期限的那一季（有些公司會提早公布） */
export function newestEnded(todayIso) {
  const d = latestDue(todayIso);
  const n = d.q === 4 ? { y: d.y + 1, q: 1 } : { y: d.y, q: d.q + 1 };
  const end = `${n.y}-${pad(n.q * 3)}-${n.q === 1 || n.q === 4 ? 31 : 30}`;
  return end < todayIso ? n : null;
}
/** 近 n 季（到最新已過期限那季為止），新到舊 */
/** 顯示 20 季；多抓 4 季才算得出每一季的年增率 */
export const SHOW_QUARTERS = 20;
export const QUARTERS = 24;
export function targetQuarters(todayIso, n = QUARTERS) {
  const out = [];
  let { y, q } = latestDue(todayIso);
  for (let i = 0; i < n; i++) {
    out.push(periodKey(y, q));
    ({ y, q } = prevQ(y, q));
  }
  return out;
}
/** 一份報表涵蓋哪幾季：Q1～Q3 有當季、去年底、去年同季；Q4 有今年底、去年底 */
export function coverage(report) {
  const { y, q } = parsePeriod(report);
  return q === 4 ? [periodKey(y, 4), periodKey(y - 1, 4)] : [periodKey(y, q), periodKey(y - 1, 4), periodKey(y - 1, q)];
}
/** 還要抓哪些報表：從新到舊，沒被涵蓋的那季就抓它自己那份 */
export function reportsToFetch(targets, finalReports, havePeriods = []) {
  const covered = new Set(havePeriods); // 資料庫已經有的季別（例如匯入的）也算涵蓋
  for (const r of finalReports) coverage(r).forEach((p) => covered.add(p));
  const out = [];
  for (const t of targets) {
    if (covered.has(t)) continue;
    out.push(t);
    coverage(t).forEach((p) => covered.add(p));
  }
  return out;
}

const LABELS = {
  inventory: /^存貨(－流動|-流動|淨額)?$/,
  cl_cur: /^合約負債[－-]流動$/,
  cl_noncur: /^合約負債[－-]非流動$/,
};

/** 解析資產負債表：{ "2026Q2": { inventory, cl_cur, cl_noncur }, … }；查無資料回 null */
export function parseBalanceSheet(html) {
  const rows = tableRows(html);
  const head = rows.find((c) => c[0] === "會計項目" && c.slice(1).some((x) => /\d{3}年\d{2}月\d{2}日/.test(x)));
  if (!head) return null;
  const periods = head.slice(1).map((x) => {
    const m = x.match(/(\d{3})年(\d{2})月\d{2}日/);
    if (!m || +m[2] % 3) return null;
    return periodKey(+m[1] + 1911, +m[2] / 3);
  });
  const out = {};
  periods.forEach((p) => p && (out[p] = { inventory: null, cl_cur: 0, cl_noncur: 0 }));
  for (const c of rows) {
    const label = (c[0] || "").replace(/\s/g, "");
    for (const [key, re] of Object.entries(LABELS)) {
      if (!re.test(label)) continue;
      periods.forEach((p, i) => {
        if (!p) return;
        const v = c[1 + i * 2];
        if (v != null && /\d/.test(v)) out[p][key] = num(v);
      });
    }
  }
  return out;
}

export async function fetchBalanceSheet(code, report) {
  const { y, q } = parsePeriod(report);
  const body = new URLSearchParams({
    encodeURIComponent: "1", step: "1", firstin: "1", off: "1", queryName: "co_id", inpuType: "co_id",
    TYPEK: "all", isnew: "false", co_id: code, year: String(y - 1911), season: pad(q),
  });
  const r = await fetch(`${MOPSOV}/mops/web/ajax_t164sb03`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, Referer: `${MOPSOV}/mops/web/t164sb03` },
    body: body.toString(),
  });
  if (!r.ok) throw new Error("資產負債表 HTTP " + r.status);
  const html = await r.text();
  if (/查詢過於頻繁|查詢過量|Overrun/i.test(html)) throw new Error("觀測站限制查詢頻率");
  return parseBalanceSheet(html);
}

/**
 * 補齊一家公司近 20 季的存貨與合約負債。
 * withNewest：連「已結束、還沒過申報期限」的那季也試著抓（網頁查詢時用）
 */
export async function ensureBalanceSheets(DB, code, todayIso, { maxFetch = 12, withNewest = false, concurrency = 3, dryRun = false } = {}) {
  const targets = targetQuarters(todayIso);
  const [reqRes, haveRes] = await DB.batch([
    DB.prepare("SELECT report, status, tries, final, fetched_at FROM bs_requests WHERE company_id = ?").bind(code),
    DB.prepare("SELECT period FROM bs_quarterly WHERE company_id = ?").bind(code),
  ]);
  const results = reqRes.results;
  const req = Object.fromEntries(results.map((r) => [r.report, r]));
  let todo = reportsToFetch(targets, results.filter((r) => r.final).map((r) => r.report), haveRes.results.map((r) => r.period));
  const newest = withNewest ? newestEnded(todayIso) : null;
  if (newest) {
    const k = periodKey(newest.y, newest.q);
    const r = req[k];
    const stale = !r || (r.status !== "ok" && Date.now() - Date.parse(r.fetched_at || 0) > 12 * 3600e3);
    if (stale) todo.unshift(k);
  }
  todo = todo.slice(0, maxFetch);
  if (dryRun) return { missing: todo.length };
  if (!todo.length) return { fetched: 0, ok: 0 };

  const now = new Date().toISOString();
  const stmts = [];
  let ok = 0;
  const run = async (report) => {
    const { y, q } = parsePeriod(report);
    const due = deadline(y, q) < todayIso;
    try {
      const data = await fetchBalanceSheet(code, report);
      if (!data || !Object.keys(data).length) {
        stmts.push(reqStmt(DB, code, report, "empty", 0, due ? 1 : 0, now));
        return;
      }
      ok++;
      stmts.push(reqStmt(DB, code, report, "ok", 0, 1, now));
      for (const [p, v] of Object.entries(data)) {
        stmts.push(DB.prepare(
          `INSERT INTO bs_quarterly (company_id, period, inventory, cl_cur, cl_noncur, src, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(company_id, period) DO UPDATE SET inventory=excluded.inventory, cl_cur=excluded.cl_cur, cl_noncur=excluded.cl_noncur,
             src=excluded.src, updated_at=excluded.updated_at WHERE excluded.src >= bs_quarterly.src`
        ).bind(code, p, v.inventory, v.cl_cur, v.cl_noncur, report, now));
      }
    } catch {
      const tries = (req[report]?.tries || 0) + 1;
      stmts.push(reqStmt(DB, code, report, "error", tries, tries >= 3 ? 1 : 0, now));
    }
  };
  for (let i = 0; i < todo.length; i += concurrency) await Promise.all(todo.slice(i, i + concurrency).map(run));
  if (stmts.length) await DB.batch(stmts);
  return { fetched: todo.length, ok };
}

function reqStmt(DB, code, report, status, tries, final, now) {
  return DB.prepare(
    `INSERT INTO bs_requests (company_id, report, status, tries, final, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, report) DO UPDATE SET status=excluded.status, tries=excluded.tries, final=excluded.final, fetched_at=excluded.fetched_at`
  ).bind(code, report, status, tries, final, now);
}

/** 持股＋觀察名單裡，下一家還沒補齊的公司（持股優先） */
export async function nextCompanyNeedingBs(DB, todayIso) {
  const targets = targetQuarters(todayIso);
  const LIST = "SELECT company_id, 1 AS h FROM holdings UNION SELECT company_id, 0 AS h FROM watchlist WHERE company_id NOT IN (SELECT company_id FROM holdings)";
  const [list, reqs, have] = await DB.batch([
    DB.prepare(LIST),
    DB.prepare("SELECT company_id, report FROM bs_requests WHERE final = 1"),
    DB.prepare(`SELECT company_id, period FROM bs_quarterly WHERE period >= ? AND company_id IN (SELECT company_id FROM (${LIST}))`).bind(targets.at(-1)),
  ]);
  const done = {}, got = {};
  for (const r of reqs.results) (done[r.company_id] ||= []).push(r.report);
  for (const r of have.results) (got[r.company_id] ||= []).push(r.period);
  const companies = list.results.filter((c) => isCode(c.company_id)).sort((a, b) => b.h - a.h || a.company_id.localeCompare(b.company_id));
  for (const c of companies) {
    if (reportsToFetch(targets, done[c.company_id] || [], got[c.company_id] || []).length) return c.company_id;
  }
  return null;
}
