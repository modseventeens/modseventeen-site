/**
 * /api/youtube-notes        → 列表（只取「完成」、依影片去重、發布日期新到舊）
 * /api/youtube-notes/:id    → 單篇筆記（頁面屬性 + 內文轉成 HTML）
 *
 * 需要在 Cloudflare Pages 設定的環境變數：
 *   NOTION_TOKEN            Notion integration 的 Internal Integration Secret（設成 Secret）
 * 選填：
 *   NOTION_DATA_SOURCE_ID   預設為「YouTube 筆記（雲端）」的 data source
 *   PREFERRED_PLAN          同一支影片有多份筆記時優先顯示的方案，預設 Vertex
 *   NOTION_API_BASE         只給本機測試用，正式環境不要設
 */

const DEFAULT_DATA_SOURCE_ID = "4139889c-3580-815b-aaf8-000b02e48535";
const NOTION_VERSION = "2025-09-03";
const LIST_TTL = 300;    // 列表在邊緣快取 5 分鐘
const DETAIL_TTL = 600;  // 單篇快取 10 分鐘（Notion 圖片網址約 1 小時過期，不要拉太長）

// 欄位名稱集中在這裡，Notion 改欄位名時只要改這裡
const F = {
  title: "標題",
  date: "發布日期",
  channel: "頻道",
  link: "連結",
  status: "狀態",
  plan: "方案",
  type: "類型",
  length: "長度",
  summary: "重點摘要", // 之後在 Notion 新增這個文字欄位，網頁會自動顯示
};
const DONE_STATUS = "完成";

export async function onRequestGet(context) {
  const { env, params, request } = context;
  if (!env.NOTION_TOKEN) return json({ error: "伺服器沒有設定 NOTION_TOKEN" }, 500);

  const seg = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + "/__cache/youtube-notes/" + (seg[0] || "list"));
  const noCache = new URL(request.url).searchParams.has("refresh");

  if (!noCache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const notion = makeNotion(env);
  let res;
  try {
    if (seg.length === 0) {
      res = json({ items: await listNotes(notion, env) }, 200, LIST_TTL);
    } else if (seg.length === 1 && /^[0-9a-f-]{32,36}$/i.test(seg[0])) {
      res = json(await getNote(notion, seg[0]), 200, DETAIL_TTL);
    } else {
      return json({ error: "找不到這個路徑" }, 404);
    }
  } catch (err) {
    return json({ error: "讀取 Notion 失敗", detail: String(err.message || err) }, 502);
  }
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/* ---------------- Notion 呼叫 ---------------- */

function makeNotion(env) {
  const base = (env.NOTION_API_BASE || "https://api.notion.com").replace(/\/$/, "");
  return async function call(path, { method = "GET", body } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(base + path, {
        method,
        headers: {
          Authorization: "Bearer " + env.NOTION_TOKEN,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 429) {
        const wait = Number(r.headers.get("Retry-After") || 1);
        await new Promise((ok) => setTimeout(ok, Math.min(wait, 5) * 1000));
        continue;
      }
      if (!r.ok) throw new Error(`Notion ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return r.json();
    }
    throw new Error("Notion 回應 429 太多次");
  };
}

async function listNotes(notion, env) {
  const dsId = env.NOTION_DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID;
  const preferred = env.PREFERRED_PLAN || "Vertex";
  const pages = [];
  let cursor;
  do {
    const body = {
      page_size: 100,
      filter: { property: F.status, select: { equals: DONE_STATUS } },
      sorts: [{ property: F.date, direction: "descending" }],
    };
    if (cursor) body.start_cursor = cursor;
    const r = await notion(`/v1/data_sources/${dsId}/query`, { method: "POST", body });
    pages.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && pages.length < 2000);

  // 比較模式會讓同一支影片有好幾份：依影片 ID 分組，優先方案 → 最新建立
  const groups = new Map();
  for (const p of pages) {
    const row = toRow(p);
    const key = row.videoId || row.id;
    const cur = groups.get(key);
    if (!cur || better(row, cur, preferred)) groups.set(key, row);
  }
  return [...groups.values()].sort(
    (a, b) => (b.date || "").localeCompare(a.date || "") || b.created.localeCompare(a.created)
  );
}

function better(a, b, preferred) {
  const pa = a.plan === preferred ? 1 : 0;
  const pb = b.plan === preferred ? 1 : 0;
  if (pa !== pb) return pa > pb;
  return a.created > b.created;
}

function toRow(page) {
  const p = page.properties || {};
  const link = p[F.link]?.url || "";
  return {
    id: page.id.replace(/-/g, ""),
    title: plain(p[F.title]?.title) || "（未命名）",
    date: p[F.date]?.date?.start || "",
    channel: p[F.channel]?.select?.name || "",
    type: p[F.type]?.select?.name || "",
    plan: p[F.plan]?.select?.name || "",
    length: plain(p[F.length]?.rich_text),
    link,
    videoId: youtubeId(link),
    created: page.created_time || "",
  };
}

async function getNote(notion, id) {
  const page = await notion(`/v1/pages/${id}`);
  const row = toRow(page);
  const summaryProp = page.properties?.[F.summary];
  const summary = summaryProp?.rich_text ? plain(summaryProp.rich_text) : "";
  const blocks = await loadBlocks(notion, id, 0);
  return { ...row, summary, html: renderBlocks(blocks) };
}

async function loadBlocks(notion, blockId, depth) {
  const out = [];
  let cursor;
  do {
    const q = cursor ? `&start_cursor=${cursor}` : "";
    const r = await notion(`/v1/blocks/${blockId}/children?page_size=100${q}`);
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);

  if (depth < 3) {
    // 子頁面（例如「逐字稿全文」）不往下讀
    const need = out.filter((b) => b.has_children && b.type !== "child_page" && b.type !== "child_database");
    for (let i = 0; i < need.length; i += 3) {
      await Promise.all(
        need.slice(i, i + 3).map(async (b) => {
          b._children = await loadBlocks(notion, b.id, depth + 1);
        })
      );
    }
  }
  return out;
}

/* ---------------- 區塊轉 HTML ---------------- */

function renderBlocks(blocks) {
  let html = "";
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "bulleted_list_item" || b.type === "numbered_list_item" || b.type === "to_do") {
      const tag = b.type === "numbered_list_item" ? "ol" : "ul";
      let items = "";
      while (i < blocks.length && blocks[i].type === b.type) {
        items += renderListItem(blocks[i]);
        i++;
      }
      i--;
      html += `<${tag}${b.type === "to_do" ? ' class="todo"' : ""}>${items}</${tag}>`;
    } else {
      html += renderBlock(b);
    }
  }
  return html;
}

function renderListItem(b) {
  const d = b[b.type];
  const box = b.type === "to_do" ? `<input type="checkbox" disabled${d.checked ? " checked" : ""}> ` : "";
  return `<li>${box}${rich(d.rich_text)}${kids(b)}</li>`;
}

function kids(b) {
  return b._children?.length ? renderBlocks(b._children) : "";
}

function renderBlock(b) {
  const d = b[b.type] || {};
  switch (b.type) {
    case "paragraph": {
      const inner = rich(d.rich_text);
      return inner ? `<p>${inner}</p>${kids(b)}` : kids(b);
    }
    case "heading_1":
      return `<h3>${rich(d.rich_text)}</h3>${kids(b)}`;
    case "heading_2":
      return `<h4>${rich(d.rich_text)}</h4>${kids(b)}`;
    case "heading_3":
      return `<h5>${rich(d.rich_text)}</h5>${kids(b)}`;
    case "quote":
      return `<blockquote>${rich(d.rich_text)}${kids(b)}</blockquote>`;
    case "callout": {
      const icon = d.icon?.type === "emoji" ? `<span class="callout-icon">${esc(d.icon.emoji)}</span>` : "";
      return `<div class="callout">${icon}<div class="callout-body">${rich(d.rich_text)}${kids(b)}</div></div>`;
    }
    case "toggle":
      return `<details class="toggle"><summary>${rich(d.rich_text)}</summary>${kids(b)}</details>`;
    case "divider":
      return "<hr>";
    case "code":
      return `<pre><code>${esc(plain(d.rich_text))}</code></pre>`;
    case "image": {
      const src = d.type === "external" ? d.external?.url : d.file?.url;
      return src ? `<figure><img src="${attr(src)}" alt="" loading="lazy">${d.caption?.length ? `<figcaption>${rich(d.caption)}</figcaption>` : ""}</figure>` : "";
    }
    case "table": {
      const rows = b._children || [];
      let t = "";
      rows.forEach((r, idx) => {
        const head = d.has_column_header && idx === 0;
        const cells = (r.table_row?.cells || [])
          .map((c, ci) => {
            const tag = head || (d.has_row_header && ci === 0) ? "th" : "td";
            return `<${tag}>${rich(c)}</${tag}>`;
          })
          .join("");
        t += `<tr>${cells}</tr>`;
      });
      return `<div class="table-wrap"><table>${t}</table></div>`;
    }
    case "column_list":
    case "column":
    case "synced_block":
      return kids(b);
    // 影片另外放在彈窗最上面；子頁面（逐字稿）不顯示
    case "video":
    case "embed":
    case "child_page":
    case "child_database":
    default:
      return "";
  }
}

function rich(arr) {
  if (!arr || !arr.length) return "";
  return arr
    .map((t) => {
      let s = esc(t.plain_text || "").replace(/\n/g, "<br>");
      const a = t.annotations || {};
      if (a.code) s = `<code>${s}</code>`;
      if (a.bold) s = `<strong>${s}</strong>`;
      if (a.italic) s = `<em>${s}</em>`;
      if (a.strikethrough) s = `<s>${s}</s>`;
      if (a.underline) s = `<u>${s}</u>`;
      if (a.color && a.color !== "default") s = `<span class="c-${a.color.replace(/[^a-z_]/g, "")}">${s}</span>`;
      const href = t.href || t.text?.link?.url;
      if (href) {
        const sec = youtubeSeconds(href);
        s =
          sec !== null
            ? `<a class="ts" href="${attr(href)}" data-t="${sec}">${s}</a>`
            : `<a href="${attr(href)}" target="_blank" rel="noopener">${s}</a>`;
      }
      return s;
    })
    .join("");
}

/* ---------------- 小工具 ---------------- */

function plain(arr) {
  return (arr || []).map((t) => t.plain_text || "").join("");
}

function youtubeId(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function youtubeSeconds(url) {
  try {
    const u = new URL(url);
    if (!/youtu\.?be/.test(u.hostname)) return null;
    const t = u.searchParams.get("t") || u.searchParams.get("start");
    if (!t) return null;
    if (/^\d+s?$/.test(t)) return parseInt(t, 10);
    const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null;
  } catch {
    return null;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function attr(s) {
  const v = String(s);
  return /^(https?:)?\/\//i.test(v) ? esc(v) : "#";
}

function json(data, status = 200, ttl = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": ttl ? `public, max-age=60, s-maxage=${ttl}` : "no-store",
    },
  });
}
