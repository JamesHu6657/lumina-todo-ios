/**
 * Factory 中转 × iOS 桥接回归测试（Node，无真机）
 * 中转要等 droid exec 整轮结束才回包，CapacitorHttp 又会缓冲整个响应：
 * 流式 chat 必须给足等待时间，不能沿用 30s 连接超时。
 * 计时器按 1/1000 缩放：1ms ≈ 真机 1s。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const WWW = path.join(__dirname, "..", "www");
const SCALE = 1000;

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function sseBody(text) {
  const frames = [
    { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const raw = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(raw);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** 模拟中转：relaySeconds 后才一次性回完整 SSE；尊重 AbortSignal */
function slowRelayFetch(relaySeconds, text) {
  return (_url, options) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ ok: true, status: 200, body: sseBody(text) }),
        (relaySeconds * 1000) / SCALE
      );
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(options.signal.reason);
        },
        { once: true }
      );
    });
}

function loadBridge(store, fetchImpl) {
  const sandbox = {
    console: { ...console, error() {} },
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms / SCALE, ...args),
    clearTimeout,
    fetch: fetchImpl,
    localStorage: store,
    AbortController,
    URL,
    TextDecoder,
    ReadableStream,
    DOMException: class DOMException extends Error {
      constructor(msg, name) {
        super(msg);
        this.name = name || "DOMException";
      }
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, "js/mobile-bridge.js"), "utf8"), sandbox);
  return sandbox.luminaAI;
}

function runChat(ai) {
  return new Promise((resolve) => {
    ai.chat(
      { messages: [{ role: "user", content: "hi" }] },
      {
        onDone: (data) => resolve({ done: data }),
        onError: (error) => resolve({ error }),
      }
    );
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function within(promise, ms = 350) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("请求没有及时收尾")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function completeResponse(content = "完整回复") {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
  };
}

async function main() {
  const store = makeLocalStorage();
  store.setItem("lumina-api-provider", "factory");
  store.setItem("lumina-api-key-factory", "relay-token-" + "f".repeat(24));
  store.setItem("lumina-factory-base", "https://relay.example.com/v1");

  // droid 跑了 60s 才回包：超过 30s 连接超时，但在中转自身 90s 上限内
  const ai = loadBridge(store, slowRelayFetch(60, "慢回复"));
  await new Promise((r) => setTimeout(r, 10));
  const result = await runChat(ai);
  assert.equal(result.error, undefined, `不应报错：${result.error}`);
  assert.equal(result.done.aborted, undefined, "不应被超时中止");
  assert.equal(result.done.content, "慢回复");
  console.log("✔ Factory 流式 chat 能等到 60s 才回包的中转响应");

  // 中转卡死时客户端仍要自行收尾，不能无限挂起
  const stuck = loadBridge(store, slowRelayFetch(600, "never"));
  await new Promise((r) => setTimeout(r, 10));
  const started = Date.now();
  const stuckResult = await runChat(stuck);
  assert.ok(stuckResult.error || stuckResult.done?.aborted, "卡死的中转必须以超时收尾");
  assert.ok(Date.now() - started < 200, "超时须在 ~120s（缩放后 120ms）内触发");
  console.log("✔ Factory 中转卡死时仍会超时收尾");

  // 模拟 CapacitorHttp：原生 fetch 不响应 AbortSignal，且可在停止后才回包。
  {
    const transport = deferred();
    const fetchStarted = deferred();
    let calls = 0;
    let lateBodyReads = 0;
    const native = loadBridge(store, () => {
      if (++calls > 1) return Promise.resolve(completeResponse("新回复"));
      fetchStarted.resolve();
      return transport.promise;
    });
    const pending = native.complete({ requestId: "native-stop", messages: [{ role: "user", content: "hi" }] });
    await within(fetchStarted.promise);
    assert.equal((await native.abort("native-stop")).ok, true);
    const stopped = await within(pending);
    assert.equal(stopped.code, "ABORTED");
    assert.equal(stopped.aborted, true);
    transport.resolve({
      ...completeResponse(),
      text: async () => { lateBodyReads++; return completeResponse().text(); },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(lateBodyReads, 0, "停止后的迟到回复不得继续读取");
    const next = await within(native.complete({
      requestId: "native-stop",
      messages: [{ role: "user", content: "again" }],
    }));
    assert.equal(next.ok, true, "停止后应释放 active 槽及 requestId");
    assert.equal(next.message.content, "新回复");
    console.log("✔ 原生 fetch 忽略 signal 时，complete 仍可停止并忽略迟到回复");
  }

  {
    const transport = deferred();
    let nativeSignal;
    const native = loadBridge(store, (_url, options) => {
      nativeSignal = options.signal;
      return transport.promise;
    });
    const timedOut = await within(native.complete({ messages: [{ role: "user", content: "hi" }] }));
    assert.equal(timedOut.code, "TIMEOUT");
    assert.equal(timedOut.timedOut, true);
    assert.equal(nativeSignal.aborted, true);
    transport.reject(new Error("迟到的原生网络失败"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    console.log("✔ 原生 fetch 忽略 signal 时，complete 仍会超时且接住迟到失败");
  }

  for (const stop of [true, false]) {
    const text = deferred();
    const bodyStarted = deferred();
    const native = loadBridge(store, async () => ({
      ...completeResponse(),
      text: () => { bodyStarted.resolve(); return text.promise; },
    }));
    const id = stop ? "native-body-stop" : "native-body-timeout";
    const pending = native.complete({ requestId: id, messages: [{ role: "user", content: "hi" }] });
    await within(bodyStarted.promise);
    if (stop) await native.abort(id);
    const result = await within(pending);
    assert.equal(result.code, stop ? "ABORTED" : "TIMEOUT");
    text.resolve(await completeResponse("迟到回复").text());
    await new Promise((resolve) => setTimeout(resolve, 5));
    console.log(`✔ complete 的正文读取也受${stop ? "停止" : "超时"}保护`);
  }
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
