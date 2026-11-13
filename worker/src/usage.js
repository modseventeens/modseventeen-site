// D1 用量計量：每次執行把讀取／寫入列數記到 meta 的 usage_<UTC 日期>（D1 每日額度以 UTC 午夜重置）
// 免費方案：每天寫入 100,000 列、讀取 5,000,000 列；有索引的欄位，每寫一列會多算一列（索引也算寫入）。

export const DAILY_WRITE_LIMIT = 100000;
export const DAILY_READ_LIMIT = 5000000;
export const ROUTINE_RESERVE = 25000; // 留給排程與網頁的量，匯入不能吃掉

const utcDay = () => new Date().toISOString().slice(0, 10);

/** 包一層 D1：所有查詢的 meta.rows_read／rows_written 都會累加到 counter */
export function meter(DB, counter = { r: 0, w: 0 }) {
  const add = (res) => {
    for (const x of Array.isArray(res) ? res : [res]) {
      counter.r += x?.meta?.rows_read || 0;
      counter.w += x?.meta?.rows_written || 0;
    }
    return res;
  };
  const wrapStmt = (st) =>
    new Proxy(st, {
      get(t, k) {
        if (k === "__raw") return t; // batch() 要用原本的 D1 statement
        if (k === "bind") return (...a) => wrapStmt(t.bind(...a));
        if (k === "run" || k === "all") return async (...a) => add(await t[k](...a));
        if (k === "first") {
          // first() 不回 meta；改用 all() 取第一列，才能記到讀取量
          return async (col) => {
            const res = add(await t.all());
            const row = res.results?.[0] ?? null;
            return row && col ? row[col] : row;
          };
        }
        const v = t[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const db = new Proxy(DB, {
    get(t, k) {
      if (k === "prepare") return (sql) => wrapStmt(t.prepare(sql));
      if (k === "batch") return async (stmts) => add(await t.batch(stmts.map((s) => s.__raw || s)));
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { db, counter };
}

/** 把這次的用量加進今天的紀錄（用原本的 DB 寫，避免把自己也算進去） */
export async function record(DB, name, counter) {
  if (!counter.r && !counter.w) return;
  const key = "usage_" + utcDay();
  try {
    const row = await DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
    const u = row ? JSON.parse(row.value) : { r: 0, w: 0, jobs: {} };
    u.r += counter.r;
    u.w += counter.w + 1; // 這筆紀錄本身也算 1 列寫入
    const j = (u.jobs[name] ||= { r: 0, w: 0, n: 0 });
    j.r += counter.r;
    j.w += counter.w;
    j.n += 1;
    await DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key, JSON.stringify(u)).run();
  } catch (e) {
    console.log("用量紀錄失敗：", String(e.message || e));
  }
}

export async function today(DB) {
  const row = await DB.prepare("SELECT value FROM meta WHERE key = ?").bind("usage_" + utcDay()).first();
  return row ? JSON.parse(row.value) : { r: 0, w: 0, jobs: {} };
}

/** 匯入前檢查：預估寫入量（列數 × 每列寫入數）加上今天已用，不能超過「上限 − 保留量」 */
export async function checkBudget(DB, rows, perRow = 2) {
  const u = await today(DB);
  const need = rows * perRow;
  const room = DAILY_WRITE_LIMIT - ROUTINE_RESERVE - u.w;
  return { ok: need <= room, used: u.w, need, room: Math.max(room, 0) };
}
