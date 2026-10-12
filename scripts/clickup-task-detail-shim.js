/**
 * 测试夹具：给旧的 ClickUp fetch 替身补上 GET /task/{id}（任务详情）端点。
 * 审查六④ 起，复用记住的任务 id 前会按 id 回查远端标题/清单/状态。旧用例的替身只认
 * 「列表查询」，对详情请求也回列表形状。这里按替身自己暴露过的数据（列表结果里的任务、
 * POST /task 建出的任务）合成详情：已知 → 200 {id,name,list,status:open}；未知 → 404。
 * 替身自己给出了真正的详情（带 name 字符串）时原样透传，新用例可借此模拟改名/关闭/网络失败。
 */
"use strict";

const DEFAULT_LIST_ID = "901818920363";

// 同一个替身（= 同一个「远端」）的多个页面共享已知任务，跟真实服务端一致
const knownByRemote = new WeakMap();

function withTaskDetail(fetchImpl, { listId = DEFAULT_LIST_ID } = {}) {
  if (typeof fetchImpl !== "function") return fetchImpl;
  if (!knownByRemote.has(fetchImpl)) knownByRemote.set(fetchImpl, new Map());
  const known = knownByRemote.get(fetchImpl);
  const reply = (status, body) => ({
    ok: status < 400,
    status,
    headers: { get: () => "application/json" },
    async text() { return JSON.stringify(body); },
  });
  const buffered = async (res) => {
    const text = await res.text();
    return { text, res: { ...res, text: async () => text } };
  };
  return async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || "GET";
    const detail = /\/api\/v2\/task\/([^/?]+)$/.exec(u);
    if (detail && method === "GET") {
      const id = decodeURIComponent(detail[1]);
      const res = await fetchImpl(url, opts);
      if (!res || !res.ok) return res;
      const { text, res: copy } = await buffered(res);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (parsed && typeof parsed === "object" && typeof parsed.name === "string" && !Array.isArray(parsed.tasks)) return copy;
      const name = known.get(id);
      if (name === undefined) return reply(404, { err: "Task not found", ECODE: "ITEM_013" });
      return reply(200, { id, name, list: { id: listId }, status: { status: "to do", type: "open" }, archived: false });
    }
    const res = await fetchImpl(url, opts);
    const isList = method === "GET" && /\/list\/[^/]+\/task\?/.test(u);
    const isCreate = method === "POST" && /\/list\/[^/]+\/task$/.test(u);
    if (!res || !res.ok || (!isList && !isCreate)) return res;
    const { text, res: copy } = await buffered(res);
    try {
      const parsed = JSON.parse(text);
      if (isList && parsed && Array.isArray(parsed.tasks)) {
        for (const t of parsed.tasks) if (t && t.id != null && typeof t.name === "string") known.set(String(t.id), t.name);
      }
      if (isCreate && parsed && parsed.id != null) {
        let name = "";
        try { name = JSON.parse(opts.body).name; } catch { name = ""; }
        known.set(String(parsed.id), typeof parsed.name === "string" ? parsed.name : name);
      }
    } catch { /* 非 JSON：原样返回 */ }
    return copy;
  };
}

module.exports = { withTaskDetail, DEFAULT_LIST_ID };
