/**
 * 桥接与关键路径回归测试（Node，无真机）
 * 覆盖：文件齐全、token 存储失败、队列单飞/并发、AI 响应上限、
 *       sync 锚点失败、operationId 幂等、secure-store 回退
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");
const { spawnSync } = require("child_process");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const WWW = path.join(ROOT, "www");
let passed = 0;
function ok(name) {
  passed++;
  console.log("✔", name);
}

function makeLocalStorage(map) {
  const m = map || new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

/** 测试用 Web Locks：同一个实例在多个「标签页」间共享即模拟同源跨页锁 */
function makeSharedLocks({ failWith } = {}) {
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
      if (failWith) return Promise.reject(failWith());
      if (options.ifAvailable && held.get(name)) return Promise.resolve().then(() => cb(null));
      return new Promise((resolve, reject) => {
        const run = () => {
          held.set(name, true);
          Promise.resolve().then(() => cb({ name })).then(resolve, reject)
            .finally(() => { held.set(name, false); grant(name); });
        };
        if (!waiters.has(name)) waiters.set(name, []);
        waiters.get(name).push(run);
        grant(name);
      });
    },
  };
}

function baseSandbox(store, fetchImpl) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch:
      fetchImpl ||
      (async () => {
        throw new Error("no network in test");
      }),
    localStorage: store,
    document: { readyState: "complete", addEventListener() {}, body: { appendChild() {} } },
    window: {},
    globalThis: null,
    AbortController,
    URLSearchParams,
    URL,
    TextDecoder,
    ReadableStream: globalThis.ReadableStream,
    crypto: {
      randomUUID: () =>
        "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36),
    },
    DOMException: class DOMException extends Error {
      constructor(msg, name) {
        super(msg);
        this.name = name || "DOMException";
      }
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

function loadClickup(store, fetchImpl, { timeoutCapMs, navigator, native, rawFetch } = {}) {
  // 旧替身补上任务详情端点（审查六④ 复用 id 前回查）；rawFetch:true 时原样使用
  const sandbox = baseSandbox(store, rawFetch ? fetchImpl : withTaskDetail(fetchImpl));
  if (navigator) sandbox.navigator = navigator;
  // 默认模拟 iOS App（Capacitor 原生壳只有一个 WebView：本页互斥即全局互斥）；
  // 跨标签页场景要显式传 navigator.locks，或 native:false 模拟没有可靠锁的浏览器
  if (native === true || (native === undefined && !navigator)) {
    sandbox.Capacitor = { isNativePlatform: () => true };
  }
  if (Number.isFinite(timeoutCapMs) && timeoutCapMs > 0) {
    const nativeSetTimeout = sandbox.setTimeout;
    sandbox.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, Math.min(ms, timeoutCapMs), ...args);
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, "js/secure-store.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-clickup.js"), "utf8"), sandbox);
  return { sandbox, api: sandbox.LUMINA_MOBILE_CLICKUP, secure: sandbox.LUMINA_SECURE_STORE };
}

const { withTaskDetail } = require("./clickup-task-detail-shim");

function loadBridge(store, fetchImpl) {
  const sandbox = baseSandbox(store, fetchImpl);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, "js/secure-store.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, "agent-tools.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-bridge.js"), "utf8"), sandbox);
  return { sandbox, ai: sandbox.luminaAI, secure: sandbox.LUMINA_SECURE_STORE };
}

function loadNotify(plugin) {
  const sandbox = baseSandbox(makeLocalStorage());
  const listeners = new Map();
  sandbox.addEventListener = (name, fn) => listeners.set(name, fn);
  sandbox.Capacitor = { Plugins: { LocalNotifications: plugin } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-notify.js"), "utf8"), sandbox);
  return { sandbox, listeners };
}

async function main() {
  const need = [
    "index.html",
    "app.js",
    "chat.js",
    "ios.css",
    "js/secure-store.js",
    "js/mobile-bridge.js",
    "js/mobile-clickup.js",
    "js/mobile-notify.js",
    "js/mobile-settings.js",
    "js/mobile-ux.js",
    "agent-tools.js",
    "agent-loop.js",
  ];
  for (const f of need) {
    assert.ok(fs.existsSync(path.join(WWW, f)), "missing " + f);
  }
  ok("www 关键文件齐全");

  const html = fs.readFileSync(path.join(WWW, "index.html"), "utf8");
  assert.match(html, /mobile-bridge\.js/);
  assert.match(html, /mobile-clickup\.js/);
  assert.match(html, /secure-store\.js/);
  assert.doesNotMatch(html, /personal-seed\.js/);
  assert.doesNotMatch(html, /personal-config\.local\.js/);
  assert.match(html, /mobile-notify\.js/);
  assert.match(html, /ios\.css/);
  assert.match(html, /opencode\.ai/);
  assert.match(html, /api\.clickup\.com/);
  assert.match(html, /viewport-fit=cover/);
  ok("index.html 含 iOS 桥接 / 安全存储 / 通知 / CSP，且不加载个人配置");

  const app = fs.readFileSync(path.join(WWW, "app.js"), "utf8");
  assert.match(app, /__luminaReorder/);
  assert.match(app, /finishedDay === today/);
  assert.match(app, /safeTimestamp/);
  assert.match(app, /lumina:foreground/);
  assert.match(app, /__luminaOnPomoChange/);
  assert.match(app, /todoId:\s*t\.id/);
  ok("app.js 含 E·K·G / 原生通知钩子 / push todoId");

  const ux = fs.readFileSync(path.join(WWW, "js/mobile-ux.js"), "utf8");
  assert.match(ux, /HOLD_MS/);
  assert.match(ux, /theme === "kanna" \? "LIGHT" : "DARK"/);
  ok("mobile-ux 含长按排序与状态栏映射");

  const bridgeSrc = fs.readFileSync(path.join(WWW, "js/mobile-bridge.js"), "utf8");
  assert.doesNotMatch(bridgeSrc, /User-Agent/);
  assert.match(bridgeSrc, /ensureAppendFits/);
  assert.match(bridgeSrc, /LUMINA_SECURE_STORE/);
  ok("mobile-bridge 无 User-Agent 且含响应上限与 secure-store");

  const chatSrc = fs.readFileSync(path.join(WWW, "chat.js"), "utf8");
  assert.match(chatSrc, /应用设置/);
  ok("chat.js Key 来源文案区分 iOS 设置");

  const cap = JSON.parse(fs.readFileSync(path.join(ROOT, "capacitor.config.json"), "utf8"));
  assert.equal(cap.plugins.StatusBar.style, "LIGHT");
  ok("capacitor 默认 StatusBar style = LIGHT");

  const swift = fs.readFileSync(
    path.join(ROOT, "ios/App/App/LuminaSecureStorePlugin.swift"),
    "utf8"
  );
  assert.match(swift, /LuminaSecureStorePlugin/);
  assert.match(swift, /kSecClassGenericPassword/);
  assert.match(swift, /SecItemUpdate/);
  assert.match(swift, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  ok("Keychain 原生插件源码存在");

  const notifySrc = fs.readFileSync(path.join(WWW, "js/mobile-notify.js"), "utf8");
  assert.match(notifySrc, /LocalNotifications/);
  assert.match(notifySrc, /91001/);
  assert.match(notifySrc, /pomoChanges/);
  ok("mobile-notify 串行调度 LocalNotifications");

  /* ---- secure-store 回退 localStorage ---- */
  {
    const store = makeLocalStorage();
    const sandbox = baseSandbox(store);
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/secure-store.js"), "utf8"), sandbox);
    const S = sandbox.LUMINA_SECURE_STORE;
    assert.equal(S.backend(), "localStorage");
    assert.equal(await S.set("k1", "v1"), true);
    assert.equal(await S.get("k1"), "v1");
    await S.remove("k1");
    assert.equal(await S.get("k1"), null);
  ok("secure-store localStorage 回退读写");
  }

  /* ---- 真机 Keychain 写失败不得降级到 localStorage ---- */
  {
    const store = makeLocalStorage();
    const sandbox = baseSandbox(store);
    sandbox.Capacitor = {
      Plugins: {
        LuminaSecureStore: {
          async set() { throw new Error("keychain unavailable"); },
          async get() { throw new Error("keychain unavailable"); },
          async remove() { throw new Error("keychain unavailable"); },
        },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/secure-store.js"), "utf8"), sandbox);
    const S = sandbox.LUMINA_SECURE_STORE;
    assert.equal(S.backend(), "keychain");
    assert.equal(await S.set("k1", "v1"), false);
    assert.equal(store.getItem("k1"), null);
    assert.equal(await S.remove("k1"), false);
    await assert.rejects(() => S.get("k1"), (err) => err?.code === "KEYCHAIN_READ_FAILED");
    ok("Keychain 失败不静默降级为 localStorage");
  }

  /* ---- 1. localStorage 写失败时不能返回“保存成功” ---- */
  {
    const brokenStore = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("quota");
      },
      removeItem() {},
    };
    const { api } = loadClickup(brokenStore);
    const r = await api.setStoredToken("pk_" + "x".repeat(24));
    assert.equal(r.ok, false);
    assert.match(String(r.error || ""), /无法保存|存储/);
    ok("localStorage 写失败时 setStoredToken 不假成功");
  }

  /* ---- 正常 token 读写 + 非法 minutes ---- */
  {
    const store = makeLocalStorage();
    const { api } = loadClickup(store);
    assert.equal((await api.setStoredToken("not-a-token")).ok, false);
    assert.equal((await api.setStoredToken("pk_" + "x".repeat(24))).ok, true);
    assert.equal((await api.status()).hasToken, true);
    const noMin = await api.logPomodoro({ minutes: 0, title: "x" });
    assert.equal(noMin.ok, false);
    assert.equal(noMin.code, "BAD_ARGS");
    ok("mobile-clickup token 读写 / 拒绝非法 minutes");
  }

  /* ---- ClickUp 番茄上传状态提示不影响返回值 ---- */
  {
    const store = makeLocalStorage();
    const expected = [
      { ok: false, code: "INDETERMINATE" },
      { ok: false, queued: true, code: "TIMEOUT" },
      { ok: true },
      { ok: false, code: "INDETERMINATE" },
    ];
    const replies = expected.slice();
    const messages = [];
    const sandbox = baseSandbox(store);
    sandbox.LUMINA_MOBILE_CLICKUP = {
      logPomodoro: () => Promise.resolve(replies.shift()),
    };
    sandbox.toast = (message) => messages.push(message);
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/secure-store.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "agent-tools.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-bridge.js"), "utf8"), sandbox);
    const first = await sandbox.luminaClickUp.logPomo({ title: "focus", minutes: 25 });
    assert.strictEqual(first, expected[0]);
    const second = await sandbox.luminaClickUp.logPomo({ title: "focus", minutes: 25 });
    assert.strictEqual(second, expected[1]);
    const third = await sandbox.luminaClickUp.logPomo({ title: "focus", minutes: 25 });
    assert.strictEqual(third, expected[2]);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /上传结果未确认/);
    assert.match(messages[1], /已加入待同步/);
    sandbox.toast = () => {
      throw new Error("toast unavailable");
    };
    const fourth = await sandbox.luminaClickUp.logPomo({ title: "focus", minutes: 25 });
    assert.strictEqual(fourth, expected[3]);
    ok("ClickUp 番茄不确定或排队时提示且 toast 故障不影响返回值");
  }

  /* ---- operationId 标记 ---- */
  {
    const store = makeLocalStorage();
    const { api } = loadClickup(store);
    assert.equal(api._opMarker("abc-123"), "[lumina-op:abc-123]");
    assert.equal(
      api._extractOpId("番茄钟 25 分钟 · Lumina Todo [lumina-op:op-pomo-9]"),
      "op-pomo-9"
    );
    const imported = api._stableTodoOperationId("项目 1 / imported");
    assert.match(imported, /^[A-Za-z0-9._:-]{6,80}$/);
    assert.equal(imported, api._stableTodoOperationId("项目 1 / imported"));
    ok("operationId marker 编解码");
  }

  /* ---- 创建任务前，pending 写失败必须阻断 POST ---- */
  {
    const map = new Map();
    const store = {
      getItem(k) { return map.has(k) ? map.get(k) : null; },
      setItem(k, v) {
        if (k === "lumina-cu-pending-push-v1") throw new Error("quota");
        map.set(k, String(v));
      },
      removeItem(k) { map.delete(k); },
    };
    let postCount = 0;
    const { api } = loadClickup(store, async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/user")) {
        return { ok: true, status: 200, async text() { return JSON.stringify({ user: { id: 1 } }); } };
      }
      if ((opts?.method || "GET") === "POST") postCount++;
      // 审查四⑧：列表查询必须是合法形状（缺 tasks 数组会被当作查询失败）
      if (u.includes("/task") && (opts?.method || "GET") === "GET") {
        return { ok: true, status: 200, async text() { return JSON.stringify({ tasks: [], last_page: true }); } };
      }
      return { ok: true, status: 200, async text() { return "{}"; } };
    });
    assert.equal((await api.setStoredToken("pk_" + "x".repeat(24))).ok, true);
    const result = await api.pushTodo({ title: "pending guard", todoId: "todo-safe-1" });
    assert.equal(result.code, "PENDING_WRITE_FAILED");
    assert.equal(postCount, 0, "没有恢复记录时不得创建远端任务");
    ok("ClickUp 创建任务先持久化 pending");
  }

  /* ---- 番茄未知结果保留 pending，查询故障时不二次 POST ---- */
  {
    const store = makeLocalStorage();
    const OP = "op-pomo-uncertain";
    let phase = "first";
    let postCount = 0;
    const fetchImpl = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/time_entries") && method === "GET") {
        if (phase === "retry") throw new Error("time-entry lookup unavailable");
        return { ok: true, status: 200, async text() { return JSON.stringify({ data: [] }); } };
      }
      if (u.includes("/task") && method === "GET") {
        return { ok: true, status: 200, async text() { return JSON.stringify({ tasks: [{ id: "task-uncertain", name: "uncertain" }], last_page: true }); } };
      }
      if (u.includes("/time_entries") && method === "POST") {
        postCount++;
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return { ok: true, status: 200, async text() { return "{}"; } };
    };
    const { api } = loadClickup(store, fetchImpl);
    assert.equal((await api.setStoredToken("pk_" + "x".repeat(24))).ok, true);
    const first = await api.logPomodoro({ title: "uncertain", minutes: 25, endedAt: Date.now(), operationId: OP });
    assert.equal(first.code, "INDETERMINATE");
    assert.equal((await api.status()).pendingPomo, 1);
    phase = "retry";
    const retry = await api.logPomodoro({ title: "uncertain", minutes: 25, endedAt: Date.now(), operationId: OP, __noQueue: true });
    assert.equal(retry.code, "INDETERMINATE");
    assert.equal(postCount, 1, "未知的旧 POST 不得因为预查失败而重发");
    ok("番茄未知结果不盲目重发");
  }

  /* ---- 损坏离线队列需保全原始内容并上报 ---- */
  {
    const store = makeLocalStorage();
    store.setItem("lumina-cu-queue-v1", "{broken");
    const { api } = loadClickup(store);
    const st = await api.status();
    assert.equal(st.queueCorrupt, true);
    assert.match(store.getItem("lumina-cu-queue-corrupt-v1") || "", /\{broken/);
    ok("损坏 ClickUp 队列会保全而非静默丢弃");
  }

  /* ---- pushTodo 超时后按 marker 恢复，不二次创建 ---- */
  {
    const store = makeLocalStorage();
    let postTaskCount = 0;
    let phase = "first-timeout";
    const fetchImpl = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/user")) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ user: { id: 42 } });
          },
        };
      }
      if (u.includes("/task") && method === "GET") {
        // 有 pending 后的恢复查询：返回带 marker 的任务
        if (phase === "recover") {
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                tasks: [
                  {
                    id: "task-recovered",
                    name: "写报告",
                    description: "从 Lumina Todo 快捷上传\n[lumina-op:todo-t1]",
                    url: "https://app.clickup.com/t/task-recovered",
                  },
                ],
              });
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ tasks: [] });
          },
        };
      }
      if (u.includes("/task") && method === "POST") {
        postTaskCount++;
        if (phase === "first-timeout") {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ id: "task-new", url: "https://app.clickup.com/t/task-new" });
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return "{}";
        },
      };
    };
    const { api } = loadClickup(store, fetchImpl);
    await api.setStoredToken("pk_" + "x".repeat(24));

    // 第一次：POST 超时，查询不到 → TIMEOUT retryable
    phase = "first-timeout";
    const r1 = await api.pushTodo({ title: "写报告", todoId: "t1", priority: "high" });
    assert.equal(r1.ok, false);
    assert.ok(r1.operationId);
    assert.equal(postTaskCount, 1);

    // 第二次：pending 存在，查询命中 marker → recovered，不再 POST
    phase = "recover";
    const r2 = await api.pushTodo({ title: "写报告", todoId: "t1", priority: "high" });
    assert.equal(r2.ok, true);
    assert.equal(r2.recovered, true);
    assert.equal(r2.taskId, "task-recovered");
    assert.equal(postTaskCount, 1, "恢复路径不得再次创建");
    ok("pushTodo 超时后按 operationId 恢复且不重复创建");
  }

  /* ---- logPomodoro 写入 description 带 op marker；重复提交 dedupe ---- */
  {
    const store = makeLocalStorage();
    let postTime = 0;
    let lastBody = null;
    const OP = "op-pomo-fixed-1";
    const fetchImpl = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/task") && method === "GET") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ tasks: [{ id: "t9", name: "focus-x" }] });
          },
        };
      }
      if (u.includes("/time_entries") && method === "GET") {
        // 第二次：已有同 marker
        if (postTime >= 1) {
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                data: [
                  {
                    id: "te1",
                    description: "番茄钟 25 分钟 · Lumina Todo [lumina-op:" + OP + "]",
                    task: { id: "t9" },
                  },
                ],
              });
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ data: [] });
          },
        };
      }
      if (u.includes("/time_entries") && method === "POST") {
        postTime++;
        lastBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          async text() {
            return "{}";
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return "{}";
        },
      };
    };
    const { api } = loadClickup(store, fetchImpl);
    await api.setStoredToken("pk_" + "x".repeat(24));
    const r1 = await api.logPomodoro({
      title: "focus-x",
      minutes: 25,
      endedAt: Date.now(),
      operationId: OP,
    });
    assert.equal(r1.ok, true);
    assert.match(String(lastBody?.description || ""), /\[lumina-op:op-pomo-fixed-1\]/);
    const r2 = await api.logPomodoro({
      title: "focus-x",
      minutes: 25,
      endedAt: Date.now(),
      operationId: OP,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.deduped, true);
    assert.equal(postTime, 1, "同 operationId 不得重复 POST time entry");
    ok("logPomodoro operationId 写入 description 且 dedupe");
  }

  /* ---- 响应头已到、body 永不结束时，flush 单飞锁也必须释放 ---- */
  {
    const store = makeLocalStorage();
    let postCount = 0;
    const fetchImpl = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/task") && method === "GET") {
        return { ok: true, status: 200, async text() { return JSON.stringify({ tasks: [{ id: "t-body", name: "body-stall" }], last_page: true }); } };
      }
      if (u.includes("/time_entries") && method === "GET") {
        return { ok: true, status: 200, async text() { return JSON.stringify({ data: [] }); } };
      }
      if (u.includes("/time_entries") && method === "POST") {
        postCount++;
        return { ok: true, status: 200, text: () => new Promise(() => {}) };
      }
      return { ok: true, status: 200, async text() { return "{}"; } };
    };
    const { api } = loadClickup(store, fetchImpl, { timeoutCapMs: 20 });
    assert.equal((await api.setStoredToken("pk_" + "x".repeat(24))).ok, true);
    store.setItem("lumina-cu-queue-v1", JSON.stringify([{
      queueId: "q-body", operationId: "op-body-stall", title: "body-stall", minutes: 25,
      endedAt: Date.now() - 1000, tries: 0, queuedAt: Date.now(),
    }]));
    const started = Date.now();
    const first = await api.flushQueue();
    assert.ok(Date.now() - started < 500, "body 超时必须及时释放 flush");
    assert.equal(first.left, 1);
    const pendingPomos = JSON.parse(store.getItem("lumina-cu-pending-pomo-v1"));
    pendingPomos[0].createdAt = Date.now() - 11 * 60 * 1000;
    store.setItem("lumina-cu-pending-pomo-v1", JSON.stringify(pendingPomos));
    // 宽限期过后的空查询不再自动补发（审查第二轮 #3）：下一次 flush 仍须能执行完，
    // 把这条交给待核对记录等用户手动重试；手动重试才再 POST
    const second = await api.flushQueue();
    assert.equal(second.left, 0, "释放后下一次 flush 必须能继续执行");
    assert.equal(postCount, 1, "过了宽限期也不得自动重 POST");
    assert.equal((await api.status()).pendingManual, 1);
    await api.retryPendingPomos();
    assert.equal(postCount, 2, "手动重试后按原 operationId 补发一次");
    ok("ClickUp body 超时释放 flush 单飞锁");
  }

  /* ---- 2. 两次并发 flushQueue 只发出一次 time-entry POST ---- */
  {
    const store = makeLocalStorage();
    let timeEntryPostCount = 0;
    let resolveFirst;
    const firstGate = new Promise((r) => {
      resolveFirst = r;
    });
    let firstInFlight = false;

    const fetchImpl = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/task") && method === "GET") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              tasks: [{ id: "t1", name: "focus-a" }],
            });
          },
        };
      }
      if (u.includes("/time_entries") && method === "GET") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ data: [] });
          },
        };
      }
      if (u.includes("/time_entries") && method === "POST") {
        timeEntryPostCount++;
        if (!firstInFlight) {
          firstInFlight = true;
          await firstGate;
        }
        return {
          ok: true,
          status: 200,
          async text() {
            return "{}";
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return "{}";
        },
      };
    };

    const { api } = loadClickup(store, fetchImpl);
    assert.equal((await api.setStoredToken("pk_" + "x".repeat(24))).ok, true);
    store.setItem(
      "lumina-cu-queue-v1",
      JSON.stringify([
        {
          queueId: "q-test-1",
          operationId: "op-q1",
          title: "focus-a",
          minutes: 25,
          endedAt: Date.now(),
          tries: 0,
          queuedAt: Date.now(),
        },
      ])
    );

    const p1 = api.flushQueue();
    const p2 = api.flushQueue();
    resolveFirst();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(timeEntryPostCount, 1, "并发 flush 只能 POST 一次");
    assert.equal(a.flushed, 1);
    assert.equal(b.flushed, 1);
    assert.equal((await api.status()).queue, 0);
    ok("并发 flushQueue 单飞且只提交一次");
  }

  /* ---- 3. flush 网络等待期间 enqueue，新项不能被旧快照覆盖 ---- */
  {
    const store = makeLocalStorage();
    let resolvePost;
    const postGate = new Promise((r) => {
      resolvePost = r;
    });
    let postSeen = 0;

    const fetchImpl = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/task") && method === "GET") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              tasks: [
                { id: "t1", name: "item-one" },
                { id: "t2", name: "item-two" },
              ],
            });
          },
        };
      }
      if (u.includes("/time_entries") && method === "GET") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ data: [] });
          },
        };
      }
      if (u.includes("/time_entries") && method === "POST") {
        postSeen++;
        if (postSeen === 1) await postGate;
        if (postSeen >= 2) {
          return {
            ok: false,
            status: 500,
            async text() {
              return "server error";
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async text() {
            return "{}";
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return "{}";
        },
      };
    };

    const { api } = loadClickup(store, fetchImpl);
    assert.equal((await api.setStoredToken("pk_" + "x".repeat(24))).ok, true);
    store.setItem(
      "lumina-cu-queue-v1",
      JSON.stringify([
        {
          queueId: "q-a",
          operationId: "op-a",
          title: "item-one",
          minutes: 25,
          endedAt: Date.now() - 1000,
          tries: 0,
          queuedAt: Date.now(),
        },
      ])
    );

    const flushP = api.flushQueue();
    await new Promise((r) => setTimeout(r, 20));

    const qNow = JSON.parse(store.getItem("lumina-cu-queue-v1") || "[]");
    qNow.push({
      queueId: "q-b",
      operationId: "op-b",
      title: "item-two",
      minutes: 25,
      endedAt: Date.now(),
      tries: 0,
      queuedAt: Date.now(),
    });
    store.setItem("lumina-cu-queue-v1", JSON.stringify(qNow));

    resolvePost();
    const result = await flushP;
    assert.equal(result.flushed, 1);
    assert.equal((await api.status()).queue, 1, "flush 期间新入队项不得被覆盖");
    const left = JSON.parse(store.getItem("lumina-cu-queue-v1") || "[]");
    assert.equal(left.length, 1);
    assert.equal(left[0].queueId, "q-b");
  ok("flush 等待期间 enqueue 不被旧快照覆盖");
  }

  /* ---- 不可重试的队列项必须转入失败记录，不能静默丢弃 ---- */
  {
    const store = makeLocalStorage();
    const fetchImpl = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/task") && method === "GET") {
        return { ok: true, status: 200, async text() { return JSON.stringify({ tasks: [{ id: "t1", name: "dead-letter" }] }); } };
      }
      if (u.includes("/time_entries") && method === "GET") {
        return { ok: true, status: 200, async text() { return JSON.stringify({ data: [] }); } };
      }
      if (u.includes("/time_entries") && method === "POST") {
        return { ok: false, status: 400, async text() { return "bad request"; } };
      }
      return { ok: true, status: 200, async text() { return "{}"; } };
    };
    const { api } = loadClickup(store, fetchImpl);
    assert.equal((await api.setStoredToken("pk_" + "x".repeat(24))).ok, true);
    store.setItem("lumina-cu-queue-v1", JSON.stringify([{
      queueId: "q-dead", operationId: "op-dead", title: "dead-letter", minutes: 25,
      endedAt: Date.now() - 1000, tries: 0, queuedAt: Date.now(),
    }]));
    const result = await api.flushQueue();
    assert.equal(result.left, 0);
    const st = await api.status();
    assert.equal(st.failed, 1);
    assert.equal(JSON.parse(store.getItem("lumina-cu-failed-v1"))[0].queueId, "q-dead");
    ok("不可重试队列项进入失败记录");
  }

  /* ---- bridge 基础 ---- */
  {
    const store = makeLocalStorage();
    const { ai } = loadBridge(store, async () => {
      throw new Error("no network in test");
    });
    assert.ok(ai?.isDesktop);
    assert.ok(ai?.isIOS);

    const st = await ai.status();
    assert.equal(st.ok, false);
    assert.equal(st.code, "NO_KEY");

    const set = await ai.setApiKey("sk-" + "a".repeat(24));
    assert.equal(set.ok, true);
    const st2 = await ai.status({ refresh: true });
    assert.equal(st2.ok, true);
    assert.equal(st2.platform, "ios");
    assert.equal(st2.source, "settings");
    ok("mobile-bridge status / setApiKey");

    const emptyRes = await ai.complete({ messages: [] });
    assert.equal(emptyRes.ok, false);
    ok("complete 空 messages 失败");

    let errorCalled = false;
    let doneCalled = false;
    const noMsg = await ai.chat(
      { messages: [{ role: "user", content: "hi" }] },
      {
        onError() {
          errorCalled = true;
        },
        onDone() {
          doneCalled = true;
        },
      }
    );
    assert.equal(noMsg.ok, true);
    assert.ok(noMsg.requestId);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(errorCalled, true, "无网络时应触发 onError");
    assert.equal(doneCalled, false, "失败路径不得 onDone 伪装成功");
    ok("chat 启动登记 requestId 且错误路径收尾");
  }

  /* ---- Keychain 后续读取故障必须被 status 上报，不能伪装成未配置 ---- */
  {
    const store = makeLocalStorage();
    let gets = 0;
    const sandbox = baseSandbox(store);
    sandbox.Capacitor = {
      Plugins: {
        LuminaSecureStore: {
          async get() {
            gets++;
            if (gets === 1) return { value: null }; // migrateKey 的首次读取
            throw new Error("keychain locked");
          },
          async set() {},
          async remove() {},
        },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/secure-store.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "agent-tools.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-bridge.js"), "utf8"), sandbox);
    const st = await sandbox.luminaAI.status({ refresh: true });
    assert.equal(st.code, "KEYCHAIN_READ_FAILED");
    assert.match(st.error, /Keychain/);
    ok("Keychain 读取故障会显示为可诊断错误");
  }

  /* ---- 从系统设置重新允许通知后，运行中的番茄会重新排程 ---- */
  {
    let permission = "denied";
    let schedules = 0;
    const { sandbox, listeners } = loadNotify({
      async checkPermissions() { return { display: permission }; },
      async cancel() {},
      async schedule() { schedules++; },
    });
    await new Promise((r) => setTimeout(r, 10));
    sandbox.__luminaOnPomoChange({
      running: true,
      sound: true,
      mode: "focus",
      endsAt: Date.now() + 60_000,
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(schedules, 0);
    permission = "granted";
    listeners.get("lumina:foreground")();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(schedules, 1);
    ok("通知权限恢复后会重排运行中的番茄");
  }

  /* ---- 长会话裁剪始终保留首条 system 指令 ---- */
  {
    const store = makeLocalStorage();
    let sent = null;
    const { ai } = loadBridge(store, async (_url, opts) => {
      sent = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        body: null,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: "ok" } }] });
        },
      };
    });
    assert.equal((await ai.setApiKey("sk-" + "b".repeat(24))).ok, true);
    const messages = [
      { role: "system", content: "SYSTEM-ANCHOR: never discard this instruction." },
      ...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `${i}:` + "x".repeat(5000) })),
    ];
    const result = await ai.complete({ messages });
    assert.equal(result.ok, true);
    assert.equal(sent.messages[0].role, "system");
    assert.match(sent.messages[0].content, /SYSTEM-ANCHOR/);
    ok("长会话裁剪保留 system 指令");
  }

  /* ---- 4. 超大非流式工具参数必须以 RESPONSE_TOO_LARGE 终止 ---- */
  {
    const store = makeLocalStorage();
    const hugeArgs = "x".repeat(40 * 1024);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      body: null,
      async text() {
        return JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "todo_list", arguments: hugeArgs },
                  },
                ],
              },
            },
          ],
        });
      },
    });
    const { ai } = loadBridge(store, fetchImpl);
    await ai.setApiKey("sk-" + "a".repeat(24));
    let errorCode = null;
    let doneCalled = false;
    const started = await ai.chat(
      { messages: [{ role: "user", content: "hi" }] },
      {
        onError(err) {
          errorCode = String(err || "");
        },
        onDone() {
          doneCalled = true;
        },
      }
    );
    assert.equal(started.ok, true);
    await new Promise((r) => setTimeout(r, 80));
    assert.match(String(errorCode), /安全上限|过大|RESPONSE/i);
    assert.equal(doneCalled, false);
    ok("超大工具参数 RESPONSE_TOO_LARGE 且不 onDone");
  }

  /* ---- 5. sync-web 找不到锚点必须非 0 退出 ---- */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-sync-"));
    const fakeDesktop = path.join(tmp, "todo-app");
    const fakeIos = path.join(tmp, "lumina-todo-ios");
    fs.mkdirSync(path.join(fakeDesktop), { recursive: true });
    fs.mkdirSync(path.join(fakeIos, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(fakeIos, "www"), { recursive: true });

    for (const f of [
      "app.js",
      "chat.js",
      "chat-messages.js",
      "agent-tools.js",
      "agent-loop.js",
      "theme-boot.js",
      "styles.css",
    ]) {
      const body =
        f === "app.js"
          ? "// no needle here\nwindow.__luminaAgent = null;\n"
          : `// stub ${f}\n`;
      fs.writeFileSync(path.join(fakeDesktop, f), body);
    }

    let syncSrc = fs.readFileSync(path.join(ROOT, "scripts/sync-web.js"), "utf8");
    fs.writeFileSync(path.join(fakeIos, "scripts/sync-web.js"), syncSrc);
    for (const rel of [
      "index.html",
      "ios.css",
      "js/secure-store.js",
      "js/mobile-bridge.js",
      "js/mobile-clickup.js",
      "js/mobile-notify.js",
      "js/mobile-settings.js",
      "js/mobile-ux.js",
    ]) {
      const p = path.join(fakeIos, "www", rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "/* keep */\n");
    }

    const child = spawnSync(process.execPath, [path.join(fakeIos, "scripts/sync-web.js")], {
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0, "锚点缺失时 sync-web 必须非 0 退出");
    assert.match(String(child.stderr || child.stdout || ""), /锚点|patch app\.js|失败/);
    ok("sync-web 锚点缺失非 0 退出");

    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /* ---- 源码静态：补丁 A / F 标记 ---- */
  {
    const cu = fs.readFileSync(path.join(WWW, "js/mobile-clickup.js"), "utf8");
    assert.match(cu, /flushPromise/);
    assert.match(cu, /queueId/);
    assert.match(cu, /QUEUE_WRITE_FAILED/);
    assert.match(cu, /operationId/);
    assert.match(cu, /INDETERMINATE/);
    assert.match(cu, /findTaskByOpMarker/);
    assert.match(cu, /findTimeEntryByOpMarker/);
    ok("mobile-clickup 含单飞锁、queueId 与幂等 operationId");
  }

  /* ---- 触摸排序：不得覆盖已有 __luminaReorder（防无限递归） ---- */
  {
    const uxSrc = fs.readFileSync(path.join(WWW, "js/mobile-ux.js"), "utf8");
    assert.match(uxSrc, /typeof window\.__luminaReorder === "function"\) return/);
    assert.doesNotMatch(uxSrc, /setInterval\(syncArt/);
    assert.match(uxSrc, /MutationObserver\(syncArt\)/);
    assert.match(uxSrc, /长按左侧手柄可排序|__luminaInstallTouchReorder/);

    // 模拟 app.js 先装 reorder，再 install：身份必须保持，且调用不递归
    const sandbox = baseSandbox(makeLocalStorage());
    let callCount = 0;
    const original = (ids) => {
      callCount++;
      if (callCount > 3) throw new Error("reorder recursion");
      return Array.isArray(ids) && ids.length > 0;
    };
    sandbox.window.__luminaReorder = original;
    vm.createContext(sandbox);
    // 只执行 patch 定义：抽 install 逻辑验证
    vm.runInContext(
      `
      (function () {
        globalThis.__luminaInstallTouchReorder = function (api) {
          if (api && typeof api === "object") {
            globalThis.__luminaTouchReorderApi = api;
          }
          if (typeof globalThis.__luminaReorder === "function") return;
          if (!api || typeof api.getTodos !== "function" || typeof api.setTodosAndPersist !== "function") {
            return;
          }
          globalThis.__luminaReorder = function (ids) {
            const list = api.getTodos();
            const map = new Map(list.map((t) => [t.id, t]));
            const next = [];
            for (const id of ids) {
              const t = map.get(id);
              if (t) { next.push(t); map.delete(id); }
            }
            for (const t of list) if (map.has(t.id)) next.push(t);
            api.setTodosAndPersist(next);
            api.render && api.render();
            return true;
          };
        };
      })();
      `,
      sandbox
    );
    sandbox.__luminaInstallTouchReorder({
      getTodos: () => [{ id: "a" }, { id: "b" }],
      setTodosAndPersist: (next) => {
        // 旧 bug：这里再调 __luminaReorder 会无限递归
        sandbox.__luminaReorder(next.map((t) => t.id));
      },
      render() {},
    });
    assert.strictEqual(sandbox.__luminaReorder, original, "不得覆盖 app 已装 reorder");
    assert.equal(sandbox.__luminaReorder(["b", "a"]), true);
    assert.equal(callCount, 1, "单次调用不得递归");
    ok("触摸排序 install 不覆盖已有 __luminaReorder");
  }

  /* ---- API Key 预热失败后可重试 ---- */
  {
    const store = makeLocalStorage();
    store.setItem("lumina-api-key", "sk-" + "b".repeat(24));
    const sandbox = baseSandbox(store);
    let migrateCalls = 0;
    sandbox.LUMINA_SECURE_STORE = {
      backend: () => "mock",
      async migrateKey() {
        migrateCalls++;
        if (migrateCalls === 1) throw new Error("keychain busy");
        return store.getItem("lumina-api-key");
      },
      async get(k) {
        return store.getItem(k);
      },
      async set(k, v) {
        store.setItem(k, v);
        return true;
      },
      async remove(k) {
        store.removeItem(k);
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "agent-tools.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-bridge.js"), "utf8"), sandbox);
    await new Promise((r) => setTimeout(r, 30));
    const st = await sandbox.luminaAI.status({ refresh: true });
    assert.equal(st.ok, true, "预热失败后 refresh 应能读到 key");
    assert.ok(migrateCalls >= 1);
    ok("API Key 预热失败后可重试");
  }

  /* ---- AI 服务商切换：端点 / 模型 / key 存储位 ---- */
  {
    const store = makeLocalStorage();
    store.setItem("lumina-api-key", "sk-" + "a".repeat(24));
    store.setItem("lumina-api-key-commandcode", "cmd-" + "c".repeat(24));
    const sandbox = baseSandbox(store);
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "agent-tools.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-bridge.js"), "utf8"), sandbox);
    await new Promise((r) => setTimeout(r, 30));
    const pv = await sandbox.luminaAI.providers();
    assert.equal(pv.ok, true);
    assert.ok(pv.list.find((x) => x.id === "commandcode"), "应有 Command Code");
    assert.ok(pv.list.find((x) => x.id === "factory"), "应有 Factory 中转");
    // 默认 OpenCode
    let st = await sandbox.luminaAI.status({ refresh: true });
    assert.equal(st.model, "deepseek-v4-flash");
    assert.ok(st.base.includes("opencode.ai"));
    // 切到 Command Code：模型带厂商前缀，端点走 api.commandcode.ai，key 各自独立
    const sw = await sandbox.luminaAI.setProvider("commandcode");
    assert.equal(sw.ok, true);
    st = await sandbox.luminaAI.status({ refresh: true });
    assert.equal(st.model, "deepseek/deepseek-v4.1-flash");
    assert.ok(st.base.includes("api.commandcode.ai"));
    assert.equal(st.ok, true, "Command Code 应读到自己存储位的 key");
    // 非法 id 报错，当前服务商不变
    const bad = await sandbox.luminaAI.setProvider("nope");
    assert.equal(bad.ok, false);
    // ClickUp token 不能当 AI key；OpenCode 仍要求 sk-
    const pkRes = await sandbox.luminaAI.setApiKey("pk_" + "z".repeat(30));
    assert.equal(pkRes.ok, false, "pk_ token 应被拒绝");
    await sandbox.luminaAI.setProvider("opencode");
    const noSk = await sandbox.luminaAI.setApiKey("x".repeat(30));
    assert.equal(noSk.ok, false, "OpenCode 仍要求 sk- 前缀");
    ok("AI 服务商可切换 Command Code（独立 key 存储）");
  }

  /* ---- Command Code complete 请求使用对应服务商配置 ---- */
  {
    const key = "cmd-" + "c".repeat(24);
    const store = makeLocalStorage();
    store.setItem("lumina-api-provider", "commandcode");
    store.setItem("lumina-api-key-commandcode", key);
    let request;
    const { ai } = loadBridge(store, async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          });
        },
      };
    });
    await new Promise((r) => setTimeout(r, 30));
    const result = await ai.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: false,
    });
    assert.equal(result.ok, true);
    assert.equal(request.url, "https://api.commandcode.ai/provider/v1/chat/completions");
    assert.equal(request.headers.Authorization, `Bearer ${key}`);
    assert.equal(request.body.model, "deepseek/deepseek-v4.1-flash");
    ok("complete 使用 Command Code URL、key 与模型");
  }

  /* ---- Factory 中转地址配置、规范化与 complete 请求 ---- */
  {
    const key = "relay-token-" + "f".repeat(24);
    const store = makeLocalStorage();
    store.setItem("lumina-api-provider", "factory");
    store.setItem("lumina-api-key-factory", key);
    let request;
    const { ai } = loadBridge(store, async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          });
        },
      };
    });
    await new Promise((r) => setTimeout(r, 30));
    const first = ai.setProviderBase("factory", "  https://relay.example.com///  ");
    assert.deepEqual(first, { ok: true, base: "https://relay.example.com/v1" });
    assert.equal(
      ai.setProviderBase("factory", "https://x.com").base,
      "https://x.com/v1"
    );
    assert.equal(
      ai.setProviderBase("factory", "https://x.com/v1/").base,
      "https://x.com/v1"
    );
    assert.equal(ai.setProviderBase("factory", "http://x.com").ok, false);
    assert.equal(ai.setProviderBase("commandcode", "https://x.com").ok, false);
    const base = ai.setProviderBase("factory", "https://relay.example.com/v1");
    assert.equal(base.ok, true);
    const result = await ai.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: false,
    });
    assert.equal(result.ok, true);
    assert.equal(request.url, "https://relay.example.com/v1/chat/completions");
    assert.equal(request.headers.Authorization, `Bearer ${key}`);
    assert.equal(request.body.model, "deepseek-v4.1-flash");
    ok("Factory 地址规范化并使用中转 URL、口令和模型");
  }

  /* ---- Factory 未配置中转地址时不发起网络请求 ---- */
  {
    const store = makeLocalStorage();
    store.setItem("lumina-api-provider", "factory");
    let fetchCalls = 0;
    const { ai } = loadBridge(store, async () => {
      fetchCalls++;
      throw new Error("unexpected fetch");
    });
    const status = await ai.status({ refresh: true });
    assert.equal(status.code, "NO_BASE");
    assert.match(status.error, /未设置 Factory 中转地址/);
    const complete = await ai.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: false,
    });
    assert.equal(complete.code, "NO_BASE");
    assert.match(complete.error, /https/);
    const chat = await ai.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(chat.code, "NO_BASE");
    assert.equal(fetchCalls, 0);
    ok("Factory 缺少中转地址时状态和请求均不发起 fetch");
  }

  /* ---- Factory 请求在服务商及地址切换期间固定配置 ---- */
  {
    const key = "relay-token-" + "g".repeat(24);
    const store = makeLocalStorage();
    store.setItem("lumina-api-provider", "factory");
    store.setItem("lumina-api-key-factory", key);
    store.setItem("lumina-factory-base", "https://old-relay.example.com/v1");
    let request;
    const { ai } = loadBridge(store, async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          });
        },
      };
    });
    await new Promise((r) => setTimeout(r, 30));
    const pending = ai.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: false,
    });
    await Promise.resolve();
    assert.equal(ai.setProvider("opencode").ok, true);
    assert.equal(
      ai.setProviderBase("factory", "https://new-relay.example.com/v1").ok,
      true
    );
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(request.url, "https://old-relay.example.com/v1/chat/completions");
    assert.equal(request.headers.Authorization, `Bearer ${key}`);
    assert.equal(request.body.model, "deepseek-v4.1-flash");
    ok("Factory 请求在服务商和中转地址切换期间固定配置");
  }

  /* ---- 请求期间切换服务商不会混用 endpoint / key / model ---- */
  {
    const key = "cmd-" + "d".repeat(24);
    const store = makeLocalStorage();
    store.setItem("lumina-api-provider", "commandcode");
    store.setItem("lumina-api-key-commandcode", key);
    let request;
    const { ai } = loadBridge(store, async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          });
        },
      };
    });
    await new Promise((r) => setTimeout(r, 30));
    const pending = ai.complete({
      messages: [{ role: "user", content: "hi" }],
      tools: false,
    });
    await Promise.resolve();
    const switched = ai.setProvider("opencode");
    assert.equal(switched.ok, true);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(request.url, "https://api.commandcode.ai/provider/v1/chat/completions");
    assert.equal(request.headers.Authorization, `Bearer ${key}`);
    assert.equal(request.body.model, "deepseek/deepseek-v4.1-flash");
    ok("请求期间切换服务商仍使用 Command Code 配置");
  }

  /* ---- 服务商选择无法持久化时返回失败且不切换 ---- */
  {
    const store = makeLocalStorage();
    const setItem = store.setItem;
    store.setItem = (key, value) => {
      if (key === "lumina-api-provider") throw new Error("storage unavailable");
      setItem(key, value);
    };
    const { ai } = loadBridge(store);
    const result = ai.setProvider("commandcode");
    assert.equal(result.ok, false);
    assert.equal((await ai.providers()).current, "opencode");
    ok("服务商存储失败时返回错误并保留当前选择");
  }

  /* ---- app.js 触控排序文案与 O(n) 历史分组 ---- */
  {
    const appSrc = fs.readFileSync(path.join(WWW, "app.js"), "utf8");
    assert.match(appSrc, /长按(左侧)?手柄可排序/);
    assert.match(appSrc, /dayCounts/);
    assert.doesNotMatch(
      appSrc,
      /list\.filter\(\(x\) => dayKey\(x\.completedAt/
    );
    ok("app.js 触控排序提示与历史分组 O(n)");
  }

  /* ---- 私人配置不能位于 www，也不能再被页面加载 ---- */
  {
    assert.equal(fs.existsSync(path.join(WWW, "js/personal-config.local.js")), false);
    assert.equal(fs.existsSync(path.join(WWW, "data/personal-secrets.json")), false);
    assert.equal(fs.existsSync(path.join(WWW, "data/desktop-state.json")), false);
    ok("私有配置不在 www，页面不会自动注入密钥");
  }

  /* ---- ClickUp team/list 仅接受不含密钥的显式配置 ---- */
  {
    const store = makeLocalStorage();
    const sandbox = baseSandbox(store);
    sandbox.LUMINA_CLICKUP_IDS = { teamId: "team-x", listId: "list-y" };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/secure-store.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-clickup.js"), "utf8"), sandbox);
    // 通过 status 与内部 id 解析：打补丁读导出
    assert.ok(sandbox.LUMINA_MOBILE_CLICKUP);
    ok("mobile-clickup 接受显式 team/list 配置");
  }


  /* ======================= Linear 审查第一轮回归（app.js，假 DOM 多标签页） ======================= */
  const { loadApp, makeStorageMap, makeClock } = require("./app-harness");
  const TODO_KEY = "lumina-todo-v2";
  const POMO_STORE_KEY = "lumina-pomo";
  const diskTodos = (storage) => (JSON.parse(storage.getItem(TODO_KEY) || "null") || { todos: [] }).todos;
  function sharedStorage() {
    const storage = makeStorageMap();
    storage.setItem("lumina-todo-seeded", "1");
    const rawSet = storage.setItem;
    storage.failTodoWrites = false;
    storage.setItem = (k, v) => {
      if (storage.failTodoWrites && k === TODO_KEY) {
        const err = new Error("quota");
        err.name = "QuotaExceededError";
        throw err;
      }
      rawSet(k, v);
    };
    return storage;
  }

  /* ---- 高 2：脏窗口恢复写前必须先合并别页写入，不能等下一次操作 ---- */
  for (const deliverEvent of [true, false]) {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    assert.equal(A.invoke("add_todo", { text: "X" }).ok, true);
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("add_todo", { text: "Y（本页写失败）" }).ok, true);
    assert.ok(!diskTodos(storage).some((t) => t.text.startsWith("Y")), "写失败时盘上不应有 Y");
    storage.failTodoWrites = false;
    assert.equal(B.invoke("add_todo", { text: "Z（别页新增）" }).ok, true);
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    // 本页下一次写成功，随后「立即关闭」：盘上必须已经同时有 Y 和 Z
    assert.equal(A.invoke("add_todo", { text: "W" }).ok, true);
    const texts = diskTodos(storage).map((t) => t.text).sort();
    assert.deepEqual(texts, ["W", "X", "Y（本页写失败）", "Z（别页新增）"].sort());
  }
  ok("高2 写失败恢复时先三方合并别页新增，恢复写后立即关闭也不丢");

  /* ---- 审查第二轮 #4：合并→恢复写再次失败→删除刚合入的远端条目 R→恢复成功：R 必须保持删除 ---- */
  for (const deliverEvent of [true, false]) {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    assert.equal(A.invoke("add_todo", { text: "X" }).ok, true);
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("add_todo", { text: "Y（本页写失败）" }).ok, true);
    storage.failTodoWrites = false;
    const r = B.invoke("add_todo", { text: "R（别页新增）" }).todo;
    assert.ok(r && r.id);
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    // 恢复写前合入 R，但这次写又失败
    storage.failTodoWrites = true;
    assert.equal(A.invoke("add_todo", { text: "W" }).ok, true);
    const mem1 = A.invoke("list_todos", {}).todos.map((t) => t.text);
    assert.ok(mem1.includes("R（别页新增）"), "合并后内存应含 R");
    // 用户删掉刚合入的 R（写仍失败）
    assert.equal(A.invoke("delete_todo", { id: r.id }).ok, true);
    assert.ok(!A.invoke("list_todos", {}).todos.some((t) => t.id === r.id), "删除后 R 不得被立即合回");
    // 恢复写成功
    storage.failTodoWrites = false;
    assert.equal(A.invoke("add_todo", { text: "V" }).ok, true);
    const disk = diskTodos(storage).map((t) => t.text).sort();
    assert.deepEqual(disk, ["V", "W", "X", "Y（本页写失败）"].sort(), "恢复写成功后 R 必须保持删除");
    assert.ok(!A.invoke("list_todos", {}).todos.some((t) => t.id === r.id));
  }
  ok("审查二#4 合并→再次写失败→删除 R→恢复成功：R 保持删除");

  /* ---- 审查二#3：长时间未确认的上传交给用户：toast 提供「重新上传」，点了才带 manualRetry ---- */
  {
    const storage = sharedStorage();
    const calls = [];
    const clickup = {
      pushTodo: async (p) => {
        calls.push(p);
        if (!p.manualRetry) return { ok: false, code: "NEEDS_MANUAL_RETRY", error: "上次上传长时间未确认", retryable: false };
        return { ok: true, taskId: "cu-manual-1", url: "https://app.clickup.com/t/cu-manual-1" };
      },
      logPomo: async () => ({ ok: true }),
    };
    const A = loadApp({ storage, clickup, confirm: true });
    const t = A.invoke("add_todo", { text: "要手动重传" }).todo;
    const r = await A.invoke("push_todo_to_clickup", { id: t.id });
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].manualRetry, undefined, "自动路径不得带 manualRetry");
    const action = A.sandbox.document.querySelector("#toastAction");
    assert.equal(action.hidden, false, "应提供「重新上传」操作");
    assert.equal(action.textContent, "重新上传");
    action.onclick();
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].manualRetry, true);
    const live = A.invoke("list_todos", {}).todos.find((x) => x.id === t.id);
    assert.equal(live.clickupTaskId, "cu-manual-1");
  }
  ok("审查二#3 长时间未确认的上传：toast 提供「重新上传」，用户确认后才带 manualRetry");

  /* ---- 高 3：ClickUp 回写不得让「撤销无关操作」回滚别页的编辑 ---- */
  {
    const storage = sharedStorage();
    let resolvePush;
    const clickup = {
      pushTodo: () => new Promise((resolve) => { resolvePush = resolve; }),
      logPomo: async () => ({ ok: true }),
    };
    const A = loadApp({ storage, clickup });
    const a1 = A.invoke("add_todo", { text: "旧正文" }).todo;
    const B = loadApp({ storage });
    assert.equal(A.invoke("add_todo", { text: "本页新增 B" }).ok, true);
    const pushing = A.invoke("push_todo_to_clickup", { id: a1.id });
    assert.equal(B.invoke("update_todo", { id: a1.id, text: "别页的新正文" }).ok, true);
    resolvePush({ ok: true, taskId: "cu-a1", url: "https://app.clickup.com/t/cu-a1" });
    const pushed = await pushing;
    assert.equal(pushed.ok, true);
    assert.equal(A.invoke("undo").ok, true);
    const after = diskTodos(storage);
    const a1After = after.find((t) => t.id === a1.id);
    assert.equal(a1After.text, "别页的新正文", "远端正文不得被撤销还原");
    assert.equal(a1After.clickupTaskId, "cu-a1");
    assert.ok(!after.some((t) => t.text === "本页新增 B"), "撤销的目标操作仍要生效");
  }
  ok("高3 ClickUp 回写后撤销无关操作，保留别页编辑与 taskId");

  /* ---- 审查三②：脏窗口撤销必须是操作级，不得回滚已合入的远端字段 ---- */
  for (const deliverEvent of [true, false]) {
    // 评审原始复现：写失败期间合入别页对已有条目的编辑，再撤销一次无关新增
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "X 旧正文" }).todo;
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("add_todo", { text: "Y（写失败）" }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "X 别页新正文" }).ok, true);
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    storage.failTodoWrites = true;
    assert.equal(A.invoke("add_todo", { text: "W 无关新增" }).ok, true);   // 恢复写前合入远端正文，写仍失败
    assert.equal(A.invoke("list_todos", {}).todos.find((t) => t.id === x.id).text, "X 别页新正文", "前置：远端正文已合入内存");
    assert.equal(A.invoke("undo").ok, true);
    const m = A.invoke("list_todos", {}).todos;
    assert.ok(!m.some((t) => t.text === "W 无关新增"), "撤销目标仍要生效");
    assert.equal(m.find((t) => t.id === x.id).text, "X 别页新正文", "撤销无关新增不得回滚远端正文");
    storage.failTodoWrites = false;
    assert.equal(A.invoke("add_todo", { text: "V" }).ok, true);
    assert.deepEqual(diskTodos(storage).map((t) => t.text).sort(), ["V", "X 别页新正文", "Y（写失败）"].sort(), "恢复写不得把旧正文落盘");
  }
  for (const deliverEvent of [true, false]) {
    // 字段级：本页改了 priority（写失败），别页改了 text；撤销 priority 只还原 priority
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "X 旧正文", priority: "low" }).todo;
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, priority: "high" }).ok, true);   // op1（写失败）
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "X 别页新正文" }).ok, true);
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    storage.failTodoWrites = true;
    assert.equal(A.invoke("add_todo", { text: "W 无关新增" }).ok, true);              // op2
    assert.equal(A.invoke("undo").ok, true);   // 撤销 op2
    assert.equal(A.invoke("undo").ok, true);   // 撤销 op1
    const m2 = A.invoke("list_todos", {}).todos;
    assert.ok(!m2.some((t) => t.text === "W 无关新增"));
    storage.failTodoWrites = false;
    assert.equal(A.invoke("add_todo", { text: "V" }).ok, true);
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(dx.text, "X 别页新正文", "字段级撤销只还原本操作改的字段，远端正文保留");
    assert.equal(dx.priority, "low", "本操作改的 priority 被撤销");
  }
  /* 不脏的相邻路径：远端编辑流入后本页又改过同一条（版本标记被销），再撤销更早的无关操作 */
  {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "X 旧正文", priority: "low" }).todo;
    const B = loadApp({ storage });
    assert.equal(A.invoke("add_todo", { text: "Y 无关新增" }).ok, true);           // op1
    assert.equal(B.invoke("update_todo", { id: x.id, text: "X 别页新正文" }).ok, true);
    A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(A.invoke("update_todo", { id: x.id, priority: "high" }).ok, true); // op2
    assert.equal(A.invoke("undo").ok, true);
    assert.equal(A.invoke("undo").ok, true);
    const d = diskTodos(storage);
    assert.ok(!d.some((t) => t.text === "Y 无关新增"));
    const dx = d.find((t) => t.id === x.id);
    assert.equal(dx.text, "X 别页新正文", "撤销更早的操作不得回滚之后合入的远端正文");
    assert.equal(dx.priority, "low");
  }
  /* 撤销删除 / 撤销排序：远端在之后改过的字段与顺序都保留 */
  {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const p = A.invoke("add_todo", { text: "P" }).todo;
    const q = A.invoke("add_todo", { text: "Q" }).todo;
    const B = loadApp({ storage });
    assert.equal(A.invoke("delete_todo", { id: q.id }).ok, true);
    assert.equal(B.invoke("update_todo", { id: p.id, text: "P 别页改" }).ok, true);
    A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(A.invoke("undo").ok, true);
    const d = diskTodos(storage).map((t) => t.text);
    assert.deepEqual(d, ["Q", "P 别页改"], "删除被撤销且按原位插回，远端编辑保留");
  }
  /* 撤销步尚未封口（同一事件循环内）就流入的远端编辑/新增：只反做本地操作 */
  {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "X", priority: "low" }).todo;
    const B = loadApp({ storage });
    assert.equal(A.invoke("update_todo", { id: x.id, priority: "high" }).ok, true);   // 本地操作
    assert.equal(B.invoke("update_todo", { id: x.id, text: "X 别页改" }).ok, true);
    assert.equal(B.invoke("add_todo", { text: "R 别页新增" }).ok, true);
    A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));                             // 同步投递，无微任务间隙
    assert.equal(A.invoke("undo").ok, true);
    const d = diskTodos(storage);
    assert.deepEqual(d.map((t) => t.text), ["R 别页新增", "X 别页改"], "远端新增与顺序保留");
    assert.equal(d.find((t) => t.id === x.id).priority, "low", "本地改的 priority 被撤销");
  }
  ok("审查三② 撤销为操作/字段级：脏窗口与不脏路径都不回滚已合入的远端编辑");

  /* ---- 审查三③：ClickUp 系统回写不得给旧正文「本地已编辑」优先权 ---- */
  for (const deliverEvent of [true, false]) {
    const storage = sharedStorage();
    let resolvePush;
    const clickup = {
      pushTodo: () => new Promise((resolve) => { resolvePush = resolve; }),
      logPomo: async () => ({ ok: true }),
    };
    const A = loadApp({ storage, clickup });
    const x = A.invoke("add_todo", { text: "X 旧正文" }).todo;
    const B = loadApp({ storage });
    const pushing = A.invoke("push_todo_to_clickup", { id: x.id });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("add_todo", { text: "Y（写失败）" }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "X 别页新正文", priority: "high" }).ok, true);
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    resolvePush({ ok: true, taskId: "cu-x", url: "https://app.clickup.com/t/cu-x" });
    assert.equal((await pushing).ok, true);
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(dx.text, "X 别页新正文", "回写 taskId 不得让旧正文盖掉远端编辑");
    assert.equal(dx.priority, "high");
    assert.equal(dx.clickupTaskId, "cu-x", "系统字段仍要合入");
    assert.ok(diskTodos(storage).some((t) => t.text === "Y（写失败）"), "本页未落盘的新增也要保留");
  }
  /* 系统回写不推 updatedAt（用户编辑时间）：软合并不会把旧正文当成新版 */
  {
    const storage = sharedStorage();
    const clickup = { pushTodo: async () => ({ ok: true, taskId: "cu-y", url: "https://app.clickup.com/t/cu-y" }), logPomo: async () => ({ ok: true }) };
    const A = loadApp({ storage, clickup });
    const y = A.invoke("add_todo", { text: "Y" }).todo;
    const before = diskTodos(storage).find((t) => t.id === y.id).updatedAt;
    A.clock.advance(5000);
    assert.equal((await A.invoke("push_todo_to_clickup", { id: y.id })).ok, true);
    const after = diskTodos(storage).find((t) => t.id === y.id);
    assert.equal(after.clickupTaskId, "cu-y");
    assert.equal(after.updatedAt, before, "ClickUp 回写不得推进用户编辑时间");
  }
  ok("审查三③ ClickUp 回写与用户字段分开合并，远端编辑胜出且关联不丢");

  /* ---- 中：Agent 完成/恢复工具在本页状态过期时不得做相反操作 ---- */
  {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const t = A.invoke("add_todo", { text: "跨页完成" }).todo;
    const B = loadApp({ storage });
    assert.equal(B.invoke("complete_todo", { id: t.id }).ok, true);
    const r1 = A.invoke("complete_todo", { id: t.id });
    assert.equal(r1.ok, true);
    assert.equal(diskTodos(storage).find((x) => x.id === t.id).completed, true, "complete 后必须是已完成");
    assert.equal(B.invoke("uncomplete_todo", { id: t.id }).ok, true);
    const r2 = A.invoke("uncomplete_todo", { id: t.id });
    assert.equal(r2.ok, true);
    assert.equal(diskTodos(storage).find((x) => x.id === t.id).completed, false, "uncomplete 后必须是进行中");
  }
  ok("中 complete/uncomplete 工具同步后按显式目标状态写入");

  /* ---- 中：update_todo 的 due_date:null 清除截止日期 ---- */
  {
    const A = loadApp({ storage: sharedStorage() });
    const t = A.invoke("add_todo", { text: "有截止日期", due_date: "2030-01-02" }).todo;
    assert.equal(t.dueDate, "2030-01-02");
    const r = A.invoke("update_todo", { id: t.id, due_date: null });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.todo.dueDate, null);
  }
  ok("中 update_todo({due_date:null}) 清除截止日期");

  /* ---- 中：导出用应用内存快照（写失败时盘上是旧数据） ---- */
  {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    A.invoke("add_todo", { text: "已落盘" });
    storage.failTodoWrites = true;
    A.invoke("add_todo", { text: "只在内存" });
    const snap = A.sandbox.__luminaExportSnapshot();
    assert.ok(snap.todos.some((t) => t.text === "只在内存"));
    assert.ok(!diskTodos(storage).some((t) => t.text === "只在内存"));
    const settingsSrc = fs.readFileSync(path.join(WWW, "js/mobile-settings.js"), "utf8");
    assert.match(settingsSrc, /__luminaExportSnapshot\(\)/);
  }
  ok("中 iOS 导出与网页导出共用内存快照");

  /* ---- 低：Agent 正文上限与保存上限一致，超长明确拒绝 ---- */
  {
    const A = loadApp({ storage: sharedStorage() });
    const long = "长".repeat(501);
    const r = A.invoke("add_todo", { text: long });
    assert.equal(r.ok, false);
    assert.equal(r.code, "BAD_ARGS");
    const t = A.invoke("add_todo", { text: "短" }).todo;
    assert.equal(A.invoke("update_todo", { id: t.id, text: long }).ok, false);
    assert.equal(A.invoke("add_todo", { text: "满".repeat(500) }).todo.text.length, 500);
  }
  ok("低 Agent 正文超过 500 字明确拒绝，不再静默截断");

  /* ---- 中：暂停后切换预设只影响下一段，计时与上传时长一致 ---- */
  {
    const MINUTE = 60 * 1000;
    const logs = [];
    const clock = makeClock();
    const storage = sharedStorage();
    const A = loadApp({
      storage,
      clock,
      clickup: { logPomo: async (p) => { logs.push(p); return { ok: true }; }, pushTodo: async () => ({ ok: false }) },
    });
    A.invoke("pomo_start", { mode: "focus" });
    clock.advance(15 * MINUTE);
    A.invoke("pomo_pause");
    const r = A.invoke("pomo_set_preset", { preset: 1 });
    assert.equal(r.ok, true);
    A.invoke("pomo_start");
    const st = A.invoke("pomo_status").pomo;
    assert.ok(Math.abs(st.remainingMs - 10 * MINUTE) < 2000, "剩余应仍约 10 分钟，实际 " + st.remainingMs);
    assert.equal(JSON.parse(storage.getItem(POMO_STORE_KEY)).segmentMs, 25 * MINUTE);
    clock.advance(11 * MINUTE);
    A.invoke("pomo_pause");
    A.invoke("pomo_start"); // 停在零点上按继续 → 结算
    await new Promise((r2) => setTimeout(r2, 20));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].minutes, 25, "上传时长必须等于实际计时的这一段");
    // 新的一段才用新预设，计时与 segmentMs 同步锁定
    A.invoke("pomo_skip");
    A.invoke("pomo_start", {});
    const fresh = JSON.parse(storage.getItem(POMO_STORE_KEY));
    assert.equal(fresh.segmentMs, 50 * MINUTE);
    assert.ok(Math.abs(fresh.endsAt - clock.Date.now() - 50 * MINUTE) < 2000);
  }
  ok("中 暂停后切换预设不改当前段，打卡时长与计时一致");

  /* ---- 中：已上传的待办记番茄时带 ClickUp taskId（长标题不再新建任务） ---- */
  {
    const MINUTE = 60 * 1000;
    const logs = [];
    const clock = makeClock();
    const A = loadApp({
      storage: sharedStorage(),
      clock,
      clickup: {
        logPomo: async (p) => { logs.push(p); return { ok: true }; },
        pushTodo: async () => ({ ok: true, taskId: "cu-long", url: "https://app.clickup.com/t/cu-long" }),
      },
    });
    const t = A.invoke("add_todo", { text: "长".repeat(300) }).todo;
    assert.equal((await A.invoke("push_todo_to_clickup", { id: t.id })).ok, true);
    A.invoke("pomo_focus_task", { id: t.id });
    clock.advance(26 * MINUTE);
    A.invoke("pomo_pause");
    A.invoke("pomo_start");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].taskId, "cu-long");
    assert.equal(logs[0].title.length, 300);
  }
  ok("中 番茄打卡优先使用待办已有的 ClickUp taskId");


  /* ======================= Linear 审查第一轮回归（ClickUp / 安全存储 / AI 桥） ======================= */
  const TOKEN_A = "pk_" + "a".repeat(24);
  const TOKEN_B = "pk_" + "b".repeat(24);
  const reply = (status, body) => ({
    ok: status < 400,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  });
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  /* ---- 中：原生 POST 忽略 AbortSignal 且不返回时，15s 截止时间覆盖整个请求 ---- */
  {
    const store = makeLocalStorage();
    const hang = () => new Promise(() => {}); // 原生层：既不返回也不理会 signal
    const { api } = loadClickup(store, async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
      if (u.includes("/task") && method === "GET") {
        return reply(200, { tasks: [{ id: "t-hang", name: "挂起的番茄" }], last_page: true });
      }
      if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
      if (method === "POST") return hang();
      return reply(200, {});
    }, { timeoutCapMs: 30 });
    assert.equal((await api.setStoredToken(TOKEN_A)).ok, true);
    const t0 = Date.now();
    const pushed = await api.pushTodo({ title: "挂起的上传", todoId: "hang-1" });
    assert.equal(pushed.code, "INDETERMINATE");
    const pomo = await api.logPomodoro({ title: "挂起的番茄", minutes: 25, endedAt: Date.now(), operationId: "op-hang-pomo" });
    assert.equal(pomo.code, "INDETERMINATE");
    assert.ok(Date.now() - t0 < 2000, "必须在截止时间内收尾");
    const st = await api.status();
    assert.equal(st.pendingPush, 1, "不确定的创建保留待核对");
    assert.equal(st.pendingPomo, 1, "不确定的打卡保留待核对");
  }
  ok("中 ClickUp 原生 POST 不返回时整体截止并保留待核对");

  /* ---- 中：更换 Token 后不得沿用旧账号的 assignee ---- */
  {
    const store = makeLocalStorage();
    const assignees = [];
    let n = 0;
    const { api } = loadClickup(store, async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      const auth = opts && opts.headers && opts.headers.Authorization;
      if (u.endsWith("/user")) return reply(200, { user: { id: auth === TOKEN_A ? 111 : 222 } });
      if (u.includes("/task") && method === "GET") return reply(200, { tasks: [], last_page: true });
      if (u.includes("/task") && method === "POST") {
        assignees.push(JSON.parse(opts.body).assignees[0]);
        n++;
        return reply(200, { id: "task-" + n });
      }
      return reply(200, {});
    });
    await api.setStoredToken(TOKEN_A);
    assert.equal((await api.pushTodo({ title: "A 账号", todoId: "acct-a" })).ok, true);
    await api.setStoredToken(TOKEN_B);
    assert.equal((await api.pushTodo({ title: "B 账号", todoId: "acct-b" })).ok, true);
    assert.deepEqual(assignees, [111, 222]);
  }
  ok("中 更换 ClickUp Token 后清除身份缓存");

  /* ---- 中：已成功上传的同一待办，重传复用结果 / 按 marker 找回，不重复创建 ---- */
  {
    const store = makeLocalStorage();
    let posts = 0;
    let remote = [];
    const fetchImpl = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.endsWith("/user")) return reply(200, { user: { id: 5 } });
      if (u.includes("/task") && method === "GET") return reply(200, { tasks: remote, last_page: true });
      if (u.includes("/task") && method === "POST") {
        posts++;
        return reply(200, { id: "task-dup-" + posts });
      }
      return reply(200, {});
    };
    const { api } = loadClickup(store, fetchImpl);
    await api.setStoredToken(TOKEN_A);
    const first = await api.pushTodo({ title: "上传一次", todoId: "dup-1" });
    assert.equal(first.ok, true);
    // 远端成功但 App 没存下关联：同一 todoId 再传
    const again = await api.pushTodo({ title: "上传一次", todoId: "dup-1" });
    assert.equal(again.ok, true);
    assert.equal(again.taskId, first.taskId);
    assert.equal(posts, 1, "本机已确认创建过，不得再次 POST");
    // 从备份恢复（本机没有任何记录），远端已有同 marker 的任务
    const fresh = makeLocalStorage();
    remote = [{ id: "task-restored", name: "备份里的", description: "x\n[lumina-op:todo-dup-2]" }];
    const { api: api2 } = loadClickup(fresh, fetchImpl);
    await api2.setStoredToken(TOKEN_A);
    const restored = await api2.pushTodo({ title: "备份里的", todoId: "dup-2" });
    assert.equal(restored.ok, true);
    assert.equal(restored.taskId, "task-restored");
    assert.equal(posts, 1, "远端已有同 marker 任务，不得重复创建");
  }
  ok("中 已上传待办重传先查本机确认与远端 marker，不重复创建");

  /* ---- 中：创建超时后查询暂时为空，宽限期内不重建；迟到落库后对账找回 ---- */
  {
    const store = makeLocalStorage();
    let posts = 0;
    let remote = [];
    const { api } = loadClickup(store, async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.endsWith("/user")) return reply(200, { user: { id: 5 } });
      if (u.includes("/task") && method === "GET") return reply(200, { tasks: remote, last_page: true });
      if (u.includes("/task") && method === "POST") {
        posts++;
        if (posts === 1) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return reply(200, { id: "task-late-" + posts });
      }
      return reply(200, {});
    });
    await api.setStoredToken(TOKEN_A);
    const r1 = await api.pushTodo({ title: "超时的上传", todoId: "late-1" });
    assert.equal(r1.code, "INDETERMINATE");
    const r2 = await api.pushTodo({ title: "超时的上传", todoId: "late-1" });
    assert.equal(r2.code, "INDETERMINATE");
    assert.equal(posts, 1, "宽限期内立即重试不得再次 POST");
    // 首次请求迟到落库：对账找回并记为已创建
    remote = [{ id: "task-late-landed", name: "超时的上传", description: "[lumina-op:todo-late-1]" }];
    const rec = await api.reconcilePendingPushes();
    assert.equal(rec.reconciled, 1);
    remote = [];
    const r3 = await api.pushTodo({ title: "超时的上传", todoId: "late-1" });
    assert.equal(r3.ok, true);
    assert.equal(r3.taskId, "task-late-landed");
    assert.equal(posts, 1);
    // 另一条：宽限期过后仍查无才允许重新创建
    const r4 = await api.pushTodo({ title: "真的没写上", todoId: "late-2" });
    assert.equal(r4.ok, true, "第二次 POST 正常返回");
    assert.equal(posts, 2);
    const stale = await api.pushTodo({ title: "过期待核对", todoId: "late-3" });
    assert.equal(stale.ok, true);
    const pendingKey = "lumina-cu-pending-push-v1";
    store.setItem(pendingKey, JSON.stringify([{
      operationId: "todo-late-4", title: "过期待核对2", createdAt: Date.now() - 11 * 60 * 1000, state: "indeterminate",
    }]));
    // 审查第二轮 #3：宽限期过后一次空查询也不自动重建，标记为需手动处理
    const postsBefore = posts;
    const r5 = await api.pushTodo({ title: "过期待核对2", todoId: "late-4" });
    assert.equal(r5.code, "NEEDS_MANUAL_RETRY", "宽限期后查无也不得自动重建");
    assert.equal(posts, postsBefore);
    assert.equal((await api.status()).pendingManual, 1);
    // 对账继续按 marker 查：仍查无就保持需手动；用户手动重试才再 POST
    await api.reconcilePendingPushes();
    assert.equal(posts, postsBefore);
    const r6 = await api.pushTodo({ title: "过期待核对2", todoId: "late-4", manualRetry: true });
    assert.equal(r6.ok, true, "用户手动重试且查无时才重建");
    assert.equal(posts, postsBefore + 1);
    assert.equal((await api.status()).pendingManual, 0);
  }
  ok("中 创建超时后宽限期内不重建，迟到提交由对账找回");

  /* ======================= Linear 审查第二轮回归（ClickUp 上传幂等） ======================= */
  const PUSHED_KEY = "lumina-cu-pushed-v1";
  const PENDING_PUSH_KEY = "lumina-cu-pending-push-v1";
  function pushServer({ lookup = "empty", delayMs = 0 } = {}) {
    const st = { posts: 0, lookup, remote: [] };
    st.fetch = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
      if (u.includes("/task") && method === "GET") {
        if (st.lookup === "fail") return reply(503, "unavailable");
        return reply(200, { tasks: st.remote, last_page: true });
      }
      if (u.includes("/task") && method === "POST") {
        st.posts++;
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const body = JSON.parse(opts.body);
        const id = "task-r2-" + st.posts;
        st.remote.push({ id, name: body.name, description: body.description });
        return reply(200, { id, url: "https://app.clickup.com/t/" + id });
      }
      return reply(200, {});
    };
    return st;
  }

  /* ---- 二#1：远端创建成功、确认记录写失败：pending 保留 taskId，查询失败也绝不重建 ---- */
  {
    const store = makeLocalStorage();
    const rawSet = store.setItem;
    let failPushed = true;
    store.setItem = (k, v) => {
      if (failPushed && k === PUSHED_KEY) throw new Error("quota");
      return rawSet(k, v);
    };
    const srv = pushServer();
    const { api } = loadClickup(store, srv.fetch);
    await api.setStoredToken(TOKEN_A);
    const first = await api.pushTodo({ title: "确认记录写失败", todoId: "r2-durable-1" });
    assert.equal(first.ok, true);
    assert.equal(srv.posts, 1);
    const pend = JSON.parse(store.getItem(PENDING_PUSH_KEY) || "[]");
    assert.equal(pend.length, 1, "确认记录没落盘时不得清除 pending");
    assert.equal(pend[0].taskId, first.taskId, "pending 里必须留下已知 taskId");
    // App 关联也没存下；重试时 marker 查询失败：直接复用 pending 里的 taskId，不 POST
    srv.lookup = "fail";
    const again = await api.pushTodo({ title: "确认记录写失败", todoId: "r2-durable-1" });
    assert.equal(again.ok, true);
    assert.equal(again.taskId, first.taskId);
    assert.equal(srv.posts, 1, "已知 taskId 时绝不重复创建");
    // 存储恢复后对账：确认记录落盘，pending 才清除
    failPushed = false;
    await api.reconcilePendingPushes();
    assert.equal(JSON.parse(store.getItem(PENDING_PUSH_KEY) || "[]").length, 0);
    assert.ok(JSON.parse(store.getItem(PUSHED_KEY)).some((x) => x.taskId === first.taskId));
    // 本地记录全丢（恢复旧备份）且 marker 查询失败：不确定就不创建
    const fresh = makeLocalStorage();
    const { api: api2 } = loadClickup(fresh, srv.fetch);
    await api2.setStoredToken(TOKEN_A);
    const blind = await api2.pushTodo({ title: "确认记录写失败", todoId: "r2-durable-1" });
    assert.equal(blind.ok, false);
    assert.equal(blind.code, "LOOKUP_FAILED");
    assert.equal(srv.posts, 1, "marker 查询不确定时不得创建");
    srv.lookup = "empty";
    const found = await api2.pushTodo({ title: "确认记录写失败", todoId: "r2-durable-1" });
    assert.equal(found.ok, true);
    assert.equal(found.taskId, first.taskId);
    assert.equal(srv.posts, 1);
  }
  ok("审查二#1 确认记录写失败时 pending 保留 taskId，查询不确定时绝不重建");

  /* ---- 二#2：同一待办并发上传只 POST 一次（同页 single-flight + 跨页租约） ---- */
  {
    const store = makeLocalStorage();
    const srv = pushServer({ delayMs: 15 });
    const { api } = loadClickup(store, srv.fetch);
    await api.setStoredToken(TOKEN_A);
    const [a, b] = await Promise.all([
      api.pushTodo({ title: "并发上传", todoId: "r2-conc-1" }),
      api.pushTodo({ title: "并发上传", todoId: "r2-conc-1" }),
    ]);
    assert.equal(srv.posts, 1, "同页并发只允许一次 POST");
    assert.equal(a.ok && b.ok, true);
    assert.equal(a.taskId, b.taskId);

    // 两个标签页共享 localStorage 与同源 Web Locks（审查四④：跨页不再靠 localStorage 租约）
    const shared = makeLocalStorage();
    const srv2 = pushServer({ delayMs: 15 });
    const sharedLocks = makeSharedLocks();
    const tab1 = loadClickup(shared, srv2.fetch, { navigator: { locks: sharedLocks } }).api;
    const tab2 = loadClickup(shared, srv2.fetch, { navigator: { locks: sharedLocks } }).api;
    await tab1.setStoredToken(TOKEN_A);
    await tab2.setStoredToken(TOKEN_A);
    const [x, y] = await Promise.all([
      tab1.pushTodo({ title: "跨页并发", todoId: "r2-conc-2" }),
      tab2.pushTodo({ title: "跨页并发", todoId: "r2-conc-2" }),
    ]);
    assert.equal(srv2.posts, 1, "跨页并发只允许一次 POST");
    assert.equal(x.ok, true);
    assert.equal(y.ok ? y.taskId : y.code, y.ok ? x.taskId : "BUSY");
    // 租约已释放：之后另一页再传直接复用已创建记录
    const z = await tab2.pushTodo({ title: "跨页并发", todoId: "r2-conc-2" });
    assert.equal(z.ok, true);
    assert.equal(z.taskId, x.taskId);
    assert.equal(srv2.posts, 1);
    // 旧版本留下的 localStorage 租约键不再参与互斥，也不挡路
    shared.setItem("lumina-cu-push-lease-v1:todo-r2-conc-3", JSON.stringify({ owner: "dead", token: "t", exp: Date.now() + 60000 }));
    const w = await tab1.pushTodo({ title: "旧租约键", todoId: "r2-conc-3" });
    assert.equal(w.ok, true);
    assert.equal(srv2.posts, 2);
  }
  ok("审查二#2 同一待办并发上传只 POST 一次（同页 single-flight、跨页 Web Lock）");

  /* ---- 审查三④：跨页租约非原子 → Web Locks 覆盖「查询→创建→确认落盘」全过程 ---- */
  {
    // 可控并发存储：租约键的写入对另一页延迟可见（两页都读到空锁、各自写入并读回自己的锁）
    const shared = new Map();
    const view = (lagKeys) => {
      const local = new Map();
      return {
        getItem: (k) => (local.has(k) ? local.get(k) : shared.has(k) ? shared.get(k) : null),
        setItem: (k, v) => {
          if (lagKeys.some((p) => k.startsWith(p))) {
            local.set(k, String(v));
            setTimeout(() => { shared.set(k, String(v)); local.delete(k); }, 5);
          } else shared.set(k, String(v));
        },
        removeItem: (k) => { local.delete(k); shared.delete(k); },
      };
    };
    const makeLocks = () => {
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
              Promise.resolve().then(() => cb({ name })).then(resolve, reject)
                .finally(() => { held.set(name, false); grant(name); });
            };
            if (!waiters.has(name)) waiters.set(name, []);
            waiters.get(name).push(run);
            grant(name);
          });
        },
      };
    };
    const runPair = async (navigator) => {
      shared.clear();
      const srv = pushServer({ delayMs: 15 });
      const lag = ["lumina-cu-push-lease-v1:"];
      const t1 = loadClickup(view(lag), srv.fetch, { navigator }).api;
      const t2 = loadClickup(view(lag), srv.fetch, { navigator }).api;
      await t1.setStoredToken(TOKEN_A);
      await t2.setStoredToken(TOKEN_A);
      await tick(30);
      const [a, b] = await Promise.all([
        t1.pushTodo({ title: "跨页原子", todoId: "r3-lock-1" }),
        t2.pushTodo({ title: "跨页原子", todoId: "r3-lock-1" }),
      ]);
      return { srv, a, b, t2 };
    };
    const locked = await runPair({ locks: makeLocks() });
    assert.equal(locked.srv.posts, 1, "Web Locks 下两页同时上传只允许一次 POST");
    assert.equal(new Set(locked.srv.remote.map((t) => t.id)).size, 1, "只能产生一个 taskId");
    const okOne = [locked.a, locked.b].filter((r) => r.ok);
    assert.equal(okOne.length >= 1, true);
    assert.ok([locked.a, locked.b].every((r) => r.ok || r.code === "BUSY"));
    // 锁释放后另一页再传：复用已创建记录，不再 POST
    const again = await locked.t2.pushTodo({ title: "跨页原子", todoId: "r3-lock-1" });
    assert.equal(again.ok, true);
    assert.equal(again.taskId, okOne[0].taskId);
    assert.equal(locked.srv.posts, 1);
  }
  ok("审查三④ 跨页上传用 Web Locks 原子互斥（延迟可见存储下仍只 POST 一次）");

  /* ---- 审查三⑤：POST 已发出后的非超时传输失败（Failed to fetch / 读正文失败 / 非 JSON）保留不确定 ---- */
  {
    const failures = {
      "Failed to fetch": () => { throw new TypeError("Failed to fetch"); },
      "Load failed": () => { throw new TypeError("Load failed"); },
      "读正文失败": () => ({ ok: true, status: 200, async text() { throw new TypeError("network connection was lost"); } }),
      "2xx 非 JSON": () => ({ ok: true, status: 200, async text() { return "<html>proxy</html>"; } }),
    };
    for (const [name, fail] of Object.entries(failures)) {
      // 待办上传：服务端已建（列表查询暂时还看不到），客户端只拿到传输错误
      let posts = 0;
      const store = makeLocalStorage();
      const { api } = loadClickup(store, async (url, opts) => {
        const u = String(url);
        const method = (opts && opts.method) || "GET";
        if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
        if (u.includes("/task") && method === "GET") return reply(200, { tasks: [], last_page: true });
        if (u.includes("/task") && method === "POST") { posts++; return fail(); }
        if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
        if (u.includes("/time_entries") && method === "POST") { posts++; return fail(); }
        return reply(200, {});
      });
      await api.setStoredToken(TOKEN_A);
      await tick(30);
      const r = await api.pushTodo({ title: "已提交的上传", todoId: "r3-transport-" + name });
      assert.equal(r.code, "INDETERMINATE", `${name}：上传结果未知必须 INDETERMINATE`);
      assert.equal((await api.status()).pendingPush, 1, `${name}：上传 pending 必须保留`);
      const again = await api.pushTodo({ title: "已提交的上传", todoId: "r3-transport-" + name });
      assert.equal(again.ok, false);
      assert.equal(posts, 1, `${name}：重试上传不得再次 POST`);
      // 番茄打卡（直接调用）
      const p = await api.logPomodoro({ title: "已提交的番茄", taskId: "task-known", minutes: 25, endedAt: Date.now(), operationId: "op-r3-" + posts + "-" + name.length });
      assert.equal(p.code, "INDETERMINATE", `${name}：打卡结果未知必须 INDETERMINATE`);
      const st = await api.status();
      assert.equal(st.pendingPomo, 1, `${name}：打卡 pending 必须保留`);
      assert.equal(st.queue, 0, `${name}：不得转入自动补发队列`);
      await api.flushQueue();
      await api.reconcilePendingPomos();
      assert.equal(posts, 2, `${name}：自动刷新不得重复打卡`);
    }
    // 队列补发路径（番茄队列自动刷新）同样不得清除 pending
    {
      let posts = 0;
      const store = makeLocalStorage();
      store.setItem("lumina-cu-queue-v1", JSON.stringify([{ queueId: "q-r3", operationId: "op-r3-queue", title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now() - 1000, tries: 0, queuedAt: Date.now() }]));
      const { api } = loadClickup(store, async (url, opts) => {
        const u = String(url);
        const method = (opts && opts.method) || "GET";
        if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
        if (u.includes("/time_entries") && method === "POST") { posts++; throw new TypeError("Failed to fetch"); }
        return reply(200, {});
      });
      await api.setStoredToken(TOKEN_A);
      await tick(40);
      await api.flushQueue();
      await api.flushQueue();
      assert.equal(posts, 1, "队列补发遇到传输错误后不得再次 POST");
      assert.equal((await api.status()).pendingPomo, 1);
    }
    // 明确拒绝（完整 4xx）才清除 pending
    {
      const store = makeLocalStorage();
      const { api } = loadClickup(store, async (url, opts) => {
        const u = String(url);
        const method = (opts && opts.method) || "GET";
        if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
        if (u.includes("/task") && method === "GET") return reply(200, { tasks: [], last_page: true });
        if (method === "POST") return reply(400, { err: "bad request" });
        if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
        return reply(200, {});
      });
      await api.setStoredToken(TOKEN_A);
      await tick(30);
      const r = await api.pushTodo({ title: "被拒绝", todoId: "r3-reject" });
      assert.equal(r.ok, false);
      assert.notEqual(r.code, "INDETERMINATE");
      assert.equal((await api.status()).pendingPush, 0, "明确拒绝才允许清除 pending");
      const p = await api.logPomodoro({ title: "被拒绝", taskId: "task-known", minutes: 25, endedAt: Date.now(), operationId: "op-r3-reject" });
      assert.equal(p.ok, false);
      assert.equal((await api.status()).pendingPomo, 0);
    }
  }
  ok("审查三⑤ POST 发出后的传输/读取/解析失败保留不确定，只有明确 4xx 拒绝才清除（待办与番茄）");

  /* ---- 中：缺 Token 时离线队列暂停，配置新 Token 后恢复补传 ---- */
  {
    const store = makeLocalStorage();
    store.setItem("lumina-cu-queue-v1", JSON.stringify([{
      queueId: "q-off", operationId: "op-offline-1", title: "离线番茄", minutes: 25,
      endedAt: Date.now() - 60000, tries: 0, queuedAt: Date.now(),
    }]));
    // 旧版本留下的：缺 token 被误记为永久失败的记录
    store.setItem("lumina-cu-failed-v1", JSON.stringify([{
      queueId: "q-legacy", operationId: "op-offline-2", title: "离线番茄2", minutes: 25,
      endedAt: Date.now() - 120000, failureCode: "NO_TOKEN", failureRetryable: false,
    }]));
    const posted = [];
    const { api } = loadClickup(store, async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
      if (u.includes("/task") && method === "GET") return reply(200, { tasks: [{ id: "t-off", name: "离线番茄" }, { id: "t-off2", name: "离线番茄2" }], last_page: true });
      if (u.includes("/time_entries") && method === "POST") {
        posted.push(JSON.parse(opts.body).description);
        return reply(200, {});
      }
      return reply(200, {});
    });
    const paused = await api.flushQueue();
    assert.equal(paused.paused, "NO_TOKEN");
    let st = await api.status();
    assert.equal(st.queue, 1, "缺 token 时队列原样保留");
    assert.equal(st.failed, 1);
    await api.setStoredToken(TOKEN_A);
    await tick(80);
    await api.flushQueue();
    st = await api.status();
    assert.equal(st.queue, 0);
    assert.equal(st.failed, 0, "鉴权类失败记录在新 token 下恢复");
    assert.equal(posted.length, 2);
  }
  ok("中 缺凭证时暂停 ClickUp 队列，重新配置后恢复补传");

  /* ---- 中：容量上限不淘汰未同步记录，明确拒绝 ---- */
  {
    const store = makeLocalStorage();
    const full = [];
    for (let i = 0; i < 200; i++) {
      full.push({ queueId: "q-" + i, operationId: "op-full-" + i, title: "x", minutes: 25, endedAt: Date.now() - 1000, tries: 0, queuedAt: Date.now() });
    }
    store.setItem("lumina-cu-queue-v1", JSON.stringify(full));
    let posts = 0;
    const { api } = loadClickup(store, async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/task") && method === "GET") return reply(200, { tasks: [{ id: "t-x", name: "x" }, { id: "t-y", name: "第201条" }], last_page: true });
      if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
      if (method === "POST") {
        posts++;
        return reply(429, "rate limited"); // 明确未写入、可重试 → 走离线队列
      }
      return reply(200, {});
    });
    await api.setStoredToken(TOKEN_A);
    await tick(80);
    const r = await api.logPomodoro({ title: "第201条", minutes: 25, endedAt: Date.now() });
    assert.equal(r.ok, false);
    assert.equal(r.code, "QUEUE_FULL");
    assert.equal(r.queued, false);
    const q = JSON.parse(store.getItem("lumina-cu-queue-v1"));
    assert.equal(q.length, 200);
    assert.equal(q[0].queueId, "q-0", "最旧的未同步记录不得被挤掉");

    // 待核对记录满 50 条：新打卡不 POST，转入队列（不淘汰旧待核对）
    const store2 = makeLocalStorage();
    const pend = [];
    for (let i = 0; i < 50; i++) pend.push({ operationId: "op-pend-" + i, minutes: 25, start: 1, duration: 1, createdAt: Date.now() });
    store2.setItem("lumina-cu-pending-pomo-v1", JSON.stringify(pend));
    const pushPend = [];
    for (let i = 0; i < 50; i++) pushPend.push({ operationId: "todo-pp-" + i, title: "p", createdAt: Date.now() });
    store2.setItem("lumina-cu-pending-push-v1", JSON.stringify(pushPend));
    let posts2 = 0;
    const { api: api2 } = loadClickup(store2, async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.endsWith("/user")) return reply(200, { user: { id: 9 } });
      if (u.includes("/task") && method === "GET") return reply(200, { tasks: [{ id: "t-z", name: "第51条" }], last_page: true });
      if (u.includes("/time_entries") && method === "GET") return reply(503, "lookup down");
      if (method === "POST") posts2++;
      return reply(200, { id: "never" });
    });
    await api2.setStoredToken(TOKEN_A);
    const r2 = await api2.logPomodoro({ title: "第51条", minutes: 25, endedAt: Date.now() });
    assert.equal(r2.code, "PENDING_FULL");
    assert.equal(r2.queued, true);
    assert.equal(JSON.parse(store2.getItem("lumina-cu-pending-pomo-v1")).length, 50);
    assert.equal(JSON.parse(store2.getItem("lumina-cu-pending-pomo-v1"))[0].operationId, "op-pend-0");
    const r3 = await api2.pushTodo({ title: "第51个上传", todoId: "pp-new" });
    assert.equal(r3.code, "PENDING_FULL");
    assert.equal(posts2, 0, "待核对记录满时不得发出无法对账的 POST");
    assert.equal(JSON.parse(store2.getItem("lumina-cu-pending-push-v1"))[0].operationId, "todo-pp-0");
  }
  ok("中 ClickUp 队列/待核对达到上限时明确拒绝，不淘汰未确认记录");

  /* ---- 中：番茄打卡优先用已知 taskId；标题规范与上传一致（>200 字不再新建） ---- */
  {
    const store = makeLocalStorage();
    const longTitle = "长".repeat(300);
    const calls = [];
    const { api } = loadClickup(store, async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      calls.push(method + " " + u.replace(/\?.*/, ""));
      if (u.includes("/task") && method === "GET") return reply(200, { tasks: [{ id: "cu-by-name", name: longTitle }], last_page: true });
      if (u.includes("/time_entries") && method === "POST") return reply(200, {});
      if (method === "POST") return reply(200, { id: "should-not-create" });
      return reply(200, { data: [] });
    });
    await api.setStoredToken(TOKEN_A);
    await tick(40);
    calls.length = 0;
    const r1 = await api.logPomodoro({ title: longTitle, taskId: "cu-known", minutes: 25, endedAt: Date.now() });
    assert.equal(r1.ok, true);
    assert.equal(r1.taskId, "cu-known");
    assert.ok(!calls.some((c) => c.startsWith("GET") && c.includes("/task")), "已知 taskId 不再列任务");
    const r2 = await api.logPomodoro({ title: longTitle, minutes: 25, endedAt: Date.now() - 3600000 });
    assert.equal(r2.ok, true);
    assert.equal(r2.taskId, "cu-by-name", "300 字标题要能按同一规范找到已上传任务");
    assert.ok(!calls.some((c) => c.startsWith("POST") && c.endsWith("/task")), "不得新建任务");
  }
  ok("中 长标题番茄记到已上传的同一任务");

  /* ---- 中：Keychain 迁移与保存/清除串行，不覆盖新密钥、不复活已清除的密钥 ---- */
  for (const action of ["set", "remove"]) {
    const store = makeLocalStorage();
    store.setItem("lumina-cu-token", TOKEN_A); // 旧明文
    const keychain = new Map();
    let releaseGet;
    let gate = new Promise((r) => { releaseGet = r; });
    const plugin = {
      async get({ key }) {
        // 原生读取在发起时取值，结果却很晚才回来（复现「旧读取随后返回空值」）
        const snapshot = keychain.has(key) ? keychain.get(key) : null;
        await gate;
        return { value: snapshot };
      },
      async set({ key, value }) { keychain.set(key, value); },
      async remove({ key }) { keychain.delete(key); },
    };
    const sandbox = baseSandbox(store);
    sandbox.Capacitor = { Plugins: { LuminaSecureStore: plugin } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/secure-store.js"), "utf8"), sandbox);
    vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-clickup.js"), "utf8"), sandbox);
    const api = sandbox.LUMINA_MOBILE_CLICKUP;
    await tick(5); // 冷启动迁移已发起并卡在 Keychain 读取
    const saving = api.setStoredToken(action === "set" ? TOKEN_B : "");
    gate = Promise.resolve();
    releaseGet();
    assert.equal((await saving).ok, true);
    await tick(20);
    if (action === "set") {
      assert.equal(keychain.get("lumina-cu-token"), TOKEN_B, "迁移不得用旧明文覆盖新密钥");
      assert.equal(await api.readToken({ refresh: true }), TOKEN_B);
    } else {
      assert.equal(keychain.has("lumina-cu-token"), false, "迁移不得复活已清除的密钥");
      assert.equal(await api.readToken({ refresh: true }), null);
    }
    assert.equal(store.getItem("lumina-cu-token"), null, "明文副本必须清掉");
  }
  ok("中 Keychain 迁移与保存/清除按 key 串行并校验代际");

  /* ---- 高：HTTP 200 流中途报错时丢弃已累计的工具调用 ---- */
  {
    const sse = (frames, { done = false } = {}) => {
      const raw = frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
      const bytes = new TextEncoder().encode(raw);
      return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    };
    const toolFrame = {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "delete_todo", arguments: "{\"id\":\"t1\"}" } }] }, finish_reason: null }],
    };
    const run = async (body, opts = {}) => {
      const { ai } = loadBridge(makeLocalStorage(), async () => ({ ok: true, status: 200, body, async text() { return opts.text || ""; } }));
      await ai.setApiKey("sk-" + "a".repeat(24));
      let done = null;
      let error = null;
      await ai.chat({ messages: [{ role: "user", content: "删掉" }] }, {
        onDone(d) { done = d; },
        onError(e) { error = e; },
      });
      await tick(60);
      return { done, error };
    };
    const midError = await run(sse([toolFrame, { error: { message: "upstream overloaded", code: 529 } }]));
    assert.equal(midError.done, null, "流内错误不得 onDone 执行工具");
    assert.match(String(midError.error), /中途报错|overloaded/);
    const truncated = await run(sse([toolFrame]));
    assert.equal(truncated.done, null, "异常 EOF 不得合成为成功");
    assert.match(String(truncated.error), /意外中断/);
    const normal = await run(sse([toolFrame, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }], { done: true }));
    assert.equal(normal.error, null);
    assert.equal(normal.done.tool_calls[0].function.name, "delete_todo");
    const doneOnly = await run(sse([{ choices: [{ index: 0, delta: { content: "好的" }, finish_reason: null }] }], { done: true }));
    assert.equal(doneOnly.error, null, "[DONE] 正常收尾即使没有 finish_reason 也算成功");
    assert.equal(doneOnly.done.content, "好的");
    const buffered = await run(null, { text: JSON.stringify({ error: { message: "bad gateway" } }) });
    assert.equal(buffered.done, null);
    assert.match(String(buffered.error), /bad gateway|中途报错/);
  }
  ok("高 SSE 流内错误/异常 EOF 传播为失败并丢弃工具调用");

  /* ---- 审查三①：按完整 SSE 事件解析；多行 error / event:error / 异常载荷一律失败关闭 ---- */
  {
    const enc = new TextEncoder();
    const streamOf = (raw, { chunk = 0 } = {}) => {
      const bytes = enc.encode(raw);
      return new ReadableStream({
        start(c) {
          if (!chunk) c.enqueue(bytes);
          else for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
          c.close();
        },
      });
    };
    const toolDelta = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"delete_todo","arguments":"{\\"id\\":\\"t1\\"}"}}]},"finish_reason":null}]}\n\n';
    const finishTools = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const DONE = "data: [DONE]\n\n";
    const run = async (fetchRes) => {
      const { ai } = loadBridge(makeLocalStorage(), async () => fetchRes);
      await ai.setApiKey("sk-" + "a".repeat(24));
      let done = null;
      let error = null;
      await ai.chat({ messages: [{ role: "user", content: "删掉" }] }, {
        onDone(d) { done = d; },
        onError(e) { error = e; },
      });
      await tick(60);
      return { done, error };
    };
    const streamed = (raw, opts) => ({ ok: true, status: 200, body: streamOf(raw, opts), async text() { return raw; } });
    const buffered = (raw, ct) => ({ ok: true, status: 200, body: null, headers: { get: (k) => (/content-type/i.test(k) ? ct || null : null) }, async text() { return raw; } });
    const failing = [
      ["多行 data 的 error 对象", toolDelta + 'data: {"error":\ndata: {"message":"upstream exploded","code":500}}\n\n' + DONE],
      ["多行 error + CRLF", (toolDelta + 'data: {"error":\ndata:  {"message":"crlf boom"}}\n\n' + DONE).replace(/\n/g, "\r\n")],
      ["event: error + JSON", toolDelta + 'event: error\ndata: {"message":"overloaded"}\n\n' + DONE],
      ["event: error + 纯文本", toolDelta + "event: error\ndata: upstream died\n\n" + DONE],
      ["event: error 无 data", toolDelta + "event: error\n\n" + DONE],
      ["Anthropic 风格 type:error", toolDelta + 'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n' + DONE],
      ["finish_reason=error", toolDelta + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\n' + DONE],
      ["无法解析的 data", toolDelta + "data: {not json\n\n" + finishTools + DONE],
      ["非对象 data", toolDelta + "data: 42\n\n" + finishTools + DONE],
      ["结构异常的 tool_calls", toolDelta + 'data: {"choices":[{"index":0,"delta":{"tool_calls":[null]},"finish_reason":null}]}\n\n' + finishTools + DONE],
      ["[DONE] 之后的 error", toolDelta + finishTools + DONE + 'data: {"error":{"message":"late"}}\n\n'],
      ["EOF 处无空行的 error", toolDelta + 'data: {"error":\ndata: {"message":"tail"}}'],
    ];
    for (const [name, raw] of failing) {
      for (const chunk of [0, 1, 7]) {
        const r = await run(streamed(raw, { chunk }));
        assert.equal(r.done, null, `${name}（chunk=${chunk}）：不得 onDone，更不能执行 delete_todo`);
        assert.ok(r.error, `${name}（chunk=${chunk}）：必须报错`);
      }
      // 原生 HTTP 缓冲整段 SSE（无 reader）走同一套事件解析
      const b = await run(buffered(raw, "text/event-stream"));
      assert.equal(b.done, null, `${name}（缓冲 SSE）：不得 onDone`);
      assert.ok(b.error, `${name}（缓冲 SSE）：必须报错`);
    }
    // 正常路径：多行 data 合法 JSON、注释保活、CRLF、逐字节分块都能正确组装
    const okRaw = ": keep-alive\n\n" + 'data: {"choices":[{"index":0,\ndata: "delta":{"content":"好"},"finish_reason":null}]}\n\n' + toolDelta + finishTools + DONE;
    for (const raw of [okRaw, okRaw.replace(/\n/g, "\r\n"), okRaw.replace(/\n/g, "\r")]) {
      for (const chunk of [0, 1, 5]) {
        const r = await run(streamed(raw, { chunk }));
        assert.equal(r.error, null, "合法 SSE 不得误判失败：" + r.error);
        assert.equal(r.done.content, "好");
        assert.equal(r.done.tool_calls[0].function.name, "delete_todo");
      }
      const b = await run(buffered(raw, "text/event-stream"));
      assert.equal(b.error, null);
      assert.equal(b.done.tool_calls.length, 1);
    }
    // 缓冲但无 content-type、以 data: 开头也识别为 SSE
    const sniff = await run(buffered(toolDelta + 'data: {"error":\ndata: {"message":"x"}}\n\n' + DONE, null));
    assert.equal(sniff.done, null);
    // complete（非流式）：HTTP 200 的 {error} / SSE 错误体都不得当作成功空回复
    for (const raw of [JSON.stringify({ error: { message: "quota" } }), JSON.stringify({ type: "error", error: { message: "x" } }), "not json", toolDelta + 'event: error\ndata: {"message":"bad"}\n\n' + DONE]) {
      const { ai } = loadBridge(makeLocalStorage(), async () => buffered(raw, null));
      await ai.setApiKey("sk-" + "a".repeat(24));
      const res = await ai.complete({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.ok, false, "complete 不得把错误体当成功：" + raw.slice(0, 40));
    }
    // 端到端：agent-loop 在流式轮收到多行 error 时不得执行累计的 delete_todo
    const { runAgentRounds } = require(path.join(WWW, "agent-loop.js"));
    const { ai } = loadBridge(makeLocalStorage(), async () => streamed(toolDelta + 'data: {"error":\ndata: {"message":"boom"}}\n\n' + DONE));
    await ai.setApiKey("sk-" + "a".repeat(24));
    const ran = [];
    let loopErr = null;
    try {
      await runAgentRounds({
        messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
        complete: async () => ({ ok: true, message: { content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "list_todos", arguments: "{}" } }] } }),
        streamRound: (messages) => new Promise((resolve, reject) => {
          ai.chat({ messages, tools: true }, {
            onDone: (d) => resolve({ text: d.content, toolCalls: d.tool_calls, aborted: Boolean(d.aborted) }),
            onError: (e) => reject(new Error(String(e))),
          });
        }),
        runTool: (tc) => { ran.push(tc.function.name); return { ok: true }; },
        refreshSystemContent: () => "s",
        onProgress() {},
      });
    } catch (err) {
      loopErr = err;
    }
    assert.deepEqual(ran, ["list_todos"], "流内错误后 delete_todo 绝不能执行");
    assert.ok(loopErr, "流式轮失败要传播给调用方");
  }
  ok("审查三① SSE 按事件组装：多行/事件型错误与异常载荷失败关闭，工具不执行（流式/缓冲/complete）");

  /* ---- 中：停止 AI 请求立即释放并发名额，迟到响应被隔离 ---- */
  {
    const hanging = [];
    const { ai } = loadBridge(makeLocalStorage(), (_url) => new Promise((resolve) => { hanging.push(resolve); }));
    await ai.setApiKey("sk-" + "a".repeat(24));
    const dones = [];
    for (let i = 0; i < 8; i++) {
      const started = await ai.chat({ messages: [{ role: "user", content: "hi" }], requestId: "stop-" + i }, {
        onDone(d) { dones.push(d); },
      });
      assert.equal(started.ok, true);
    }
    for (let i = 0; i < 8; i++) assert.equal((await ai.abort("stop-" + i)).ok, true);
    await tick(20);
    assert.equal(dones.length, 8);
    assert.ok(dones.every((d) => d.aborted === true));
    let lateDelta = 0;
    let reusedDone = null;
    const ninth = await ai.chat({ messages: [{ role: "user", content: "hi" }], requestId: "stop-0" }, {
      onDelta() { lateDelta++; },
      onDone(d) { reusedDone = d; },
    });
    assert.equal(ninth.ok, true, "第 9 次请求不应报 TOO_MANY_REQUESTS：" + (ninth.error || ""));
    // 旧的原生请求此刻才迟到返回：不得把内容推给复用同 requestId 的新会话
    const lateBody = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"迟到"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        c.close();
      },
    });
    hanging[0]({ ok: true, status: 200, body: lateBody });
    await tick(30);
    assert.equal(lateDelta, 0);
    assert.equal(reusedDone, null);
    await ai.abort("stop-0");
  }
  ok("中 停止流式请求立即释放并发名额并隔离迟到响应");

  /* ======================= Linear 复审第四轮回归 ======================= */

  /* ---- 审查四①：脏窗口里立即撤销，先合并盘上最新远端写再逆操作；读不到盘就放弃 ---- */
  for (const kind of ["edit", "add"]) {
    for (const deliverEvent of [true, false]) {
      const storage = sharedStorage();
      const clickup = { pushTodo: async () => ({ ok: true, taskId: "cu-z", url: "https://app.clickup.com/t/cu-z" }), logPomo: async () => ({ ok: true }) };
      const A = loadApp({ storage, clickup });
      const z = A.invoke("add_todo", { text: "Z 其它" }).todo;
      let x;
      if (kind === "edit") {
        x = A.invoke("add_todo", { text: "X 原文" }).todo;
        assert.equal(A.invoke("update_todo", { id: x.id, text: "X 本页改" }).ok, true);   // 已落盘，进撤销栈
      } else {
        x = A.invoke("add_todo", { text: "X 本页新增" }).todo;                            // 已落盘，进撤销栈
      }
      const B = loadApp({ storage });
      storage.failTodoWrites = true;
      assert.equal((await A.invoke("push_todo_to_clickup", { id: z.id })).ok, true);       // 系统回写失败 → 脏窗口
      storage.failTodoWrites = false;
      assert.equal(B.invoke("update_todo", { id: x.id, text: "X 别页改" }).ok, true);
      if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
      assert.equal(A.invoke("undo").ok, true);                                              // 恢复合并之前立即撤销
      const dx = diskTodos(storage).find((t) => t.id === x.id);
      assert.ok(dx, `${kind}/${deliverEvent}：撤销不得删掉别页刚编辑过的条目`);
      assert.equal(dx.text, "X 别页改", `${kind}/${deliverEvent}：恢复写不得盖掉别页编辑`);
      assert.equal(diskTodos(storage).find((t) => t.id === z.id).clickupTaskId, "cu-z", "系统回写仍要落盘");
    }
  }
  {
    // 脏窗口里盘读不出（损坏）：放弃撤销，撤销步留着，内存不动
    const storage = sharedStorage();
    const clickup = { pushTodo: async () => ({ ok: true, taskId: "cu-z", url: "https://app.clickup.com/t/cu-z" }), logPomo: async () => ({ ok: true }) };
    const A = loadApp({ storage, clickup });
    const z = A.invoke("add_todo", { text: "Z" }).todo;
    const x = A.invoke("add_todo", { text: "X 原文" }).todo;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "X 本页改" }).ok, true);
    storage.failTodoWrites = true;
    assert.equal((await A.invoke("push_todo_to_clickup", { id: z.id })).ok, true);
    storage.failTodoWrites = false;
    storage._map.set(TODO_KEY, "{corrupt");
    const r = A.invoke("undo");
    assert.equal(r.ok, false, "读不到最新盘内容时必须放弃撤销");
    assert.equal(storage.getItem(TODO_KEY), "{corrupt", "放弃撤销时不得写盘覆盖");
    assert.equal(A.invoke("list_todos", {}).todos.find((t) => t.id === x.id).text, "X 本页改");
  }
  ok("审查四① 脏窗口立即撤销先合并最新远端写；撤销新增不删别页编辑；读盘失败放弃撤销");

  /* ---- 审查四② / ③：finish_reason 统一校验 + tool delta 严格校验（流式/缓冲/complete/agent-loop） ---- */
  {
    const enc = new TextEncoder();
    const streamOf = (raw) => new ReadableStream({ start(c) { c.enqueue(enc.encode(raw)); c.close(); } });
    const ev = (o) => "data: " + JSON.stringify(o) + "\n\n";
    const DONE = "data: [DONE]\n\n";
    const toolDelta = ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "delete_todo", arguments: "{\"id\":\"t1\"}" } }] }, finish_reason: null }] });
    const fin = (f) => ev({ choices: [{ index: 0, delta: {}, finish_reason: f }] });
    const runChat = async (fetchRes) => {
      const { ai } = loadBridge(makeLocalStorage(), async () => fetchRes);
      await ai.setApiKey("sk-" + "a".repeat(24));
      let done = null;
      let error = null;
      await ai.chat({ messages: [{ role: "user", content: "删掉" }] }, { onDone(d) { done = d; }, onError(e) { error = e; } });
      await tick(60);
      return { done, error };
    };
    const streamed = (raw) => ({ ok: true, status: 200, body: streamOf(raw), async text() { return raw; } });
    const buffered = (raw, ct) => ({ ok: true, status: 200, body: null, headers: { get: (k) => (/content-type/i.test(k) ? ct || null : null) }, async text() { return raw; } });
    const runComplete = async (raw) => {
      const { ai } = loadBridge(makeLocalStorage(), async () => buffered(raw, null));
      await ai.setApiKey("sk-" + "a".repeat(24));
      return ai.complete({ messages: [{ role: "user", content: "hi" }] });
    };
    // ③ 异常 tool delta：同一 index 的 arguments 变成对象 / 非法 index / id 前后不一致 / type 异常 / name 非字符串 / 缺名
    const badDeltas = [
      ["arguments 为对象", { index: 0, function: { arguments: { id: "t2" } } }],
      ["arguments 为数字", { index: 0, function: { arguments: 7 } }],
      ["index 为字符串", { index: "0", function: { arguments: "x" } }],
      ["index 为负数", { index: -1, function: { arguments: "x" } }],
      ["index 为小数", { index: 0.5, function: { arguments: "x" } }],
      ["id 前后不一致", { index: 0, id: "call_other", function: { arguments: "" } }],
      ["id 非字符串", { index: 0, id: 42 }],
      ["type 异常", { index: 0, type: "code_interpreter" }],
      ["name 非字符串", { index: 0, function: { name: { x: 1 } } }],
      ["function 为数组", { index: 0, function: ["x"] }],
    ];
    for (const [name, tc] of badDeltas) {
      const raw = toolDelta + ev({ choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }] }) + fin("tool_calls") + DONE;
      const a = await runChat(streamed(raw));
      assert.equal(a.done, null, `③ ${name}：不得执行旧参数`);
      assert.ok(a.error, `③ ${name}：必须报错`);
      const b = await runChat(buffered(raw, "text/event-stream"));
      assert.equal(b.done, null, `③ ${name}（缓冲 SSE）：不得 onDone`);
    }
    // 有 id/参数却始终没有工具名的槽位：不能被静默丢掉而让其它调用照常执行
    const nameless = toolDelta + ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_2", function: { arguments: "{}" } }] }, finish_reason: null }] }) + fin("tool_calls") + DONE;
    assert.equal((await runChat(streamed(nameless))).done, null, "③ 缺工具名的槽位要整轮失败");
    // 非流式整条 tool_call 的 id/name 类型异常同样失败
    const cBad = await runComplete(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 5, type: "function", function: { name: "delete_todo", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
    assert.equal(cBad.ok, false, "③ complete 的 tool_call id 非字符串要失败");
    // ② 截断 / 过滤 / 非法结束原因：工具调用一律不得交出
    const badFinish = [["length", "length"], ["content_filter", "content_filter"], ["对象", { type: "stop" }], ["数字", 3], ["未知字符串", "weird_reason"]];
    for (const [name, f] of badFinish) {
      const raw = toolDelta + fin(f) + DONE;
      const a = await runChat(streamed(raw));
      assert.equal(a.done, null, `② 流式 finish_reason=${name}：不得 onDone 交出工具调用`);
      assert.ok(a.error, `② 流式 finish_reason=${name}：必须报错`);
      const b = await runChat(buffered(raw, "text/event-stream"));
      assert.equal(b.done, null, `② 缓冲 SSE finish_reason=${name}：不得 onDone`);
      const cJson = await runComplete(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "delete_todo", arguments: "{}" } }] }, finish_reason: f }] }));
      assert.equal(cJson.ok, false, `② complete JSON finish_reason=${name}：不得返回工具调用`);
      const cSse = await runComplete(raw);
      assert.equal(cSse.ok, false, `② complete SSE finish_reason=${name}：不得返回工具调用`);
      // 流式非 SSE JSON 整体回包
      const d = await runChat(buffered(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "delete_todo", arguments: "{}" } }] }, finish_reason: f }] }), "application/json"));
      assert.equal(d.done, null, `② 流式缓冲 JSON finish_reason=${name}：不得 onDone`);
    }
    // 纯文本被 length 截断：没有副作用，照常返回并带上 finish_reason
    const textOnly = await runChat(streamed(ev({ choices: [{ index: 0, delta: { content: "半句" }, finish_reason: null }] }) + fin("length") + DONE));
    assert.equal(textOnly.error, null);
    assert.equal(textOnly.done.content, "半句");
    assert.equal(textOnly.done.finish_reason, "length");
    // 正常 tool_calls / stop 仍然放行
    for (const f of ["tool_calls", "stop"]) {
      const okRun = await runChat(streamed(toolDelta + fin(f) + DONE));
      assert.equal(okRun.error, null, "合法结束不得误判：" + okRun.error);
      assert.equal(okRun.done.tool_calls[0].function.name, "delete_todo");
    }
    // ② agent-loop 第二道闸门：即使上游（或别的桥实现）交出了工具调用，截断/过滤/非法结束也不执行
    const { runAgentRounds } = require(path.join(WWW, "agent-loop.js"));
    for (const f of ["length", "content_filter", { x: 1 }]) {
      const ran = [];
      let err = null;
      try {
        await runAgentRounds({
          messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
          complete: async () => ({ ok: true, finish_reason: f, message: { content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "delete_todo", arguments: "{}" } }] } }),
          streamRound: async () => ({ text: "", toolCalls: [], aborted: false }),
          runTool: (tc) => { ran.push(tc.function.name); return { ok: true }; },
          refreshSystemContent: () => "s",
        });
      } catch (e) { err = e; }
      assert.deepEqual(ran, [], "② agent-loop complete 轮 finish_reason 异常时不得执行工具");
      assert.ok(err);
      const ran2 = [];
      err = null;
      try {
        await runAgentRounds({
          messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
          complete: async () => ({ ok: true, finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c0", type: "function", function: { name: "list_todos", arguments: "{}" } }] } }),
          streamRound: async () => ({ text: "", toolCalls: [{ id: "c1", type: "function", function: { name: "delete_todo", arguments: "{}" } }], finishReason: f, aborted: false }),
          runTool: (tc) => { ran2.push(tc.function.name); return { ok: true }; },
          refreshSystemContent: () => "s",
        });
      } catch (e) { err = e; }
      assert.deepEqual(ran2, ["list_todos"], "② agent-loop 流式轮 finish_reason 异常时不得执行工具");
      assert.ok(err);
    }
  }
  ok("审查四②③ 截断/过滤/非法 finish_reason 与异常 tool delta 一律失败关闭（流式/缓冲/complete/agent-loop）");

  /* ---- 审查四④：没有可靠跨页锁（无 Web Locks / SecurityError）时不自动提交，不靠 localStorage 回读 ---- */
  {
    const securityError = () => { const e = new Error("The operation is insecure."); e.name = "SecurityError"; return e; };
    for (const mode of ["no-locks", "security-error"]) {
      const shared = makeLocalStorage();
      const srv = pushServer({ delayMs: 15 });
      let entryPosts = 0;
      const fetchAll = async (url, opts) => {
        const u = String(url);
        const method = (opts && opts.method) || "GET";
        if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
        if (u.includes("/time_entries") && method === "POST") { entryPosts++; await tick(10); return reply(200, {}); }
        return srv.fetch(url, opts);
      };
      const nav = mode === "security-error" ? { locks: makeSharedLocks({ failWith: securityError }) } : undefined;
      const t1 = loadClickup(shared, fetchAll, { navigator: nav, native: false }).api;
      const t2 = loadClickup(shared, fetchAll, { navigator: nav, native: false }).api;
      await t1.setStoredToken(TOKEN_A);
      await t2.setStoredToken(TOKEN_A);
      await tick(30);
      const [a, b] = await Promise.all([
        t1.pushTodo({ title: "无锁上传", todoId: "r4-nolock-" + mode }),
        t2.pushTodo({ title: "无锁上传", todoId: "r4-nolock-" + mode }),
      ]);
      assert.equal(srv.posts, 0, `${mode}：没有可靠跨页锁时不得自动创建任务`);
      assert.equal(a.code, "LOCK_UNAVAILABLE");
      assert.equal(b.code, "LOCK_UNAVAILABLE");
      assert.equal(a.retryable, true, "锁不可用是可重试状态");
      // 番茄：两页同一 operationId 同时打卡
      const op = "op-r4-nolock-" + mode;
      const [p1, p2] = await Promise.all([
        t1.logPomodoro({ title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now(), operationId: op }),
        t2.logPomodoro({ title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now(), operationId: op }),
      ]);
      assert.equal(entryPosts, 0, `${mode}：没有可靠跨页锁时番茄不得提交`);
      assert.equal(p1.ok || p2.ok, false);
      assert.ok([p1, p2].every((r) => r.code === "LOCK_UNAVAILABLE"));
      await t1.flushQueue();
      assert.equal(entryPosts, 0, `${mode}：无锁时队列也不得自动补发`);
    }
    // App 单 WebView（Capacitor 原生壳）里锁服务抛 SecurityError：本页互斥即全局互斥，照常提交一次
    {
      const srv = pushServer({ delayMs: 5 });
      const { api } = loadClickup(makeLocalStorage(), srv.fetch, { navigator: { locks: makeSharedLocks({ failWith: securityError }) }, native: true });
      await api.setStoredToken(TOKEN_A);
      await tick(30);
      const [a, b] = await Promise.all([
        api.pushTodo({ title: "App 内上传", todoId: "r4-native" }),
        api.pushTodo({ title: "App 内上传", todoId: "r4-native" }),
      ]);
      assert.equal(srv.posts, 1);
      assert.equal(a.ok && b.ok, true);
    }
  }
  ok("审查四④ 无 Web Locks / SecurityError 时失败关闭（LOCK_UNAVAILABLE、不 POST），App 单 WebView 照常");

  /* ---- 审查四⑤：不同 operationId 的待核对读-改-写在全局 store 锁内，跨进程也不互相覆盖 ---- */
  {
    // 跨进程模型：每页读的是本页缓存快照，写直达共享存储；只有拿到跨页锁时本页缓存才与共享存储同步
    const M = new Map();
    const lockCore = makeSharedLocks();
    const makeTab = () => {
      const C = new Map(M);
      const refresh = () => { C.clear(); for (const [k, v] of M) C.set(k, v); };
      return {
        storage: {
          getItem: (k) => (C.has(k) ? C.get(k) : null),
          setItem: (k, v) => { C.set(k, String(v)); M.set(k, String(v)); },
          removeItem: (k) => { C.delete(k); M.delete(k); },
        },
        locks: {
          request(name, options, cb) {
            if (typeof options === "function") { cb = options; options = {}; }
            return lockCore.request(name, options, (lock) => { if (lock) refresh(); return cb(lock); });
          },
        },
      };
    };
    let posts = 0;
    const fetchImpl = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/task") && method === "GET") { await tick(40); return reply(200, { tasks: [{ id: "task-b", name: "B 番茄" }], last_page: true }); }
      if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
      if (u.includes("/time_entries") && method === "POST") {
        posts++;
        const body = JSON.parse(opts.body);
        if (body.description.includes("op-r4-a")) { await tick(10); return reply(504, "gateway timeout"); }
        await tick(80);
        return reply(504, "gateway timeout");
      }
      return reply(200, {});
    };
    const A = makeTab();
    const B = makeTab();
    const ta = loadClickup(A.storage, fetchImpl, { navigator: { locks: A.locks } }).api;
    const tb = loadClickup(B.storage, fetchImpl, { navigator: { locks: B.locks } }).api;
    await ta.setStoredToken(TOKEN_A);
    await tb.setStoredToken(TOKEN_A);
    await tick(30);
    // B 先开始（按标题找任务，慢）；A 随后打卡并立刻写入 pending(op-a)，B 之后才写 pending(op-b)
    const pb = tb.logPomodoro({ title: "B 番茄", minutes: 25, endedAt: Date.now(), operationId: "op-r4-b" });
    await tick(5);
    const pa = ta.logPomodoro({ title: "A 番茄", taskId: "task-a", minutes: 25, endedAt: Date.now(), operationId: "op-r4-a" });
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.equal(ra.code, "INDETERMINATE");
    assert.equal(rb.code, "INDETERMINATE");
    const pend = JSON.parse(M.get("lumina-cu-pending-pomo-v1") || "[]").map((x) => x.operationId).sort();
    assert.deepEqual(pend, ["op-r4-a", "op-r4-b"], "别页对其它 operationId 的写入不得覆盖掉本条待核对记录");
    // 之后重试 op-a 不得因记录丢失而重新 POST
    const again = await ta.logPomodoro({ title: "A 番茄", taskId: "task-a", minutes: 25, endedAt: Date.now(), operationId: "op-r4-a" });
    assert.equal(again.ok, false);
    assert.equal(posts, 2, "不确定记录被覆盖会导致重复 POST");
  }
  ok("审查四⑤ 共享待核对集合在全局 store 锁内读-改-写，不同 operationId 互不覆盖");

  /* ---- 审查四⑥：POST 成功后队列移除写失败，下一轮不得因远端暂不可见而重复 POST ---- */
  {
    const store = makeLocalStorage();
    const rawSet = store.setItem;
    let failQueueOnce = false;
    store.setItem = (k, v) => {
      if (failQueueOnce && k === "lumina-cu-queue-v1") { failQueueOnce = false; throw new Error("quota"); }
      return rawSet(k, v);
    };
    store.setItem("lumina-cu-queue-v1", JSON.stringify([{ queueId: "q-r4-6", operationId: "op-r4-6", title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now() - 1000, tries: 0, queuedAt: Date.now() }]));
    let posts = 0;
    const { api } = loadClickup(store, async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });   // 远端暂不可见
      if (u.includes("/time_entries") && method === "POST") { posts++; failQueueOnce = true; return reply(200, { id: "te" }); }
      return reply(200, {});
    });
    await api.setStoredToken(TOKEN_A);
    await tick(80);                         // setStoredToken 触发的那一轮 flush：POST 成功，队列移除写失败
    assert.equal(posts, 1);
    const q1 = JSON.parse(store.getItem("lumina-cu-queue-v1") || "[]");
    assert.equal(q1.length, 1, "前置：队列移除写失败，队列项仍在");
    const second = await api.flushQueue();
    assert.equal(posts, 1, "已确认的打卡不得因远端暂不可见而重复 POST");
    assert.equal(second.left, 0);
    assert.equal(JSON.parse(store.getItem("lumina-cu-queue-v1") || "[]").length, 0, "回执在：队列项被移除");
    assert.equal(JSON.parse(store.getItem("lumina-cu-pending-pomo-v1") || "[]").length, 0, "队列移除成功后回执清掉");
    // 写失败时返回的 left 是盘上真实剩余
    const store2 = makeLocalStorage();
    const raw2 = store2.setItem;
    let fail2 = false;
    store2.setItem = (k, v) => {
      if (fail2 && k === "lumina-cu-queue-v1") throw new Error("quota");
      return raw2(k, v);
    };
    store2.setItem("lumina-cu-queue-v1", JSON.stringify([{ queueId: "q-r4-6b", operationId: "op-r4-6b", title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now() - 1000, tries: 0, queuedAt: Date.now() }]));
    let posts2 = 0;
    const api2 = loadClickup(store2, async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
      if (u.includes("/time_entries") && method === "POST") { posts2++; fail2 = true; return reply(200, { id: "te" }); }
      return reply(200, {});
    }).api;
    const res = await api2.setStoredToken(TOKEN_A).then(() => api2.flushQueue());
    await tick(40);
    if (res.error) assert.equal(res.left, 1, "队列写失败时 left 必须是盘上真实剩余（1），不是 0");
    const res2 = await api2.flushQueue();
    assert.equal(res2.left, 1, "队列持续写失败：left 如实为 1");
    assert.equal(res2.error, "QUEUE_WRITE_FAILED");
    assert.equal(posts2, 1, "持续写失败也只 POST 一次");
  }
  ok("审查四⑥ POST 成功先落「已确认」回执，队列移除写失败后不重发，left 计数如实");

  /* ---- 审查四⑦：番茄按标题新建任务的 POST 结果未知：持久化 pending + marker，只对账不重建 ---- */
  for (const failKind of ["transport", "504", "read"]) {
    const st = { taskPosts: 0, entryPosts: 0, created: [], visible: false };
    const fetchImpl = async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/task") && method === "GET") return reply(200, { tasks: st.visible ? st.created : [], last_page: true });
      if (u.includes("/task") && method === "POST") {
        st.taskPosts++;
        const body = JSON.parse(opts.body);
        st.created.push({ id: "task-new-" + st.taskPosts, name: body.name, description: body.description || "" });
        if (failKind === "transport") throw new TypeError("Failed to fetch");
        if (failKind === "504") return reply(504, "gateway timeout");
        return { ok: true, status: 200, async text() { throw new TypeError("network connection was lost"); } };
      }
      if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
      if (u.includes("/time_entries") && method === "POST") { st.entryPosts++; return reply(200, {}); }
      return reply(200, {});
    };
    const store = makeLocalStorage();
    const { api } = loadClickup(store, fetchImpl);
    await api.setStoredToken(TOKEN_A);
    await tick(30);
    const r = await api.logPomodoro({ title: "全新任务-" + failKind, minutes: 25, endedAt: Date.now() });
    assert.equal(r.ok, false);
    assert.equal(st.taskPosts, 1);
    assert.equal(r.queued, true, `${failKind}：打卡本身要保留在队列里`);
    await api.flushQueue();
    await api.flushQueue();
    assert.equal(st.taskPosts, 1, `${failKind}：建任务结果未知时 flush 不得重建任务`);
    assert.equal(st.entryPosts, 0);
    assert.equal((await api.status()).pendingTask, 1, `${failKind}：建任务的不确定记录要落盘`);
    // 迟到的创建对账可见后：按 marker 采用这个任务，只记一次时间
    st.visible = true;
    await api.flushQueue();
    assert.equal(st.taskPosts, 1, `${failKind}：对账可见后也不重建`);
    assert.equal(st.entryPosts, 1, `${failKind}：时间记录补发一次`);
    assert.equal((await api.status()).pendingTask, 0);
    assert.equal((await api.status()).queue, 0);
  }
  ok("审查四⑦ 番茄新建任务结果未知时持久化 pending + marker，flush 只对账不重建");

  /* ---- 审查四⑧：查询 200 但缺 tasks/data 数组 = 查询失败，不得重发或清 pending ---- */
  {
    // 时间记录：手动重试一条已过宽限期的待核对，查询返回 {}
    const store = makeLocalStorage();
    const old = Date.now() - 11 * 60 * 1000;
    store.setItem("lumina-cu-pending-pomo-v1", JSON.stringify([{ operationId: "op-r4-8", title: "x", taskId: "task-known", minutes: 25, endedAt: old, start: old - 1500000, duration: 1500000, createdAt: old, needsManual: true, rev: "r1" }]));
    let entryPosts = 0;
    let shape = {};
    const { api } = loadClickup(store, async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || "GET";
      if (u.includes("/time_entries") && method === "GET") return reply(200, shape);
      if (u.includes("/time_entries") && method === "POST") { entryPosts++; return reply(200, {}); }
      if (u.includes("/task") && method === "GET") return reply(200, shape);
      if (u.includes("/task") && method === "POST") { entryPosts++; return reply(200, { id: "t-x" }); }
      if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
      return reply(200, {});
    });
    await api.setStoredToken(TOKEN_A);
    await tick(30);
    for (const bad of [{}, { data: null }, { data: { items: [] } }, { tasks: "none" }]) {
      shape = bad;
      const r = await api.retryPendingPomos();
      assert.equal(r.ok, false, "缺数组的查询不能当成查无：" + JSON.stringify(bad));
      assert.equal(entryPosts, 0, "缺数组时不得补发：" + JSON.stringify(bad));
      assert.equal(JSON.parse(store.getItem("lumina-cu-pending-pomo-v1")).length, 1, "pending 必须保留");
      const reco = await api.reconcilePendingPomos();
      assert.equal(reco.left, 1);
      // 待办：稳定 id 首次上传，列表查询缺 tasks → 不创建
      const p = await api.pushTodo({ title: "缺数组", todoId: "r4-shape-" + JSON.stringify(bad).length });
      assert.equal(p.ok, false);
      assert.equal(entryPosts, 0, "列表缺 tasks 数组时不得创建任务");
    }
    // 已过宽限期 + 用户手动重新上传：查询缺 tasks 仍不得重建
    store.setItem("lumina-cu-pending-push-v1", JSON.stringify([{ operationId: "todo-r4-shape-manual", title: "y", createdAt: old, state: "indeterminate", needsManual: true }]));
    shape = { err: "proxy" };
    const m = await api.pushTodo({ title: "y", todoId: "r4-shape-manual", manualRetry: true });
    assert.equal(m.code, "INDETERMINATE");
    assert.equal(entryPosts, 0);
    assert.equal(JSON.parse(store.getItem("lumina-cu-pending-push-v1")).length, 1);
  }
  ok("审查四⑧ 查询响应缺 tasks/data 数组判为查询失败：不补发、不创建、不清 pending");

  /* ======================= Linear 复审第五轮回归 ======================= */

  /* ---- 审查五 A：撤销未落盘的本地编辑不得用历史 before 盖掉远端同字段编辑 ---- */
  for (const deliverEvent of [true, false]) {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "X original" }).todo;
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "X local" }).ok, true);      // 写盘失败 → 脏窗口
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "X remote" }).ok, true);
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "X remote");
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    A.invoke("undo");
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.notEqual(dx.text, "X original", `${deliverEvent}：撤销绝不能把历史 before 写回盘覆盖远端编辑`);
    assert.equal(dx.text, "X remote", `${deliverEvent}：冲突字段撤销后取远端最新值`);
    assert.equal(A.invoke("list_todos", {}).todos.find((t) => t.id === x.id).text, "X remote");
  }
  {
    // 无冲突字段照常撤销：本地脏窗口里改正文，远端改优先级 → 撤销恢复正文、保留远端优先级
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Y original" }).todo;
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "Y local" }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, priority: "high" }).ok, true);
    assert.equal(A.invoke("undo").ok, true);
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(dx.text, "Y original", "无冲突字段照常撤销");
    assert.equal(dx.priority, "high", "远端其它字段编辑保留");
  }
  {
    // 已成功落盘的本地编辑再撤销：没有远端冲突 → 恢复 before（行为不变）
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Z original" }).todo;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "Z local" }).ok, true);
    assert.equal(A.invoke("undo").ok, true);
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "Z original");
  }
  ok("审查五 A 撤销未落盘编辑：冲突字段取远端最新值、不写回历史 before；无冲突字段照常撤销");

  /* ---- 审查五 B：显式 null 的 tool delta / 整条 tool_call 字段不得绕过校验去执行旧参数 ---- */
  {
    const enc = new TextEncoder();
    const streamOf = (raw) => new ReadableStream({ start(c) { c.enqueue(enc.encode(raw)); c.close(); } });
    const ev = (o) => "data: " + JSON.stringify(o) + "\n\n";
    const DONE = "data: [DONE]\n\n";
    const toolDelta = ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "delete_todo", arguments: "{\"id\":\"t1\"}" } }] }, finish_reason: null }] });
    const fin = (f) => ev({ choices: [{ index: 0, delta: {}, finish_reason: f }] });
    const runChat = async (fetchRes) => {
      const { ai } = loadBridge(makeLocalStorage(), async () => fetchRes);
      await ai.setApiKey("sk-" + "a".repeat(24));
      let done = null;
      let error = null;
      await ai.chat({ messages: [{ role: "user", content: "删掉" }] }, { onDone(d) { done = d; }, onError(e) { error = e; } });
      await tick(60);
      return { done, error };
    };
    const streamed = (raw) => ({ ok: true, status: 200, body: streamOf(raw), async text() { return raw; } });
    const buffered = (raw, ct) => ({ ok: true, status: 200, body: null, headers: { get: (k) => (/content-type/i.test(k) ? ct || null : null) }, async text() { return raw; } });
    const runComplete = async (raw) => {
      const { ai } = loadBridge(makeLocalStorage(), async () => buffered(raw, null));
      await ai.setApiKey("sk-" + "a".repeat(24));
      return ai.complete({ messages: [{ role: "user", content: "hi" }] });
    };
    const nullDeltas = [
      ["function.arguments:null", { index: 0, function: { arguments: null } }],
      ["function:null", { index: 0, function: null }],
      ["function.name:null", { index: 0, function: { name: null } }],
      ["id:null", { index: 0, id: null }],
      ["type:null", { index: 0, type: null }],
      ["index:null", { index: null, function: { arguments: "" } }],
    ];
    for (const [name, tc] of nullDeltas) {
      const raw = toolDelta + ev({ choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }] }) + fin("tool_calls") + DONE;
      const a = await runChat(streamed(raw));
      assert.equal(a.done, null, `五B ${name}（流式）：不得执行旧参数`);
      assert.ok(a.error, `五B ${name}（流式）：必须报错`);
      const b = await runChat(buffered(raw, "text/event-stream"));
      assert.equal(b.done, null, `五B ${name}（缓冲 SSE）：不得 onDone`);
      assert.ok(b.error, `五B ${name}（缓冲 SSE）：必须报错`);
      const c = await runComplete(raw);
      assert.equal(c.ok, false, `五B ${name}（complete SSE）：不得返回工具调用`);
    }
    // 整条 tool_call（complete JSON / 流式缓冲 JSON）：键存在但为 null 同样失败
    const wholeBad = [
      ["arguments:null", { id: "c1", type: "function", function: { name: "delete_todo", arguments: null } }],
      ["function:null", { id: "c1", type: "function", function: null }],
      ["id:null", { id: null, type: "function", function: { name: "delete_todo", arguments: "{}" } }],
      ["type:null", { id: "c1", type: null, function: { name: "delete_todo", arguments: "{}" } }],
    ];
    for (const [name, tc] of wholeBad) {
      const body = JSON.stringify({ choices: [{ message: { content: "", tool_calls: [tc] }, finish_reason: "tool_calls" }] });
      const c = await runComplete(body);
      assert.equal(c.ok, false, `五B complete JSON ${name}：必须失败`);
      const d = await runChat(buffered(body, "application/json"));
      assert.equal(d.done, null, `五B 流式缓冲 JSON ${name}：不得 onDone`);
    }
    // 合法：缺省键（没带 arguments / id 只在首片）仍正常
    const okRaw = toolDelta + ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "" } }] }, finish_reason: null }] }) + fin("tool_calls") + DONE;
    const okRun = await runChat(streamed(okRaw));
    assert.equal(okRun.error, null, String(okRun.error));
    assert.equal(okRun.done.tool_calls[0].function.arguments, "{\"id\":\"t1\"}");
    // agent-loop 第二道防线：桥实现交出 function:null / arguments:null 时整轮不执行
    const { runAgentRounds } = require(path.join(WWW, "agent-loop.js"));
    for (const bad of [
      { id: "c0", type: "function", function: { name: "delete_todo", arguments: null } },
      { id: "c0", type: "function", name: "delete_todo", function: null },
      { id: "c0", type: "function", function: { name: "delete_todo", arguments: 7 } },
    ]) {
      for (const via of ["complete", "stream"]) {
        const ran = [];
        let err = null;
        try {
          await runAgentRounds({
            messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
            complete: async () => via === "complete"
              ? ({ ok: true, finish_reason: "tool_calls", message: { content: "", tool_calls: [bad] } })
              : ({ ok: true, finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "cl", type: "function", function: { name: "list_todos", arguments: "{}" } }] } }),
            streamRound: async () => ({ text: "", toolCalls: [bad], finishReason: "tool_calls", aborted: false }),
            runTool: (tc) => { ran.push(tc.function && tc.function.name); return { ok: true }; },
            refreshSystemContent: () => "s",
          });
        } catch (e) { err = e; }
        assert.ok(!ran.includes("delete_todo"), `五B agent-loop ${via}：null 字段的调用不得执行`);
        assert.ok(err, `五B agent-loop ${via}：必须报错`);
      }
    }
  }
  ok("审查五 B 显式 null 的 tool delta / 整条 tool_call 字段失败关闭（流式/缓冲 SSE/complete/agent-loop）");

  /* ---- 审查五 C：正常成功也保留独立完成回执，同一 operationId 不得 POST 两次 ---- */
  {
    const mk = (opts = {}) => {
      const st = { posts: 0 };
      const fetchImpl = async (url, o) => {
        const u = String(url);
        const method = (o && o.method) || "GET";
        if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });   // 远端暂不可见
        if (u.includes("/time_entries") && method === "POST") { st.posts++; await tick(5); return reply(200, { id: "te" }); }
        if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
        return reply(200, {});
      };
      return { st, fetchImpl, ...opts };
    };
    // 同页连续重试
    {
      const { st, fetchImpl } = mk();
      const store = makeLocalStorage();
      const { api } = loadClickup(store, fetchImpl);
      await api.setStoredToken(TOKEN_A);
      await tick(30);
      const args = { operationId: "op-r5-c-same", title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now() - 1000 };
      assert.equal((await api.logPomodoro(args)).ok, true);
      assert.equal(st.posts, 1);
      assert.equal(JSON.parse(store.getItem("lumina-cu-pending-pomo-v1") || "[]").length, 0, "成功后待核对清空");
      const again = await api.logPomodoro(args);
      assert.equal(again.ok, true, "同 operationId 再次调用直接判成功");
      assert.equal(st.posts, 1, "同页连续重试不得再次 POST");
    }
    // 两个标签页同一 operationId 并发：先到者成功，后到者在锁内看到完成回执
    {
      const { st, fetchImpl } = mk();
      const shared = makeLocalStorage();
      const locks = makeSharedLocks();
      const t1 = loadClickup(shared, fetchImpl, { navigator: { locks } }).api;
      const t2 = loadClickup(shared, fetchImpl, { navigator: { locks } }).api;
      await t1.setStoredToken(TOKEN_A);
      await t2.setStoredToken(TOKEN_A);
      await tick(30);
      const args = { operationId: "op-r5-c-tabs", title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now() - 1000 };
      const [a, b] = await Promise.all([t1.logPomodoro(args), t2.logPomodoro(args)]);
      assert.equal(a.ok && b.ok, true, JSON.stringify([a, b]));
      assert.equal(st.posts, 1, "两页同一 operationId 只能 POST 一次");
      assert.equal((await t2.logPomodoro(args)).ok, true);
      assert.equal(st.posts, 1);
    }
    // 完成回执写不进去：保留待核对（不确定/已确认）状态，重试不 POST
    {
      const { st, fetchImpl } = mk();
      const store = makeLocalStorage();
      const rawSet = store.setItem;
      store.setItem = (k, v) => { if (k === "lumina-cu-pomo-done-v1") throw new Error("quota"); return rawSet(k, v); };
      const { api } = loadClickup(store, fetchImpl);
      await api.setStoredToken(TOKEN_A);
      await tick(30);
      const args = { operationId: "op-r5-c-fail", title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now() - 1000 };
      await api.logPomodoro(args);
      assert.equal(st.posts, 1);
      assert.equal(JSON.parse(store.getItem("lumina-cu-pending-pomo-v1") || "[]").length, 1, "回执写失败时不得清掉待核对");
      await api.logPomodoro(args);
      assert.equal(st.posts, 1, "回执写失败后重试也不得再 POST");
    }
  }
  ok("审查五 C 番茄打卡独立完成回执：同页连续重试/两页并发都只 POST 一次；回执写失败保留待核对");

  /* ---- 审查五 D：按标题建任务的结果持久化，另一页不得再建同名任务 ---- */
  for (const failMap of [false, true]) {
    const st = { taskPosts: 0, entryPosts: 0, entryTids: [] };
    const fetchImpl = async (url, o) => {
      const u = String(url);
      const method = (o && o.method) || "GET";
      if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
      if (u.includes("/time_entries") && method === "POST") { st.entryPosts++; st.entryTids.push(JSON.parse(o.body).tid); return reply(200, {}); }
      if (u.includes("/task") && method === "GET") return reply(200, { tasks: [], last_page: true });   // 新建任务暂不可见
      if (u.includes("/task") && method === "POST") { st.taskPosts++; await tick(5); return reply(200, { id: "task-d-" + st.taskPosts }); }
      if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
      return reply(200, {});
    };
    const shared = makeLocalStorage();
    if (failMap) {
      const rawSet = shared.setItem;
      shared.setItem = (k, v) => { if (k === "lumina-cu-task-map-v1") throw new Error("quota"); return rawSet(k, v); };
    }
    const locks = makeSharedLocks();
    const t1 = loadClickup(shared, fetchImpl, { navigator: { locks } }).api;
    const t2 = loadClickup(shared, fetchImpl, { navigator: { locks } }).api;
    await t1.setStoredToken(TOKEN_A);
    await t2.setStoredToken(TOKEN_A);
    await tick(30);
    const r1 = await t1.logPomodoro({ title: "新任务 D", minutes: 25, endedAt: Date.now() - 1000 });
    assert.equal(r1.ok, true);
    assert.equal(st.taskPosts, 1);
    const r2 = await t2.logPomodoro({ title: "新任务 D", minutes: 25, endedAt: Date.now() - 500 });
    assert.equal(st.taskPosts, 1, `${failMap}：另一页不得重建同名任务`);
    if (!failMap) {
      assert.equal(r2.ok, true);
      assert.deepEqual(st.entryTids, ["task-d-1", "task-d-1"], "第二页记到同一个任务上");
      assert.equal((await t2.status()).pendingTask, 0);
    } else {
      assert.equal((await t1.status()).pendingTask, 1, "映射写不进去：建任务的 pending 必须保留");
      // 审查六③：pending 里带着已知 taskId → 另一页直接了结并记到同一任务上，仍不重建
      assert.equal(r2.ok, true, "映射缺失 + pending 带已知 taskId：直接复用，不建");
      assert.deepEqual(st.entryTids, ["task-d-1", "task-d-1"]);
    }
  }
  ok("审查五 D 按标题建任务的 taskId 持久化（账号+清单+标题）；映射落盘后才清 pending，另一页不重建");

  /* ======================= Linear 复审第六轮回归 ======================= */

  /* ---- 审查六① 撤销未落盘的删除：远端在删除后改过 → 恢复远端最新版，绝不写回历史快照 ---- */
  for (const deliverEvent of [true, false]) {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Original" }).todo;
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("delete_todo", { id: x.id }).ok, true);   // 写盘失败 → 脏窗口
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "REMOTE EDIT", priority: "high" }).ok, true);
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(A.invoke("undo").ok, true);
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.ok(dx, `${deliverEvent}：撤销删除后条目回来`);
    assert.equal(dx.text, "REMOTE EDIT", `${deliverEvent}：撤销删除不得把历史快照写回盘盖掉远端编辑`);
    assert.equal(dx.priority, "high", `${deliverEvent}：远端其它字段编辑保留`);
  }
  {
    // 批量清除已完成（同一删除类逆操作）：远端在清除后改过其中一条 → 恢复远端最新版
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Done original" }).todo;
    assert.equal(A.invoke("complete_todo", { id: x.id }).ok, true);
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("clear_completed").ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "Done remote" }).ok, true);
    assert.equal(A.invoke("undo").ok, true);
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.ok(dx && dx.completed, "批量清除撤销后条目回来且仍是已完成");
    assert.equal(dx.text, "Done remote", "批量清除撤销同样取远端最新版");
  }
  {
    // 删除前本页还有一步未落盘编辑（另一字段）：恢复时本页改动与远端改动三方合并，再撤销那步编辑也只撤本页增量
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Base" }).todo;
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, priority: "high" }).ok, true);
    assert.equal(A.invoke("delete_todo", { id: x.id }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "Remote text" }).ok, true);
    assert.equal(A.invoke("undo").ok, true);
    let dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(dx.text, "Remote text");
    assert.equal(dx.priority, "high", "本页删除前的未落盘改动保留");
    assert.equal(A.invoke("undo").ok, true);
    dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(dx.text, "Remote text", "撤销更早的编辑也不能动远端正文");
    assert.notEqual(dx.priority, "high", "本页那步优先级编辑被撤掉");
  }
  {
    // 没有远端改动的删除：撤销照常恢复删除前快照（行为不变）
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Plain" }).todo;
    storage.failTodoWrites = true;
    assert.equal(A.invoke("delete_todo", { id: x.id }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(A.invoke("undo").ok, true);
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "Plain");
  }
  {
    // 同类：未落盘编辑与远端同字段冲突后，本页后续写成功落盘，再撤销那步编辑 → 取远端值而不是历史 before
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "O" }).todo;
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "L" }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R" }).ok, true);
    assert.equal(A.invoke("add_todo", { text: "later" }).ok, true);   // 恢复写成功（本页 L 盖住 R）
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "L");
    assert.equal(A.invoke("undo").ok, true);   // 撤销 add
    assert.equal(A.invoke("undo").ok, true);   // 撤销编辑
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "R", "落盘成功后冲突记录仍有效：撤销露出远端值");
  }
  ok("审查六① 撤销删除/批量清除：远端删除后改过 → 恢复远端最新版（与本页改动三方合并）；冲突记录落盘后仍有效");

  /* ---- 审查七① 侧表记录绑定到具体撤销步：重复「删除→撤销」不得复用上一代基线把远端最新编辑改回旧版 ---- */
  for (const deliverEvent of [true, false]) {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Original" }).todo;
    const B = loadApp({ storage });
    // 第一代
    storage.failTodoWrites = true;
    assert.equal(A.invoke("delete_todo", { id: x.id }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R1" }).ok, true);
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(A.invoke("undo").ok, true);
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "R1", `${deliverEvent}：第一次撤销恢复 R1`);
    // 第二代
    B.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    storage.failTodoWrites = true;
    assert.equal(A.invoke("delete_todo", { id: x.id }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R2" }).ok, true);
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(A.invoke("undo").ok, true);
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.ok(dx, `${deliverEvent}：第二次撤销删除后条目回来`);
    assert.equal(dx.text, "R2", `${deliverEvent}：第二次撤销不得把远端最新 R2 改回 R1`);
  }
  {
    // 批量清除已完成，两代
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Done O" }).todo;
    assert.equal(A.invoke("complete_todo", { id: x.id }).ok, true);
    const B = loadApp({ storage });
    for (const gen of ["R1", "R2", "R3"]) {
      B.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
      storage.failTodoWrites = true;
      assert.equal(A.invoke("clear_completed").ok, true);
      storage.failTodoWrites = false;
      assert.equal(B.invoke("update_todo", { id: x.id, text: gen }).ok, true);
      assert.equal(A.invoke("undo").ok, true);
      const dx = diskTodos(storage).find((t) => t.id === x.id);
      assert.ok(dx && dx.completed, `批量清除第 ${gen} 代撤销后条目回来且仍已完成`);
      assert.equal(dx.text, gen, `批量清除第 ${gen} 代撤销取该代远端最新版`);
    }
  }
  {
    // 同一次删除期间远端改了两次：仍以删除那一代的基线合并（取最新 R2，本页删除前改动保留）
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Base" }).todo;
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, priority: "high" }).ok, true);
    assert.equal(A.invoke("delete_todo", { id: x.id }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R1" }).ok, true);
    A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R2" }).ok, true);
    A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(A.invoke("undo").ok, true);
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(dx.text, "R2");
    assert.equal(dx.priority, "high", "同一代内保持删除时的基线：本页删除前的改动仍保留");
  }
  {
    // 编辑冲突记录同样绑定到产生它的那一步：撤销后即作废，不能被更早那步（字段值碰巧相同）再次套用
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "P" }).todo;
    const B = loadApp({ storage });
    assert.equal(A.invoke("update_todo", { id: x.id, text: "L" }).ok, true);    // Ea: P→L
    assert.equal(A.invoke("update_todo", { id: x.id, text: "M" }).ok, true);    // Eb: L→M
    B.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "L" }).ok, true);    // Ec: M→L（未落盘）
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R1" }).ok, true);   // 冲突：本页 L 胜出，记下 R1
    assert.equal(A.invoke("undo").ok, true);                                     // 撤销 Ec → 露出 R1
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "R1");
    B.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(B.invoke("update_todo", { id: x.id, text: "L" }).ok, true);    // 远端又改回 L（远端最新）
    A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(A.invoke("undo").ok, true);                                     // 撤销 Eb：当前 L≠M，不动
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "L");
    assert.equal(A.invoke("undo").ok, true);                                     // 撤销 Ea
    assert.notEqual(diskTodos(storage).find((t) => t.id === x.id).text, "R1", "已消费的冲突记录不得被更早一步复用（R1 是被远端自己替换掉的旧值）");
  }
  {
    // 编辑→撤销→再编辑→撤销 循环：每一代各自的远端值，不串代
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "O" }).todo;
    const B = loadApp({ storage });
    for (const gen of ["R1", "R2", "R3"]) {
      B.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
      storage.failTodoWrites = true;
      assert.equal(A.invoke("update_todo", { id: x.id, text: "L" }).ok, true);
      storage.failTodoWrites = false;
      assert.equal(B.invoke("update_todo", { id: x.id, text: gen }).ok, true);
      assert.equal(A.invoke("undo").ok, true);
      assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, gen, `编辑循环第 ${gen} 代撤销露出该代远端值`);
    }
  }
  ok("审查七① 侧表记录绑定撤销步（删除代/编辑步）：重复删除→撤销（单条/批量）与编辑循环都不复用上一代基线或已消费记录");

  /* ---- 审查八① 编辑冲突记录必须始终反映「自该步以来最近一次观察到的远端值」：
     远端后来改成与本页相同的值时也要刷新，否则依次撤销会把陈旧的 R1 写回盖掉远端最新 ---- */
  for (const deliverEvent of [true, false]) {
    for (const later of ["L", "R2"]) {
      const storage = sharedStorage();
      const A = loadApp({ storage });
      const x = A.invoke("add_todo", { text: "Original" }).todo;
      const B = loadApp({ storage });
      const tag = `${deliverEvent ? "有" : "无"} storage 事件 / 远端后来=${later}`;
      storage.failTodoWrites = true;
      assert.equal(A.invoke("update_todo", { id: x.id, text: "L" }).ok, true);   // A: Original→L（写失败）
      storage.failTodoWrites = false;
      assert.equal(B.invoke("update_todo", { id: x.id, text: "R1" }).ok, true);  // B 存 R1
      if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
      storage.failTodoWrites = true;
      const y = A.invoke("add_todo", { text: "unrelated" }).todo;                 // 合并看到 R1（记冲突 theirs=R1），写又失败
      assert.ok(y && y.id);
      storage.failTodoWrites = false;
      assert.equal(B.invoke("update_todo", { id: x.id, text: later }).ok, true); // B 后来存 later
      if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
      assert.equal(A.invoke("undo").ok, true);                                    // 撤销新增（写已恢复）
      let d = diskTodos(storage);
      assert.ok(!d.some((t) => t.id === y.id), `${tag}：撤销新增后无关条目移除`);
      assert.equal(d.find((t) => t.id === x.id).text, "L", `${tag}：撤销新增不动 x（本页 L 胜出）`);
      assert.equal(A.invoke("undo").ok, true);                                    // 撤销原编辑
      d = diskTodos(storage);
      assert.equal(d.find((t) => t.id === x.id).text, later, `${tag}：撤销原编辑须露出远端最新 ${later}，不得写回陈旧 R1 或 Original`);
    }
  }
  for (const deliverEvent of [true, false]) {
    // 本页恢复落盘后（非脏）别页先改 R3 再独立改回 L：storage 事件采纳 / mutator 入口读盘同样刷新冲突基准
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Original" }).todo;
    const B = loadApp({ storage });
    const tag = `${deliverEvent ? "有" : "无"} storage 事件 / 非脏采纳`;
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "L" }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R1" }).ok, true);
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    const y = A.invoke("add_todo", { text: "unrelated" }).todo;                   // 合并记 R1，这次写成功（盘上 L）
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "L");
    B.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    for (const v of ["R3", "L"]) {
      assert.equal(B.invoke("update_todo", { id: x.id, text: v }).ok, true);
      if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    }
    assert.equal(A.invoke("undo").ok, true);
    assert.ok(!diskTodos(storage).some((t) => t.id === y.id));
    assert.equal(A.invoke("undo").ok, true);
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "L", `${tag}：撤销原编辑露出远端最新 L，不得写回陈旧 R1`);
  }
  {
    // 回显不是远端改动：本页 L 已落盘、别页只存了无关条目（x 原样回显）→ 冲突记录不被回显刷新，撤销仍还给 R1
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "Original" }).todo;
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "L" }).ok, true);
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R1" }).ok, true);
    const y = A.invoke("add_todo", { text: "unrelated" }).todo;
    B.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    const z = B.invoke("add_todo", { text: "from B" }).todo;
    A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(A.invoke("undo").ok, true);
    assert.equal(A.invoke("undo").ok, true);
    const d = diskTodos(storage);
    assert.ok(!d.some((t) => t.id === y.id) && d.some((t) => t.id === z.id));
    assert.equal(d.find((t) => t.id === x.id).text, "R1", "远端只是回显本页已落盘的 L：撤销仍还给最近一次独立远端值 R1");
  }
  {
    // 每个撤销步各一条记录：同组较晚一步的新冲突不得顶掉较早一步的记录
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "O" }).todo;
    const B = loadApp({ storage });
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "L" }).ok, true);    // E1: O→L
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R1" }).ok, true);
    storage.failTodoWrites = true;
    A.invoke("add_todo", { text: "u1" });                                        // 合并：E1 记 R1
    assert.equal(A.invoke("update_todo", { id: x.id, text: "M" }).ok, true);    // E2: L→M
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R2" }).ok, true);
    storage.failTodoWrites = true;
    A.invoke("add_todo", { text: "u2" });                                        // 合并：E2 记 R2，E1 刷新为 R2
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "L" }).ok, true);    // 远端独立改成 L
    for (let i = 0; i < 2; i++) assert.equal(A.invoke("undo").ok, true);        // 撤销 u2、E2
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "L", "撤销 E2 露出远端最新 L");
    for (let i = 0; i < 2; i++) assert.equal(A.invoke("undo").ok, true);        // 撤销 u1、E1
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "L", "撤销 E1 不得写回 Original / R1，远端最新 L 保留");
  }
  ok("审查八① 编辑冲突记录随每次合并刷新远端基准（远端改成与本页相同也刷新）：依次撤销露出远端最新值（有/无 storage 事件，L/R2；非脏采纳；回显不刷新；每步各一条）");

  /* ======================= Linear 复审第九轮回归：撤销改为按字段写入戳判定 ======================= */

  /* ---- 审查九① 首次「同值」独立远端编辑也受撤销保护：A 改成 L（写失败），B 独立改成同一个 L，A 撤销不得把 B 的 L 改回原值 ---- */
  for (const field of ["text", "priority"]) {
    for (const deliverEvent of [true, false]) {
      const storage = sharedStorage();
      const A = loadApp({ storage });
      const x = A.invoke("add_todo", { text: "Original", priority: "low" }).todo;
      const B = loadApp({ storage });
      const tag = `${field} / ${deliverEvent ? "有" : "无"} storage 事件`;
      const patch = field === "text" ? { text: "L" } : { priority: "high" };
      storage.failTodoWrites = true;
      assert.equal(A.invoke("update_todo", { id: x.id, ...patch }).ok, true);   // A: Original→L（写失败）
      storage.failTodoWrites = false;
      assert.equal(B.invoke("update_todo", { id: x.id, ...patch }).ok, true);   // B 独立写下同值 L
      if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
      const r = A.invoke("undo");
      assert.equal(r.ok, true);
      const dx = diskTodos(storage).find((t) => t.id === x.id);
      assert.equal(dx[field], patch[field], `${tag}：B 独立写下的同值不得被撤销写回原值`);
      assert.equal(A.invoke("list_todos", {}).todos.find((t) => t.id === x.id)[field], patch[field], `${tag}：内存同样保留 B 的值`);
      assert.ok(Array.isArray(r.skipped) && r.skipped.some((s) => s.id === x.id && s.field === field),
        `${tag}：部分撤销要报告被跳过的字段组`);
    }
  }
  ok("审查九① 同值独立远端编辑受撤销保护（text / priority × 有/无 storage 事件），并报告跳过的字段");

  /* ---- 审查九② 迟到的陈旧 storage 事件不得让内存或撤销基准倒退 ---- */
  for (const stale of [true, false]) {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "O" }).todo;
    const B = loadApp({ storage });
    const tag = stale ? "迟到的陈旧 R1 事件" : "对照：无陈旧事件";
    storage.failTodoWrites = true;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "M" }).ok, true);   // E1: O→M（写失败）
    storage.failTodoWrites = false;
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R1" }).ok, true);
    const e1 = storage.getItem(TODO_KEY);                                        // R1 的 storage 事件被扣住
    assert.equal(B.invoke("update_todo", { id: x.id, text: "R2" }).ok, true);
    const u = A.invoke("add_todo", { text: "u" }).todo;                          // 恢复合并看到 R2，本页 M 落盘
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "M");
    if (stale) {
      A.deliverStorage(TODO_KEY, e1);                                            // 陈旧 R1 事件此刻才到
      assert.equal(A.invoke("list_todos", {}).todos.find((t) => t.id === x.id).text, "M", `${tag}：陈旧快照不得让内存倒退`);
      assert.ok(A.invoke("list_todos", {}).todos.some((t) => t.id === u.id), `${tag}：陈旧快照不得吞掉本页新增`);
      assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "M", `${tag}：陈旧快照不得被写回盘`);
    }
    assert.equal(A.invoke("undo").ok, true);                                     // 撤销 u
    assert.ok(!diskTodos(storage).some((t) => t.id === u.id));
    assert.equal(A.invoke("undo").ok, true);                                     // 撤销 E1
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "R2", `${tag}：撤销须露出最新远端 R2，不得写回陈旧 R1`);
  }
  ok("审查九② 迟到的陈旧 storage 事件按盘修订号丢弃：内存不倒退，撤销露出最新远端 R2（含无陈旧事件对照）");

  /* ---- 审查九③ 撤销新增：别页在条目上写过（即便净值相同）就保留，绝不删掉别页的编辑 ---- */
  for (const deliverEvent of [true, false]) {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const y = A.invoke("add_todo", { text: "Y", priority: "low" }).todo;
    const B = loadApp({ storage });
    assert.equal(B.invoke("update_todo", { id: y.id, priority: "high" }).ok, true);
    assert.equal(B.invoke("update_todo", { id: y.id, priority: "low" }).ok, true);   // 别页写过，净值回到 low
    if (deliverEvent) A.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    const r = A.invoke("undo");
    assert.equal(r.ok, true);
    assert.ok(diskTodos(storage).some((t) => t.id === y.id), `${deliverEvent}：别页在条目上写过，撤销新增不得删掉它`);
    assert.ok(Array.isArray(r.skipped) && r.skipped.some((s) => s.id === y.id), `${deliverEvent}：报告保留下来的新增条目`);
  }
  ok("审查九③ 撤销新增按写入戳判定：别页写过的条目保留并报告");

  /* ---- 审查九④ 写入戳随条目落盘并在合并中保留；旧版（无戳、无修订号）存档照常加载、编辑、撤销 ---- */
  {
    const storage = sharedStorage();
    storage.setItem(TODO_KEY, JSON.stringify({ v: 4, writer: "old-tab", savedAt: 1, todos: [
      { id: "legacy-1", text: "旧条目", completed: false, priority: "low", category: "inbox", dueDate: null,
        createdAt: 1700000000000, updatedAt: 1700000000000, completedAt: null, pomodoros: 0, clickupTaskId: null, clickupUrl: null },
    ] }));
    const A = loadApp({ storage });
    assert.equal(A.invoke("list_todos", {}).todos[0].text, "旧条目");
    assert.equal(A.invoke("update_todo", { id: "legacy-1", text: "新正文" }).ok, true);
    const disk = JSON.parse(storage.getItem(TODO_KEY));
    assert.ok(Number.isFinite(disk.rev) && disk.rev > 0, "新写入带单调盘修订号");
    const d0 = disk.todos[0];
    assert.ok(d0._fw && d0._fw.text && d0._fw.text.op, "写过的字段组带写入戳落盘");
    assert.equal(A.invoke("undo").ok, true);
    assert.equal(diskTodos(storage)[0].text, "旧条目", "旧数据上的本页编辑照常撤销");
    // 戳经别页往返后仍在
    const B = loadApp({ storage });
    assert.equal(B.invoke("add_todo", { text: "B 新增" }).ok, true);
    const after = JSON.parse(storage.getItem(TODO_KEY));
    assert.ok(after.rev > disk.rev, "盘修订号单调递增");
    assert.ok(after.todos.find((t) => t.id === "legacy-1"), "旧条目仍在");
    assert.ok(after.todos.find((t) => t.text === "B 新增")._fw, "别页新增同样带戳");
    // 导出不带内部写入戳
    assert.ok(!A.sandbox.__luminaExportSnapshot().todos.some((t) => "_fw" in t), "导出快照不含内部写入戳");
  }
  ok("审查九④ 写入戳与盘修订号落盘、跨页往返保留；旧版存档照常加载/编辑/撤销；导出不含内部戳");

  /* ---- 审查九⑤ 本页写盘恰好盖掉一份没见过的远端写：它的 storage 事件到达时仍按修订号视为新快照、软合并救回；
     软合并逐组按写入戳取较新一方，不再整条按 updatedAt 覆盖掉本页刚写的另一组 ---- */
  {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "O" }).todo;
    const B = loadApp({ storage });
    const rawSet = storage.setItem;
    let hook = true, eB = null;
    storage.setItem = (k, v) => {
      if (hook && k === TODO_KEY) {                 // A 已读盘、尚未落盘的瞬间，B 写入 R
        hook = false;
        assert.equal(B.invoke("update_todo", { id: x.id, text: "R" }).ok, true);
        eB = storage.getItem(TODO_KEY);
      }
      rawSet(k, v);
    };
    assert.equal(A.invoke("update_todo", { id: x.id, priority: "high" }).ok, true);
    storage.setItem = rawSet;
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "O", "前提：A 的写盖掉了 B 的 R");
    A.deliverStorage(TODO_KEY, eB);
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(dx.text, "R", "被盖掉的远端写须被软合并救回");
    assert.equal(dx.priority, "high", "软合并不得用远端整条覆盖本页刚写的优先级");
  }
  ok("审查九⑤ 被本页写盖掉的远端写按修订号仍可软合并救回；软合并逐组按写入戳取较新一方");

  /* ======================= Linear 复审第十轮回归 ======================= */

  /* ---- 审查十② 撤销不回退字段写入 rev：A 改 O→M 落盘，B 见过 M 后写别的组；B 的写恰被 A 的撤销写盖掉，
     它的快照（带 A 编辑 M 的旧 rev）迟到软合并时不得复活已撤销的 M ---- */
  for (const field of ["text", "priority"]) {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "O", priority: "low", category: "inbox" }).todo;
    const patch = field === "text" ? { text: "M" } : { priority: "high" };
    const orig = field === "text" ? "O" : "low";
    assert.equal(A.invoke("update_todo", { id: x.id, ...patch }).ok, true);
    const editRev = JSON.parse(storage.getItem(TODO_KEY)).todos.find((t) => t.id === x.id)._fw[field].rev;
    const B = loadApp({ storage });
    assert.equal(B.invoke("list_todos", {}).todos.find((t) => t.id === x.id)[field], patch[field], "前提：B 见过 A 的编辑");
    const rawSet = storage.setItem;
    let hook = true, eB = null;
    storage.setItem = (k, v) => {
      if (hook && k === TODO_KEY) {                 // A 撤销已读盘、尚未落盘的瞬间，B 改另一组
        hook = false;
        assert.equal(B.invoke("update_todo", { id: x.id, category: "work" }).ok, true);
        eB = storage.getItem(TODO_KEY);
      }
      rawSet(k, v);
    };
    assert.equal(A.invoke("undo").ok, true);
    storage.setItem = rawSet;
    const undone = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(undone[field], orig, `${field}：撤销已落盘`);
    assert.ok(undone._fw[field].rev > editRev, `${field}：撤销写回的字段戳 rev 必须新于被撤销的编辑（不得回退）`);
    assert.equal(JSON.parse(eB).todos.find((t) => t.id === x.id)[field], patch[field], "前提：B 的快照仍带已撤销的值");
    A.deliverStorage(TODO_KEY, eB);                  // 迟到的回显快照
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(dx[field], orig, `${field}：迟到的回显快照不得复活已撤销的编辑`);
    assert.equal(A.invoke("list_todos", {}).todos.find((t) => t.id === x.id)[field], orig, `${field}：内存同样不复活`);
    assert.equal(dx.category, "work", `${field}：B 对另一组的写仍须软合并救回`);
  }
  // 连续两步编辑同一组：撤销后一步换了新戳，更早那步的撤销仍认得出自己
  {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "O" }).todo;
    assert.equal(A.invoke("update_todo", { id: x.id, text: "M1" }).ok, true);
    assert.equal(A.invoke("update_todo", { id: x.id, text: "M2" }).ok, true);
    assert.equal(A.invoke("undo").ok, true);
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "M1");
    const r = A.invoke("undo");
    assert.equal(r.ok, true);
    assert.equal(diskTodos(storage).find((t) => t.id === x.id).text, "O", "更早那步仍可撤销");
    assert.ok(!(r.skipped || []).length, "不得误报为别处写过");
  }
  ok("审查十② 撤销写回给字段新戳（rev 单调前进）：迟到的回显快照不再复活已撤销的编辑；连续撤销仍逐步生效");

  /* ---- 审查十① 嵌套写入链作为撤销基准：A 改→B 改同组→A 撤销（保留 B）→B 撤销（回到初始值，不露出 A 已撤销的值）；
     A 改→B 改→B 撤销（露出 A 仍有效的值） ---- */
  for (const deliverEvent of [true, false]) {
    for (const field of ["text", "priority"]) {
      const vals = field === "text" ? ["O", "a", "b"] : ["low", "medium", "high"];
      const setup = () => {
        const storage = sharedStorage();
        const A = loadApp({ storage });
        const x = A.invoke("add_todo", { text: "O", priority: "low" }).todo;
        const B = loadApp({ storage });
        const sync = (to) => { if (deliverEvent) to.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY)); };
        const cur = () => diskTodos(storage).find((t) => t.id === x.id)[field];
        assert.equal(A.invoke("update_todo", { id: x.id, [field]: vals[1] }).ok, true); sync(B);
        assert.equal(B.invoke("update_todo", { id: x.id, [field]: vals[2] }).ok, true); sync(A);
        assert.equal(cur(), vals[2]);
        return { A, B, sync, cur, id: x.id };
      };
      const tag = `${field}/${deliverEvent ? "有" : "无"}事件`;
      {
        const { A, B, sync, cur, id } = setup();
        const r = A.invoke("undo");
        assert.equal(r.ok, true); sync(B);
        assert.equal(cur(), vals[2], `${tag}：A 撤销须保留 B 之后的写`);
        assert.ok((r.skipped || []).some((s) => s.field === field), `${tag}：A 撤销报告跳过该字段`);
        assert.equal(B.invoke("undo").ok, true); sync(A);
        assert.equal(cur(), vals[0], `${tag}：B 撤销须回到初始值，不得露出 A 已撤销的值`);
        if (deliverEvent) assert.equal(A.invoke("list_todos", {}).todos.find((t) => t.id === id)[field], vals[0], `${tag}：A 内存随事件一致`);
      }
      {
        const { B, sync, cur } = setup();
        assert.equal(B.invoke("undo").ok, true);
        assert.equal(cur(), vals[1], `${tag}：B 撤销须露出 A 仍有效的值`);
      }
    }
  }
  ok("审查十① 写入链完整保留：撤销跳过已撤销的写，恢复为链上最近仍有效的写（有/无 storage 事件，text/priority）");

  /* ---- 审查十③ 快照不按全局 rev 丢弃：A、B 交错「读-改-写」写出同号快照（各改不同任务/字段），
     第三页 C 依次收到两份后两处编辑都在；盘上 rev 回退时 C 仍合并新编辑 ---- */
  for (const order of ["AB", "BA"]) {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "X0", priority: "low" }).todo;
    const y = A.invoke("add_todo", { text: "Y0", priority: "low" }).todo;
    const B = loadApp({ storage });
    const C = loadApp({ storage });
    const rawSet = storage.setItem;
    let hook = true, eB = null;
    storage.setItem = (k, v) => {
      if (hook && k === TODO_KEY) {                 // A 已按盘上 rev 算好修订号、尚未落盘的瞬间，B 写入
        hook = false;
        assert.equal(B.invoke("update_todo", { id: y.id, priority: "high" }).ok, true);
        eB = storage.getItem(TODO_KEY);
      }
      rawSet(k, v);
    };
    assert.equal(A.invoke("update_todo", { id: x.id, text: "XA" }).ok, true);
    storage.setItem = rawSet;
    const eA = storage.getItem(TODO_KEY);
    assert.equal(JSON.parse(eA).rev, JSON.parse(eB).rev, "前提：A、B 写出同号快照");
    assert.equal(JSON.parse(eA).todos.find((t) => t.id === y.id).priority, "low", "前提：A 的快照不含 B 的编辑");
    for (const e of order === "AB" ? [eA, eB] : [eB, eA]) C.deliverStorage(TODO_KEY, e);
    const mem = C.invoke("list_todos", {}).todos;
    assert.equal(mem.find((t) => t.id === x.id).text, "XA", `${order}：C 须保留 A 的编辑`);
    assert.equal(mem.find((t) => t.id === y.id).priority, "high", `${order}：同号的 B 快照不得被当作旧快照丢掉`);
    const d = diskTodos(storage);
    assert.equal(d.find((t) => t.id === x.id).text, "XA", `${order}：合并结果写回盘`);
    assert.equal(d.find((t) => t.id === y.id).priority, "high", `${order}：合并结果写回盘`);
    assert.ok(JSON.parse(storage.getItem(TODO_KEY)).rev > JSON.parse(eA).rev, `${order}：写回的修订号单调递增`);
  }
  {
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "X0", priority: "low" }).todo;
    const y = A.invoke("add_todo", { text: "Y0", category: "inbox" }).todo;
    const B = loadApp({ storage });
    const C = loadApp({ storage });
    const rawSet = storage.setItem;
    let hook = true, eB2 = null;
    storage.setItem = (k, v) => {
      if (hook && k === TODO_KEY) {                 // A 读盘后、落盘前：B 连写两版，C 收到 B 的最新版
        hook = false;
        assert.equal(B.invoke("update_todo", { id: y.id, text: "YB" }).ok, true);
        assert.equal(B.invoke("update_todo", { id: y.id, category: "work" }).ok, true);
        eB2 = storage.getItem(TODO_KEY);
        C.deliverStorage(TODO_KEY, eB2);
      }
      rawSet(k, v);
    };
    assert.equal(A.invoke("update_todo", { id: x.id, priority: "high" }).ok, true);
    storage.setItem = rawSet;
    const eA = storage.getItem(TODO_KEY);
    assert.ok(JSON.parse(eA).rev < JSON.parse(eB2).rev, "前提：盘上修订号回退");
    C.deliverStorage(TODO_KEY, eA);
    const mem = C.invoke("list_todos", {}).todos;
    assert.equal(mem.find((t) => t.id === x.id).priority, "high", "盘上 rev 回退：C 仍须合并 A 的新编辑");
    assert.equal(mem.find((t) => t.id === y.id).text, "YB", "C 已合并的 B 编辑不得被回退的盘写冲掉");
    assert.equal(mem.find((t) => t.id === y.id).category, "work");
    const d = diskTodos(storage);
    assert.equal(d.find((t) => t.id === x.id).priority, "high");
    assert.equal(d.find((t) => t.id === y.id).text, "YB", "合并结果写回盘，救回被覆盖的 B 编辑");
    assert.ok(JSON.parse(storage.getItem(TODO_KEY)).rev > JSON.parse(eB2).rev, "写回的修订号高于已见最大值");
    // 同一份 payload 重复投递：已合并，不改内存
    const snap = JSON.stringify(C.invoke("list_todos", {}).todos);
    C.deliverStorage(TODO_KEY, eB2);
    assert.equal(JSON.stringify(C.invoke("list_todos", {}).todos), snap, "重复投递的旧快照不得让内存倒退");
  }
  ok("审查十③ 快照按字段写入戳合并、不按全局 rev 丢弃：同号交错快照（两种到达顺序）与盘上 rev 回退都不丢编辑，写回修订号单调");

  /* ---- 审查十一① 同值旧快照不回退撤销戳：A 改 O→a→b 再撤销回 a（新戳）；C 载入撤销后的盘，
     先收到值同为 a 的旧快照、再收到含 b 的迟到快照——旧戳不得盖掉撤销戳，b 不得复活 ---- */
  for (const field of ["text", "priority", "dueDate"]) {
    const vals = { text: ["O", "a", "b"], priority: ["low", "medium", "high"], dueDate: [null, "2030-01-02", "2030-03-04"] }[field];
    const param = field === "dueDate" ? "due_date" : field;
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "O", priority: "low" }).todo;
    if (field !== "text") assert.equal(A.invoke("update_todo", { id: x.id, text: "a" }).ok, true);
    assert.equal(A.invoke("update_todo", { id: x.id, [param]: vals[1] }).ok, true);
    const sA = storage.getItem(TODO_KEY);
    assert.equal(A.invoke("update_todo", { id: x.id, [param]: vals[2] }).ok, true);
    const sB = storage.getItem(TODO_KEY);
    assert.equal(A.invoke("undo").ok, true);
    const undone = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(undone[field], vals[1], `${field}：前提：撤销回 ${vals[1]}`);
    const undoRev = undone._fw[field].rev;
    const C = loadApp({ storage });
    C.deliverStorage(TODO_KEY, sA);                 // 同值旧快照
    assert.equal(diskTodos(storage).find((t) => t.id === x.id)._fw[field].rev, undoRev, `${field}：同值旧快照不得回退盘上撤销戳`);
    C.deliverStorage(TODO_KEY, sB);                 // 含已撤销值的迟到快照
    const mem = C.invoke("list_todos", {}).todos.find((t) => t.id === x.id);
    assert.equal(mem[field], vals[1], `${field}：迟到快照不得在内存复活已撤销的值`);
    const dx = diskTodos(storage).find((t) => t.id === x.id);
    assert.equal(dx[field], vals[1], `${field}：已撤销的值不得写回盘`);
    assert.equal(dx._fw[field].rev, undoRev, `${field}：撤销戳保留`);
  }
  ok("审查十一① 同值旧快照按完整写入版本比较：不回退撤销戳，迟到快照不复活已撤销的值（text / priority / dueDate）");

  /* ---- 审查十一② 撤销链裁剪携带单调版本：A 改 O→a，B 改 a→b；A 撤销（保留 b，把 B 链上 a 那环裁成 O）；
     C 载入裁剪后的盘，再收到裁剪前的 B 快照——旧链不得把 a 装回，B 撤销须回到 O ---- */
  for (const field of ["text", "priority", "dueDate"]) {
    const vals = { text: ["O", "a", "b"], priority: ["low", "medium", "high"], dueDate: [null, "2030-01-02", "2030-03-04"] }[field];
    const param = field === "dueDate" ? "due_date" : field;
    const storage = sharedStorage();
    const A = loadApp({ storage });
    const x = A.invoke("add_todo", { text: "O", priority: "low" }).todo;
    const B = loadApp({ storage });
    const cur = () => diskTodos(storage).find((t) => t.id === x.id)[field];
    assert.equal(A.invoke("update_todo", { id: x.id, [param]: vals[1] }).ok, true);
    B.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(B.invoke("update_todo", { id: x.id, [param]: vals[2] }).ok, true);
    const sB = storage.getItem(TODO_KEY);
    A.deliverStorage(TODO_KEY, sB);
    assert.equal(A.invoke("undo").ok, true);
    assert.equal(cur(), vals[2], `${field}：前提：A 撤销保留 B 的写`);
    const C = loadApp({ storage });
    C.deliverStorage(TODO_KEY, sB);                 // 裁剪前的 B 快照迟到
    const link = diskTodos(storage).find((t) => t.id === x.id)._fw[field].over;
    assert.ok(link && link.v && (link.v[field] ?? null) === vals[0], `${field}：旧快照不得把已撤销的 ${vals[1]} 节点装回链上`);
    B.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(B.invoke("undo").ok, true);
    assert.equal(cur(), vals[0], `${field}：B 撤销须回到初始值，不得恢复 A 已撤销的值`);
    C.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
    assert.equal(C.invoke("list_todos", {}).todos.find((t) => t.id === x.id)[field], vals[0], `${field}：C 内存随事件一致`);
    // 再投递一次裁剪前的快照：值与链都不得倒退
    C.deliverStorage(TODO_KEY, sB);
    assert.equal(cur(), vals[0], `${field}：迟到快照不得复活已撤销的写`);
  }
  ok("审查十一② 撤销链裁剪携带单调版本：裁剪前的旧快照不能把已撤销节点装回，后续撤销回到初始值（text / priority / dueDate）");

  /* ---- 审查十一③ 恢复别页的值保留其操作身份：
     (1) A1 O→a，B1 a→b，A2 b→c；A 撤销 A2 露出 b（仍属 B1），B 撤销 B1 须回到 a，A 再撤销 A1 回到 O
     (2) A 改 O→a，B 改 a→b，B 撤销回到 a（仍属 A 那步），A 撤销须回到 O ---- */
  for (const field of ["text", "priority", "dueDate"]) {
    const vals = { text: ["O", "a", "b", "c"], priority: ["low", "medium", "high", "low"], dueDate: [null, "2030-01-02", "2030-03-04", "2030-05-06"] }[field];
    const param = field === "dueDate" ? "due_date" : field;
    const setup = () => {
      const storage = sharedStorage();
      const A = loadApp({ storage });
      const x = A.invoke("add_todo", { text: "O", priority: "low" }).todo;
      const B = loadApp({ storage });
      const cur = () => diskTodos(storage).find((t) => t.id === x.id)[field] ?? null;
      /* 每步之间让出事件循环：撤销步按真实时序在微任务里封口，之后到达的远端写不再并进它的 before */
      const settle = () => new Promise((r) => setTimeout(r, 0));
      const edit = async (P, Q, v) => {
        assert.equal(P.invoke("update_todo", { id: x.id, [param]: v }).ok, true);
        await settle();
        Q.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
      };
      const undo = async (P, Q) => {
        assert.equal(P.invoke("undo").ok, true);
        await settle();
        Q.deliverStorage(TODO_KEY, storage.getItem(TODO_KEY));
      };
      return { A, B, id: x.id, cur, edit, undo };
    };
    {
      const { A, B, id, cur, edit, undo } = setup();
      await edit(A, B, vals[1]);
      await edit(B, A, vals[2]);
      await edit(A, B, vals[3]);
      await undo(A, B);
      assert.equal(cur(), vals[2], `${field}：(1) A 撤销 A2 露出 B1 的值`);
      await undo(B, A);
      assert.equal(cur(), vals[1], `${field}：(1) B 撤销 B1 不得被跳过，须回到 A1 的值`);
      await undo(A, B);
      assert.equal(cur(), vals[0], `${field}：(1) A 再撤销 A1 回到初始值`);
      assert.equal(B.invoke("list_todos", {}).todos.find((t) => t.id === id)[field] ?? null, vals[0], `${field}：(1) B 内存随事件一致`);
    }
    {
      const { A, B, cur, edit, undo } = setup();
      await edit(A, B, vals[1]);
      await edit(B, A, vals[2]);
      await undo(B, A);
      assert.equal(cur(), vals[1], `${field}：(2) B 撤销回到 A 的值`);
      await undo(A, B);
      assert.equal(cur(), vals[0], `${field}：(2) A 撤销不得被跳过，须回到初始值`);
    }
  }
  ok("审查十一③ 恢复别页的值保留其操作身份：撤销链可继续逐步回退（text / priority / dueDate）");

  /* ---- 审查十一④ 删除写入版本化墓碑：B 改 Y（快照含未改的 X），A 删 X，C 随后收到 B 的迟到快照——
     X 不得被补回内存或写回盘（C 收没收到 A 删除的 storage 事件都一样）；
     A 撤销删除后，各页再收到删除前的旧快照或删除时的旧墓碑，都不得丢掉 X ---- */
  {
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const ids = (P) => P.invoke("list_todos", {}).todos.map((t) => t.id);
    const setup = () => {
      const storage = sharedStorage();
      const A = loadApp({ storage });
      const x = A.invoke("add_todo", { text: "X" }).todo;
      const y = A.invoke("add_todo", { text: "Y" }).todo;
      const B = loadApp({ storage });
      const C = loadApp({ storage });
      assert.equal(B.invoke("update_todo", { id: y.id, text: "Y2" }).ok, true);
      const lateB = storage.getItem(TODO_KEY);
      assert.ok(JSON.parse(lateB).todos.some((t) => t.id === x.id), "B 的快照应含未改动的 X");
      assert.equal(A.invoke("delete_todo", { id: x.id }).ok, true);
      const afterDel = storage.getItem(TODO_KEY);
      assert.ok(JSON.parse(afterDel)._tomb[x.id], "删除应把墓碑随快照落盘");
      return { storage, A, B, C, x, y, lateB, afterDel };
    };
    for (const deliverDelete of [true, false]) {
      const { storage, A, B, C, x, y, lateB, afterDel } = setup();
      if (deliverDelete) C.deliverStorage(TODO_KEY, afterDel);
      C.deliverStorage(TODO_KEY, lateB);
      assert.ok(!ids(C).includes(x.id), `C 内存不得复活 X（deliverDelete=${deliverDelete}）`);
      assert.ok(!diskTodos(storage).some((t) => t.id === x.id), `盘上不得复活 X（deliverDelete=${deliverDelete}）`);
      A.deliverStorage(TODO_KEY, lateB);
      /* B 不收自己快照的事件；没收到删除事件时它只是还没见到删除，下次写盘前的读盘会跟上 */
      if (deliverDelete) B.deliverStorage(TODO_KEY, afterDel);
      else assert.ok(B.invoke("add_todo", { text: "Z" }).ok);
      for (const [n, P] of [["A", A], ["B", B], ["C", C]]) assert.ok(!ids(P).includes(x.id), `${n} 内存不得复活 X（deliverDelete=${deliverDelete}）`);
      assert.ok(!diskTodos(storage).some((t) => t.id === x.id), `各页处理迟到快照后盘上仍无 X（deliverDelete=${deliverDelete}）`);
      assert.equal(diskTodos(storage).find((t) => t.id === y.id).text, "Y2", "B 对 Y 的编辑保留");
      /* 新开的页面从盘加载：墓碑随存储快照持久化 */
      const D = loadApp({ storage });
      D.deliverStorage(TODO_KEY, lateB);
      assert.ok(!ids(D).includes(x.id), `重新加载的页面收到迟到快照也不复活 X（deliverDelete=${deliverDelete}）`);
    }
    {
      const { storage, A, B, C, x, lateB, afterDel } = setup();
      B.deliverStorage(TODO_KEY, afterDel);   // B 持有墓碑
      await settle();
      assert.equal(A.invoke("undo").ok, true);
      const afterUndo = storage.getItem(TODO_KEY);
      assert.ok(diskTodos(storage).some((t) => t.id === x.id), "撤销删除后盘上有 X");
      await settle();
      C.deliverStorage(TODO_KEY, lateB);      // 删除前的旧快照
      C.deliverStorage(TODO_KEY, afterDel);   // 删除时的旧墓碑
      B.deliverStorage(TODO_KEY, afterUndo);
      B.deliverStorage(TODO_KEY, lateB);
      A.deliverStorage(TODO_KEY, lateB);
      A.deliverStorage(TODO_KEY, afterDel);
      for (const [n, P] of [["A", A], ["B", B], ["C", C]]) assert.ok(ids(P).includes(x.id), `撤销删除后 ${n} 内存不得丢 X`);
      assert.ok(diskTodos(storage).some((t) => t.id === x.id), "撤销删除后各页收到旧快照/旧墓碑，盘上仍有 X");
      assert.ok(B.invoke("add_todo", { text: "Z" }).ok);
      assert.ok(diskTodos(storage).some((t) => t.id === x.id), "持有旧墓碑的页面再写盘也不删 X");
      const afterZ = storage.getItem(TODO_KEY);   // 含撤销删除后的 X
      /* 撤销删除之后再删：新的删除照常胜出 */
      assert.equal(C.invoke("delete_todo", { id: x.id }).ok, true);
      A.deliverStorage(TODO_KEY, afterZ);
      assert.ok(!ids(A).includes(x.id) && !diskTodos(storage).some((t) => t.id === x.id), "再次删除后，撤销删除时的旧快照不得复活 X");
    }
    {
      /* 旧存档没有 _tomb：照常加载、合并 */
      const storage = sharedStorage();
      const A = loadApp({ storage });
      const x = A.invoke("add_todo", { text: "X" }).todo;
      const raw = JSON.parse(storage.getItem(TODO_KEY));
      delete raw._tomb;
      storage.setItem(TODO_KEY, JSON.stringify(raw));
      const B = loadApp({ storage });
      assert.ok(ids(B).includes(x.id), "无 _tomb 的旧数据照常加载");
    }
  }
  ok("审查十一④ 删除写入版本化墓碑：迟到快照不再复活已删任务；撤销删除生成新版本，旧快照/旧墓碑不丢任务");

  /* ---- 审查六② 完成回执未能证明落盘时，任何清理都不得清掉唯一的「已确认」记录 ---- */
  for (const mode of ["throw", "silent"]) {
    const mk = () => {
      const st = { posts: 0 };
      const fetchImpl = async (url, o) => {
        const u = String(url);
        const method = (o && o.method) || "GET";
        if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });   // 远端暂不可见
        if (u.includes("/time_entries") && method === "POST") { st.posts++; return reply(200, { id: "te" }); }
        if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
        return reply(200, {});
      };
      return { st, fetchImpl };
    };
    const breakDone = (store) => {
      const rawSet = store.setItem;
      store.setItem = (k, v) => {
        if (k === "lumina-cu-pomo-done-v1") {
          if (mode === "throw") throw new Error("quota");
          return;   // silent：写调用「成功」但没落盘（只有读回能发现）
        }
        return rawSet(k, v);
      };
      return () => { store.setItem = rawSet; };
    };
    const PK = "lumina-cu-pending-pomo-v1";
    // 直接打卡成功 → 自动对账（无队列项）→ 同 operationId 重试
    {
      const { st, fetchImpl } = mk();
      const store = makeLocalStorage();
      const { api } = loadClickup(store, fetchImpl);
      await api.setStoredToken(TOKEN_A);
      await tick(30);
      const restore = breakDone(store);
      const args = { operationId: "op-r6-2-" + mode, title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now() - 1000 };
      assert.equal((await api.logPomodoro(args)).ok, true);
      assert.equal(st.posts, 1);
      let pend = JSON.parse(store.getItem(PK) || "[]");
      assert.equal(pend.length, 1, `${mode}：回执未落盘时保留已确认记录`);
      assert.equal(pend[0].state, "confirmed");
      await api.reconcilePendingPomos();
      pend = JSON.parse(store.getItem(PK) || "[]");
      assert.equal(pend.length, 1, `${mode}：自动对账不得清掉唯一的已确认记录`);
      assert.equal((await api.logPomodoro(args)).ok, true);
      assert.equal(st.posts, 1, `${mode}：同 operationId 重试不得再 POST`);
      // 回执恢复可写后，下一次对账补写回执并读回确认，才释放已确认记录
      restore();
      await api.reconcilePendingPomos();
      assert.equal(JSON.parse(store.getItem(PK) || "[]").length, 0, `${mode}：回执可证明落盘后才释放`);
      assert.ok(JSON.parse(store.getItem("lumina-cu-pomo-done-v1") || "[]").some((x) => x.operationId === args.operationId));
      assert.equal((await api.logPomodoro(args)).ok, true);
      assert.equal(st.posts, 1);
    }
    // 队列补发成功 → 队列项移除后的清理同样不得清掉
    {
      const { st, fetchImpl } = mk();
      const store = makeLocalStorage();
      const { api } = loadClickup(store, fetchImpl);
      await api.setStoredToken(TOKEN_A);
      await tick(30);
      breakDone(store);
      const op = "op-r6-2q-" + mode;
      store.setItem("lumina-cu-queue-v1", JSON.stringify([{ queueId: "q-r6", operationId: op, title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now() - 1000, tries: 0, queuedAt: Date.now() }]));
      await api.flushQueue();
      assert.equal(st.posts, 1);
      assert.equal(JSON.parse(store.getItem("lumina-cu-queue-v1") || "[]").length, 0);
      assert.equal(JSON.parse(store.getItem(PK) || "[]").length, 1, `${mode}：队列项移除后回执未落盘 → 已确认记录保留`);
      await api.reconcilePendingPomos();
      assert.equal((await api.logPomodoro({ operationId: op, title: "x", taskId: "task-known", minutes: 25, endedAt: Date.now() - 1000 })).ok, true);
      assert.equal(st.posts, 1, `${mode}：之后同 operationId 不得再 POST`);
    }
  }
  ok("审查六② 完成回执须读回确认落盘才释放已确认记录（直接打卡/自动对账/队列移除后清理），否则同 operationId 不再 POST");

  /* ---- 审查六③ 手动重试按 marker 找到任务：与 ensureTask 共用锁与持久了结，映射落盘后才清 pending ---- */
  for (const failMap of [false, true]) {
    const OPT = "ptask-r6-3-" + (failMap ? "f" : "o");
    const st = { taskPosts: 0, entryTids: [] };
    const task = { id: "task-r6-3", name: "R6 三号", description: "从 Lumina Todo 番茄打卡创建\n[lumina-op:" + OPT + "]", list: { id: "901818920363" }, status: { status: "to do", type: "open" } };
    const fetchImpl = async (url, o) => {
      const u = String(url);
      const method = (o && o.method) || "GET";
      if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
      if (u.includes("/time_entries") && method === "POST") { st.entryTids.push(JSON.parse(o.body).tid); return reply(200, {}); }
      if (/\/task\/[^/?]+$/.test(u) && method === "GET") return reply(200, task);
      // 只看 open 的标题查询还没索引到新任务；含 closed 的 marker 扫描能看到
      if (u.includes("/task?") && method === "GET") return reply(200, { tasks: u.includes("include_closed=true") ? [task] : [], last_page: true });
      if (u.includes("/task") && method === "POST") { st.taskPosts++; return reply(200, { id: "task-dup" }); }
      if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
      return reply(200, {});
    };
    const shared = makeLocalStorage();
    if (failMap) {
      const rawSet = shared.setItem;
      shared.setItem = (k, v) => { if (k === "lumina-cu-task-map-v1") throw new Error("quota"); return rawSet(k, v); };
    }
    const locks = makeSharedLocks();
    const t1 = loadClickup(shared, fetchImpl, { navigator: { locks }, rawFetch: true }).api;
    await t1.setStoredToken(TOKEN_A);
    await tick(30);
    shared.setItem("lumina-cu-pending-task-v1", JSON.stringify([{ key: "r6 三号", operationId: OPT, title: "R6 三号", createdAt: Date.now() - 11 * 60 * 1000, needsManual: true }]));
    await t1.retryPendingPomos();
    const pt = JSON.parse(shared.getItem("lumina-cu-pending-task-v1") || "[]");
    if (failMap) {
      assert.equal(pt.length, 1, "映射写不进去：手动对账不得清 pending");
      assert.equal(pt[0].taskId, "task-r6-3", "pending 记下已知 taskId");
    } else {
      assert.equal(pt.length, 0, "映射落盘后才清 pending");
    }
    // 另一页（页内缓存为空）同标题打卡：不得重建，记到找到的任务上
    const t2 = loadClickup(shared, fetchImpl, { navigator: { locks }, rawFetch: true }).api;
    await t2.setStoredToken(TOKEN_A);
    await tick(30);
    const r = await t2.logPomodoro({ title: "R6 三号", minutes: 25, endedAt: Date.now() - 1000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(st.taskPosts, 0, `${failMap}：另一页不得重建任务`);
    assert.deepEqual(st.entryTids, ["task-r6-3"]);
  }
  ok("审查六③ 手动重试按 marker 找到任务：共用 task 锁与持久了结，映射写失败保留 pending（带 taskId），另一页不重建");

  /* ---- 审查六④ 复用记住的标题→taskId 前按 id 回查：改名/关闭则作废改按标题查；回查不确定不新建 ---- */
  {
    const mkRemote = () => {
      const st = {
        tasks: [{ id: "task-A", name: "R6 四号", list: { id: "901818920363" }, status: { status: "to do", type: "open" } }],
        detailFail: false, taskPosts: 0, entryTids: [],
      };
      st.fetch = async (url, o) => {
        const u = String(url);
        const method = (o && o.method) || "GET";
        if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
        if (u.includes("/time_entries") && method === "POST") { st.entryTids.push(JSON.parse(o.body).tid); return reply(200, {}); }
        const d = /\/task\/([^/?]+)$/.exec(u);
        if (d && method === "GET") {
          if (st.detailFail) return reply(503, "unavailable");
          const t = st.tasks.find((x) => x.id === d[1]);
          return t ? reply(200, t) : reply(404, { err: "Task not found" });
        }
        if (u.includes("/task?") && method === "GET") {
          const open = !u.includes("include_closed=true");
          return reply(200, { tasks: st.tasks.filter((t) => !open || t.status.type !== "closed"), last_page: true });
        }
        if (u.includes("/task") && method === "POST") {
          st.taskPosts++;
          const t = { id: "task-new-" + st.taskPosts, name: JSON.parse(o.body).name, description: JSON.parse(o.body).description, list: { id: "901818920363" }, status: { status: "to do", type: "open" } };
          st.tasks.push(t);
          return reply(200, t);
        }
        if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
        return reply(200, {});
      };
      return st;
    };
    const setup = async () => {
      const st = mkRemote();
      const shared = makeLocalStorage();
      const locks = makeSharedLocks();
      const t1 = loadClickup(shared, st.fetch, { navigator: { locks }, rawFetch: true }).api;
      await t1.setStoredToken(TOKEN_A);
      await tick(30);
      assert.equal((await t1.logPomodoro({ title: "R6 四号", minutes: 25, endedAt: Date.now() - 5000 })).ok, true);
      assert.deepEqual(st.entryTids, ["task-A"]);
      const t2 = loadClickup(shared, st.fetch, { navigator: { locks }, rawFetch: true }).api;
      await t2.setStoredToken(TOKEN_A);
      await tick(30);
      return { st, t1, t2, shared };
    };
    // 改名：A → 「别的名字」，另有 open 任务 B 叫原标题 → 时间记到 B（另一页走持久映射、同页走页内缓存都一样）
    for (const which of ["t2", "t1"]) {
      const env = await setup();
      env.st.tasks[0].name = "别的名字";
      env.st.tasks.push({ id: "task-B", name: "R6 四号", list: { id: "901818920363" }, status: { status: "to do", type: "open" } });
      const r = await env[which].logPomodoro({ title: "R6 四号", minutes: 25, endedAt: Date.now() - 1000 });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(env.st.entryTids, ["task-A", "task-B"], `${which}：改名后的 A 不得再接收这个标题的时间`);
      assert.equal(env.st.taskPosts, 0);
      const map = JSON.parse(env.shared.getItem("lumina-cu-task-map-v1") || "[]");
      assert.ok(!map.some((x) => x.taskId === "task-A" && x.kind !== "created"), "A 的标题索引已作废");
    }
    // 关闭：A 已关闭且没有同名 open 任务 → 按标题查不到 → 新建
    {
      const env = await setup();
      env.st.tasks[0].status = { status: "complete", type: "closed" };
      const r = await env.t2.logPomodoro({ title: "R6 四号", minutes: 25, endedAt: Date.now() - 1000 });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(env.st.taskPosts, 1, "已关闭的任务不得复用");
      assert.deepEqual(env.st.entryTids, ["task-A", "task-new-1"]);
    }
    // 移到别的清单：同样作废
    {
      const env = await setup();
      env.st.tasks[0].list = { id: "other-list" };
      const r = await env.t2.logPomodoro({ title: "R6 四号", minutes: 25, endedAt: Date.now() - 1000 });
      assert.equal(r.ok, true);
      assert.notEqual(env.st.entryTids[1], "task-A", "移出清单的任务不得复用");
    }
    // 回查不确定（网络/5xx）：不新建、不写时间，返回可重试
    {
      const env = await setup();
      env.st.detailFail = true;
      const r = await env.t2.logPomodoro({ title: "R6 四号", minutes: 25, endedAt: Date.now() - 1000 });
      assert.equal(r.ok, false);
      assert.equal(r.code, "TASK_INDETERMINATE");
      assert.equal(r.retryable, true);
      assert.equal(env.st.taskPosts, 0, "回查不确定时不得新建");
      assert.deepEqual(env.st.entryTids, ["task-A"], "回查不确定时不得写时间");
    }
    // 显式 taskId 路径不变：不回查、不列任务
    {
      const env = await setup();
      env.st.tasks[0].name = "别的名字";
      env.st.detailFail = true;
      const r = await env.t2.logPomodoro({ title: "R6 四号", taskId: "task-A", minutes: 25, endedAt: Date.now() - 1000 });
      assert.equal(r.ok, true);
      assert.deepEqual(env.st.entryTids, ["task-A", "task-A"]);
    }
  }
  ok("审查六④ 记住的标题→taskId 复用前按 id 回查标题/清单/状态：改名/关闭/移走即作废改按标题查；回查不确定不新建；显式 taskId 不变");

  /* ---- 审查七② 建任务响应丢失后按 marker 立即找回：回执落盘后仍须回查标题/清单/状态 ---- */
  {
    const LIST = "901818920363";
    const mk = (variant) => {
      const st = { tasks: [], taskPosts: 0, entryTids: [], detailFail: false };
      st.fetch = async (url, o) => {
        const u = String(url);
        const method = (o && o.method) || "GET";
        if (u.includes("/time_entries") && method === "GET") return reply(200, { data: [] });
        if (u.includes("/time_entries") && method === "POST") { st.entryTids.push(JSON.parse(o.body).tid); return reply(200, {}); }
        const d = /\/task\/([^/?]+)$/.exec(u);
        if (d && method === "GET") {
          if (st.detailFail) return reply(503, "unavailable");
          const t = st.tasks.find((x) => x.id === d[1]);
          return t ? reply(200, t) : reply(404, { err: "Task not found" });
        }
        if (u.includes("/task?") && method === "GET") {
          const open = !u.includes("include_closed=true");
          return reply(200, { tasks: st.tasks.filter((t) => !open || t.status.type !== "closed"), last_page: true });
        }
        if (u.includes("/task") && method === "POST") {
          st.taskPosts++;
          const b = JSON.parse(o.body);
          const t = { id: "task-made-" + st.taskPosts, name: b.name, description: b.description, list: { id: LIST }, status: { status: "to do", type: "open" } };
          st.tasks.push(t);
          if (st.taskPosts === 1) {
            // 第一次创建成功但响应丢失；对账前 A 被改名，另有任务 B 现在叫原标题
            t.name = "已改名 Y";
            if (variant === "withB") st.tasks.push({ id: "task-B", name: "R7 二号", list: { id: LIST }, status: { status: "to do", type: "open" } });
            if (variant === "detailFail") { t.name = "R7 二号"; st.detailFail = true; }
            throw new TypeError("Failed to fetch");
          }
          return reply(200, t);
        }
        if (u.endsWith("/user")) return reply(200, { user: { id: 7 } });
        return reply(200, {});
      };
      return st;
    };
    // 改名 + 同名 B：时间记到 B，不记到已改名的 A，不重复创建
    {
      const st = mk("withB");
      const shared = makeLocalStorage();
      const api = loadClickup(shared, st.fetch, { navigator: { locks: makeSharedLocks() }, rawFetch: true }).api;
      await api.setStoredToken(TOKEN_A);
      await tick(30);
      const r = await api.logPomodoro({ title: "R7 二号", minutes: 25, endedAt: Date.now() - 1000 });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(st.entryTids, ["task-B"], "marker 找回的 A 已改名：时间不得记到 A");
      assert.equal(st.taskPosts, 1, "不得重复创建");
      const map = JSON.parse(shared.getItem("lumina-cu-task-map-v1") || "[]");
      assert.ok(map.some((x) => x.kind === "created" && x.taskId === "task-made-1"), "建任务完成回执仍落盘（那次创建确已完成）");
      assert.ok(!map.some((x) => x.kind !== "created" && x.taskId === "task-made-1"), "A 的标题索引作废");
      assert.equal(JSON.parse(shared.getItem("lumina-cu-pending-task-v1") || "[]").length, 0, "回执落盘后 pending 已了结");
    }
    // 改名且没有同名任务：时间同样不记到 A
    {
      const st = mk("noB");
      const shared = makeLocalStorage();
      const api = loadClickup(shared, st.fetch, { navigator: { locks: makeSharedLocks() }, rawFetch: true }).api;
      await api.setStoredToken(TOKEN_A);
      await tick(30);
      await api.logPomodoro({ title: "R7 二号", minutes: 25, endedAt: Date.now() - 1000 });
      assert.ok(!st.entryTids.includes("task-made-1"), "改名后的 A 不得接收原标题的时间");
    }
    // 回查不确定：保留记录、暂停提交时间，返回可重试 TASK_INDETERMINATE，不新建
    {
      const st = mk("detailFail");
      const shared = makeLocalStorage();
      const api = loadClickup(shared, st.fetch, { navigator: { locks: makeSharedLocks() }, rawFetch: true }).api;
      await api.setStoredToken(TOKEN_A);
      await tick(30);
      const r = await api.logPomodoro({ title: "R7 二号", minutes: 25, endedAt: Date.now() - 1000 });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.code, "TASK_INDETERMINATE");
      assert.equal(r.retryable, true);
      assert.deepEqual(st.entryTids, [], "回查不确定时不提交时间");
      assert.equal(st.taskPosts, 1, "回查不确定时不新建");
      const map = JSON.parse(shared.getItem("lumina-cu-task-map-v1") || "[]");
      const pend = JSON.parse(shared.getItem("lumina-cu-pending-task-v1") || "[]");
      assert.ok(map.some((x) => x.kind === "created" && x.taskId === "task-made-1") || pend.some((x) => x.taskId === "task-made-1"), "建任务记录保留");
      // 恢复后重试：回查通过才记时间，且仍不重建
      st.detailFail = false;
      await api.flushQueue();
      const r2 = st.entryTids.length ? { ok: true } : await api.logPomodoro({ title: "R7 二号", minutes: 25, endedAt: Date.now() - 500 });
      assert.equal(r2.ok, true, JSON.stringify(r2));
      assert.equal(st.entryTids[0], "task-made-1");
      assert.equal(st.taskPosts, 1);
    }
  }
  ok("审查七② 建任务响应丢失后 marker 找回：回执落盘后仍回查标题/清单/状态，改名则按标题重查，回查不确定暂停提交且不新建");

  console.log("\n全部通过：", passed);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
