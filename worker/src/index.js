// modseventeen-mops：定時抓公開資訊觀測站資料寫進 D1
//
// 排程（wrangler.toml 的 crons，時間是 UTC）：
//   每 10 分鐘（整 10 分）   即時重大訊息 + 名單公司的內文（台灣 07:00–23:59）
//   每 10 分鐘（錯開 5 分）  最新公告（台灣 07:00–23:59）
//   UTC 14:40（台灣 22:40） 當日重大訊息補抓、設質解質、事前申報、名單同步、清理 180 天前資料
//   UTC 12:00（台灣 20:00） 月報（持股異動、大額取得／轉讓、質押比例），抓到過就不再抓
//
// 手動執行（第一次部署後補資料、或除錯用）：
//   https://<worker 網址>/run?job=realtime|latest|details|daily|pledges|pretransfer|monthly|watchlist|cleanup|all&key=<RUN_KEY>
import * as M from "./mops.js";

const KEEP_DAYS = 180;
const DETAILS_PER_RUN = 15;

export default {
  async scheduled(event, env, ctx) {
    const tw = M.twNow();
    const hour = tw.getUTCHours();
    const daytime = hour >= 7;
    let jobs = [];
    if (event.cron === "*/10 * * * *") jobs = daytime ? ["realtime", "details"] : [];
    else if (event.cron === "5-59/10 * * * *") jobs = daytime ? ["latest"] : [];
    else if (event.cron === "40 14 * * *") jobs = ["daily", "pledges", "pretransfer", "watchlist", "cleanup"];
    else if (event.cron === "0 12 * * *") jobs = ["monthly"];
    if (jobs.length) ctx.waitUntil(runJobs(env, jobs));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") return new Response("modseventeen-mops", { status: 200 });
    if (!env.RUN_KEY || url.searchParams.get("key") !== env.RUN_KEY) return new Response("forbidden", { status: 403 });
    const job = url.searchParams.get("job") || "all";
    const jobs = job === "all" ? ["watchlist", "realtime", "latest", "daily", "pledges", "pretransfer", "monthly", "details"] : job.split(",");
    const report = await runJobs(env, jobs);
    return new Response(JSON.stringify(report, null, 1), { headers: { "Content-Type": "application/json; charset=utf-8" } });
  },
};

const JOBS = { realtime, latest, details, daily, pledges, pretransfer, monthly, watchlist, cleanup };

async function runJobs(env, jobs) {
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
      report[name] = await fn(env);
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
     (id, kind, market, company_id, company_name, date, time, subject, category, detail_api, detail_params, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < fresh.length; i += 50) {
    await env.DB.batch(
      fresh.slice(i, i + 50).map((r) =>
        stmt.bind(r.id, kind, r.market, r.company_id, r.company_name, r.date, r.time, r.subject, M.classify(kind, r.subject), r.detail_api, r.detail_params, r.url, now)
      )
    );
  }
  return { fetched: rows.length, added: fresh.length };
}

/** 觀察名單＋持股公司的重大訊息：抓內文（說明全文、符合條款），持股優先 */
async function details(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.rowid AS rid, a.detail_api, a.detail_params FROM announcements a
     WHERE a.kind = 'material' AND a.detail_at IS NULL AND a.detail_api <> ''
       AND (a.company_id IN (SELECT company_id FROM watchlist) OR a.company_id IN (SELECT company_id FROM holdings))
     ORDER BY (a.company_id IN (SELECT company_id FROM holdings)) DESC, a.date DESC, a.time DESC LIMIT ?`
  ).bind(DETAILS_PER_RUN).all();
  let ok = 0, failed = 0;
  for (const r of results) {
    try {
      const d = await M.fetchDetail(r.detail_api, r.detail_params);
      await env.DB.prepare("UPDATE announcements SET speaker=?, clause=?, fact_date=?, detail=?, detail_at=? WHERE rowid=?")
        .bind(d.speaker, d.clause, d.fact_date, d.detail, new Date().toISOString(), r.rid).run();
      ok++;
    } catch {
      failed++;
    }
  }
  return { ok, failed };
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
  await env.DB.batch(M.SCHEMA.map((s) => env.DB.prepare(s)));
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
