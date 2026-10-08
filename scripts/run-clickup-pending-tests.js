/**
 * ClickUp 番茄打卡「待核对」回归测试（Node，无真机）
 * 直接打卡超时后只留 pending、不入队；对账确认远端没有时，过了宽限期必须转入补发队列，
 * 否则这条番茄永远进不了 ClickUp，「待核对」也永远不消。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "www", "js", "mobile-clickup.js"), "utf8");
const PENDING_KEY = "lumina-cu-pending-pomo-v1";
const QUEUE_KEY = "lumina-cu-queue-v1";
const GRACE_MS = 10 * 60 * 1000;

function makeStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/** lookup: "empty" | "hit" | "fail" —— time_entries 查询的行为 */
function makeClickUp() {
  const state = { lookup: "empty", posts: [] };
  const reply = (status, body) => ({
    ok: status < 400,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  });
  state.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || "GET";
    if (u.includes("/time_entries") && method === "GET") {
      if (state.lookup === "fail") return reply(503, "unavailable");
      if (state.lookup === "hit") {
        const op = state.hitOp;
        return reply(200, { data: [{ id: "te-1", description: `番茄钟 25 分钟 · Lumina Todo [lumina-op:${op}]` }] });
      }
      return reply(200, { data: [] });
    }
    if (u.includes("/task") && method === "GET") {
      return reply(200, { tasks: [{ id: "task-1", name: "focus" }], last_page: true });
    }
    if (u.includes("/time_entries") && method === "POST") {
      state.posts.push(JSON.parse(opts.body));
      return reply(200, {});
    }
    return reply(200, {});
  };
  return state;
}

async function load(pendings, cu) {
  const store = makeStore();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: (...a) => cu.fetch(...a),
    localStorage: store,
    AbortController,
    URLSearchParams,
    URL,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.LUMINA_MOBILE_CLICKUP;
  assert.equal((await api.setStoredToken("pk_" + "x".repeat(24))).ok, true);
  await new Promise((r) => setTimeout(r, 20)); // 等 setStoredToken 触发的空队列 flush 结束
  store.setItem(PENDING_KEY, JSON.stringify(pendings));
  return { api, store };
}

function pending(operationId, ageMs) {
  const endedAt = Date.now() - ageMs;
  const duration = 25 * 60 * 1000;
  return {
    operationId,
    title: "focus",
    minutes: 25,
    endedAt,
    start: endedAt - duration,
    duration,
    createdAt: endedAt,
  };
}

async function main() {
  // 1. 确认没有 + 已过宽限期：转入队列并按原 operationId 补发一次
  {
    const cu = makeClickUp();
    const { api, store } = await load([pending("op-lost-1", GRACE_MS + 60_000)], cu);
    const r = await api.reconcilePendingPomos();
    assert.equal(r.requeued, 1);
    assert.equal(r.left, 0);
    const q = JSON.parse(store.getItem(QUEUE_KEY) || "[]");
    assert.equal(q.length, 1);
    assert.equal(q[0].operationId, "op-lost-1");
    await api.flushQueue();
    assert.equal(cu.posts.length, 1, "应补发一次");
    assert.match(cu.posts[0].description, /\[lumina-op:op-lost-1\]/);
    const st = await api.status();
    assert.equal(st.queue, 0);
    assert.equal(st.pendingPomo, 0);
    console.log("✔ 确认远端没有且过宽限期：转入队列，按原 operationId 补发一次");
  }

  // 2. 宽限期内：保持待核对，不入队、不 POST
  {
    const cu = makeClickUp();
    const { api, store } = await load([pending("op-fresh-1", 60_000)], cu);
    const r = await api.reconcilePendingPomos();
    assert.equal(r.requeued, 0);
    assert.equal(r.left, 1);
    assert.equal(JSON.parse(store.getItem(QUEUE_KEY) || "[]").length, 0);
    await api.flushQueue();
    assert.equal(cu.posts.length, 0);
    console.log("✔ 宽限期内保持待核对，不补发");
  }

  // 3. 查询失败：什么都不动
  {
    const cu = makeClickUp();
    cu.lookup = "fail";
    const { api, store } = await load([pending("op-unknown-1", GRACE_MS + 60_000)], cu);
    const r = await api.reconcilePendingPomos();
    assert.equal(r.requeued, 0);
    assert.equal(r.left, 1);
    assert.equal(JSON.parse(store.getItem(QUEUE_KEY) || "[]").length, 0);
    assert.equal(cu.posts.length, 0);
    console.log("✔ 查询失败时不入队、不补发");
  }

  // 4. 远端已有：只清待核对，不补发
  {
    const cu = makeClickUp();
    cu.lookup = "hit";
    cu.hitOp = "op-landed-1";
    const { api, store } = await load([pending("op-landed-1", GRACE_MS + 60_000)], cu);
    const r = await api.reconcilePendingPomos();
    assert.equal(r.reconciled, 1);
    assert.equal(r.requeued, 0);
    assert.equal(JSON.parse(store.getItem(QUEUE_KEY) || "[]").length, 0);
    assert.equal(cu.posts.length, 0);
    console.log("✔ 远端已有：只清待核对");
  }

  // 5. 队列里已有同 operationId：不重复入队
  {
    const cu = makeClickUp();
    const p = pending("op-dup-1", GRACE_MS + 60_000);
    const { api, store } = await load([p], cu);
    store.setItem(QUEUE_KEY, JSON.stringify([{
      queueId: "q-existing", operationId: "op-dup-1", title: "focus", minutes: 25,
      endedAt: p.endedAt, tries: 0, queuedAt: Date.now(),
    }]));
    const r = await api.reconcilePendingPomos();
    assert.equal(r.requeued, 1);
    assert.equal(r.left, 0);
    assert.equal(JSON.parse(store.getItem(QUEUE_KEY)).length, 1, "同 operationId 只能有一条");
    console.log("✔ 队列已有同 operationId 时不重复入队");
  }

  // 6. 队列写失败：pending 不能被清掉（否则记录丢失）
  {
    const cu = makeClickUp();
    const { api, store } = await load([pending("op-qfail-1", GRACE_MS + 60_000)], cu);
    const setItem = store.setItem;
    store.setItem = (k, v) => {
      if (k === QUEUE_KEY) throw new Error("quota");
      setItem(k, v);
    };
    const r = await api.reconcilePendingPomos();
    assert.equal(r.requeued, 0);
    assert.equal(r.left, 1, "队列写不进去时必须保留待核对");
    console.log("✔ 队列写失败时保留待核对，不丢记录");
  }
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
