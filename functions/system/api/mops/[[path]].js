/**
 * /system/api/mops/*  網頁讀公開資訊觀測站資料（D1）
 * 路徑在 /system 底下，受 Cloudflare Access「system*」規則保護。
 *
 *   meta                         更新時間、名單家數、可選月份
 *   announcements?kind=material|latest&date=YYYY-MM-DD&scope=holdings|watch|all&q=
 *   （announcements、pretransfers、pledges 也可用 from=YYYY-MM-DD&to=YYYY-MM-DD 指定日期區間；資料只保留 180 天）
 *   （每筆資料都帶 held：是否為持股）
 *   announcements/<rid>          單則內容（名單外的重大訊息會即時去觀測站抓內文）
 *   pretransfers?month=YYYY-MM&scope&q
 *   pledges?month=YYYY-MM&scope&q
 *   insiders?ym=YYYY-MM&scope&q
 *   metrics?code=2330 或 ?q=名稱  關鍵指標：近 36 個月營收、近 20 季存貨與合約負債（沒抓過的季別即時去觀測站抓）
 *   metrics                      沒給公司時回傳持股清單
 *
 * Pages 專案需要綁定 D1：變數名稱 DB。
 */
import { fetchDetail, migrate, classify, makeNote, applyEpsNotes, RULES_VER, twNow, isoDate } from "../../../../worker/src/mops.js";
import { ensureBalanceSheets, targetQuarters, isCode } from "../../../../worker/src/metrics.js";

const ALLOWED = ["modseventeen.com", "www.modseventeen.com", "localhost", "127.0.0.1"];
let schemaReady = false;

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  if (!ALLOWED.includes(url.hostname)) return json({ error: "請從 modseventeen.com 開啟" }, 403);
  if (!env.DB) return json({ error: "Pages 專案還沒綁定 D1（變數名稱 DB）" }, 500);
  if (!schemaReady) {
    // 排程還沒跑過時，資料表可能還不存在
    await migrate(env.DB);
    schemaReady = true;
  }

  const seg = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const q = url.searchParams;
  const opts = {
    scope: ["all", "holdings"].includes(q.get("scope")) ? q.get("scope") : "watch",
    search: (q.get("q") || "").trim(),
  };
  try {
    switch (seg[0]) {
      case "meta":
        return json(await meta(env));
      case "announcements":
        if (seg[1]) return json(await announcement(env, seg[1]));
        return json(await announcements(env, q.get("kind") === "latest" ? "latest" : "material", q.get("date"), opts, dateRange(q)));
      case "pretransfers":
        return json(await pretransfers(env, q.get("month"), opts, dateRange(q)));
      case "pledges":
        return json(await pledges(env, q.get("month"), opts, dateRange(q)));
      case "insiders":
        return json(await insiders(env, q.get("ym"), opts));
      case "metrics":
        return json(await metrics(env, (q.get("code") || q.get("q") || "").trim()));
      default:
        return json({ error: "找不到這個路徑" }, 404);
    }
  } catch (err) {
    return json({ error: "讀取失敗", detail: String(err.message || err) }, 500);
  }
}

/* ---------------- 關鍵指標 ---------------- */

async function metrics(env, input) {
  const DB = env.DB;
  if (!input) {
    const { results } = await DB.prepare(
      "SELECT h.company_id AS id, COALESCE(c.name, h.name) AS name FROM holdings h LEFT JOIN company_names c ON c.company_id = h.company_id ORDER BY h.company_id"
    ).all();
    return { holdings: results };
  }
  let code = input.toUpperCase();
  if (!isCode(code)) {
    const { results } = await DB.prepare(
      `SELECT company_id AS id, name FROM company_names WHERE name LIKE ? ORDER BY (name = ?) DESC, length(name), company_id LIMIT 20`
    ).bind(`%${input}%`, input).all();
    if (!results.length) return { error: `找不到「${input}」` };
    if (results.length > 1 && results[0].name !== input) return { matches: results };
    code = results[0].id;
  }
  const [info, held, watch] = await DB.batch([
    DB.prepare(
      `SELECT name, market FROM company_names WHERE company_id = ?
       UNION ALL SELECT company_name, market FROM announcements WHERE company_id = ? LIMIT 1`
    ).bind(code, code),
    DB.prepare("SELECT name FROM holdings WHERE company_id = ?").bind(code),
    DB.prepare("SELECT name FROM watchlist WHERE company_id = ?").bind(code),
  ]);
  const company = {
    id: code,
    name: info.results[0]?.name || held.results[0]?.name || watch.results[0]?.name || "",
    market: info.results[0]?.market || "",
    held: held.results.length > 0,
    watch: watch.results.length > 0,
  };
  const today = isoDate(twNow());
  const got = await ensureBalanceSheets(DB, code, today, { maxFetch: 12, withNewest: true });
  const oldest = targetQuarters(today).at(-1);
  const [rev, bs] = await DB.batch([
    DB.prepare("SELECT ym, revenue FROM revenue_monthly WHERE company_id = ? ORDER BY ym DESC LIMIT 36").bind(code),
    DB.prepare("SELECT period, inventory, cl_cur, cl_noncur FROM bs_quarterly WHERE company_id = ? AND period >= ? ORDER BY period").bind(code, oldest),
  ]);
  if (!company.name && !rev.results.length && !bs.results.length) return { error: `找不到股號 ${code} 的資料` };
  return { company, revenue: rev.results.reverse(), bs: bs.results, fetched: got.fetched };
}

/* ---------------- 篩選條件 ---------------- */

/** 回傳 { sql, binds }：名單範圍 + 股號／名稱搜尋 */
function filters(opts, alias = "") {
  const p = alias ? alias + "." : "";
  const parts = [];
  const binds = [];
  if (opts.scope === "watch") parts.push(`${p}company_id IN (SELECT company_id FROM watchlist)`);
  if (opts.scope === "holdings") parts.push(`${p}company_id IN (SELECT company_id FROM holdings)`);
  if (opts.search) {
    if (/^\d{4,6}[A-Za-z]?$/.test(opts.search)) {
      parts.push(`${p}company_id = ?`);
      binds.push(opts.search.toUpperCase());
    } else {
      parts.push(`${p}company_name LIKE ?`);
      binds.push(`%${opts.search}%`);
    }
  }
  return { sql: parts.length ? " AND " + parts.join(" AND ") : "", binds };
}

const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const MAX_ROWS = 3000;
/** from／to 日期區間（顛倒會自動對調）；沒給或格式不對回 null */
function dateRange(q) {
  let from = q.get("from"), to = q.get("to");
  if (!validDate(from) || !validDate(to)) return null;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
const validYm = (s) => /^\d{4}-\d{2}$/.test(s || "");

/* ---------------- 各端點 ---------------- */

async function meta(env) {
  const [watch, hold, dates, ims, runs] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM watchlist"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM holdings"),
    env.DB.prepare("SELECT kind, MAX(date) AS d FROM announcements GROUP BY kind"),
    env.DB.prepare("SELECT DISTINCT ym FROM insider_monthly ORDER BY ym DESC"),
    env.DB.prepare("SELECT key, value FROM meta WHERE key LIKE 'last_%'"),
  ]);
  const latestDate = {};
  dates.results.forEach((r) => (latestDate[r.kind] = r.d));
  const updated = {};
  runs.results.forEach((r) => {
    try {
      const v = JSON.parse(r.value);
      updated[r.key.slice(5)] = { at: v.at, ok: v.ok, error: v.error };
    } catch {}
  });
  return { watchCount: watch.results[0].n, holdingsCount: hold.results[0].n, latestDate, insiderMonths: ims.results.map((r) => r.ym), updated };
}

async function announcements(env, kind, date, opts, range) {
  const f = filters(opts);
  let rows;
  if (range) {
    rows = await env.DB.prepare(
      `SELECT rowid AS rid, market, company_id, company_name, date, time, subject, category, url, note, detail_at IS NOT NULL AS has_detail, company_id IN (SELECT company_id FROM holdings) AS held
       FROM announcements WHERE kind = ? AND date BETWEEN ? AND ?${f.sql} ORDER BY date DESC, time DESC LIMIT ${MAX_ROWS + 1}`
    ).bind(kind, range.from, range.to, ...f.binds).all();
    const items = rows.results;
    return { kind, from: range.from, to: range.to, items: items.slice(0, MAX_ROWS), truncated: items.length > MAX_ROWS };
  }
  if (opts.search) {
    // 搜尋公司：不限日期，最近 500 則
    rows = await env.DB.prepare(
      `SELECT rowid AS rid, market, company_id, company_name, date, time, subject, category, url, note, detail_at IS NOT NULL AS has_detail, company_id IN (SELECT company_id FROM holdings) AS held
       FROM announcements WHERE kind = ?${f.sql} ORDER BY date DESC, time DESC LIMIT 500`
    ).bind(kind, ...f.binds).all();
    return { kind, date: null, items: rows.results };
  }
  if (!validDate(date)) {
    const r = await env.DB.prepare("SELECT MAX(date) AS d FROM announcements WHERE kind = ?").bind(kind).first();
    date = r?.d || null;
  }
  if (!date) return { kind, date: null, items: [] };
  rows = await env.DB.prepare(
    `SELECT rowid AS rid, market, company_id, company_name, date, time, subject, category, url, note, detail_at IS NOT NULL AS has_detail, company_id IN (SELECT company_id FROM holdings) AS held
     FROM announcements WHERE kind = ? AND date = ?${f.sql} ORDER BY time DESC`
  ).bind(kind, date, ...f.binds).all();
  return { kind, date, items: rows.results };
}

async function announcement(env, rid) {
  if (!/^\d+$/.test(rid)) throw new Error("編號格式不對");
  let row = await env.DB.prepare(
    `SELECT rowid AS rid, kind, market, company_id, company_name, date, time, subject, category, url,
            detail_api, detail_params, speaker, clause, fact_date, detail, detail_at, note, company_id IN (SELECT company_id FROM holdings) AS held FROM announcements WHERE rowid = ?`
  ).bind(+rid).first();
  if (!row) throw new Error("找不到這則資料");
  if (row.kind === "material" && !row.detail_at && row.detail_api) {
    // 名單外的公司：第一次點開才去觀測站抓內文，抓到就存起來
    const d = await fetchDetail(row.detail_api, row.detail_params);
    const at = new Date().toISOString();
    const category = classify("material", row.subject, d.clause);
    const item = { company_id: row.company_id, category, detail: d.detail, note: makeNote(category, d.detail) };
    const epsStmts = await applyEpsNotes(env.DB, [item]);
    const note = item.note;
    await env.DB.batch([
      env.DB.prepare("UPDATE announcements SET speaker=?, clause=?, fact_date=?, detail=?, detail_at=?, category=?, note=?, cat_ver=? WHERE rowid=?")
        .bind(d.speaker, d.clause, d.fact_date, d.detail, at, category, note, RULES_VER, +rid),
      ...epsStmts,
    ]);
    row = { ...row, ...d, detail_at: at, category, note };
  }
  delete row.detail_api;
  delete row.detail_params;
  return row;
}

function monthRange(month) {
  const m = validYm(month) ? month : null;
  return m ? [m + "-01", m + "-31"] : null;
}

async function pretransfers(env, month, opts, dr) {
  const range = dr ? [dr.from, dr.to] : monthRange(month);
  const f = filters(opts);
  const cond = range ? " AND report_date BETWEEN ? AND ?" : "";
  const rows = await env.DB.prepare(
    `SELECT market, report_date, company_id, company_name, role, holder, method, shares, holding, after, transferee, period, company_id IN (SELECT company_id FROM holdings) AS held
     FROM pretransfers WHERE 1=1${cond}${f.sql} ORDER BY report_date DESC, company_id LIMIT ${MAX_ROWS}`
  ).bind(...(range || []), ...f.binds).all();
  return { month: month || null, from: dr?.from || null, to: dr?.to || null, items: rows.results };
}

async function pledges(env, month, opts, dr) {
  const range = dr ? [dr.from, dr.to] : monthRange(month);
  if (dr) month = dr.to.slice(0, 7); // 質押比例取區間結束月份以前最新的月報
  const f = filters(opts);
  const cond = range ? " AND report_date BETWEEN ? AND ?" : "";
  const [events, ymRow] = await env.DB.batch([
    env.DB.prepare(
      `SELECT market, company_id, company_name, role, holder, event_date, pledged, released, accumulated, pledgee, report_date, company_id IN (SELECT company_id FROM holdings) AS held
       FROM pledges WHERE 1=1${cond}${f.sql} ORDER BY report_date DESC, event_date DESC LIMIT ${MAX_ROWS}`
    ).bind(...(range || []), ...f.binds),
    env.DB.prepare("SELECT MAX(ym) AS ym FROM pledge_ratio" + (month && validYm(month) ? " WHERE ym <= ?" : "")).bind(...(month && validYm(month) ? [month] : [])),
  ]);
  const ym = ymRow.results[0]?.ym || null;
  let ratio = [];
  if (ym) {
    // 全部公司時只列 50% 以上，避免列表太長；名單內則全部列出
    const minRatio = opts.scope === "all" && !opts.search ? 50 : 0; // 觀察名單／持股範圍全部列出
    const r = await env.DB.prepare(
      `SELECT market, company_id, company_name, ratio, company_id IN (SELECT company_id FROM holdings) AS held FROM pledge_ratio WHERE ym = ? AND ratio >= ?${f.sql} ORDER BY ratio DESC`
    ).bind(ym, minRatio, ...f.binds).all();
    ratio = r.results;
  }
  return { month: month || null, from: dr?.from || null, to: dr?.to || null, items: events.results, ratio: { ym, items: ratio } };
}

async function insiders(env, ym, opts) {
  if (!validYm(ym)) {
    const r = await env.DB.prepare("SELECT MAX(ym) AS ym FROM insider_monthly").first();
    ym = r?.ym || null;
  }
  if (!ym) return { ym: null, changes: [], large: [] };
  const f = filters(opts);
  const [changes, large] = await env.DB.batch([
    env.DB.prepare(
      `SELECT market, company_id, company_name, issued, ds_increase, ds_decrease, ds_holding, ds_pct, mgr_holding, major_holding, company_id IN (SELECT company_id FROM holdings) AS held
       FROM insider_monthly WHERE ym = ? AND (ds_increase > 0 OR ds_decrease > 0)${f.sql}
       ORDER BY (ds_increase - ds_decrease) DESC`
    ).bind(ym, ...f.binds),
    env.DB.prepare(
      `SELECT market, direction, company_id, company_name, role, holder, shares, company_id IN (SELECT company_id FROM holdings) AS held FROM insider_large
       WHERE ym = ?${f.sql} ORDER BY direction, shares DESC`
    ).bind(ym, ...f.binds),
  ]);
  return { ym, changes: changes.results, large: large.results };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
