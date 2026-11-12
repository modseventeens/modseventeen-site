// modseventeen-mops：定時抓公開資訊觀測站資料寫進 D1
//
// 排程（wrangler.toml 的 crons，時間是 UTC）：
//   每 10 分鐘（整 10 分）   即時重大訊息 + 重大訊息內文（台灣 07:00–23:59）
//   每 10 分鐘（錯開 5 分）  最新公告（台灣 07:00–23:59）＋ 舊資料重新分類（全天）
//   夜間（台灣 00:00–06:59）兩個 10 分鐘排程：月營收（每次一份彙總表）、補持股＋觀察名單的資產負債表（每次一家）
//   UTC 14:40（台灣 22:40） 當日重大訊息補抓、設質解質、事前申報、名單同步、清理 180 天前資料
//   UTC 12:00（台灣 20:00） 月報（持股異動、大額取得／轉讓、質押比例），抓到過就不再抓
//
// 手動執行（第一次部署後補資料、或除錯用）：
//   https://<worker 網址>/run?job=realtime|latest|details|daily|pledges|pretransfer|monthly|watchlist|cleanup|all&key=<RUN_KEY>
//   回補存貨與合約負債：curl -X POST "https://<worker 網址>/run?job=importbs&key=<RUN_KEY>" --data-binary @bs.csv
//   回補月營收：curl -X POST "https://<worker 網址>/run?job=importrev&key=<RUN_KEY>" --data-binary @rev.csv
//   回補各季累計 EPS：curl -X POST "https://<worker 網址>/run?job=importeps&key=<RUN_KEY>" --data-binary @eps.csv
import * as M from "./mops.js";
import * as K from "./metrics.js";

const KEEP_DAYS = 180;
const DETAILS_PER_RUN = 12; // 每 10 分鐘抓幾則內文（量小一點，讓每次執行的 CPU 時間短一點）
const DETAILS_OTHERS_DAYS = 3; // 名單外的公司只補抓最近幾天的內文，點開時仍會即時抓
const RECLASSIFY_PER_RUN = 80;

export default {
  async scheduled(event, env, ctx) {
    const tw = M.twNow();
    const hour = tw.getUTCHours();
    const daytime = hour >= 7;
    let jobs = [];
    // 工作拆到兩個排程，每次執行的量比較小
    // 夜間（00:00–06:59）空檔：月營收、補持股＋觀察名單的資產負債表
    if (event.cron === "*/10 * * * *") jobs = daytime ? ["realtime", "details"] : ["bs"];
    // 每月 1～15 日白天也跑月營收（每次一份彙總表），新出現的公司會變成一則「營收」重大訊息
    else if (event.cron === "5-59/10 * * * *") jobs = daytime ? (tw.getUTCDate() <= 15 ? ["latest", "reclassify", "revenue"] : ["latest", "reclassify"]) : ["reclassify", "revenue", "bs"];
    else if (event.cron === "40 14 * * *") jobs = ["daily", "pledges", "pretransfer", "watchlist", "cleanup"];
    else if (event.cron === "0 12 * * *") jobs = ["monthly"];
    if (jobs.length) ctx.waitUntil(runJobs(env, jobs));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") return new Response("modseventeen-mops", { status: 200 });
    if (!env.RUN_KEY || url.searchParams.get("key") !== env.RUN_KEY) return new Response("forbidden", { status: 403 });
    const job = url.searchParams.get("job") || "all";
    if (job === "importbs") {
      // 回補存貨與合約負債：POST 一個 CSV（B,股號,YYYYQn,存貨,合約負債流動,合約負債非流動；千元）
      if (request.method !== "POST") return new Response("請用 POST 上傳檔案", { status: 405 });
      await ensureSchema(env);
      const report = await importBs(env, await request.text());
      return new Response(JSON.stringify(report, null, 1), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    if (job === "importrev") {
      // 回補月營收：POST 一個 CSV（R,股號,YYYY-MM,營收／C,股號,市場,名稱）
      if (request.method !== "POST") return new Response("請用 POST 上傳檔案", { status: 405 });
      await ensureSchema(env);
      const report = await importRevenue(env, await request.text());
      return new Response(JSON.stringify(report, null, 1), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    if (job === "importeps") {
      // 回補各季累計 EPS：POST 一個 CSV（年度,季別,股號,累計EPS，一行一筆）
      if (request.method !== "POST") return new Response("請用 POST 上傳檔案", { status: 405 });
      await ensureSchema(env);
      const report = await importEps(env, await request.text());
      return new Response(JSON.stringify(report, null, 1), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    const jobs = job === "all" ? ["watchlist", "realtime", "latest", "daily", "pledges", "pretransfer", "monthly", "details", "reclassify"] : job.split(",");
    // 手動執行 all 時同一次已經發了很多對外請求，內文少抓一點，避免超過免費方案上限
    const report = await runJobs(env, jobs, { detailsLimit: job === "all" ? 5 : DETAILS_PER_RUN });
    return new Response(JSON.stringify(report, null, 1), { headers: { "Content-Type": "application/json; charset=utf-8" } });
  },
};

const JOBS = { realtime, latest, details, daily, pledges, pretransfer, monthly, watchlist, cleanup, reclassify, revenue, bs };

async function runJobs(env, jobs, opts = {}) {
  await ensureSchema(env);
  const report = {};
  for (const name of jobs) {
    const fn = JOBS[name];
    if (!fn) {
      report[name] = "沒有這個工作";
      continue;
    }
    const t0 = Date.now();
    try {
      report[name] = await fn(env, opts);
      await setMeta(env, "last_" + name, JSON.stringify({ at: new Date().toISOString(), ok: true, result: report[name] }));
    } catch (err) {
      report[name] = { error: String(err.message || err) };
      await setMeta(env, "last_" + name, JSON.stringify({ at: new Date().toISOString(), ok: false, error: report[name].error })).catch(() => {});
    }
    report[name] = { ...report[name], ms: Date.now() - t0 };
  }
  return report;
}

/* ---------------- 工作 ---------------- */

async function realtime(env) {
  const result = {};
  for (const market of M.MARKETS) {
    const rows = await M.fetchRealtime(market);
    result[market] = await insertAnnouncements(env, "material", rows);
  }
  return result;
}

async function latest(env) {
  const result = {};
  for (const market of M.MARKETS) {
    const rows = await M.fetchLatest(market);
    result[market] = await insertAnnouncements(env, "latest", rows);
  }
  return result;
}

async function daily(env) {
  // 當日重大訊息：補抓今天與昨天，避免即時列表漏掉
  const today = M.twNow();
  let added = 0;
  for (const back of [0, 1]) {
    const d = new Date(today.getTime() - back * 86400e3);
    const rows = await M.fetchDaily(d);
    added += (await insertAnnouncements(env, "material", rows)).added;
  }
  return { added };
}

/** 只寫入沒看過的；先用同一天的 id 清單比對，避免重複寫入浪費額度 */
async function insertAnnouncements(env, kind, rows) {
  if (!rows.length) return { fetched: 0, added: 0 };
  const dates = [...new Set(rows.map((r) => r.date))];
  const seen = new Set();
  for (const date of dates) {
    const { results } = await env.DB.prepare("SELECT id FROM announcements WHERE kind = ? AND date = ?").bind(kind, date).all();
    results.forEach((r) => seen.add(r.id));
  }
  const now = new Date().toISOString();
  const fresh = rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO announcements
     (id, kind, market, company_id, company_name, date, time, subject, category, detail_api, detail_params, url, created_at, cat_ver)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < fresh.length; i += 50) {
    await env.DB.batch(
      fresh.slice(i, i + 50).map((r) =>
        stmt.bind(r.id, kind, r.market, r.company_id, r.company_name, r.date, r.time, r.subject, M.classify(kind, r.subject), r.detail_api, r.detail_params, r.url, now, M.RULES_VER)
      )
    );
  }
  return { fetched: rows.length, added: fresh.length };
}

/**
 * 重大訊息內文：抓到後依「符合條款」重新分類，並算出備註（金額／法說會時間地點／EPS）
 * 優先順序：持股 → 觀察名單 → 其他公司（只補最近幾天）
 */
async function details(env, opts = {}) {
  const limit = opts.detailsLimit || DETAILS_PER_RUN;
  const since = M.isoDate(new Date(M.twNow().getTime() - DETAILS_OTHERS_DAYS * 86400e3));
  const HELD = "a.company_id IN (SELECT company_id FROM holdings)";
  const WATCH = "a.company_id IN (SELECT company_id FROM watchlist)";
  const { results } = await env.DB.prepare(
    `SELECT a.rowid AS rid, a.company_id, a.subject, a.detail_api, a.detail_params FROM announcements a
     WHERE a.kind = 'material' AND a.detail_at IS NULL AND a.detail_api <> '' AND COALESCE(a.detail_tries, 0) < 3
       AND (${HELD} OR ${WATCH} OR a.date >= ?)
     ORDER BY (${HELD}) DESC, (${WATCH}) DESC, a.date DESC, a.time DESC LIMIT ?`
  ).bind(since, limit).all();
  const now = new Date().toISOString();
  const updates = [];
  const done = [];
  let ok = 0, failed = 0;
  for (const r of results) {
    try {
      const d = await M.fetchDetail(r.detail_api, r.detail_params);
      const category = M.classify("material", r.subject, d.clause);
      done.push({ r, d, company_id: r.company_id, category, detail: d.detail, note: M.makeNote(category, d.detail) });
      ok++;
    } catch {
      updates.push(env.DB.prepare("UPDATE announcements SET detail_tries = COALESCE(detail_tries, 0) + 1 WHERE rowid=?").bind(r.rid));
      failed++;
    }
  }
  const epsStmts = await M.applyEpsNotes(env.DB, done);
  for (const x of done) {
    updates.push(env.DB.prepare(
      "UPDATE announcements SET speaker=?, clause=?, fact_date=?, detail=?, detail_at=?, category=?, note=?, cat_ver=? WHERE rowid=?"
    ).bind(x.d.speaker, x.d.clause, x.d.fact_date, x.d.detail, now, x.category, x.note, M.RULES_VER, x.r.rid));
  }
  updates.push(...epsStmts);
  if (updates.length) await env.DB.batch(updates);
  return { ok, failed };
}

/** 規則改版後，分批把舊資料重新分類、重算備註 */
async function reclassify(env) {
  const { results } = await env.DB.prepare(
    "SELECT rowid AS rid, kind, company_id, subject, clause, detail FROM announcements WHERE cat_ver IS NULL OR cat_ver < ? ORDER BY date DESC, time DESC LIMIT ?"
  ).bind(M.RULES_VER, RECLASSIFY_PER_RUN).all();
  if (!results.length) return { updated: 0 };
  const stmt = env.DB.prepare("UPDATE announcements SET category=?, note=?, cat_ver=? WHERE rowid=?");
  const items = results.map((r) => {
    const category = M.classify(r.kind, r.subject, r.clause);
    return { r, company_id: r.company_id, category, detail: r.detail, note: r.kind === "material" ? M.makeNote(category, r.detail) : "" };
  });
  const epsStmts = await M.applyEpsNotes(env.DB, items.filter((x) => x.r.kind === "material"));
  const stmts = items.map((x) => stmt.bind(x.category, x.note, M.RULES_VER, x.r.rid)).concat(epsStmts);
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { updated: results.length };
}

async function pledges(env) {
  const months = monthsToRefresh();
  const result = {};
  for (const market of M.MARKETS) {
    let rows = [];
    for (const m of months) rows = rows.concat(await M.fetchPledges(market, m));
    result[market] = await insertRows(env, "pledges",
      ["id", "market", "company_id", "company_name", "role", "holder", "event_date", "pledged", "released", "accumulated", "pledgee", "note", "report_date"], rows);
  }
  return result;
}

async function pretransfer(env) {
  const months = monthsToRefresh();
  const result = {};
  for (const market of M.MARKETS) {
    let rows = [];
    for (const m of months) rows = rows.concat(await M.fetchPretransfer(market, m));
    result[market] = await insertRows(env, "pretransfers",
      ["id", "market", "status", "report_date", "company_id", "company_name", "role", "holder", "method", "shares", "holding", "after", "transferee", "period"], rows);
  }
  return result;
}

/** 每月 1–5 日也重抓上個月，避免月底最後幾天的申報漏掉 */
function monthsToRefresh() {
  const tw = M.twNow();
  const thisMonth = M.addMonths(tw, 0);
  return tw.getUTCDate() <= 5 ? [M.addMonths(tw, -1), thisMonth] : [thisMonth];
}

async function monthly(env) {
  const tw = M.twNow();
  const result = {};
  // 月報約在次月 15–20 日公布；檢查最近兩個月還沒抓到的
  for (const back of [1, 2]) {
    const m = M.addMonths(tw, -back);
    const ym = M.ymOf(m);
    const done = await getMeta(env, "monthly_" + ym);
    if (done) {
      result[ym] = "已抓過";
      continue;
    }
    let complete = true;
    const counts = {};
    for (const market of M.MARKETS) {
      const im = await M.fetchIRB110(market, m);
      const acq = await M.fetchIRBLarge(market, m, "IRB150");
      const tra = await M.fetchIRBLarge(market, m, "IRB140");
      const pr = await M.fetchIRB180(market, m);
      if (!im) {
        complete = false;
        counts[market] = "還沒公布";
        continue;
      }
      counts[market] = {
        insider_monthly: (await insertRows(env, "insider_monthly",
          ["id", "ym", "market", "company_id", "company_name", "issued", "ds_increase", "ds_decrease", "ds_holding", "ds_pct", "mgr_holding", "major_holding"], im, true)).added,
        insider_large: (await insertRows(env, "insider_large",
          ["id", "ym", "market", "direction", "company_id", "company_name", "role", "holder", "shares"], [...(acq || []), ...(tra || [])], true)).added,
        pledge_ratio: (await insertRows(env, "pledge_ratio", ["id", "ym", "market", "company_id", "company_name", "ratio"], pr || [], true)).added,
      };
    }
    if (complete) await setMeta(env, "monthly_" + ym, new Date().toISOString());
    result[ym] = counts;
  }
  return result;
}

async function watchlist(env) {
  const result = {};
  // 觀察名單：讀到空的就保留原本的，避免發佈設定出錯時把名單清空
  if (!env.WATCHLIST_CSV_URL) result.watchlist = { skipped: "沒有設定 WATCHLIST_CSV_URL" };
  else {
    try {
      const list = await M.fetchWatchlist(env.WATCHLIST_CSV_URL);
      result.watchlist = list.length ? { count: await replaceList(env, "watchlist", list) } : { skipped: "名單是空的，保留原本的名單" };
    } catch (err) {
      result.watchlist = { error: String(err.message || err) };
    }
  }
  // 持股：可以是空的（全部賣出），但讀取失敗時保留原本的
  const url = M.holdingsCsvUrl(env);
  if (!url) result.holdings = { skipped: "沒有持股名單網址" };
  else {
    try {
      const list = await M.fetchWatchlist(url);
      result.holdings = { count: await replaceList(env, "holdings", list) };
    } catch (err) {
      result.holdings = { error: String(err.message || err) };
    }
  }
  if (result.watchlist.error && result.holdings.error) throw new Error(`觀察名單：${result.watchlist.error}；持股：${result.holdings.error}`);
  return result;
}

async function replaceList(env, table, list) {
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(`INSERT INTO ${table} (company_id, name, note, updated_at) VALUES (?, ?, ?, ?)`);
  const stmts = [env.DB.prepare(`DELETE FROM ${table}`)];
  list.forEach((w) => stmts.push(stmt.bind(w.company_id, w.name, w.note, now)));
  await env.DB.batch(stmts);
  return list.length;
}

/* ---------------- 關鍵指標 ---------------- */

const REV_FILES = [["sii", 0], ["sii", 1], ["otc", 0], ["otc", 1]];

/**
 * 月營收：上個月的 4 份彙總表，每次只處理一份。
 *   1～15 日：每份至少隔 35 分鐘重抓一次（公司陸續申報）；之後沒抓過才抓。
 *   新出現的公司（資料庫還沒有這個月的營收）→ 寫成一則「營收」類重大訊息；
 *   一次新出現太多家（> 400，例如第一次跑或回補）就只寫數字、不發公告，避免把舊資料當新聞。
 */
const REV_REFRESH_MS = 35 * 60e3;
const REV_BULK = 400;
async function revenue(env) {
  const tw = M.twNow();
  const today = M.isoDate(tw);
  const day = tw.getUTCDate();
  const month = M.addMonths(tw, -1);
  const ym = `${month.getUTCFullYear()}-${M.pad(month.getUTCMonth() + 1)}`;
  const rocY = month.getUTCFullYear() - 1911, m = month.getUTCMonth() + 1;
  const keys = REV_FILES.map(([market, part]) => `rev_${ym}_${market}${part}`);
  const { results } = await env.DB.prepare(`SELECT key, value FROM meta WHERE key IN (${keys.map(() => "?").join(",")})`).bind(...keys).all();
  const last = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const stale = (k) => !last[k] || (day <= 15 && Date.now() - Date.parse(last[k].length === 10 ? last[k] + "T00:00:00+08:00" : last[k]) > REV_REFRESH_MS);
  const cand = keys.map((k, i) => i).filter((i) => stale(keys[i]));
  if (!cand.length) return { ym, status: "已是最新" };
  // 最久沒更新的先抓
  cand.sort((a, b) => (last[keys[a]] || "").localeCompare(last[keys[b]] || ""));
  const i = cand[0];
  const [market, part] = REV_FILES[i];
  const rows = await K.fetchRevenue(market, rocY, m, part);
  const now = new Date().toISOString();
  const { results: have } = await env.DB.prepare("SELECT company_id FROM revenue_monthly WHERE ym = ?").bind(ym).all();
  const haveSet = new Set(have.map((r) => r.company_id));
  const fresh = rows.filter((r) => r.cur != null && !haveSet.has(r.code));
  const stmts = rows.length ? K.revenueStatements(env.DB, rows, market, ym, now) : [];
  let announced = 0;
  if (fresh.length && fresh.length <= REV_BULK) {
    const time = `${M.pad(tw.getUTCHours())}:${M.pad(tw.getUTCMinutes())}:${M.pad(tw.getUTCSeconds())}`;
    const ins = env.DB.prepare(
      `INSERT OR IGNORE INTO announcements (id, kind, market, company_id, company_name, date, time, subject, category, url, note, detail, detail_at, created_at, cat_ver)
       VALUES (?, 'material', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of fresh) {
      const a = K.revenueAnnouncement(r, market, ym, today, time);
      stmts.push(ins.bind(a.id, a.market, a.company_id, a.company_name, a.date, a.time, a.subject, a.category, a.url, a.note, a.detail, now, now, M.RULES_VER));
      announced++;
    }
  }
  stmts.push(env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(keys[i], now));
  await env.DB.batch(stmts);
  return { ym, file: `${market}${part}`, companies: rows.length, fresh: fresh.length, announced };
}

/** 資產負債表：每次補一家持股／觀察名單公司（最多抓 12 季報表） */
async function bs(env) {
  const today = M.isoDate(M.twNow());
  const code = await K.nextCompanyNeedingBs(env.DB, today);
  if (!code) return { status: "持股與觀察名單都已補齊" };
  return { company: code, ...(await K.ensureBalanceSheets(env.DB, code, today, { maxFetch: 12 })) };
}

/** 匯入回補的存貨與合約負債（較新的季報已寫入的數字不覆蓋） */
async function importBs(env, text) {
  const rows = K.parseBsCsv(text);
  if (!rows.length) return { imported: 0, error: "檔案裡沒有資料" };
  const now = new Date().toISOString();
  const v = (x) => (x == null ? "NULL" : x);
  const stmts = [];
  for (let i = 0; i < rows.length; i += 300) {
    stmts.push(env.DB.prepare(
      `INSERT INTO bs_quarterly (company_id, period, inventory, cl_cur, cl_noncur, src, updated_at) VALUES ${rows.slice(i, i + 300)
        .map((r) => `('${r.code}','${r.period}',${v(r.inventory)},${r.cl_cur},${r.cl_noncur},'${r.period}','${now}')`).join(",")}
       ON CONFLICT(company_id, period) DO NOTHING`
    ));
  }
  await env.DB.batch(stmts);
  const periods = [...new Set(rows.map((r) => r.period))].sort();
  return { imported: rows.length, companies: new Set(rows.map((r) => r.code)).size, from: periods[0], to: periods.at(-1) };
}

/** 匯入回補的月營收 */
async function importRevenue(env, text) {
  const { rev, names } = K.parseRevenueCsv(text);
  if (!rev.length && !names.length) return { imported: 0, error: "檔案裡沒有資料" };
  const now = new Date().toISOString();
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const stmts = [];
  for (let i = 0; i < rev.length; i += 400) {
    stmts.push(env.DB.prepare(
      `INSERT INTO revenue_monthly (company_id, ym, revenue) VALUES ${rev.slice(i, i + 400).map((r) => `(${q(r.code)},'${r.ym}',${r.rev})`).join(",")} ${K.REV_UPSERT}`
    ));
  }
  for (let i = 0; i < names.length; i += 300) {
    stmts.push(env.DB.prepare(
      `INSERT INTO company_names (company_id, name, market, updated_at) VALUES ${names.slice(i, i + 300).map((n) => `(${q(n.code)},${q(n.name)},'${n.market}','${now}')`).join(",")} ${K.NAME_UPSERT}`
    ));
  }
  await env.DB.batch(stmts);
  const months = [...new Set(rev.map((r) => r.ym))].sort();
  return { imported: rev.length, companies: names.length, from: months[0], to: months.at(-1) };
}

/** 匯入回補的累計 EPS，並讓財報備註全部重算 */
async function importEps(env, text) {
  const rows = M.parseEpsCsv(text);
  if (!rows.length) return { imported: 0, error: "檔案裡沒有資料" };
  const now = new Date().toISOString();
  const stmts = [];
  for (let i = 0; i < rows.length; i += 400) {
    const values = rows.slice(i, i + 400).map((r) => `('${r.code}',${r.year},${r.q},${r.eps},'mops','${now}')`).join(",");
    stmts.push(env.DB.prepare(
      `INSERT INTO eps_cum (company_id, year, quarter, eps, source, updated_at) VALUES ${values}
       ON CONFLICT(company_id, year, quarter) DO UPDATE SET eps=excluded.eps, source=excluded.source, updated_at=excluded.updated_at`
    ));
  }
  stmts.push(env.DB.prepare("UPDATE announcements SET cat_ver = NULL WHERE category = '財報'"));
  const res = await env.DB.batch(stmts);
  const quarters = {};
  for (const r of rows) quarters[`${r.year}Q${r.q}`] = (quarters[`${r.year}Q${r.q}`] || 0) + 1;
  return { imported: rows.length, quarters, renote: res.at(-1).meta?.changes || 0 };
}

async function cleanup(env) {
  const cutoff = M.isoDate(new Date(M.twNow().getTime() - KEEP_DAYS * 86400e3));
  const cutoffYm = cutoff.slice(0, 7);
  const res = await env.DB.batch([
    env.DB.prepare("DELETE FROM announcements WHERE date < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM pledges WHERE report_date < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM pretransfers WHERE report_date < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM insider_monthly WHERE ym < ?").bind(cutoffYm),
    env.DB.prepare("DELETE FROM insider_large WHERE ym < ?").bind(cutoffYm),
    env.DB.prepare("DELETE FROM pledge_ratio WHERE ym < ?").bind(cutoffYm),
  ]);
  return { deleted: res.reduce((s, r) => s + (r.meta?.changes || 0), 0), cutoff };
}

/* ---------------- 小工具 ---------------- */

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await M.migrate(env.DB);
  schemaReady = true;
}

/** 一般資料表：INSERT OR IGNORE；replace=true 時改用 INSERT OR REPLACE（月報可能被更正） */
async function insertRows(env, table, cols, rows, replace = false) {
  if (!rows.length) return { fetched: 0, added: 0 };
  const verb = replace ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  const hasCreated = ["pledges", "pretransfers"].includes(table);
  const allCols = hasCreated ? [...cols, "created_at"] : cols;
  const stmt = env.DB.prepare(`${verb} INTO ${table} (${allCols.join(",")}) VALUES (${allCols.map(() => "?").join(",")})`);
  const now = new Date().toISOString();
  let added = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const res = await env.DB.batch(
      rows.slice(i, i + 50).map((r) => stmt.bind(...cols.map((c) => r[c] ?? null), ...(hasCreated ? [now] : [])))
    );
    added += res.reduce((s, x) => s + (x.meta?.changes || 0), 0);
  }
  return { fetched: rows.length, added };
}

async function getMeta(env, key) {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  return r ? r.value : null;
}
async function setMeta(env, key, value) {
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key, value).run();
}
