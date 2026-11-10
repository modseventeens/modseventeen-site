// worker/ 資料夾是排程 Worker 的原始碼，不對外提供
export function onRequest() {
  return new Response("Not found", { status: 404 });
}
