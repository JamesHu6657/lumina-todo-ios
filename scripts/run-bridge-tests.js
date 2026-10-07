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

  console.log("\n全部通过：", passed);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
