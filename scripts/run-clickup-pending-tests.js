/**
 * ClickUp 番茄打卡「待核对」回归测试（Node，无真机）
 * 直接打卡超时后只留 pending、不入队；对账持续按 marker 查。
 * 审查第二轮 #3：宽限期过后一次空查询不能证明原请求不会再提交——不自动补发，
 * 只标记为「需手动重试」；用户手动重试且再次确认查无，才按原 operationId 补发一次。
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
  const state = { lookup: "empty", posts: [], postFail: 0 };
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
      if (state.postFail && state.postFail-- > 0) return reply(504, "gateway timeout");
      return reply(200, {});
    }
    return reply(200, {});
  };
  return state;
}

async function load(pendings, cu, opts = {}) {
  const store = opts.store || makeStore();
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
  if (opts.navigator) sandbox.navigator = opts.navigator;
  // 默认模拟 iOS App（单 WebView）；跨标签页场景显式传 navigator.locks 或 native:false
  if (opts.native === true || (opts.native === undefined && !opts.navigator)) {
    sandbox.Capacitor = { isNativePlatform: () => true };
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.LUMINA_MOBILE_CLICKUP;
  assert.equal((await api.setStoredToken("pk_" + "x".repeat(24))).ok, true);
  await new Promise((r) => setTimeout(r, 20)); // 等 setStoredToken 触发的空队列 flush 结束
  if (pendings) store.setItem(PENDING_KEY, JSON.stringify(pendings));
  return { api, store };
}

/** 多「页面」共享的 Web Locks 替身（FIFO、exclusive、ifAvailable） */
function makeLockManager() {
  const held = new Map();
  const waiters = new Map();
  const grant = (name) => {
    const q = waiters.get(name);
    if (held.get(name) || !q || !q.length) return;
    q.shift()();
  };
  return {
    request(name, options, cb) {
      if (typeof options === "function") { cb = options; options = {}; }
      if (options.ifAvailable && held.get(name)) return Promise.resolve().then(() => cb(null));
      return new Promise((resolve, reject) => {
        const run = () => {
          held.set(name, true);
          Promise.resolve()
            .then(() => cb({ name, mode: "exclusive" }))
            .then(resolve, reject)
            .finally(() => { held.set(name, false); grant(name); });
        };
        if (!waiters.has(name)) waiters.set(name, []);
        waiters.get(name).push(run);
        grant(name);
      });
    },
  };
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
  // 1. 查无 + 已过宽限期：不自动补发，标记需手动；继续对账；手动重试才补发一次
  {
    const cu = makeClickUp();
    const { api, store } = await load([pending("op-lost-1", GRACE_MS + 60_000)], cu);
    const r = await api.reconcilePendingPomos();
    assert.equal(r.requeued, 0, "宽限期后的空查询不得自动转入补发");
    assert.equal(r.left, 1);
    assert.equal(r.needsManual, 1);
    assert.equal(JSON.parse(store.getItem(QUEUE_KEY) || "[]").length, 0);
    await api.flushQueue();
    assert.equal(cu.posts.length, 0, "不得自动补发");
    assert.equal((await api.status()).pendingManual, 1);
    // 迟到的原请求随后落库：对账找回，不再需要手动处理
    // （这里先验证仍查无时，再次对账保持原状）
    await api.reconcilePendingPomos();
    assert.equal(cu.posts.length, 0);
    const m = await api.retryPendingPomos();
    assert.equal(m.ok, true);
    assert.equal(m.requeued, 1);
    assert.equal(cu.posts.length, 1, "手动重试后补发一次");
    assert.match(cu.posts[0].description, /\[lumina-op:op-lost-1\]/);
    const st = await api.status();
    assert.equal(st.queue, 0);
    assert.equal(st.pendingPomo, 0);
    assert.equal(st.pendingManual, 0);
    console.log("✔ 过宽限期仍查无：不自动补发、标记需手动；手动重试才按原 operationId 补发一次");
  }

  // 1b. 需手动的记录在原请求迟到落库后由对账自动消掉；手动重试遇到查询失败什么都不动
  {
    const cu = makeClickUp();
    const { api } = await load([pending("op-late-1", GRACE_MS + 60_000)], cu);
    await api.reconcilePendingPomos();
    assert.equal((await api.status()).pendingManual, 1);
    cu.lookup = "fail";
    const f = await api.retryPendingPomos();
    assert.equal(f.ok, false);
    assert.equal(f.code, "LOOKUP_FAILED");
    assert.equal(cu.posts.length, 0, "手动重试时查询失败也不得 POST");
    cu.lookup = "hit";
    cu.hitOp = "op-late-1";
    const r = await api.reconcilePendingPomos();
    assert.equal(r.reconciled, 1);
    assert.equal((await api.status()).pendingPomo, 0);
    assert.equal(cu.posts.length, 0);
    console.log("✔ 需手动记录仍持续对账：原请求迟到落库即消；手动重试查询失败不发");
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

  // 5. 手动重试时队列里已有同 operationId：不重复入队
  {
    const cu = makeClickUp();
    cu.postFail = 99; // 让补发停在队列里，便于检查条数
    const p = pending("op-dup-1", GRACE_MS + 60_000);
    const { api, store } = await load([p], cu);
    store.setItem(QUEUE_KEY, JSON.stringify([{
      queueId: "q-existing", operationId: "op-dup-1", title: "focus", minutes: 25,
      endedAt: p.endedAt, tries: 0, queuedAt: Date.now(),
    }]));
    const r = await api.retryPendingPomos();
    assert.equal(r.requeued, 1);
    const q = JSON.parse(store.getItem(QUEUE_KEY));
    assert.equal(q.filter((x) => x.operationId === "op-dup-1").length, 1, "同 operationId 只能有一条");
    console.log("✔ 手动重试时队列已有同 operationId 不重复入队");
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
    const r = await api.retryPendingPomos();
    assert.equal(r.requeued, 0);
    assert.equal(r.code, "QUEUE_WRITE_FAILED");
    assert.equal(r.left, 1, "队列写不进去时必须保留待核对");
    console.log("✔ 队列写失败时保留待核对，不丢记录");
  }

  // 7. 手动重试的补发又遇到不确定 POST：宽限期内不能再次 POST，过期后也不自动补发
  {
    const operationId = "op-retry-grace-1";
    const cu = makeClickUp();
    cu.postFail = 1;
    const { api, store } = await load([pending(operationId, GRACE_MS + 60_000)], cu);
    await api.retryPendingPomos();
    assert.equal(cu.posts.length, 1);
    assert.equal((await api.status()).queue, 1);
    assert.equal((await api.status()).pendingPomo, 1);

    await api.reconcilePendingPomos();
    await api.flushQueue();
    assert.equal(cu.posts.length, 1, "宽限期内再次前台同步不得立刻重 POST");
    assert.equal((await api.status()).queue, 1);
    assert.equal((await api.status()).pendingPomo, 1);

    const pendingItems = JSON.parse(store.getItem(PENDING_KEY));
    pendingItems[0].createdAt = Date.now() - GRACE_MS - 60_000;
    store.setItem(PENDING_KEY, JSON.stringify(pendingItems));
    await api.reconcilePendingPomos();
    await api.flushQueue();
    assert.equal(cu.posts.length, 1, "宽限期结束后一次空查询也不得自动补发");
    assert.equal((await api.status()).queue, 0, "需手动的记录交给待核对，不堵队列");
    assert.equal((await api.status()).pendingManual, 1);
    await api.retryPendingPomos();
    assert.equal(cu.posts.length, 2, "用户手动重试且确认远端没有后只补发一次");
    assert.equal((await api.status()).queue, 0);
    assert.equal((await api.status()).pendingPomo, 0);
    assert.match(cu.posts[0].description, /\[lumina-op:op-retry-grace-1\]/);
    assert.match(cu.posts[1].description, /\[lumina-op:op-retry-grace-1\]/);
    console.log("✔ 不确定的补发在宽限期内不重发，过期后也只在手动重试时按原 operationId 补发");
  }

  // 审查第一轮：待核对记录（上限 50）已满时，新打卡不发无法对账的 POST、不挤掉旧记录，转入队列
  {
    const cu = makeClickUp();
    const full = [];
    for (let i = 0; i < 50; i++) full.push(pending("op-full-" + i, 60_000));
    const { api, store } = await load(full, cu);
    const r = await api.logPomodoro({ title: "focus", minutes: 25, endedAt: Date.now(), operationId: "op-over-cap" });
    assert.equal(r.code, "PENDING_FULL");
    assert.equal(r.queued, true);
    assert.equal(cu.posts.length, 0);
    const kept = JSON.parse(store.getItem(PENDING_KEY));
    assert.equal(kept.length, 50);
    assert.equal(kept[0].operationId, "op-full-0", "最旧的待核对记录不得被淘汰");
    const q = JSON.parse(store.getItem(QUEUE_KEY) || "[]");
    assert.equal(q.length, 1);
    assert.equal(q[0].operationId, "op-over-cap");
    // 队列补发时待核对仍满：保留队列项，不消耗重试次数
    await api.flushQueue();
    assert.equal(cu.posts.length, 0);
    const q2 = JSON.parse(store.getItem(QUEUE_KEY) || "[]");
    assert.equal(q2.length, 1);
    assert.equal(q2[0].tries, 0);
    console.log("✔ 待核对记录已满时新打卡转入队列，不淘汰旧记录、不盲发");
  }

  // 审查三⑥：重叠的「重试待核对」——同页 single-flight、跨页 Web Lock 串行、无锁时 compare-and-clear
  for (const mode of ["same-page", "two-tabs-locks", "two-tabs-no-locks"]) {
    const cu = makeClickUp();
    cu.postFail = 1;            // 第一次补发 504：结果未知，必须留下新的待核对
    const slowFetch = cu.fetch;
    // 时序（评审复现）：两次重试同时读到旧记录；第一次查询先返回、开始补发并写入新 pending、
    // POST 在途；第二次的查询更慢，在这之后才返回并拿旧快照去「清除」
    const lookupDelays = [20, 60];
    cu.fetch = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/time_entries") && method === "GET") {
        await new Promise((r) => setTimeout(r, lookupDelays.length ? lookupDelays.shift() : 20));
      }
      if (u.includes("/time_entries") && method === "POST") {
        await new Promise((r) => setTimeout(r, 30));
      }
      return slowFetch(url, opts);
    };
    const nav = mode === "two-tabs-locks" ? { locks: makeLockManager() } : undefined;
    const realFetch = cu.fetch;
    cu.fetch = slowFetch;   // 加载阶段不计入时序
    // 审查四④：两个标签页且没有 Web Locks（非 App 单 WebView）时没有可靠互斥，必须失败关闭
    const native = mode === "two-tabs-no-locks" ? false : undefined;
    const first = await load([{ ...pending("op-overlap-1", GRACE_MS + 60_000), needsManual: true }], cu, { navigator: nav, native });
    const second = mode === "same-page" ? first : await load(null, cu, { store: first.store, navigator: nav, native });
    cu.fetch = realFetch;
    const [r1, r2] = await Promise.all([first.api.retryPendingPomos(), second.api.retryPendingPomos()]);
    assert.ok(r1 && r2);
    if (mode === "two-tabs-no-locks") {
      assert.equal(cu.posts.length, 0, "无可靠跨页锁：不得补发");
      assert.equal(r1.code, "LOCK_UNAVAILABLE");
      assert.equal(r2.code, "LOCK_UNAVAILABLE");
      assert.equal(JSON.parse(first.store.getItem(PENDING_KEY) || "[]").length, 1, "无锁时待核对记录原样保留");
      await first.api.flushQueue();
      await first.api.reconcilePendingPomos();
      assert.equal(cu.posts.length, 0);
      continue;
    }
    assert.equal(cu.posts.length, 1, `${mode}：重叠重试只允许补发一次`);
    const pend = JSON.parse(first.store.getItem(PENDING_KEY) || "[]");
    assert.equal(pend.length, 1, `${mode}：504 后的新待核对记录不得被旧快照清掉`);
    assert.equal(pend[0].operationId, "op-overlap-1");
    // 之后的自动刷新/对账/补发都不得绕过待核对再次 POST
    await first.api.flushQueue();
    await second.api.flushQueue();
    await first.api.reconcilePendingPomos();
    await first.api.flushQueue();
    assert.equal(cu.posts.length, 1, `${mode}：自动刷新不得重复 POST`);
  }
  console.log("✔ 审查三⑥ 重叠手动重试：single-flight + 锁 + 版本校验，504 后不被旧快照清除、不重复补发");

  // 审查四⑨：single-flight 只合并相同过滤条件；[A] 与 [B] 重叠时两条都要处理
  {
    const cu = makeClickUp();
    const slow = cu.fetch;
    cu.fetch = async (url, opts) => {
      if (String(url).includes("/time_entries") && ((opts && opts.method) || "GET") === "GET") {
        await new Promise((r) => setTimeout(r, 15));
      }
      return slow(url, opts);
    };
    const { api, store } = await load([
      { ...pending("op-filter-a", GRACE_MS + 60_000), needsManual: true },
      { ...pending("op-filter-b", GRACE_MS + 60_000), needsManual: true },
    ], cu);
    const same1 = api.retryPendingPomos(["op-filter-a"]);
    const same2 = api.retryPendingPomos(["op-filter-a"]);
    assert.strictEqual(same1, same2, "相同过滤条件的重叠调用共享同一次执行");
    const other = api.retryPendingPomos(["op-filter-b"]);
    assert.notStrictEqual(other, same1, "不同过滤条件不得被合并吞掉");
    const [ra, rb] = await Promise.all([same1, other]);
    assert.equal(ra.requeued, 1);
    assert.equal(rb.requeued, 1, "[B] 的重试必须真的处理 B");
    const posted = cu.posts.map((p) => (p.description.match(/lumina-op:([^\]]+)/) || [])[1]).sort();
    assert.deepEqual(posted, ["op-filter-a", "op-filter-b"]);
    assert.equal(JSON.parse(store.getItem(PENDING_KEY) || "[]").length, 0);
  }
  console.log("✔ 审查四⑨ 重试待核对按过滤条件 single-flight：[A] 与 [B] 各自执行，相同条件才合并");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
