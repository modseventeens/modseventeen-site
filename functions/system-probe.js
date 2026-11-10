/**
 * /system-probe —— 測試從 Cloudflare 機房能不能抓到公開資訊觀測站等資料來源
 * 路徑以 system 開頭，會被 Cloudflare Access 的 `system*` 規則保護。
 *
 *   /system-probe          → 測試頁（瀏覽器打開，逐項執行）
 *   /system-probe?t=名稱    → 只跑單一測試，回傳 JSON
 *
 * 這支只是一次性的連線測試，確認完可以刪掉。
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const ALLOWED = ["modseventeen.com", "www.modseventeen.com", "localhost", "127.0.0.1"];

const TESTS = {
  egress: { label: "Cloudflare 出口位置", run: testEgress },
  big5: { label: "執行環境支援 Big5 解碼", run: testBig5 },
  mops_realtime_sii: { label: "觀測站｜即時重大訊息（上市）", run: () => mopsList("sii") },
  mops_realtime_otc: { label: "觀測站｜即時重大訊息（上櫃）", run: () => mopsList("otc") },
  mops_detail: { label: "觀測站｜重大訊息內文", run: testMopsDetail },
  mops_daily: { label: "觀測站｜當日重大訊息", run: testMopsDaily },
  mops_latest: { label: "觀測站｜最新公告（上市）", run: testMopsLatest },
  mopsov: { label: "觀測站舊站｜連線", run: testMopsov },
  siis_pledge: { label: "證交所 siis｜設質解質逐筆（上市）", run: () => testSiisPledge("sii") },
  siis_pledge_otc: { label: "證交所 siis｜設質解質逐筆（上櫃）", run: () => testSiisPledge("otc") },
  siis_irb110: { label: "證交所 siis｜內部人持股異動月報 IRB110", run: () => testSiisMonthly("IRB110") },
  siis_irb150: { label: "證交所 siis｜取得 100 萬股以上 IRB150", run: () => testSiisMonthly("IRB150") },
  openapi_twse_ap04: { label: "證交所 OpenAPI｜上市每日重大訊息", run: () => openapi("https://openapi.twse.com.tw/v1/opendata/t187ap04_L") },
  openapi_twse_ap12: { label: "證交所 OpenAPI｜內部人轉讓事前申報", run: () => openapi("https://openapi.twse.com.tw/v1/opendata/t187ap12_L") },
  openapi_tpex_ap04: { label: "櫃買 OpenAPI｜上櫃每日重大訊息", run: () => openapi("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O") },
};

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  if (!ALLOWED.includes(url.hostname)) return new Response("請從 modseventeen.com 開啟", { status: 403 });

  const t = url.searchParams.get("t");
  if (!t) return new Response(page(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

  const test = TESTS[t];
  if (!test) return json({ ok: false, note: "沒有這個測試" }, 404);
  const started = Date.now();
  let result;
  try {
    result = await test.run();
  } catch (err) {
    result = { ok: false, note: "例外：" + String(err && err.message ? err.message : err).slice(0, 300) };
  }
  result.ms = Date.now() - started;
  return json(result);
}

/* ---------------- 各項測試 ---------------- */

async function testEgress() {
  const r = await fetch("https://www.cloudflare.com/cdn-cgi/trace");
  const txt = await r.text();
  const kv = Object.fromEntries(txt.trim().split("\n").map((l) => l.split("=")));
  return { ok: r.ok, status: r.status, note: `機房 ${kv.colo || "?"}｜國家 ${kv.loc || "?"}`, sample: kv.ip ? "出口 IP " + kv.ip : "" };
}

async function testBig5() {
  try {
    const s = new TextDecoder("big5").decode(new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5]));
    return { ok: s === "中文", note: s === "中文" ? "支援" : "解出來是：" + s };
  } catch (e) {
    return { ok: false, note: "不支援，要另外帶解碼表：" + String(e.message || e) };
  }
}

async function mopsPost(api, body) {
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
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  return { r, text, j };
}

function mopsFail(res) {
  const blocked = /SECURITY|無法執行|Access Denied|forbidden/i.test(res.text);
  return {
    ok: false,
    status: res.r.status,
    bytes: res.text.length,
    note: blocked ? "疑似被擋：" + res.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120) : res.j ? `code ${res.j.code}：${res.j.message}` : "回應不是 JSON：" + res.text.slice(0, 120),
  };
}

async function mopsList(market) {
  const res = await mopsPost("home_page/t05sr01_1", { count: "0", marketKind: market });
  const data = res.j?.result?.data;
  if (res.j?.code !== 200 || !Array.isArray(data)) return mopsFail(res);
  const x = data[0];
  return { ok: true, status: res.r.status, bytes: res.text.length, n: data.length, sample: x ? `${x.companyId} ${x.companyAbbreviation} ${x.time}｜${x.subject.slice(0, 30)}` : "（今天還沒有資料）" };
}

async function testMopsDetail() {
  let list = await mopsPost("home_page/t05sr01_1", { count: "0", marketKind: "sii" });
  let data = list.j?.result?.data;
  if (!data?.length) {
    list = await mopsPost("home_page/t05sr01_1", { count: "0", marketKind: "otc" });
    data = list.j?.result?.data;
  }
  if (!data?.length) return { ok: false, note: "列表沒有資料可以測內文（非交易日可能是空的）" };
  const res = await mopsPost(data[0].url.apiName, data[0].url.parameters);
  const row = res.j?.result?.data?.[0];
  if (res.j?.code !== 200 || !row) return mopsFail(res);
  return { ok: true, status: res.r.status, bytes: res.text.length, n: 1, sample: `條款：${row[7]}｜說明 ${String(row[9] || "").length} 字` };
}

async function testMopsDaily() {
  // 找最近一個有資料的日子（最多往回 7 天）
  const now = new Date(Date.now() + 8 * 3600e3);
  for (let back = 0; back < 7; back++) {
    const d = new Date(now.getTime() - back * 86400e3);
    const body = { year: String(d.getUTCFullYear() - 1911), month: pad(d.getUTCMonth() + 1), day: pad(d.getUTCDate()) };
    const res = await mopsPost("t05st02", body);
    const data = res.j?.result?.data;
    if (res.j?.code !== 200 || !Array.isArray(data)) return mopsFail(res);
    if (data.length) {
      const x = data[0];
      return { ok: true, status: res.r.status, bytes: res.text.length, n: data.length, sample: `${body.year}/${body.month}/${body.day}｜${x[2]} ${x[3]}｜${String(x[4]).slice(0, 30)}` };
    }
    await sleep(500);
  }
  return { ok: true, n: 0, note: "連得到，但近 7 天都沒資料" };
}

async function testMopsLatest() {
  const res = await mopsPost("home_page/t51sb10", { count: "0", marketKind: "sii" });
  const data = res.j?.result?.data;
  if (res.j?.code !== 200 || !Array.isArray(data)) return mopsFail(res);
  const x = data[0];
  return { ok: true, status: res.r.status, bytes: res.text.length, n: data.length, sample: x ? `${x.companyId} ${x.companyAbbreviation}｜${x.subject.slice(0, 30)}` : "" };
}

async function testMopsov() {
  const r = await fetch("https://mopsov.twse.com.tw/mops/web/index", { headers: { "User-Agent": UA } });
  const text = await r.text();
  const blocked = /SECURITY|無法執行/i.test(text);
  return { ok: r.ok && !blocked, status: r.status, bytes: text.length, note: blocked ? "疑似被擋" : "" };
}

async function fetchBig5(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://mopsov.twse.com.tw/" } });
  const buf = await r.arrayBuffer();
  let text,
    decoded = true;
  try {
    text = new TextDecoder("big5").decode(buf);
  } catch {
    text = new TextDecoder("latin1").decode(buf);
    decoded = false;
  }
  return { r, text, decoded, bytes: buf.byteLength };
}

function htmlRows(text) {
  return (text.match(/<tr[\s>]/gi) || []).length;
}

function cellsOf(rowHtml) {
  return (rowHtml.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) =>
    c.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
  );
}

async function testSiisPledge(market) {
  const now = new Date(Date.now() + 8 * 3600e3);
  const y = now.getUTCFullYear() - 1911;
  const m = pad(now.getUTCMonth() + 1);
  const res = await fetchBig5(`https://siis.twse.com.tw/server-java/STAMAK03?colorchg=1&step=1&order=1&TYPEK=${market}&year=${y}&smonth=${m}&emonth=${m}`);
  const rows = htmlRows(res.text);
  const dataRow = (res.text.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []).map(cellsOf).find((c) => /^\d{4}$/.test(c[0] || ""));
  return {
    ok: res.r.ok && rows > 2,
    status: res.r.status,
    bytes: res.bytes,
    n: Math.max(0, rows - 2),
    sample: dataRow ? `${dataRow[0]} ${dataRow[1]}｜${dataRow[2]}｜設質 ${dataRow[5]}／解質 ${dataRow[6]}` : "",
    note: res.decoded ? "" : "Big5 解碼失敗，中文會是亂碼",
  };
}

async function testSiisMonthly(report) {
  const now = new Date(Date.now() + 8 * 3600e3);
  for (let back = 1; back <= 3; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const y = d.getUTCFullYear() - 1911;
    const m = pad(d.getUTCMonth() + 1);
    const res = await fetchBig5(`https://siis.twse.com.tw/publish/sii/${y}${report}_${m}.HTM`);
    if (res.r.status === 404) {
      await sleep(500);
      continue;
    }
    const rows = htmlRows(res.text);
    const dataRow = (res.text.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []).map(cellsOf).find((c) => /^\d{4}/.test(c[0] || ""));
    return {
      ok: res.r.ok && rows > 2,
      status: res.r.status,
      bytes: res.bytes,
      n: rows,
      sample: `${y} 年 ${m} 月｜` + (dataRow ? dataRow.slice(0, 4).join(" / ").slice(0, 60) : ""),
      note: res.decoded ? "" : "Big5 解碼失敗，中文會是亂碼",
    };
  }
  return { ok: false, note: "最近 3 個月的月報都找不到（404）" };
}

async function openapi(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const text = await r.text();
  let arr = null;
  try {
    arr = JSON.parse(text);
  } catch {}
  if (!Array.isArray(arr)) return { ok: false, status: r.status, bytes: text.length, note: "回應不是 JSON 陣列：" + text.replace(/\s+/g, " ").slice(0, 120) };
  const x = arr[0] || {};
  return { ok: true, status: r.status, bytes: text.length, n: arr.length, sample: Object.values(x).slice(0, 4).join(" / ").slice(0, 60) };
}

/* ---------------- 小工具與測試頁 ---------------- */

function pad(n) {
  return String(n).padStart(2, "0");
}
function sleep(ms) {
  return new Promise((ok) => setTimeout(ok, ms));
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function page() {
  const list = JSON.stringify(Object.entries(TESTS).map(([k, v]) => [k, v.label]));
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>資料來源連線測試</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#0a0a0a}
h1{font-size:24px;margin-bottom:6px}p{color:#666;margin-top:0}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:16px}
th,td{border-bottom:1px solid #e5e5e5;padding:8px 6px;text-align:left;vertical-align:top}
th{color:#666;font-weight:600}td.r{white-space:nowrap}.ok{color:#1b8a3a;font-weight:700}.ng{color:#c62828;font-weight:700}.wait{color:#999}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #0a0a0a;background:#0a0a0a;color:#fff;cursor:pointer;margin-right:8px}
button.sec{background:#fff;color:#0a0a0a}#msg{color:#006aff;margin-left:6px}
</style></head><body>
<h1>資料來源連線測試</h1>
<p>從 Cloudflare 機房逐項連線，每項之間間隔 1 秒，全部跑完約 30–60 秒。</p>
<button id="run">開始測試</button><button id="copy" class="sec">複製結果</button><span id="msg"></span>
<table><thead><tr><th>測試項目</th><th>結果</th><th>HTTP</th><th>耗時</th><th>筆數</th><th>內容樣本／說明</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const TESTS = ${list};
const results = {};
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function draw() {
  document.getElementById("rows").innerHTML = TESTS.map(([k, label]) => {
    const r = results[k];
    const st = !r ? '<span class="wait">等待中</span>' : r.running ? '<span class="wait">執行中…</span>' : r.ok ? '<span class="ok">通過</span>' : '<span class="ng">失敗</span>';
    return "<tr><td>" + esc(label) + "</td><td class=r>" + st + "</td><td class=r>" + esc(r && r.status) + "</td><td class=r>" + (r && r.ms != null ? r.ms + " ms" : "") +
      "</td><td class=r>" + esc(r && r.n) + "</td><td>" + esc([r && r.sample, r && r.note].filter(Boolean).join("｜")) + "</td></tr>";
  }).join("");
}
draw();
document.getElementById("run").onclick = async () => {
  document.getElementById("run").disabled = true;
  for (const [k] of TESTS) {
    results[k] = { running: true }; draw();
    try {
      const r = await fetch("?t=" + k);
      const text = await r.text();
      try { results[k] = JSON.parse(text); }
      catch { results[k] = { ok: false, status: r.status, note: "函式沒有正常回應（可能超過 CPU 時間上限）：" + text.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").slice(0, 120) }; }
    } catch (e) { results[k] = { ok: false, note: String(e) }; }
    draw();
    await new Promise(r => setTimeout(r, 1000));
  }
  document.getElementById("run").disabled = false;
  document.getElementById("msg").textContent = "完成，按「複製結果」貼給 Claude";
};
document.getElementById("copy").onclick = async () => {
  const out = TESTS.map(([k, label]) => ({ test: k, label, ...results[k] }));
  await navigator.clipboard.writeText(JSON.stringify(out, null, 1));
  document.getElementById("msg").textContent = "已複製";
};
</script></body></html>`;
}
