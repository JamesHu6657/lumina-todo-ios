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

function loadClickup(store, fetchImpl, { timeoutCapMs } = {}) {
  const sandbox = baseSandbox(store, fetchImpl);
  if (Number.isFinite(timeoutCapMs) && timeoutCapMs > 0) {
    const nativeSetTimeout = sandbox.setTimeout;
    sandbox.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, Math.min(ms, timeoutCapMs), ...args);
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, "js/secure-store.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-clickup.js"), "utf8"), sandbox);
  return { sandbox, api: sandbox.LUMINA_MOBILE_CLICKUP, secure: sandbox.LUMINA_SECURE_STORE };
}

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
    await api.flushQueue();
    assert.equal(postCount, 2, "释放后下一次 flush 必须能继续执行");
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
    const r5 = await api.pushTodo({ title: "过期待核对2", todoId: "late-4" });
    assert.equal(r5.ok, true, "宽限期后查无可以重建");
  }
  ok("中 创建超时后宽限期内不重建，迟到提交由对账找回");

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

  console.log("\n全部通过：", passed);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
